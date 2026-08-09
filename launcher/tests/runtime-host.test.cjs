const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CURRENT_CONNECTOR_NAME } = require("../electron/connector-identity.cjs");
const {
  resolveBrowserLoginExecutable,
  RuntimeHost,
} = require("../electron/runtime.cjs");
const {
  resolveSystemDefaultBrowserExecutable,
  parseMacDefaultBrowserIdentifier,
  parseWindowsDefaultBrowserIdentifier,
} = require("../electron/system-default-browser.cjs");

test("system default browser resolution uses generic macOS application metadata", () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (command === "defaults" && args.at(-1) === "LSHandlers") {
      return "{ LSHandlerRoleAll = \"com.example.browser\"; LSHandlerURLScheme = http; }";
    }
    if (command === "mdfind" && args[0].includes("kMDItemCFBundleIdentifier")) return "";
    if (command === "mdfind") return "/Applications/Example Browser.app\n";
    if (command === "mdls") return "com.example.Browser\n";
    if (command === "defaults") return "Example Browser";
    throw new Error(`Unexpected command: ${command}`);
  };

  assert.equal(parseMacDefaultBrowserIdentifier(
    "{ LSHandlerRoleAll = \"com.example.browser\"; LSHandlerURLScheme = http; }",
  ), "com.example.browser");
  assert.equal(
    resolveSystemDefaultBrowserExecutable({ platform: "darwin", env: {}, run }),
    "/Applications/Example Browser.app/Contents/MacOS/Example Browser",
  );
  assert.equal(calls[1][0], "mdfind");
  assert.equal(calls[2][0], "mdfind");
});

test("system default browser resolution scans application bundles when Spotlight has no result", () => {
  const run = (command, args) => {
    if (command === "defaults" && args.at(-1) === "LSHandlers") {
      return "{ LSHandlerRoleAll = \"com.example.browser\"; LSHandlerURLScheme = http; }";
    }
    if (command === "mdfind") return "";
    if (command === "find") return "/Applications/Example Browser.app\n";
    if (command === "mdls") return "com.example.browser\n";
    if (command === "defaults") return "Example Browser";
    throw new Error(`Unexpected command: ${command}`);
  };

  assert.equal(
    resolveSystemDefaultBrowserExecutable({ platform: "darwin", env: {}, run }),
    "/Applications/Example Browser.app/Contents/MacOS/Example Browser",
  );
});

test("system default browser resolution uses the generic Windows association command", () => {
  const run = (command, args) => {
    if (command !== "reg.exe") throw new Error(`Unexpected command: ${command}`);
    if (args.includes("ProgId")) return "ProgId    REG_SZ    ExampleHTML\n";
    return '(Default)    REG_SZ    "C:\\Program Files\\Example\\browser.exe" -- "%1"\n';
  };

  assert.equal(parseWindowsDefaultBrowserIdentifier("ProgId    REG_SZ    ExampleHTML\n"), "ExampleHTML");
  assert.equal(
    resolveSystemDefaultBrowserExecutable({ platform: "win32", env: {}, run }),
    "C:\\Program Files\\Example\\browser.exe",
  );
});

test("system default browser resolution uses the generic Linux desktop entry", () => {
  const dataHome = "/home/test/.local/share";
  const executable = "/opt/example/bin/example-browser";
  const desktopFile = `${dataHome}/applications/example.desktop`;
  const run = (command) => command === "xdg-settings" ? "example.desktop\n" : "";
  const exists = (candidate) => candidate === desktopFile || candidate === executable;
  const read = (candidate) => {
    assert.equal(candidate, desktopFile);
    return "[Desktop Entry]\nType=Application\nExec=/opt/example/bin/example-browser -- %U\n";
  };

  assert.equal(
    resolveSystemDefaultBrowserExecutable({
      platform: "linux",
      env: { HOME: "/home/test", PATH: "/usr/bin" },
      run,
      exists,
      read,
    }),
    executable,
  );
});

