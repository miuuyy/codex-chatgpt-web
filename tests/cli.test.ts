import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBrokerEndpoint, defaultConfig, ZERO_RISK_CHATGPT_CONNECTOR_NAME } from "../src/config";
import { LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";

setDefaultTimeout(30_000);

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "../src/cli.ts"),
    ...args,
  ], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("production and DEV setup reject the removed connector-name option before configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-fixed-connector-"));
  try {
    const env = {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
      CODEX_CHATGPT_WEB_DEV_HOME: join(root, "dev"),
    };
    for (const command of [["setup"], ["dev", "setup"]]) {
      const result = await runCli([
        ...command, "--browser-only", "--app-name", "Other Connector", "--acknowledge-unofficial",
      ], env);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/Unknown.*arguments: --app-name Other Connector/);
    }
    expect(existsSync(join(root, "app", "config.json"))).toBeFalse();
    expect(existsSync(join(root, "dev", "config.json"))).toBeFalse();
    const help = await runCli(["--help"], env);
    expect(help.stdout).not.toContain("--app-name");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("setup browser-interaction flags are explicit and mutually exclusive", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-interaction-"));
  try {
    const result = await runCli([
      "setup",
      "--browser-only",
      "--automatic-browser-interaction",
      "--zero-risk-browser-interaction",
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Choose at most one browser interaction mode");

    const profileConflict = await runCli([
      "setup",
      "--browser-only",
      "--zero-risk-browser-interaction",
      "--zero-risk-pro",
      "--zero-risk-default",
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    });
    expect(profileConflict.exitCode).toBe(1);
    expect(profileConflict.stderr).toContain("Choose at most one Zero Risk model profile");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual setup rejects capability refresh and Bigger Context", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-manual-invalid-"));
  try {
    const env = {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    };
    const refresh = await runCli([
      "setup",
      "--browser-only",
      "--zero-risk-browser-interaction",
      "--refresh-account-capabilities",
      "--acknowledge-unofficial",
    ], env);
    expect(refresh.exitCode).toBe(1);
    expect(refresh.stderr).toContain("cannot refresh account capabilities");

    const bigger = await runCli([
      "setup",
      "--browser-only",
      "--zero-risk-browser-interaction",
      "--bigger-context",
      "--acknowledge-unofficial",
    ], env);
    expect(bigger.exitCode).toBe(1);
    expect(bigger.stderr).toContain("does not support Bigger Context");

    const browserOnly = await runCli([
      "setup",
      "--browser-only",
      "--zero-risk-browser-interaction",
      "--acknowledge-unofficial",
    ], env);
    expect(browserOnly.exitCode).toBe(1);
    expect(browserOnly.stderr).toContain("requires --full");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("passkey capture cannot be invoked outside the live Launcher control channel", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-passkey-auth-"));
  try {
    const result = await runCli([
      "login",
      "--launcher-control",
      "--chrome",
      process.execPath,
      "--storage-state",
      join(root, "storage-state.json"),
    ], { ...process.env });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Launcher-controlled passkey login requires a live launcher authorization");
    expect(existsSync(join(root, "storage-state.json"))).toBe(false);
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
      version: 3,
      kind: "codex-web-gpt-launcher",
      profile: "development",
      pid: process.pid,
      endpoint: "http://127.0.0.1:48121",
      control: { endpoint: `http://127.0.0.1:${address.port}`, token: controlToken },
      helper: { executable: process.execPath, script: helperScript },
      partition: "persist:codex-web-gpt-dev-chatgpt",
      idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId: "d".repeat(32),
      surfaceTargets: { ["d".repeat(32)]: "native-owned-target" },
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


test("DEV setup can explicitly reuse persisted capabilities during managed-Chrome migration", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-reuse-capabilities-"));
  const devHome = join(root, "dev");
  const descriptorPath = join(devHome, "runtime", "launcher-browser.json");
  const helperScript = join(root, "helper.cjs");
  const controlToken = "dev-reuse-control-token-0123456789abcdefghijklmnop";
  let inspections = 0;
  const control = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    inspections += 1;
    expect(request.url).toBe("/v1/session/inspect");
    expect(request.headers.authorization).toBe(`Bearer ${controlToken}`);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ detectCapabilities: false });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authenticated: true,
      temporary: true,
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
      version: 3,
      kind: "codex-web-gpt-launcher",
      profile: "development",
      pid: process.pid,
      endpoint: "http://127.0.0.1:48141",
      control: { endpoint: `http://127.0.0.1:${address.port}`, token: controlToken },
      helper: { executable: process.execPath, script: helperScript },
      partition: "persist:codex-web-gpt-dev-chatgpt",
      idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId: "r".repeat(32),
      surfaceTargets: { ["r".repeat(32)]: "native-owned-target" },
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    mkdirSync(devHome, { recursive: true });
    writeFileSync(join(devHome, "config.json"), `${JSON.stringify({
      ...defaultConfig("browser-only"),
      purpose: "dev-harness",
      browserHost: "managed-chrome",
      browserInteractionMode: "automatic",
      solAvailable: true,
      proAvailable: false,
    }, null, 2)}\n`, { mode: 0o600 });
    const result = await runCli([
      "dev",
      "setup",
      "--browser-only",
      "--browser-host-descriptor",
      descriptorPath,
      "--reuse-stored-account-capabilities",
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: devHome,
      CODEX_CHATGPT_WEB_HOME: join(root, "production"),
      CODEX_HOME: join(root, "production-codex"),
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(inspections).toBe(1);
    expect(JSON.parse(readFileSync(join(devHome, "config.json"), "utf8"))).toMatchObject({
      purpose: "dev-harness",
      browserHost: "launcher",
      browserHostDescriptorPath: descriptorPath,
      solAvailable: true,
      proAvailable: false,
    });
    expect(existsSync(join(root, "production-codex", "config.toml"))).toBe(false);
  } finally {
    await new Promise<void>(resolveClose => control.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV stored-capability reuse rejects invalid preconditions without changing normal setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-reuse-invalid-"));
  const devHome = join(root, "dev");
  const descriptorPath = join(devHome, "runtime", "launcher-browser.json");
  const env = {
    ...process.env,
    CODEX_WEB_GPT_DEV_HOME: devHome,
    CODEX_CHATGPT_WEB_HOME: join(root, "production"),
    CODEX_HOME: join(root, "production-codex"),
  };
  const baseArgs = [
    "dev", "setup", "--browser-only", "--browser-host-descriptor", descriptorPath,
    "--reuse-stored-account-capabilities", "--acknowledge-unofficial",
  ];
  const writeConfig = (overrides: Record<string, unknown> = {}, omitCapabilities = false) => {
    mkdirSync(devHome, { recursive: true });
    const value = {
      ...defaultConfig("browser-only"),
      purpose: "dev-harness",
      browserHost: "managed-chrome",
      browserInteractionMode: "automatic",
      solAvailable: true,
      proAvailable: false,
      ...overrides,
    } as Record<string, unknown>;
    if (omitCapabilities) {
      delete value.solAvailable;
      delete value.proAvailable;
    }
    writeFileSync(join(devHome, "config.json"), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  };
  try {
    let result = await runCli(baseArgs, env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("require an existing DEV configuration");

    writeConfig({}, true);
    result = await runCli(baseArgs, env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("require explicitly persisted solAvailable and proAvailable values");

    writeConfig();
    result = await runCli([...baseArgs, "--refresh-account-capabilities"], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Choose either --reuse-stored-account-capabilities or --refresh-account-capabilities");

    writeConfig();
    result = await runCli([...baseArgs, "--zero-risk-browser-interaction"], env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("require automatic browser interaction");

    writeConfig({ browserHost: "launcher", browserHostDescriptorPath: descriptorPath });
    result = await runCli(baseArgs, env);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("only for managed-chrome to launcher migration");

    const production = await runCli([
      "setup", "--browser-only", "--reuse-stored-account-capabilities", "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "prod-codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "prod-app"),
    });
    expect(production.exitCode).toBe(1);
    expect(production.stderr).toMatch(/Unknown.*arguments: --reuse-stored-account-capabilities/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DEV setup accepts explicit browser-interaction flags and preserves manual fail-closed validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-dev-interaction-"));
  const devHome = join(root, "dev");
  const descriptorPath = join(devHome, "runtime", "launcher-browser.json");
  const helperScript = join(root, "helper.cjs");
  try {
    mkdirSync(join(devHome, "runtime"), { recursive: true });
    writeFileSync(helperScript, "module.exports = {};\n", { mode: 0o700 });
    writeFileSync(descriptorPath, `${JSON.stringify({
      version: 3,
      kind: "codex-web-gpt-launcher",
      profile: "development",
      pid: process.pid,
      endpoint: "http://127.0.0.1:48131",
      control: {
        endpoint: "http://127.0.0.1:48132",
        token: "dev-manual-control-token-0123456789abcdefghijklmnop",
      },
      helper: { executable: process.execPath, script: helperScript },
      partition: "persist:codex-web-gpt-dev-chatgpt",
      idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId: "m".repeat(32),
      surfaceTargets: { ["m".repeat(32)]: "native-owned-target" },
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    const env = {
      ...process.env,
      CODEX_WEB_GPT_DEV_HOME: devHome,
      CODEX_CHATGPT_WEB_HOME: join(root, "production"),
      CODEX_HOME: join(root, "production-codex"),
    };

    const manualBrowserOnly = await runCli([
      "dev",
      "setup",
      "--browser-only",
      "--browser-host-descriptor",
      descriptorPath,
      "--zero-risk-browser-interaction",
      "--acknowledge-unofficial",
    ], env);
    expect(manualBrowserOnly.exitCode).toBe(1);
    expect(manualBrowserOnly.stderr).toContain("requires --full");
    expect(manualBrowserOnly.stderr).not.toContain("Unknown DEV arguments");

    const conflicting = await runCli([
      "dev",
      "setup",
      "--browser-only",
      "--automatic-browser-interaction",
      "--zero-risk-browser-interaction",
    ], env);
    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.stderr).toContain("Choose at most one browser interaction mode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser check uses metadata-only launcher liveness in Zero Risk", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-manual-browser-check-"));
  const appHome = join(root, "app");
  const descriptorPath = join(appHome, "runtime", "launcher-browser.json");
  const helperScript = join(root, "helper.cjs");
  let requests = 0;
  const cdp = createServer((request, response) => {
    requests += 1;
    expect(request.url).toBe("/json/version");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      webSocketDebuggerUrl: "ws://127.0.0.1:48142/devtools/browser/manual-check",
    }));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    cdp.once("error", rejectListen);
    cdp.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = cdp.address();
    if (!address || typeof address === "string") throw new Error("CDP test server has no port");
    mkdirSync(join(appHome, "runtime"), { recursive: true });
    writeFileSync(helperScript, "module.exports = {};\n", { mode: 0o700 });
    writeFileSync(descriptorPath, `${JSON.stringify({
      version: 3,
      kind: "codex-web-gpt-launcher",
      profile: "production",
      pid: process.pid,
      endpoint: `http://127.0.0.1:${address.port}`,
      control: {
        endpoint: "http://127.0.0.1:48143",
        token: "manual-browser-check-token-0123456789abcdefghijklmnop",
      },
      helper: { executable: process.execPath, script: helperScript },
      partition: "persist:codex-web-gpt-chatgpt",
      idleUrl: LAUNCHER_BROWSER_IDLE_URL,
      surfaceId: "s".repeat(32),
      surfaceTargets: { ["s".repeat(32)]: "native-owned-target" },
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    const config = {
      ...defaultConfig("full"),
      appName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
      browserHost: "launcher",
      browserInteractionMode: "manual",
      browserHostDescriptorPath: descriptorPath,
      tunnel: {
        binaryPath: process.execPath,
        tunnelId: `tunnel_${"a".repeat(32)}`,
        runtimeKeyFile: join(root, "runtime.key"),
        profileDir: join(root, "tunnel-profile"),
        profileName: "manual-check",
        alias: "manual-check",
      },
    };
    writeFileSync(join(appHome, "config.json"), `${JSON.stringify(config)}\n`, { mode: 0o600 });

    const result = await runCli(["browser", "check"], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: appHome,
      CODEX_HOME: join(root, "codex"),
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("DOM inspection is intentionally disabled");
    expect(requests).toBe(1);
  } finally {
    await new Promise<void>(resolveClose => cdp.close(() => resolveClose()));
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
    version: 3,
    kind: "codex-web-gpt-launcher",
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:48111",
    control: { endpoint: "http://127.0.0.1:48112", token },
    helper: { executable: process.execPath, script: helperScript },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "a".repeat(32),
    surfaceTargets: { ["a".repeat(32)]: "native-owned-target" },
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
