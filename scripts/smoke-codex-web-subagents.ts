import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";

const codexArg = process.argv.slice(2).find(argument => !argument.startsWith("--"));
const codex = resolve(codexArg ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
if (!existsSync(codex)) throw new Error(`Codex executable is missing: ${codex}`);

const runtimeConfig = loadConfig();
if (runtimeConfig.browserHost !== "launcher") {
  throw new Error("Live Web subagent smoke requires the launcher-owned browser host");
}
if (runtimeConfig.subagentProtocol !== "compatibility-v1") {
  throw new Error("Live Web subagent smoke requires one consistent Compatibility V1 runtime configuration");
}
if (!runtimeConfig.solAvailable) {
  throw new Error("Live Web subagent smoke requires the authenticated Sol model surface");
}

const bundled = spawnSync(codex, ["debug", "models", "--bundled"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 15_000,
});
if (bundled.status !== 0) {
  throw new Error(`Could not read bundled Codex models: ${bundled.error?.message || bundled.stderr}`);
}

const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-live-subagents-"));
const codexHome = join(root, "codex");
mkdirSync(codexHome, { recursive: true });
const catalogPath = join(root, "models.json");
const catalogConfig = structuredClone(runtimeConfig);
catalogConfig.subagentProtocol = "compatibility-v1";
writeFileSync(
  catalogPath,
  `${JSON.stringify(augmentNativeModelCatalog(JSON.parse(bundled.stdout), catalogConfig))}\n`,
);

const bridgeBaseUrl = `http://${runtimeConfig.host}:${runtimeConfig.port}/v1`;
writeFileSync(join(codexHome, "config.toml"), [
  'model = "chatgpt-web/medium"',
  'model_provider = "live_bridge"',
  `model_catalog_json = ${JSON.stringify(catalogPath)}`,
  "",
  "[model_providers.live_bridge]",
  'name = "Live codex-chatgpt-web bridge"',
  `base_url = ${JSON.stringify(bridgeBaseUrl)}`,
  'env_key = "CODEX_WEB_LIVE_SMOKE_KEY"',
  'wire_api = "responses"',
  "supports_websockets = false",
  "",
  "[agents]",
  "max_depth = 2",
  "",
  "[features]",
  "multi_agent = true",
  "multi_agent_v2 = false",
  "",
].join("\n"));

const expectedVersion = (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  version?: unknown;
}).version;
if (typeof expectedVersion !== "string" || !expectedVersion) {
  throw new Error("Repository package.json has no version");
}

const prompt = [
  "Use the available agent tools; do not read package.json in the parent yourself.",
  "Spawn exactly one child with model chatgpt-web/high, reasoning_effort high, and no forked history.",
  "Ask it to read package.json through its repository tools and return CHILD_RESULT followed by the",
  "exact version. Wait for that exact child id even if it has already completed, then return",
  "LIVE_WEB_SUBAGENT_OK followed by the same version.",
  "Do not use fallback models. If any requested model or agent operation is unavailable, fail explicitly.",
].join(" ");

interface RolloutRecord {
  type?: string;
  payload?: Record<string, unknown>;
}

function rolloutFiles(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...rolloutFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
  }
  return result;
}

function records(path: string): RolloutRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as RolloutRecord);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function subagentDepth(meta: RolloutRecord | undefined): number {
  const source = object(meta?.payload?.source);
  const subagent = object(source?.subagent);
  const spawn = object(subagent?.thread_spawn);
  return typeof spawn?.depth === "number" ? spawn.depth : 0;
}

function responseItems(entries: RolloutRecord[]): Record<string, unknown>[] {
  return entries
    .filter(entry => entry.type === "response_item")
    .flatMap(entry => object(entry.payload) ? [entry.payload!] : []);
}

function compactOutput(value: string): string {
  return value.length <= 8_000 ? value : value.slice(-8_000);
}

try {
  const processHandle = Bun.spawn([
    codex,
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    "chatgpt-web/medium",
    prompt,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_WEB_LIVE_SMOKE_KEY: "loopback-live-smoke",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    processHandle.kill();
  }, 8 * 60_000);
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  clearTimeout(timeout);
  if (timedOut) throw new Error("Live Web subagent smoke timed out after 8 minutes");

  const files = existsSync(join(codexHome, "sessions")) ? rolloutFiles(join(codexHome, "sessions")) : [];
  const sessions = files.map(path => {
    const entries = records(path);
    const meta = entries.find(entry => entry.type === "session_meta");
    const context = entries.find(entry => entry.type === "turn_context");
    const completion = entries.find(entry => entry.type === "event_msg"
      && object(entry.payload)?.type === "task_complete");
    return { path, entries, meta, context, completion, depth: subagentDepth(meta) };
  });
  const rootSession = sessions.find(session => session.depth === 0);
  const childSession = sessions.find(session => session.depth === 1);
  const failures: string[] = [];
  if (exitCode !== 0) failures.push(`Codex exited ${exitCode}`);
  if (!rootSession) failures.push("missing root rollout");
  if (!childSession) failures.push("missing depth-1 Web child rollout");

  for (const [label, session, expectedModel] of [
    ["root", rootSession, "chatgpt-web/medium"],
    ["child", childSession, "chatgpt-web/high"],
  ] as const) {
    const context = object(session?.context?.payload);
    if (context?.cwd !== process.cwd()) failures.push(`${label} did not inherit the repository cwd`);
    if (context?.model !== expectedModel) failures.push(`${label} used ${String(context?.model)}, expected ${expectedModel}`);
    if (context?.multi_agent_version !== "v1") failures.push(`${label} did not run on Compatibility V1`);
    const completion = object(session?.completion?.payload);
    if (object(completion?.error)) failures.push(`${label} completed with ${JSON.stringify(completion?.error)}`);
  }

  for (const [label, session] of [["root", rootSession]] as const) {
    const items = session ? responseItems(session.entries) : [];
    const waits = items.filter(item => item.type === "function_call" && item.name === "wait_agent");
    const waitOutputs = items.filter(item => item.type === "function_call_output"
      && typeof item.output === "string"
      && (item.output.includes("completed") || item.output.includes("errored")));
    if (waits.length === 0) failures.push(`${label} never called targeted wait_agent`);
    if (waitOutputs.length === 0) failures.push(`${label} never received a terminal agent status`);
  }

  const rootCompletion = object(rootSession?.completion?.payload);
  const finalMessage = typeof rootCompletion?.last_agent_message === "string"
    ? rootCompletion.last_agent_message
    : "";
  if (!finalMessage.includes("LIVE_WEB_SUBAGENT_OK") || !finalMessage.includes(expectedVersion)) {
    failures.push(`root did not return the acceptance marker for version ${expectedVersion}`);
  }

  if (failures.length > 0) {
    throw new Error(
      `${failures.join("; ")}\nCodex stdout:\n${compactOutput(stdout)}\nCodex stderr:\n${compactOutput(stderr)}`,
    );
  }
  process.stdout.write(
    `LIVE_WEB_SUBAGENT_CHAIN_OK root=chatgpt-web/medium child=chatgpt-web/high version=${expectedVersion}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