test("browser login uses only the system default and never falls back", () => {
  const checked = [];
  assert.equal(resolveBrowserLoginExecutable({
    resolveDefaultBrowserExecutable: () => "/opt/default-browser",
    isUsable: (candidate) => {
      checked.push(candidate);
      return candidate === "/opt/default-browser";
    },
  }), "/opt/default-browser");
  assert.deepEqual(checked, ["/opt/default-browser"]);

  assert.throws(() => resolveBrowserLoginExecutable({
    resolveDefaultBrowserExecutable: () => "/opt/missing-browser",
    isUsable: () => false,
  }), /system default browser executable is unavailable: \/opt\/missing-browser/);
});

test("browser login reports default-browser resolution failures directly", () => {
  assert.throws(() => resolveBrowserLoginExecutable({
    resolveDefaultBrowserExecutable: () => { throw new Error("default association is unavailable"); },
  }), /Could not resolve the system default browser: default association is unavailable/);
  assert.equal(resolveBrowserLoginExecutable({
    resolveDefaultBrowserExecutable: () => "/opt/default-browser",
    isUsable: () => true,
  }), "/opt/default-browser");
});

function hostFor(existingConfig) {
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(os.tmpdir(), "codex-web-gpt-runtime-host-test"),
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => existingConfig,
      readSetupConfig: () => existingConfig,
    },
  });
  let invocation;
  host.runSetup = async (name, args) => {
    invocation = { name, args };
    return { code: 0, stdout: "", stderr: "" };
  };
  host.resolveBrowserLoginExecutable = () => "/usr/bin/chromium";
  return { host, invocation: () => invocation };
}

test("core setup preserves an existing full-harness installation", async () => {
  const fixture = hostFor({ mode: "full", appName: "Codex Native2" });
  const result = await fixture.host.setupCore();
  assert.equal(result.mode, "full");
  assert.deepEqual(fixture.invocation().args, [
    "setup",
    "--full",
    "--browser-host-descriptor",
    "/runtime/launcher-browser.json",
    "--refresh-account-capabilities",
    "--replace-codex-route",
    "--acknowledge-unofficial",
    "--restart-service",
    "--app-name",
    "Codex Native2",
  ]);
});

test("core setup replaces the known legacy connector identity with the direct-turn identity", async () => {
  const fixture = hostFor({ mode: "full", appName: "Codex Native" });
  await fixture.host.setupCore();
  assert.deepEqual(fixture.invocation().args.slice(-2), ["--app-name", "Codex Native2"]);
});

test("core setup starts in browser-only mode when no installation exists", async () => {
  const fixture = hostFor(null);
  const result = await fixture.host.setupCore();
  assert.equal(result.mode, "browser-only");
  assert.deepEqual(fixture.invocation().args.slice(0, 2), ["setup", "--browser-only"]);
  assert.equal(fixture.invocation().args.includes("--refresh-account-capabilities"), true);
  assert.equal(fixture.invocation().args.includes("--replace-codex-route"), true);
  assert.deepEqual(fixture.invocation().args.slice(-2), ["--chrome", "/usr/bin/chromium"]);
});

