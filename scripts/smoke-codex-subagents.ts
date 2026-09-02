import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { bridgeToResponsesSSE } from "../src/bridge";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import { forwardNativeCodexRequest } from "../src/native-passthrough";
import type { AdapterEvent } from "../src/types";

const protocol = process.argv.includes("--v1") ? "v1" : "v2";
const rootModel = protocol === "v2" ? "gpt-5.6-sol" : "chatgpt-web/pro";
const explicitChildModel = protocol === "v2" ? "chatgpt-web/pro" : "gpt-5.6-sol";
const requestedChildReasoningEffort = protocol === "v2" ? "ultra" : "max";
const effectiveChildReasoningEffort = protocol === "v2" ? "medium" : "max";
const codexArg = process.argv.slice(2).find(argument => argument !== "--v1" && argument !== "--v2");
const codex = resolve(codexArg ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
if (!existsSync(codex)) throw new Error(`Codex executable is missing: ${codex}`);

const bundled = spawnSync(codex, ["debug", "models", "--bundled"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 15_000,
});
if (bundled.status !== 0) {
  throw new Error(`Could not read bundled Codex models: ${bundled.error?.message || bundled.stderr}`);
}

const sourceCatalog = JSON.parse(bundled.stdout) as { models?: unknown[] };
const catalogConfig = defaultConfig("browser-only");
catalogConfig.solAvailable = true;
catalogConfig.proAvailable = true;
catalogConfig.subagentProtocol = protocol === "v1" ? "compatibility-v1" : "native";
const catalog = augmentNativeModelCatalog(sourceCatalog, catalogConfig);

const root = join(tmpdir(), `codex-chatgpt-web-subagents-${process.pid}-${Date.now()}`);
const codexHome = join(root, "codex");
mkdirSync(codexHome, { recursive: true });
writeFileSync(join(root, "models.json"), `${JSON.stringify(catalog)}\n`);

type Role = "root" | "child" | "grandchild";
const steps = new Map<Role, number>();
const rolesByThread = new Map<string, Role>();
const observed = new Set<string>();
const failures: string[] = [];
const requestLog: Array<{
  role: Role;
  step: number;
  threadId?: string;
  agentName?: string;
  model?: string;
  reasoningEffort?: string;
  inputTypes: string[];
  functionOutputs: string[];
  encryptedContent: boolean;
}> = [];

const toolNamespace = protocol === "v1" ? "multi_agent_v1" : "collaboration";
const collaborationMap = new Map([
  ["spawn_agent", { namespace: toolNamespace, name: "spawn_agent" }],
  ["wait_agent", { namespace: toolNamespace, name: "wait_agent" }],
  [protocol === "v1" ? "send_input" : "followup_task", {
    namespace: toolNamespace,
    name: protocol === "v1" ? "send_input" : "followup_task",
  }],
]);

const v2MessageTools = new Set(["spawn_agent", "send_message", "followup_task"]);

function hasEncryptedV2MessageSchema(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasEncryptedV2MessageSchema);
  const record = value as Record<string, unknown>;
  const parameters = record.parameters && typeof record.parameters === "object"
    ? record.parameters as Record<string, unknown>
    : undefined;
  const properties = parameters?.properties && typeof parameters.properties === "object"
    ? parameters.properties as Record<string, unknown>
    : undefined;
  const message = properties?.message && typeof properties.message === "object"
    ? properties.message as Record<string, unknown>
    : undefined;
  if (record.type === "function"
    && typeof record.name === "string"
    && v2MessageTools.has(record.name)
    && message?.encrypted === true) return true;
  return Object.values(record).some(hasEncryptedV2MessageSchema);
}

function removePlaintextV2Markers(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.reduce((changed, item) => removePlaintextV2Markers(item) || changed, false);
  }
  const record = value as Record<string, unknown>;
  let changed = false;
  if (record.type === "function_call"
    && record.namespace === "collaboration"
    && typeof record.name === "string"
    && v2MessageTools.has(record.name)
    && Array.isArray(record.encrypted_function_args)
    && record.encrypted_function_args.length === 0) {
    delete record.encrypted_function_args;
    changed = true;
  }
  for (const child of Object.values(record)) {
    if (removePlaintextV2Markers(child)) changed = true;
  }
  return changed;
}

