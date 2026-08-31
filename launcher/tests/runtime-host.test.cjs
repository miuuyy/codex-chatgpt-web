const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CURRENT_CONNECTOR_NAME, DEV_CONNECTOR_NAME } = require("../electron/connector-identity.cjs");
const { RuntimeHost } = require("../electron/runtime.cjs");

function hostFor(existingConfig, userData = path.join(os.tmpdir(), "codex-web-gpt-runtime-host-test"), coreHome) {
  const host = new RuntimeHost({
    app: {
      getPath: () => userData,
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    ...(coreHome ? { coreHome } : {}),
    supervisor: {
      readConfig: () => existingConfig,
      readSetupConfig: () => existingConfig,
      stopForSetup: async () => ({ status: "stopped" }),
      startIfConfigured: async () => ({ status: "ready" }),
    },
  });
  let invocation;
  host.runSetup = async (name, args) => {
    invocation = { name, args };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { host, invocation: () => invocation };
}

test("Cloudflare connector details expose DCR registration and the private authorization passphrase", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-oauth-ui-test-"));
  const coreHome = path.join(root, "core");
  fs.mkdirSync(path.join(coreHome, "oauth"), { recursive: true });
  fs.writeFileSync(path.join(coreHome, "oauth", "passphrase.txt"), "private-passphrase\n", { mode: 0o600 });
  const config = {
    mode: "full",
    tunnel: {
      kind: "cloudflare",
      binaryPath: "/bin/cloudflared",
      configPath: "/config.yml",
      hostname: "mcp.example.com",
      mcpPath: `/mcp/${"a".repeat(43)}`,
    },
  };
  try {
    const settings = hostFor(config, path.join(root, "launcher"), coreHome).host.cloudflareSettings();
    assert.equal(settings.publicUrl, `https://mcp.example.com${config.tunnel.mcpPath}`);
    assert.equal(settings.registrationUrl, `${settings.publicUrl}/oauth/register`);
    assert.equal(settings.authorizationPassphrase, "private-passphrase");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function devHostFor(existingConfig) {
  const host = new RuntimeHost({
    app: {
      getPath: () => path.join(os.tmpdir(), "codex-web-gpt-dev-runtime-host-test"),
      getVersion: () => "1.1.3",
    },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/dev/runtime/launcher-browser.json",
    coreHome: "/dev",
    launcherProfile: "development",
    supervisor: {
      readConfig: () => existingConfig,
      readSetupConfig: () => existingConfig,
      stopForSetup: async () => ({ status: "stopped" }),
      startIfConfigured: async () => ({ status: "ready" }),
    },
  });
  let invocation;
  host.runDevSetup = async (name, args) => {
    invocation = { name, args };
    return { code: 0, stdout: "", stderr: "" };
  };
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
  assert.equal(fixture.invocation().args.includes("--chrome"), false);
});

test("DEV core setup configures only the isolated harness contract", async () => {
  const fixture = devHostFor(null);
  const result = await fixture.host.setupDevCore();
  assert.equal(result.mode, "browser-only");
  assert.deepEqual(fixture.invocation(), {
    name: "dev-profile-setup",
    args: [
      "dev",
      "setup",
      "--browser-only",
      "--browser-host-descriptor",
      "/dev/runtime/launcher-browser.json",
      "--refresh-account-capabilities",
      "--acknowledge-unofficial",
    ],
  });
  assert.equal(fixture.invocation().args.includes("--replace-codex-route"), false);
  assert.equal(fixture.invocation().args.includes("--restart-service"), false);
});

test("Bigger Context uses the setup transaction and refreshes the production Codex catalog", async () => {
  const fixture = hostFor({ mode: "full", appName: "Codex Native2" });
  const result = await fixture.host.setBiggerContext(true);
  assert.equal(result.enabled, true);
  assert.deepEqual(fixture.invocation(), {
    name: "bigger-context",
    args: [
      "setup",
      "--full",
      "--browser-host-descriptor",
      "/runtime/launcher-browser.json",
      "--replace-codex-route",
      "--acknowledge-unofficial",
      "--restart-service",
      "--bigger-context",
      "--app-name",
      "Codex Native2",
    ],
  });
});

test("Bigger Context updates the isolated DEV config without installing a Codex route", async () => {
  const fixture = devHostFor({ mode: "browser-only" });
  const result = await fixture.host.setBiggerContext(false);
  assert.equal(result.enabled, false);
  assert.deepEqual(fixture.invocation(), {
    name: "bigger-context",
    args: [
      "dev",
      "setup",
      "--browser-only",
      "--browser-host-descriptor",
      "/dev/runtime/launcher-browser.json",
      "--acknowledge-unofficial",
      "--standard-context",
    ],
  });
});

test("DEV setup child environment removes launcher-rebound production aliases", async () => {
  const fixture = devHostFor(null);
  assert.deepEqual(fixture.host.devSetupEnvironment({
    KEEP_ME: "yes",
    CODEX_CHATGPT_WEB_HOME: "/dev",
    CODEX_HOME: "/dev/codex-home",
    CODEX_WEB_GPT_DEV_HOME: "/stale-dev",
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: "/dev/launcher",
  }), {
    KEEP_ME: "yes",
    CODEX_WEB_GPT_DEV_HOME: path.resolve("/dev"),
  });

  let runOptions;
  fixture.host.captureSetupCheckpoint = () => [];
  fixture.host.devSetupEnvironment = () => ({ ISOLATED_DEV_ENV: "yes" });
  fixture.host.run = async (_name, _args, options) => {
    runOptions = options;
    return { code: 0, stdout: "", stderr: "" };
  };

  await RuntimeHost.prototype.runDevSetup.call(fixture.host, "dev-environment-test", [], {});
  assert.equal(runOptions.embedded, true);
  assert.deepEqual(runOptions.environment, { ISOLATED_DEV_ENV: "yes" });
});

test("DEV MCP setup reuses only DEV-home credentials and targets its distinct connector", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-dev-mcp-host-"));
  const runtimeKeyFile = path.join(root, "runtime.key");
  fs.writeFileSync(runtimeKeyFile, "private key\n", { mode: 0o600 });
  const fixture = devHostFor({
    purpose: "dev-harness",
    mode: "full",
    browserHost: "launcher",
    appName: "Codex Native2",
    tunnel: {
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile,
    },
  });
  try {
    await fixture.host.setupDevMcp();
    assert.deepEqual(fixture.invocation(), {
      name: "dev-mcp-setup",
      args: [
        "dev",
        "setup",
        "--full",
        "--browser-host-descriptor",
        "/dev/runtime/launcher-browser.json",
        "--app-name",
        "Codex Native2 DEV",
        "--acknowledge-unofficial",
      ],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("DEV doctor requires live tunnel readiness without probing a Responses listener", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-dev-doctor-"));
  const runtimeKeyFile = path.join(root, "runtime.key");
  fs.writeFileSync(runtimeKeyFile, "private key\n", { mode: 0o600 });
  const fixture = devHostFor({
    purpose: "dev-harness",
    mode: "full",
    appName: "Codex Native2 DEV",
    tunnel: { runtimeKeyFile },
  });
  fixture.host.supervisor.readTunnelHealth = async () => ({
    ready: true,
    detail: "ready",
  });
  try {
    const report = await fixture.host.devDoctor();
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks.map(check => [check.id, check.status]), [
      ["dev-profile", "ok"],
      ["dev-tunnel-credentials", "ok"],
      ["dev-tunnel-runtime", "ok"],
      ["responses-listener", "ok"],
    ]);
    assert.match(report.checks.at(-1).message, /never starts a Responses listener/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production doctor parses its structured unhealthy report from exit status one", async () => {
  const fixture = hostFor(null);
  let runOptions;
  fixture.host.run = async (_name, _args, options) => {
    runOptions = options;
    return {
      code: 1,
      stdout: JSON.stringify({
        ok: false,
        mode: "full",
        checks: [{ id: "browser-host", status: "error", message: "busy" }],
      }),
      stderr: "",
    };
  };

  const report = await fixture.host.doctor();

  assert.equal(report.ok, false);
  assert.equal(report.checks[0].message, "busy");
  assert.deepEqual(runOptions.acceptedExitCodes, [0, 1]);
});

test("production and DEV setup entrypoints reject the opposite launcher profile", async () => {
  await assert.rejects(hostFor(null).host.setupDevCore(), /isolated DEV launcher/);
  await assert.rejects(devHostFor(null).host.setupCore(), /unavailable in the isolated DEV launcher profile/);
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

test("launcher update transaction does not preserve a stale disconnected route preference", async () => {
  const fixture = hostFor({
    mode: "browser-only",
    browserHost: "launcher",
    releaseVersion: "1.1.1",
  });

  const result = await fixture.host.upgradeManagedRuntime();

  assert.equal(result.updated, true);
  assert.equal("bridgeEnabled" in result, false);
  assert.equal(fixture.invocation().args.includes("disconnect"), false);
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
      "--tunnel-kind",
      "openai",
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

test("MCP setup reuses saved OpenAI credentials while Cloudflare is active", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-provider-slots-"));
  const keyPath = path.join(root, "tunnel-runtime.key");
  const cloudflaredPath = path.join(root, "cloudflared");
  const cloudflareConfigPath = path.join(root, "config.yml");
  fs.writeFileSync(keyPath, "saved-private-runtime-key\n", { mode: 0o600 });
  fs.writeFileSync(cloudflaredPath, "binary");
  fs.writeFileSync(cloudflareConfigPath, "tunnel: test\ningress: []\n");
  const fixture = hostFor({
    mode: "full",
    appName: "Codex Native2",
    tunnel: {
      kind: "cloudflare",
      binaryPath: cloudflaredPath,
      configPath: cloudflareConfigPath,
      hostname: "mcp.example.com",
      mcpPath: `/mcp/${"a".repeat(43)}`,
    },
    inactiveTunnel: {
      kind: "openai",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: keyPath,
    },
  });
  try {
    assert.equal(fixture.host.activeTunnelKind(), "cloudflare");
    assert.equal(fixture.host.mcpCredentialsConfigured("openai"), true);
    assert.equal(fixture.host.mcpCredentialsConfigured("cloudflare"), true);
    await fixture.host.setupMcp({ tunnelKind: "openai", replace: false });
    assert.deepEqual(fixture.invocation().args.slice(6, 10), [
      "--tunnel-kind",
      "openai",
      "--replace-codex-route",
      "--acknowledge-unofficial",
    ]);
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

test("MCP setup accepts a custom connector name", async () => {
  const fixture = hostFor(null);
  await fixture.host.setupMcp({
    appName: "XR Local Codex",
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
    "XR Local Codex",
  ]);
});

test("MCP setup passes a selected Cloudflare named tunnel without OpenAI credentials", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-cloudflare-setup-"));
  const binaryPath = path.join(root, "cloudflared");
  const configPath = path.join(root, "config.yml");
  fs.writeFileSync(binaryPath, "binary");
  fs.writeFileSync(configPath, "tunnel: test\ningress: []\n");
  const userData = path.join(root, "launcher-data");
  const fixture = hostFor(null, userData);
  try {
    await fixture.host.setupMcp({
      appName: "XR Local Codex",
      tunnelKind: "cloudflare",
      cloudflaredBinaryPath: binaryPath,
      cloudflareConfigPath: configPath,
      cloudflareHostname: "mcp.example.com",
    });
    const mcpPathFile = path.join(userData, "secrets", "cloudflare-mcp-path");
    assert.deepEqual(fixture.invocation().args.slice(0, 18), [
      "setup",
      "--full",
      "--browser-host-descriptor",
      "/runtime/launcher-browser.json",
      "--app-name",
      "XR Local Codex",
      "--tunnel-kind",
      "cloudflare",
      "--cloudflared-binary",
      binaryPath,
      "--cloudflare-config",
      configPath,
      "--cloudflare-hostname",
      "mcp.example.com",
      "--cloudflare-mcp-path-file",
      mcpPathFile,
      "--replace-codex-route",
      "--acknowledge-unofficial",
    ]);
    const firstPath = fs.readFileSync(mcpPathFile, "utf8").trim();
    assert.match(firstPath, /^\/mcp\/[A-Za-z0-9_-]{40,}$/);

    await fixture.host.setupMcp({
      appName: "XR Local Codex",
      tunnelKind: "cloudflare",
      cloudflaredBinaryPath: binaryPath,
      cloudflareConfigPath: configPath,
      cloudflareHostname: "mcp.example.com",
    });
    assert.equal(fs.readFileSync(mcpPathFile, "utf8").trim(), firstPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
  let routeActive = active;
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
      return { stdout: JSON.stringify({ installed: true, active: routeActive, errors: [] }) };
    }
    if (action === "route connect") {
      routeActive = true;
      return { stdout: JSON.stringify({ changed: true, active: true }) };
    }
    if (action === "route disconnect") {
      routeActive = false;
      return { stdout: JSON.stringify({ changed: true, active: false }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };
  return { calls, host, supervisor };
}

test("launcher connects an inactive installed route", async () => {
  const fixture = bridgeFixture({ active: false });
  const result = await fixture.host.connectBridgeRoute();
  assert.equal(result.active, true);
  assert.deepEqual(fixture.calls, ["route status", "route connect", "route status"]);
});

test("launcher leaves an already connected route unchanged", async () => {
  const fixture = bridgeFixture({ active: true });
  const result = await fixture.host.connectBridgeRoute();
  assert.equal(result.active, true);
  assert.deepEqual(fixture.calls, ["route status"]);
});

test("machine-readable route output is recorded as one structured activity event", async () => {
  const records = [];
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-structured-output") },
    logger: {
      info(event, detail) { records.push({ event, detail }); },
      warn() {},
      error() {},
    },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {},
  });
  host.command = () => ({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({ installed: true, active: true, errors: [] }, null, 2))"],
    cwd: process.cwd(),
  });

  await host.run("bridge-connect", [], { stdoutLog: "json" });

  const output = records.filter(record => record.event === "runtime.operation_result");
  assert.deepEqual(output, [{
    event: "runtime.operation_result",
    detail: {
      operation: "bridge-connect",
      output: { installed: true, active: true, errors: [] },
    },
  }]);
  assert.equal(records.some(record => record.event === "runtime.stdout"), false);
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
  await assert.rejects(fixture.host.connectBridgeRoute(), /remained disconnected/);
  assert.deepEqual(fixture.calls, ["route status", "route connect", "runtime:stop"]);
});

test("startup recovery can restore the Codex route without requiring a healthy local runtime", async () => {
  const fixture = bridgeFixture({ active: true });
  const result = await fixture.host.restoreBridgeRoute("runtime-start-fail-safe");
  assert.equal(result.active, false);
  assert.deepEqual(fixture.calls, ["route status", "route disconnect", "route status"]);
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
  let routeActive = true;
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: routeActive, errors: [] }) };
    }
    if (action === "route disconnect") {
      routeActive = false;
      return { stdout: JSON.stringify({ changed: true, active: false }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };

  await assert.rejects(
    host.uninstallIntegration(),
    /previous Codex route was restored, but launcher runtime cleanup did not complete/,
  );
  assert.deepEqual(calls, ["runtime:stop", "route status", "route disconnect", "route status"]);
});

test("integration removal is accepted only after a new status process observes it absent", async () => {
  const calls = [];
  const config = { mode: "browser-only", browserHost: "launcher", releaseVersion: "2.1.8" };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-uninstall-success") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => config,
      readSetupConfig: () => config,
      stopForSetup: async () => { calls.push("runtime:stop"); },
    },
  });
  host.launcherControlEnvironment = () => ({ CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "test-token" });
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "uninstall --yes --launcher-control") {
      return { stdout: "uninstalled\n" };
    }
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: false, active: false, errors: [] }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };

  await host.uninstallIntegration();
  assert.deepEqual(calls, [
    "runtime:stop",
    "uninstall --yes --launcher-control",
    "route status",
  ]);
});

test("integration removal rejects a command that leaves an inactive journal behind", async () => {
  const calls = [];
  const config = { mode: "browser-only", browserHost: "launcher", releaseVersion: "2.1.8" };
  const host = new RuntimeHost({
    app: { getPath: () => path.join(os.tmpdir(), "codex-web-gpt-uninstall-stale") },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/source",
    browserDescriptorPath: "/runtime/launcher-browser.json",
    supervisor: {
      readConfig: () => config,
      readSetupConfig: () => config,
      stopForSetup: async () => { calls.push("runtime:stop"); },
    },
  });
  host.launcherControlEnvironment = () => ({ CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "test-token" });
  host.run = async (_name, args) => {
    const action = args.join(" ");
    calls.push(action);
    if (action === "uninstall --yes --launcher-control") {
      return { stdout: "uninstalled\n" };
    }
    if (action === "route status") {
      return { stdout: JSON.stringify({ installed: true, active: false, errors: [] }) };
    }
    throw new Error(`Unexpected command: ${action}`);
  };

  await assert.rejects(
    host.uninstallIntegration(),
    /integration removal did not persist in the active config/,
  );
  assert.deepEqual(calls, [
    "runtime:stop",
    "uninstall --yes --launcher-control",
    "route status",
    "route status",
  ]);
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
  const dev = devHostFor({ mode: "full", appName: "Codex Native2" });
  assert.equal(dev.host.browserConnectorName(), DEV_CONNECTOR_NAME);
  assert.equal(dev.host.mcpConnectorName(), DEV_CONNECTOR_NAME);
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
  const recoveryJournalPath = path.join(coreHome, "codex", "integration-journal.recovery.json");
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
    fs.writeFileSync(recoveryJournalPath, "partial recovery journal\n");
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
    assert.equal(fs.existsSync(recoveryJournalPath), false);
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
  const recoveryJournalPath = path.join(coreHome, "codex", "integration-journal.recovery.json");
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
  for (const file of [configPath, journalPath, recoveryJournalPath, keyPath, profilePath, codexConfigPath, codexModelsCachePath]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(configPath, `${JSON.stringify(oldConfig)}\n`, { mode: 0o600 });
  fs.writeFileSync(journalPath, "old journal\n", { mode: 0o600 });
  fs.writeFileSync(recoveryJournalPath, "old recovery journal\n", { mode: 0o600 });
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
    fs.writeFileSync(recoveryJournalPath, "new recovery journal\n");
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
    assert.equal(fs.readFileSync(recoveryJournalPath, "utf8"), "old recovery journal\n");
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