test("launcher login captures verified storage in a private transfer and returns explicit cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-browser-login-"));
  const descriptorPath = path.join(root, "launcher-browser.json");
  const staleTransfer = path.join(root, "browser-login", "transfer-stale123");
  fs.mkdirSync(staleTransfer, { recursive: true });
  fs.writeFileSync(path.join(staleTransfer, "storage-state.json"), "stale secret\n");
  const host = new RuntimeHost({
    app: { getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: descriptorPath,
    platform: "linux",
    supervisor: { readConfig: () => null, readSetupConfig: () => null },
  });
  host.resolveBrowserLoginExecutable = () => "/usr/bin/chromium";
  host.launcherControlEnvironment = () => ({ CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "private-token" });
  let invocation;
  host.run = async (name, args, options) => {
    invocation = { name, args, options };
    const statePath = args[args.indexOf("--storage-state") + 1];
    fs.writeFileSync(statePath, `${JSON.stringify({ cookies: [], origins: [] })}\n`, { mode: 0o600 });
    fs.writeFileSync(`${statePath}.verified.json`, `${JSON.stringify({
      version: 1,
      authenticated: true,
      verifiedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    return { code: 0, stdout: "", stderr: "" };
  };

  try {
    assert.equal(fs.existsSync(staleTransfer), false);
    const transfer = await host.captureSystemBrowserLogin();
    assert.equal(invocation.name, "browser-login");
    assert.deepEqual(invocation.args.slice(0, 5), [
      "login",
      "--launcher-control",
      "--chrome",
      "/usr/bin/chromium",
      "--storage-state",
    ]);
    assert.deepEqual(invocation.options.env, { CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "private-token" });
    assert.deepEqual(transfer.storageState, { cookies: [], origins: [] });
    const transferRoot = path.dirname(invocation.args.at(-1));
    assert.equal(fs.existsSync(transferRoot), true);
    await transfer.cleanup();
    assert.equal(fs.existsSync(transferRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher login refuses to proceed when stale private transfer state cannot be removed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-browser-login-cleanup-"));
  const host = new RuntimeHost({
    app: { getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    platform: "linux",
    supervisor: { readConfig: () => null, readSetupConfig: () => null },
  });
  let resolvedExecutable = false;
  host.cleanupBrowserLoginTransfers = () => { throw new Error("synthetic cleanup denial"); };
  host.resolveBrowserLoginExecutable = () => {
    resolvedExecutable = true;
    return "/usr/bin/chromium";
  };
  try {
    await assert.rejects(
      host.captureSystemBrowserLogin(),
      /Refusing to start system-browser login.*synthetic cleanup denial/,
    );
    assert.equal(resolvedExecutable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher update transaction upgrades its owned full runtime with saved configuration", async () => {
  const fixture = hostFor({
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native2",
    releaseVersion: "1.1.1",
  });
  fixture.host.bridgeStatus = async () => ({ installed: true, active: true, errors: [] });

  const result = await fixture.host.upgradeManagedRuntime();

  assert.deepEqual(fixture.invocation().args, [
    "setup",
    "--full",
    "--browser-host-descriptor",
    "/runtime/launcher-browser.json",
    "--acknowledge-unofficial",
    "--restart-service",
    "--app-name",
    "Codex Native2",
  ]);
  assert.deepEqual(result, {
    updated: true,
    mode: "full",
    bridgeEnabled: true,
    fromVersion: "1.1.1",
    toVersion: "1.1.3",
    connectorMigrated: false,
    stdout: "",
  });
});

test("launcher migrates the legacy connector identity even when the release version is unchanged", async () => {
  const fixture = hostFor({
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native",
    releaseVersion: "1.1.3",
  });
  fixture.host.bridgeStatus = async () => ({ installed: true, active: true, errors: [] });

  const result = await fixture.host.upgradeManagedRuntime();

  assert.deepEqual(fixture.invocation().args, [
    "setup",
    "--full",
    "--browser-host-descriptor",
    "/runtime/launcher-browser.json",
    "--acknowledge-unofficial",
    "--restart-service",
    "--app-name",
    "Codex Native2",
  ]);
  assert.equal(result.updated, true);
  assert.equal(result.connectorMigrated, true);
  assert.equal(result.fromVersion, result.toVersion);
});

test("launcher update transaction preserves a deliberately disconnected Codex route", async () => {
  const fixture = hostFor({
    mode: "browser-only",
    browserHost: "launcher",
    releaseVersion: "1.1.1",
  });
  let disabled = 0;
  fixture.host.bridgeStatus = async () => ({ installed: true, active: false, errors: [] });
  fixture.host.setBridgeEnabled = async (enabled) => {
    assert.equal(enabled, false);
    disabled += 1;
  };

  const result = await fixture.host.upgradeManagedRuntime();

  assert.equal(result.bridgeEnabled, false);
  assert.equal(disabled, 1);
});

test("launcher update transaction leaves current and externally owned runtimes unchanged", async () => {
  const current = hostFor({ mode: "browser-only", browserHost: "launcher", releaseVersion: "1.1.3" });
  const currentFull = hostFor({
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native2",
    releaseVersion: "1.1.3",
  });
  const external = hostFor({ mode: "browser-only", browserHost: "managed-chrome", releaseVersion: "1.1.1" });

  assert.deepEqual(await current.host.upgradeManagedRuntime(), { updated: false });
  assert.deepEqual(await currentFull.host.upgradeManagedRuntime(), { updated: false });
  assert.deepEqual(await external.host.upgradeManagedRuntime(), { updated: false });
  assert.equal(current.invocation(), undefined);
  assert.equal(currentFull.invocation(), undefined);
  assert.equal(external.invocation(), undefined);
});

test("MCP setup reuses valid private credentials without exposing or rewriting them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-saved-mcp-"));
  const keyPath = path.join(root, "tunnel-runtime.key");
  fs.writeFileSync(keyPath, "saved-private-runtime-key\n", { mode: 0o600 });
  const fixture = hostFor({
    mode: "full",
    appName: "Codex Native2",
    tunnel: {
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: keyPath,
    },
  });
  try {
    assert.equal(fixture.host.mcpCredentialsConfigured(), true);
    await fixture.host.setupMcp({ replace: false });
    assert.deepEqual(fixture.invocation().args, [
      "setup",
      "--full",
      "--browser-host-descriptor",
      "/runtime/launcher-browser.json",
      "--app-name",
      "Codex Native2",
      "--replace-codex-route",
      "--acknowledge-unofficial",
      "--restart-service",
    ]);
    assert.equal(fixture.invocation().args.includes("--refresh-account-capabilities"), false);
    assert.equal(fixture.invocation().args.includes("--replace-codex-route"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("new MCP setup uses the explicit default connector name", async () => {
  const fixture = hostFor(null);
  await fixture.host.setupMcp({
    replace: true,
    tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    runtimeKey: "new-private-runtime-key",
  });

  assert.deepEqual(fixture.invocation().args.slice(0, 6), [
    "setup",
    "--full",
    "--browser-host-descriptor",
    "/runtime/launcher-browser.json",
    "--app-name",
    "Codex Native2",
  ]);
});

test("MCP credential replacement remains explicit and requires a complete new pair", async () => {
  const fixture = hostFor(null);
  await assert.rejects(
    Promise.resolve().then(() => fixture.host.setupMcp({ replace: true })),
    /Tunnel ID must be/,
  );
  await assert.rejects(
    Promise.resolve().then(() => fixture.host.setupMcp({
      replace: true,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    })),
    /runtime key is required/,
  );
});

test("mutating launcher operations are serialized before lifecycle changes begin", async () => {
  const fixture = hostFor(null);
  fixture.host.lifecycleOperation = "mcp-setup";
  await assert.rejects(fixture.host.setupCore(), /Another launcher operation is active: mcp-setup/);
  assert.equal(fixture.invocation(), undefined);
});

function bridgeFixture({ active }) {
  const calls = [];
  const supervisor = {
    readConfig: () => ({ mode: "browser-only" }),
    readSetupConfig: () => ({ mode: "browser-only" }),
    startIfConfigured: async () => {
      calls.push("runtime:start");
      return { status: "ready" };
    },
    stopForSetup: async () => {
      calls.push("runtime:stop");
      return { status: "stopped" };
    },
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-bridge-test") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor,
  });
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active, errors: [] }) };
    }
    if (action === "route connect") return { stdout: JSON.stringify({ changed: true, active: true }) };
    if (action === "route disconnect") return { stdout: JSON.stringify({ changed: true, active: false }) };
    throw new Error(`Unexpected command: ${action}`);
  };
  return { calls, host, supervisor };
}

test("bridge connection starts a healthy runtime before routing Codex to it", async () => {
  const fixture = bridgeFixture({ active: false });
  const result = await fixture.host.setBridgeEnabled(true);
  assert.equal(result.active, true);
  assert.deepEqual(fixture.calls, ["route status", "runtime:start", "route connect"]);
});

test("bridge disconnection proves idleness and stops the runtime before restoring the prior route", async () => {
  const fixture = bridgeFixture({ active: true });
  const result = await fixture.host.setBridgeEnabled(false);
  assert.equal(result.active, false);
  assert.deepEqual(fixture.calls, ["route status", "runtime:stop", "route disconnect"]);
});

test("bridge connection rejects a route command that did not reach the requested state", async () => {
  const fixture = bridgeFixture({ active: false });
  fixture.host.run = async (_name, args) => {
    const action = args.join(" ");
    fixture.calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: false, errors: [] }) };
    }
    return { stdout: JSON.stringify({ changed: false, active: false }) };
  };
  await assert.rejects(fixture.host.setBridgeEnabled(true), /remained disconnected/);
  assert.deepEqual(fixture.calls, ["route status", "runtime:start", "route connect", "runtime:stop"]);
});

test("bridge disconnection restarts the existing runtime if restoring the prior route fails", async () => {
  const fixture = bridgeFixture({ active: true });
  fixture.host.run = async (_name, args) => {
    const action = args.join(" ");
    fixture.calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: true, errors: [] }) };
    }
    throw new Error("synthetic route restore failure");
  };
  await assert.rejects(fixture.host.setBridgeEnabled(false), /synthetic route restore failure/);
  assert.deepEqual(fixture.calls, ["route status", "runtime:stop", "route disconnect", "runtime:start"]);
});

test("startup recovery can restore the Codex route without requiring a healthy local runtime", async () => {
  const fixture = bridgeFixture({ active: true });
  const result = await fixture.host.restoreBridgeRoute("runtime-start-fail-safe");
  assert.equal(result.active, false);
  assert.deepEqual(fixture.calls, ["route status", "route disconnect"]);
});

test("failed runtime cleanup during removal still restores the previous Codex route", async () => {
  const calls = [];
  const config = { mode: "full", browserHost: "launcher", releaseVersion: "1.1.2" };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-uninstall-fail-safe") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => config,
      readSetupConfig: () => config,
      stopForSetup: async () => {
        calls.push("runtime:stop");
        throw new Error("Tunnel health probe timed out after 5000ms");
      },
    },
  });
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: true, errors: [] }) };
    }
    if (action === "route disconnect") {
      return { stdout: JSON.stringify({ changed: true, active: false }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };

  await assert.rejects(
    host.uninstallIntegration(),
    /previous Codex route was restored, but launcher runtime cleanup did not complete/,
  );
  assert.deepEqual(calls, ["runtime:stop", "route status", "route disconnect"]);
});

test("connector verification uses the current identity and rejects a legacy local runtime", () => {
  const full = hostFor({ mode: "full", appName: "Codex Native2" });
  assert.equal(full.host.mcpConnectorName(), "Codex Native2");
  assert.equal(full.host.browserConnectorName(), "Codex Native2");
  const defaultName = hostFor(null);
  assert.equal(defaultName.host.browserConnectorName(), CURRENT_CONNECTOR_NAME);
  const legacyFull = hostFor({ mode: "full", appName: "Codex Native" });
  assert.equal(legacyFull.host.browserConnectorName(), "Codex Native2");
  assert.throws(
    () => legacyFull.host.mcpConnectorName(),
    /still targets legacy ChatGPT connector.*create that connector as a new ChatGPT plugin/,
  );
  const invalidFull = hostFor({ mode: "full", appName: "   " });
  assert.throws(() => invalidFull.host.mcpConnectorName(), /Connector name is invalid/);
  assert.throws(() => invalidFull.host.browserConnectorName(), /Connector name is invalid/);
  const browserOnly = hostFor({ mode: "browser-only", appName: "Codex Native" });
  assert.equal(browserOnly.host.browserConnectorName(), "Codex Native2");
  assert.throws(() => browserOnly.host.mcpConnectorName(), /MCP runtime is not configured/);
});

test("launcher-controlled CLI operations use the live descriptor token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-control-"));
  const descriptorPath = path.join(root, "launcher-browser.json");
  fs.writeFileSync(descriptorPath, `${JSON.stringify({
    pid: process.pid,
    control: { token: "launcher-live-control-token-0123456789abcdefghijkl" },
  })}\n`);
  const host = new RuntimeHost({
    app: { getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: descriptorPath,
    supervisor: { readConfig: () => null },
  });
  try {
    assert.deepEqual(host.launcherControlEnvironment(), {
      CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "launcher-live-control-token-0123456789abcdefghijkl",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed first-time setup removes its route before restoring the unconfigured state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-first-setup-rollback-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  const journalPath = path.join(coreHome, "codex", "integration-journal.json");
  const configPath = path.join(root, "config.json");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const codexModelsCachePath = path.join(codexHome, "models_cache.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(codexConfigPath, "original codex config\n");
  fs.writeFileSync(codexModelsCachePath, "original codex models cache\n");
  let cleared = 0;
  let stops = 0;
  const calls = [];
  const supervisor = {
    coreHome,
    configPath,
    readConfig: () => fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null,
    readSetupConfig: () => fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : null,
    stopForSetup: async () => {
      stops += 1;
      return { status: "stopped" };
    },
    startIfConfigured: async () => ({ status: fs.existsSync(configPath) ? "ready" : "not-configured" }),
    clearState: () => { cleared += 1; },
  };
  const host = new RuntimeHost({
    app: { getPath: () => root },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(root, "launcher-browser.json"),
    codexHome,
    supervisor,
  });
  host.run = async (_name, args) => {
    calls.push(args);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify({ mode: "browser-only", browserHost: "launcher" })}\n`);
    fs.writeFileSync(journalPath, "partial integration journal\n");
    fs.writeFileSync(codexConfigPath, "partially changed codex config\n");
    fs.rmSync(codexModelsCachePath);
    throw new Error("synthetic setup failure");
  };
  try {
    await assert.rejects(
      host.runSetup("core-setup", ["setup", "--browser-only"], {}),
      /synthetic setup failure; incomplete first-time setup was rolled back/,
    );
    assert.deepEqual(calls.map((args) => args[0]), ["setup"]);
    assert.equal(fs.existsSync(configPath), false);
    assert.equal(fs.existsSync(journalPath), false);
    assert.equal(fs.readFileSync(codexConfigPath, "utf8"), "original codex config\n");
    assert.equal(fs.readFileSync(codexModelsCachePath, "utf8"), "original codex models cache\n");
    assert.equal(stops, 2);
    assert.equal(cleared, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher delegates an existing terminal-managed installation to the migration-aware CLI", async () => {
  let config = { mode: "full", browserHost: "managed-chrome", releaseVersion: "0.1.16" };
  let prepared = 0;
  let launcherStops = 0;
  const coreHome = path.join(os.tmpdir(), "codex-web-gpt-runtime-host-migration-core");
  const supervisor = {
    coreHome,
    configPath: path.join(coreHome, "config.json"),
    readSetupConfig: () => config,
    readConfig: () => {
      if (config.browserHost !== "launcher") throw new Error("not launcher-owned");
      return config;
    },
    prepareExternalMigration: () => { prepared += 1; },
    stopForSetup: async () => { launcherStops += 1; },
    startIfConfigured: async () => ({ status: "ready" }),
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-runtime-host-migration") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    codexHome: path.join(coreHome, "codex"),
    launchAgentsDir: path.join(coreHome, "LaunchAgents"),
    supervisor,
  });
  host.run = async () => {
    config = { mode: "full", browserHost: "launcher", releaseVersion: "0.2.0" };
    return { code: 0, stdout: "", stderr: "" };
  };

  await host.runSetup("core-setup", ["setup", "--full"], {});
  assert.equal(prepared, 1);
  assert.equal(launcherStops, 0);
});