async function nativeResponseWithoutPlaintextMarkers(
  events: ReadableStream<Uint8Array>,
): Promise<Response> {
  const text = await new Response(events).text();
  const rewritten = text.split("\n").map(line => {
    if (!line.startsWith("data: ") || line === "data: [DONE]") return line;
    try {
      const event = JSON.parse(line.slice(6)) as unknown;
      return removePlaintextV2Markers(event) ? `data: ${JSON.stringify(event)}` : line;
    } catch {
      return line;
    }
  }).join("\n");
  return new Response(rewritten, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function hasEncryptedContent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasEncryptedContent);
  const record = value as Record<string, unknown>;
  return record.type === "encrypted_content" || Object.values(record).some(hasEncryptedContent);
}

function agentMessageText(input: unknown): string {
  if (!Array.isArray(input)) return "";
  return input
    .filter(item => item && typeof item === "object" && (item as { type?: unknown }).type === "agent_message")
    .map(item => JSON.stringify(item))
    .join("\n");
}

function roleOf(body: Record<string, unknown>): Role {
  const metadata = body.client_metadata && typeof body.client_metadata === "object"
    ? body.client_metadata as Record<string, unknown>
    : undefined;
  const rawTurnMetadata = metadata?.["x-codex-turn-metadata"];
  const threadId = typeof metadata?.thread_id === "string" ? metadata.thread_id : undefined;
  if (threadId && rolesByThread.has(threadId)) return rolesByThread.get(threadId)!;
  if (protocol === "v2" && typeof rawTurnMetadata === "string") {
    try {
      const agentName = (JSON.parse(rawTurnMetadata) as { agent_name?: unknown }).agent_name;
      if (typeof agentName === "string") {
        if (agentName.includes("/lifecycle_grandchild")) {
          if (threadId) rolesByThread.set(threadId, "grandchild");
          return "grandchild";
        }
        if (agentName.includes("/lifecycle_child")) {
          if (threadId) rolesByThread.set(threadId, "child");
          return "child";
        }
        if (agentName === "/root") {
          if (threadId) rolesByThread.set(threadId, "root");
          return "root";
        }
      }
    } catch { /* fall through to input-based classification */ }
  }
  if (Array.isArray(body.input)) {
    const latestAgentMessage = [...body.input].reverse().find(item =>
      item && typeof item === "object" && (item as { type?: unknown }).type === "agent_message"
    ) as { recipient?: unknown } | undefined;
    const recipient = typeof latestAgentMessage?.recipient === "string"
      ? latestAgentMessage.recipient
      : "";
    if (recipient.includes("/lifecycle_grandchild")) {
      if (threadId) rolesByThread.set(threadId, "grandchild");
      return "grandchild";
    }
    if (recipient.includes("/lifecycle_child")) {
      if (threadId) rolesByThread.set(threadId, "child");
      return "child";
    }
  }
  const agentText = agentMessageText(body.input);
  if (agentText.includes("GRANDCHILD_LIFECYCLE")) {
    if (threadId) rolesByThread.set(threadId, "grandchild");
    return "grandchild";
  }
  if (agentText.includes("CHILD_LIFECYCLE") || agentText.includes("FOLLOWUP_LIFECYCLE")) {
    if (threadId) rolesByThread.set(threadId, "child");
    return "child";
  }
  const inputText = JSON.stringify(body.input ?? "");
  if (inputText.includes("GRANDCHILD_LIFECYCLE")) {
    if (threadId) rolesByThread.set(threadId, "grandchild");
    return "grandchild";
  }
  if (inputText.includes("CHILD_LIFECYCLE") || inputText.includes("FOLLOWUP_LIFECYCLE")) {
    if (threadId) rolesByThread.set(threadId, "child");
    return "child";
  }
  if (!inputText.includes("ROOT_LIFECYCLE")) {
    throw new Error(`Could not classify Codex lifecycle request: ${inputText.slice(-500)}`);
  }
  if (threadId) rolesByThread.set(threadId, "root");
  return "root";
}

function spawnedAgentId(body: Record<string, unknown>): string {
  if (!Array.isArray(body.input)) throw new Error("V1 lifecycle request has no input history");
  for (const item of [...body.input].reverse()) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "function_call_output") continue;
    const output = (item as { output?: unknown }).output;
    if (typeof output !== "string") continue;
    try {
      const agentId = (JSON.parse(output) as { agent_id?: unknown }).agent_id;
      if (typeof agentId === "string" && agentId) return agentId;
    } catch { /* not a spawn result */ }
  }
  throw new Error("V1 lifecycle could not find the spawned agent id");
}

async function* toolCall(name: string, args: Record<string, unknown>): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: `call_${name}_${crypto.randomUUID()}`, name };
  yield { type: "tool_call_delta", arguments: JSON.stringify(args) };
  yield { type: "tool_call_end" };
  yield { type: "done", stopReason: "tool_use", endTurn: false };
}

