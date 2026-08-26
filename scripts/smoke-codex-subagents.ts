import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { bridgeToResponsesSSE } from "../src/bridge";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import type { AdapterEvent } from "../src/types";

const protocol = process.argv.includes("--v1") ? "v1" : "v2";
const explicitChildModel = "gpt-5.6-sol";
const explicitChildReasoningEffort = "max";
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
      reasoning_effort: explicitChildReasoningEffort,
    } : {
      task_name: "lifecycle_child",
      message: "CHILD_LIFECYCLE: spawn the requested grandchild, wait for it, then report success.",
      fork_turns: "none",
      model: explicitChildModel,
      reasoning_effort: explicitChildReasoningEffort,
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
      reasoning_effort: explicitChildReasoningEffort,
    } : {
      task_name: "lifecycle_grandchild",
      message: "GRANDCHILD_LIFECYCLE: reply with GRANDCHILD_LIFECYCLE_OK.",
      fork_turns: "none",
      model: explicitChildModel,
      reasoning_effort: explicitChildReasoningEffort,
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
      return new Response(bridgeToResponsesSSE(
        responseFor(role, step, body),
        "chatgpt-web/pro",
        collaborationMap,
      ), {
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
  'model = "chatgpt-web/pro"',
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
    "chatgpt-web/pro",
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
    if (firstRequest?.reasoningEffort !== explicitChildReasoningEffort) {
      failures.push(
        `${role} used reasoning ${firstRequest?.reasoningEffort ?? "none"}, expected ${explicitChildReasoningEffort}`,
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
