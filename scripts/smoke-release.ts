import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultBrokerEndpoint, defaultChromeExecutable } from "../src/config";
import { VERSION } from "../src/version";

const sourceBundle = resolve(process.argv[2] ?? "dist/runtime");
const sourceRoot = resolve(import.meta.dir, "..");
const root = join(homedir(), `.codex-chatgpt-web-release-smoke-${process.pid}-${Date.now()}`);
const firstLocation = join(root, "first-location");
const runtimeRoot = join(root, "relocated-runtime");
cpSync(sourceBundle, firstLocation, { recursive: true });
renameSync(firstLocation, runtimeRoot);

const manifest = JSON.parse(readFileSync(join(runtimeRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
if (manifest.schemaVersion !== 1
  || manifest.appVersion !== VERSION
  || manifest.playwright !== "1.62.0"
  || !/^[a-f0-9]{64}$/.test(String(manifest.bundleId ?? ""))) {
  throw new Error(`Unexpected runtime manifest: ${JSON.stringify(manifest)}`);
}
if (typeof manifest.launcher !== "string" || typeof manifest.entrypoint !== "string") {
  throw new Error(`Runtime manifest has no launcher or entrypoint: ${JSON.stringify(manifest)}`);
}
const launcher = join(runtimeRoot, manifest.launcher);
const runtimeExecutable = join(runtimeRoot, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
const entrypoint = join(runtimeRoot, manifest.entrypoint);
const runtimeCommand = [runtimeExecutable, entrypoint];
const cliBundle = readFileSync(join(runtimeRoot, "app", "cli.js"), "utf8");
const launcherText = readFileSync(launcher, "utf8");
for (const forbidden of [sourceRoot, dirname(sourceBundle), "/private/tmp/codex-chatgpt-web-verify", "/tmp/codex-chatgpt-web-verify"]) {
  if (cliBundle.includes(forbidden) || launcherText.includes(forbidden)) {
    throw new Error(`Runtime artifact embeds an ephemeral build path: ${forbidden}`);
  }
}

const version = Bun.spawnSync([...runtimeCommand, "--version"], { stdout: "pipe", stderr: "pipe" });
if (version.exitCode !== 0 || version.stdout.toString().trim() !== VERSION) {
  throw new Error(`Relocated launcher failed: ${version.stderr.toString()}`);
}

const appHome = join(root, "app-state");
const codexHome = join(root, "codex");
mkdirSync(join(appHome, "browser"), { recursive: true });
mkdirSync(codexHome, { recursive: true });
const portServer = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
const port = portServer.port;
portServer.stop();
const config = {
  version: 3,
  releaseVersion: VERSION,
  mode: "browser-only",
  host: "127.0.0.1",
  port,
  contextWindow: 256_000,
  appName: "Codex Native",
  browserHost: "managed-chrome",
  chromeExecutablePath: defaultChromeExecutable(),
  storageStatePath: join(appHome, "browser", "storage-state.json"),
  brokerSocketPath: defaultBrokerEndpoint(appHome),
  headed: true,
  proAvailable: true,
  autoApproveToolCalls: false,
  controlToken: "release-smoke-control-token-0123456789abcdef",
  runtimeCommand,
  acknowledgedUnofficialAt: new Date().toISOString(),
};
writeFileSync(join(appHome, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });

const env = { ...process.env, CODEX_CHATGPT_WEB_HOME: appHome, CODEX_HOME: codexHome };
const child = Bun.spawn([...runtimeCommand, "serve"], { env, stdout: "pipe", stderr: "pipe" });
let stoppedGracefully = false;
try {
  const deadline = Date.now() + 10_000;
  let health: Response | undefined;
  while (Date.now() < deadline) {
    try {
      health = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (health.ok) break;
    } catch {}
    await Bun.sleep(50);
  }
  if (!health?.ok) throw new Error("relocated daemon did not become healthy");
  const payload = await health.json() as Record<string, unknown>;
  if (payload.service !== "codex-chatgpt-web" || payload.mode !== "browser-only") {
    throw new Error(`unexpected health payload: ${JSON.stringify(payload)}`);
  }

  const unauthenticatedModels = await fetch(`http://127.0.0.1:${port}/v1/models`);
  const unauthenticatedModelsBody = await unauthenticatedModels.json() as { error?: { message?: string } };
  if (unauthenticatedModels.status !== 502
    || !unauthenticatedModelsBody.error?.message?.includes("incoming Bearer authorization")) {
    throw new Error(`native model passthrough did not fail closed without Codex auth: ${JSON.stringify(unauthenticatedModelsBody)}`);
  }
  const websocketNegotiation = await fetch(`http://127.0.0.1:${port}/v1/responses`);
  if (websocketNegotiation.status !== 426) {
    throw new Error(`Responses WebSocket negotiation did not select Codex HTTP/SSE fallback: HTTP ${websocketNegotiation.status}`);
  }
  const invalid = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/not-enabled", input: "test", stream: false }),
  });
  if (invalid.status !== 400) throw new Error(`unsupported model did not fail closed: HTTP ${invalid.status}`);

  const unauthorizedDrain = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
    method: "POST",
    headers: { authorization: "Bearer wrong-release-smoke-token" },
  });
  if (unauthorizedDrain.status !== 401) throw new Error(`lifecycle control accepted an invalid token: HTTP ${unauthorizedDrain.status}`);

  const drain = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.controlToken}` },
  });
  const drainPayload = await drain.json() as Record<string, unknown>;
  if (!drain.ok || drainPayload.accepting_turns !== false
    || drainPayload.active_http_turns !== 0 || drainPayload.active_browser_turns !== 0) {
    throw new Error(`daemon did not acknowledge an idle authenticated drain: ${JSON.stringify(drainPayload)}`);
  }
  const rejectedWhileDraining = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/high", reasoning: { effort: "high" }, input: "test", stream: false }),
  });
  if (rejectedWhileDraining.status !== 503) {
    throw new Error(`daemon accepted a new turn while draining: HTTP ${rejectedWhileDraining.status}`);
  }
  const resume = await fetch(`http://127.0.0.1:${port}/admin/resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.controlToken}` },
  });
  const resumePayload = await resume.json() as Record<string, unknown>;
  if (!resume.ok || resumePayload.accepting_turns !== true) {
    throw new Error(`daemon did not resume after the drain smoke: ${JSON.stringify(resumePayload)}`);
  }

  if (process.platform === "darwin") {
    const browser = Bun.spawnSync([...runtimeCommand, "browser", "check"], { env, stdout: "pipe", stderr: "pipe" });
    if (browser.exitCode !== 0) throw new Error(`relocated Playwright smoke failed: ${browser.stderr.toString()}`);
  }
  const finalDrain = await fetch(`http://127.0.0.1:${port}/admin/drain`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.controlToken}` },
  });
  if (!finalDrain.ok) throw new Error(`relocated daemon refused final drain: HTTP ${finalDrain.status}`);
  const shutdown = await fetch(`http://127.0.0.1:${port}/admin/shutdown`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.controlToken}` },
  });
  if (!shutdown.ok) throw new Error(`relocated daemon refused graceful shutdown: HTTP ${shutdown.status}`);
  await Promise.race([
    child.exited,
    Bun.sleep(10_000).then(() => { throw new Error("relocated daemon did not exit after graceful shutdown"); }),
  ]);
  stoppedGracefully = true;
  process.stdout.write("RELOCATABLE_RUNTIME_SMOKE_OK\n");
} finally {
  if (!stoppedGracefully) {
    child.kill("SIGTERM");
    await child.exited;
  }
  rmSync(root, { recursive: true, force: true });
}