async function* finalAnswer(text: string): AsyncGenerator<AdapterEvent> {
  yield { type: "text_delta", text, phase: "final_answer" };
  yield { type: "done", stopReason: "stop", endTurn: true };
}

function responseFor(role: Role, step: number, body: Record<string, unknown>): AsyncIterable<AdapterEvent> {
  if (role === "root") {
    if (step === 0) return toolCall("spawn_agent", protocol === "v1" ? {
      message: "CHILD_LIFECYCLE: spawn the requested grandchild, wait for it, then report success.",
      fork_context: false,
      model: explicitChildModel,
      reasoning_effort: requestedChildReasoningEffort,
    } : {
      task_name: "lifecycle_child",
      message: "CHILD_LIFECYCLE: spawn the requested grandchild, wait for it, then report success.",
      fork_turns: "none",
      model: explicitChildModel,
      reasoning_effort: requestedChildReasoningEffort,
    });
    if (step === 1) return toolCall("wait_agent", protocol === "v1"
      ? { targets: [spawnedAgentId(body)], timeout_ms: 500 }
      : { timeout_ms: 500 });
    if (step === 2) return toolCall(protocol === "v1" ? "send_input" : "followup_task", protocol === "v1" ? {
      target: spawnedAgentId(body),
      message: "FOLLOWUP_LIFECYCLE: acknowledge this follow-up with CHILD_FOLLOWUP_OK.",
      interrupt: true,
    } : {
      target: "/root/lifecycle_child",
      message: "FOLLOWUP_LIFECYCLE: acknowledge this follow-up with CHILD_FOLLOWUP_OK.",
    });
    if (step === 3) return toolCall("wait_agent", protocol === "v1"
      ? { targets: [spawnedAgentId(body)], timeout_ms: 500 }
      : { timeout_ms: 500 });
    return finalAnswer("ROOT_LIFECYCLE_OK");
  }
  if (role === "child") {
    if (step === 0) return toolCall("spawn_agent", protocol === "v1" ? {
      message: "GRANDCHILD_LIFECYCLE: reply with GRANDCHILD_LIFECYCLE_OK.",
      fork_context: false,
      model: explicitChildModel,
      reasoning_effort: requestedChildReasoningEffort,
    } : {
      task_name: "lifecycle_grandchild",
      message: "GRANDCHILD_LIFECYCLE: reply with GRANDCHILD_LIFECYCLE_OK.",
      fork_turns: "none",
      model: explicitChildModel,
      reasoning_effort: requestedChildReasoningEffort,
    });
    if (step === 1) return toolCall("wait_agent", protocol === "v1"
      ? { targets: [spawnedAgentId(body)], timeout_ms: 500 }
      : { timeout_ms: 500 });
    if (step === 2) return finalAnswer("CHILD_LIFECYCLE_OK");
    return finalAnswer("CHILD_FOLLOWUP_OK");
  }
  return finalAnswer("GRANDCHILD_LIFECYCLE_OK");
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/models") return Response.json(catalog);
    if (url.pathname !== "/v1/responses" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    try {
      const body = await request.json() as Record<string, unknown>;
      const role = roleOf(body);
      const step = steps.get(role) ?? 0;
      steps.set(role, step + 1);
      observed.add(`${role}:${step}`);
      const clientMetadata = body.client_metadata && typeof body.client_metadata === "object"
        ? body.client_metadata as Record<string, unknown>
        : {};
      let agentName: string | undefined;
      if (typeof clientMetadata["x-codex-turn-metadata"] === "string") {
        try {
          const parsed = JSON.parse(clientMetadata["x-codex-turn-metadata"] as string) as { agent_name?: unknown };
          if (typeof parsed.agent_name === "string") agentName = parsed.agent_name;
        } catch { /* diagnostic only */ }
      }
      requestLog.push({
        role,
        step,
        ...(typeof clientMetadata.thread_id === "string" ? { threadId: clientMetadata.thread_id } : {}),
        ...(agentName ? { agentName } : {}),
        ...(typeof body.model === "string" ? { model: body.model } : {}),
        ...(body.reasoning && typeof body.reasoning === "object"
          && typeof (body.reasoning as Record<string, unknown>).effort === "string"
          ? { reasoningEffort: String((body.reasoning as Record<string, unknown>).effort) }
          : {}),
        inputTypes: Array.isArray(body.input)
          ? body.input.map(item => item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string"
            ? String((item as { type: string }).type)
            : "unknown")
          : [],
        functionOutputs: Array.isArray(body.input)
          ? body.input.flatMap(item => item && typeof item === "object"
            && (item as { type?: unknown }).type === "function_call_output"
            && typeof (item as { output?: unknown }).output === "string"
            ? [String((item as { output: string }).output).slice(0, 500)]
            : [])
          : [],
        encryptedContent: hasEncryptedContent(body.input),
      });
      if ((role === "child" && step === 0) || (role === "grandchild" && step === 0)) {
        if (hasEncryptedContent(body.input)) {
          failures.push(`${role} received encrypted_content instead of plaintext agent_message input`);
        }
      }
      const responseStream = bridgeToResponsesSSE(
        responseFor(role, step, body),
        "chatgpt-web/pro",
        collaborationMap,
      );
      if (protocol === "v2" && role === "root") {
        const proxyRequest = new Request(request.url, {
          method: "POST",
          headers: {
            authorization: "Bearer local-lifecycle-smoke",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
        return await forwardNativeCodexRequest(proxyRequest, "responses", async upstreamRequest => {
          const forwarded = await upstreamRequest.clone().json() as unknown;
          if (hasEncryptedV2MessageSchema(forwarded)) {
            failures.push("native V2 proxy left collaboration message schemas encrypted");
          }
          return await nativeResponseWithoutPlaintextMarkers(responseStream);
        }, body, { plaintextMultiAgentV2Messages: true });
      }
      return new Response(responseStream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      return Response.json({ error: { type: "server_error", message: failures.at(-1) } }, { status: 500 });
    }
  },
});

writeFileSync(join(codexHome, "config.toml"), [
  `model = ${JSON.stringify(rootModel)}`,
  'model_provider = "lifecycle"',
  `model_catalog_json = ${JSON.stringify(join(root, "models.json"))}`,
  "",
  "[model_providers.lifecycle]",
  'name = "Local lifecycle smoke"',
  `base_url = "http://127.0.0.1:${server.port}/v1"`,
  'env_key = "OPENAI_API_KEY"',
  'wire_api = "responses"',
  "supports_websockets = false",
  "",
  "[agents]",
  "max_depth = 2",
  "",
  "[features]",
  "multi_agent = true",
  ...(protocol === "v1" ? ["multi_agent_v2 = false"] : [
    "",
    "[features.multi_agent_v2]",
    "enabled = true",
    "min_wait_timeout_ms = 100",
    "max_wait_timeout_ms = 5000",
    "default_wait_timeout_ms = 500",
  ]),
  "",
].join("\n"));

try {
  const processHandle = Bun.spawn([
    codex,
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    rootModel,
    "ROOT_LIFECYCLE: complete the nested subagent lifecycle and the follow-up.",
  ], {
    cwd: root,
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENAI_API_KEY: "local-lifecycle-smoke",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => processHandle.kill(), 60_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error(`Codex lifecycle exited ${exitCode}: ${stderr || stdout}`);
  if (!stdout.includes("ROOT_LIFECYCLE_OK")) {
    throw new Error(
      `Codex lifecycle did not return the root result. Observed: ${JSON.stringify([...observed])}`
        + `\nRequests: ${JSON.stringify(requestLog)}\nCodex output: ${stdout}\n${stderr}`,
    );
  }
  for (const required of [
    "root:0", "root:1", "root:2", "root:3", "root:4",
    "child:0", "child:1", "child:2", "child:3",
    "grandchild:0",
  ]) {
    if (!observed.has(required)) failures.push(`missing lifecycle step ${required}`);
  }
  for (const role of ["child", "grandchild"] as const) {
    const firstRequest = requestLog.find(entry => entry.role === role && entry.step === 0);
    if (firstRequest?.model !== explicitChildModel) {
      failures.push(`${role} used ${firstRequest?.model ?? "no model"}, expected ${explicitChildModel}`);
    }
    if (firstRequest?.reasoningEffort !== effectiveChildReasoningEffort) {
      failures.push(
        `${role} used reasoning ${firstRequest?.reasoningEffort ?? "none"}, expected ${effectiveChildReasoningEffort}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${failures.join("; ")}\nObserved: ${JSON.stringify([...observed])}`
        + `\nRequests: ${JSON.stringify(requestLog)}`
        + `\nCodex stdout: ${stdout.slice(-8_000)}\nCodex stderr: ${stderr.slice(-8_000)}`,
    );
  }
  process.stdout.write(`CODEX_SUBAGENT_${protocol.toUpperCase()}_LIFECYCLE_SMOKE_OK ${JSON.stringify([...observed].toSorted())}\n`);
} finally {
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