test("failed terminal migration verifies the unchanged previous runtime instead of claiming recovery", async () => {
  const config = { mode: "browser-only", browserHost: "managed-chrome", releaseVersion: "0.1.16" };
  const calls = [];
  const coreHome = path.join(os.tmpdir(), "codex-web-gpt-runtime-host-migration-failure-core");
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-runtime-host-migration-failure") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    codexHome: path.join(coreHome, "codex"),
    launchAgentsDir: path.join(coreHome, "LaunchAgents"),
    supervisor: {
      coreHome,
      configPath: path.join(coreHome, "config.json"),
      readSetupConfig: () => config,
      readConfig: () => { throw new Error("not launcher-owned"); },
      prepareExternalMigration() {},
    },
  });
  host.run = async (_name, args) => {
    calls.push(args[0]);
    if (args[0] === "setup") throw new Error("synthetic migration failure");
    return { code: 0, stdout: '{"ok":true}', stderr: "" };
  };

  await assert.rejects(
    host.runSetup("core-setup", ["setup", "--browser-only"], {}),
    /synthetic migration failure$/,
  );
  assert.deepEqual(calls, ["setup", "doctor"]);
});

test("failed launcher update restores every mutable setup file before restarting the previous runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-setup-checkpoint-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  const configPath = path.join(coreHome, "config.json");
  const journalPath = path.join(coreHome, "codex", "integration-journal.json");
  const keyPath = path.join(coreHome, "secrets", "tunnel-runtime.key");
  const profileDir = path.join(coreHome, "tunnel", "profiles");
  const profilePath = path.join(profileDir, "custom.yaml");
  const codexConfigPath = path.join(codexHome, "config.toml");
  const codexModelsCachePath = path.join(codexHome, "models_cache.json");
  const oldConfig = {
    mode: "full",
    browserHost: "launcher",
    releaseVersion: "0.1.16",
    tunnel: {
      runtimeKeyFile: keyPath,
      profileDir,
      profileName: "custom",
    },
  };
  for (const file of [configPath, journalPath, keyPath, profilePath, codexConfigPath, codexModelsCachePath]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(configPath, `${JSON.stringify(oldConfig)}\n`, { mode: 0o600 });
  fs.writeFileSync(journalPath, "old journal\n", { mode: 0o600 });
  fs.writeFileSync(keyPath, "old key\n", { mode: 0o600 });
  fs.writeFileSync(profilePath, "old profile\n", { mode: 0o600 });
  fs.writeFileSync(codexConfigPath, "old codex config\n", { mode: 0o600 });
  fs.writeFileSync(codexModelsCachePath, "old codex models cache\n", { mode: 0o600 });

  let startAttempts = 0;
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
  const supervisor = {
    coreHome,
    configPath,
    readSetupConfig: readConfig,
    readConfig,
    stopForSetup: async () => ({ status: "stopped" }),
    startIfConfigured: async () => {
      startAttempts += 1;
      if (readConfig().releaseVersion !== oldConfig.releaseVersion) {
        throw new Error("synthetic updated runtime startup failure");
      }
      return { status: "ready" };
    },
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(root, "launcher") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(coreHome, "runtime", "launcher-browser.json"),
    codexHome,
    supervisor,
  });
  host.run = async () => {
    fs.writeFileSync(configPath, `${JSON.stringify({ ...oldConfig, releaseVersion: "0.2.0" })}\n`);
    fs.writeFileSync(journalPath, "new journal\n");
    fs.writeFileSync(keyPath, "new key\n");
    fs.writeFileSync(profilePath, "new profile\n");
    fs.writeFileSync(codexConfigPath, "new codex config\n");
    fs.rmSync(codexModelsCachePath);
    return { code: 0, stdout: "", stderr: "" };
  };

  try {
    await assert.rejects(
      host.runSetup("core-setup", ["setup", "--full"], {}),
      /synthetic updated runtime startup failure$/,
    );
    assert.equal(startAttempts, 2);
    assert.deepEqual(readConfig(), oldConfig);
    assert.equal(fs.readFileSync(journalPath, "utf8"), "old journal\n");
    assert.equal(fs.readFileSync(keyPath, "utf8"), "old key\n");
    assert.equal(fs.readFileSync(profilePath, "utf8"), "old profile\n");
    assert.equal(fs.readFileSync(codexConfigPath, "utf8"), "old codex config\n");
    assert.equal(fs.readFileSync(codexModelsCachePath, "utf8"), "old codex models cache\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed terminal migration restores removed launchd ownership before verifying the old runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-terminal-checkpoint-"));
  const coreHome = path.join(root, "core");
  const codexHome = path.join(root, "codex");
  const launchAgentsDir = path.join(root, "LaunchAgents");
  const configPath = path.join(coreHome, "config.json");
  const daemonPlist = path.join(launchAgentsDir, "io.github.codex-chatgpt-web.daemon.plist");
  const tunnelPlist = path.join(launchAgentsDir, "io.github.codex-chatgpt-web.tunnel.plist");
  const oldConfig = {
    mode: "full",
    browserHost: "managed-chrome",
    releaseVersion: "0.1.16",
  };
  for (const file of [configPath, daemonPlist, tunnelPlist]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(configPath, `${JSON.stringify(oldConfig)}\n`, { mode: 0o600 });
  fs.writeFileSync(daemonPlist, "old daemon plist\n", { mode: 0o600 });
  fs.writeFileSync(tunnelPlist, "old tunnel plist\n", { mode: 0o600 });

  let startAttempts = 0;
  const calls = [];
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
  const supervisor = {
    coreHome,
    configPath,
    readSetupConfig: readConfig,
    readConfig: () => {
      const config = readConfig();
      if (config.browserHost !== "launcher") throw new Error("not launcher-owned");
      return config;
    },
    prepareExternalMigration() {},
    startIfConfigured: async () => {
      startAttempts += 1;
      throw new Error("synthetic launcher startup failure");
    },
  };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(root, "launcher") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: path.join(coreHome, "runtime", "launcher-browser.json"),
    codexHome,
    launchAgentsDir,
    platform: "darwin",
    supervisor,
  });
  host.run = async (_name, args) => {
    calls.push(args.join(" "));
    if (args[0] === "setup") {
      fs.writeFileSync(configPath, `${JSON.stringify({ ...oldConfig, browserHost: "launcher", releaseVersion: "0.2.0" })}\n`);
      fs.rmSync(daemonPlist);
      fs.rmSync(tunnelPlist);
    }
    return { code: 0, stdout: args[0] === "doctor" ? '{"ok":true}' : "", stderr: "" };
  };

  try {
    await assert.rejects(
      host.runSetup("core-setup", ["setup", "--full"], {}),
      /synthetic launcher startup failure$/,
    );
    assert.equal(startAttempts, 1);
    assert.deepEqual(readConfig(), oldConfig);
    assert.equal(fs.readFileSync(daemonPlist, "utf8"), "old daemon plist\n");
    assert.equal(fs.readFileSync(tunnelPlist, "utf8"), "old tunnel plist\n");
    assert.deepEqual(calls, [
      "setup --full",
      "service install",
      "tunnel start",
      "doctor --json",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
