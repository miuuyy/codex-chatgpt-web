import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";

async function runCli(
  args: string[],
  env: Record<string, string | undefined>,
  input?: string,
  inputDelayMs = 0,
) {
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "../src/cli.ts"),
    ...args,
  ], {
    env,
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined) {
    const inputSink = child.stdin;
    if (!inputSink) throw new Error("CLI test subprocess has no piped stdin");
    if (inputDelayMs > 0) await Bun.sleep(inputDelayMs);
    inputSink.write(input);
    await inputSink.flush();
    inputSink.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("setup validates the port before performing runtime work", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-"));
  try {
    const result = await runCli([
      "setup",
      "--browser-only",
      "--chrome",
      process.execPath,
      "--browser-host-descriptor",
      join(root, "launcher-browser.json"),
      "--port",
      "0",
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    });
    const { stderr } = result;
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("--port must be an integer from 1 to 65535");
    expect(stderr).not.toContain("Choose either --chrome or --browser-host-descriptor");
    expect(stderr).not.toContain("Unknown arguments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launcher-controlled login fails before opening Chrome without live authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-login-"));
  const statePath = join(root, "storage-state.json");
  try {
    const result = await runCli([
      "login",
      "--launcher-control",
      "--chrome",
      process.execPath,
      "--storage-state",
      statePath,
    ], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
      CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: undefined,
      CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: undefined,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Launcher-controlled login requires a live launcher authorization");
    expect(existsSync(statePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorized launcher login accepts one bounded private continuation command", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-login-control-"));
  const descriptorPath = join(root, "runtime", "launcher-browser.json");
  const helperScript = join(root, "helper.cjs");
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  const token = "launcher-login-control-token-0123456789abcdefghijklmnop";
  try {
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(helperScript, "module.exports = {};\n", { mode: 0o700 });
    writeFileSync(executable, [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"",
      "case \" $* \" in",
      "  *\" --remote-debugging-pipe \"*) exit 0 ;;",
      "esac",
      "trap 'exit 0' TERM INT HUP",
      "while :; do sleep 1; done",
      "",
    ].join("\n"), { mode: 0o700 });
    writeFileSync(descriptorPath, `${JSON.stringify({
      version: 2,
      kind: "codex-web-gpt-launcher",
      profile: "production",
      pid: process.pid,
      endpoint: "http://127.0.0.1:48111",
      control: { endpoint: "http://127.0.0.1:48112", token },
      helper: { executable: process.execPath, script: helperScript },
      partition: "persist:codex-web-gpt-chatgpt",
      idleUrl: "about:blank#codex-web-gpt-browser-host",
      surfaceId: "c".repeat(32),
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    const statePath = join(root, "browser-login", "storage-state.json");
    const result = await runCli([
      "login",
      "--launcher-control",
      "--chrome",
      executable,
      "--storage-state",
      statePath,
    ], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
      CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: descriptorPath,
      CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: token,
      CODEX_LOGIN_ARG_LOG: argsLog,
    }, `${JSON.stringify({ version: 1, type: "browser-login-continue" })}\n`, 1_000);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("control input");
    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(launches).toHaveLength(2);
    expect(launches[0]).not.toContain("--remote-debugging-pipe");
    expect(launches[1]).toContain("--remote-debugging-pipe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV chat list works without starting launcher, broker, or Responses services", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-list-"));
  try {
    const result = await runCli(["dev", "list"], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: join(root, "dev"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
      CODEX_HOME: join(root, "codex"),
    });
    expect(result).toEqual({ exitCode: 0, stdout: "No named DEV chats yet.\n", stderr: "" });
    expect(existsSync(join(root, "codex", "config.toml"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV help exposes separate history-fill and live composer-fill operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-help-"));
  try {
    const result = await runCli(["dev", "help"], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: join(root, "dev"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
      CODEX_HOME: join(root, "codex"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("/fill TOKENS");
    expect(result.stdout).toContain("/send-fill TOKENS");
    expect(result.stderr).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV status reports the isolated home without creating a Codex route", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-status-"));
  const devHome = join(root, "dev");
  try {
    const result = await runCli(["dev", "status", "--json"], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: devHome,
      CODEX_CHATGPT_WEB_HOME: join(root, "production"),
      CODEX_HOME: join(root, "production-codex"),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      paths: {
        home: devHome,
        codexHome: join(devHome, "codex-home"),
        launcherUserData: join(devHome, "launcher"),
      },
      launcher: { running: false },
      config: { configured: false },
    });
    expect(existsSync(join(root, "production-codex", "config.toml"))).toBe(false);
    expect(existsSync(join(devHome, "codex-home", "config.toml"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV chat explains the isolated launcher setup when its profile is empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-empty-"));
  try {
    const result = await runCli(["dev", "chat", "smoke", "hello"], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: join(root, "dev"),
      CODEX_CHATGPT_WEB_HOME: join(root, "production"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("In the window labelled DEV");
    expect(result.stderr).toContain("Complete optional MCP setup only for simulated tool rounds");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic --home cannot collapse DEV mode into another runtime home", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-home-"));
  try {
    const result = await runCli(["--home", join(root, "shared"), "dev", "status"], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: join(root, "dev"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--home does not apply to DEV mode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV browser-only setup persists only the isolated harness profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-setup-"));
  const devHome = join(root, "dev");
  const descriptorPath = join(devHome, "runtime", "launcher-browser.json");
  const helperScript = join(root, "helper.cjs");
  const controlToken = "dev-launcher-control-token-0123456789abcdefghijklmnop";
  let inspections = 0;
  const control = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    inspections += 1;
    expect(request.url).toBe("/v1/session/inspect");
    expect(request.headers.authorization).toBe(`Bearer ${controlToken}`);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ detectCapabilities: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authenticated: true,
      temporary: true,
      solAvailable: true,
      proAvailable: false,
      url: "https://chatgpt.com/?temporary-chat=true",
    }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    control.once("error", rejectListen);
    control.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = control.address();
    if (!address || typeof address === "string") throw new Error("control server has no port");
    mkdirSync(join(devHome, "runtime"), { recursive: true });
    writeFileSync(helperScript, "module.exports = {};\n", { mode: 0o700 });
    writeFileSync(descriptorPath, `${JSON.stringify({
      version: 2,
      kind: "codex-web-gpt-launcher",
      profile: "development",
      pid: process.pid,
      endpoint: "http://127.0.0.1:48121",
      control: { endpoint: `http://127.0.0.1:${address.port}`, token: controlToken },
      helper: { executable: process.execPath, script: helperScript },
      partition: "persist:codex-web-gpt-dev-chatgpt",
      idleUrl: "about:blank#codex-web-gpt-browser-host",
      surfaceId: "d".repeat(32),
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    const result = await runCli([
      "dev",
      "setup",
      "--browser-only",
      "--browser-host-descriptor",
      descriptorPath,
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: devHome,
      CODEX_CHATGPT_WEB_HOME: join(root, "production"),
      CODEX_HOME: join(root, "production-codex"),
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("No Codex route, Responses listener, or system service was installed");
    expect(result.stdout).toContain("DEV launcher owns the isolated MCP tunnel");
    expect(inspections).toBe(1);
    expect(JSON.parse(readFileSync(join(devHome, "config.json"), "utf8"))).toMatchObject({
      version: 3,
      purpose: "dev-harness",
      mode: "browser-only",
      appName: "Codex Native2 DEV",
      browserHost: "launcher",
      browserHostDescriptorPath: descriptorPath,
      solAvailable: true,
      proAvailable: false,
    });
    expect(existsSync(join(root, "production-codex", "config.toml"))).toBe(false);
    expect(existsSync(join(devHome, "codex-home", "config.toml"))).toBe(false);
  } finally {
    await new Promise<void>(resolveClose => control.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal uninstall refuses to race a launcher-owned runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-uninstall-"));
  const appHome = join(root, "app");
  const configPath = join(appHome, "config.json");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: join(appHome, "runtime", "launcher-browser.json"),
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "launcher-uninstall-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
  })}\n`);
  try {
    const result = await runCli([
      "uninstall",
      "--yes",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be removed from Codex Web GPT Settings");
    expect(existsSync(configPath)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authorized launcher uninstall does not re-probe an already stopped full runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-launcher-uninstall-"));
  const appHome = join(root, "app");
  const codexHome = join(root, "codex");
  const descriptorPath = join(appHome, "runtime", "launcher-browser.json");
  const helperScript = join(root, "helper.cjs");
  const runtimeKeyFile = join(appHome, "secrets", "runtime.key");
  const token = "launcher-uninstall-control-token-0123456789abcdef";
  mkdirSync(join(appHome, "runtime"), { recursive: true });
  mkdirSync(join(appHome, "secrets"), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(helperScript, "module.exports = {};\n");
  writeFileSync(runtimeKeyFile, "test-key\n");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 2,
    kind: "codex-web-gpt-launcher",
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:48111",
    control: { endpoint: "http://127.0.0.1:48112", token },
    helper: { executable: process.execPath, script: helperScript },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "a".repeat(32),
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  writeFileSync(join(appHome, "config.json"), `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "full",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "runtime-control-token-0123456789abcdef0123456789",
    runtimeCommand: [process.execPath],
    tunnel: {
      binaryPath: join(root, "missing-tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile,
      profileDir: join(appHome, "tunnel", "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  })}\n`);
  try {
    const result = await runCli([
      "uninstall",
      "--yes",
      "--launcher-control",
    ], {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_CHATGPT_WEB_HOME: appHome,
      CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: descriptorPath,
      CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: token,
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("Uninstalled and removed private application data");
    expect(existsSync(appHome)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
