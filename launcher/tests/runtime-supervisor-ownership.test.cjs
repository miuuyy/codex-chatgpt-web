const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { packagedRuntimePaths } = require("../electron/runtime-command.cjs");
const { linuxDesktopEntry, requireAutostartState } = require("../electron/autostart.cjs");
const {
  MAX_RESTARTS_PER_WINDOW,
  RuntimeSupervisor,
  managedTunnelConnectArgs,
  validateConfig,
} = require("../electron/runtime-supervisor.cjs");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function localHealthServer(statusForPath = () => 200) {
  const server = http.createServer((request, response) => {
    response.writeHead(statusForPath(request.url || "/"));
    response.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function launcherConfig(descriptorPath, overrides = {}) {
  const root = path.dirname(descriptorPath);
  return {
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: path.join(root, "storage-state.json"),
    brokerSocketPath: process.platform === "win32"
      ? "\\\\.\\pipe\\codex-chatgpt-web-runtime-supervisor-test"
      : path.join(root, "turn-broker.sock"),
    headed: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    useEnhancedWebSessionMode: false,
    controlToken: "runtime-supervisor-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
    ...overrides,
  };
}

test("launcher preserves stale ownership evidence when an old active runtime cannot be drained", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-active-stale-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const statePath = path.join(root, "runtime", "launcher-supervisor.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(launcherConfig(descriptorPath, {
    releaseVersion: "0.1.16",
    controlToken: "active-stale-control-token-0123456789abcdef",
  }))}\n`);
  const staleState = {
    version: 1,
    ownerPid: 999_999_999,
    daemonPid: process.pid,
    tunnelPid: null,
    status: "ready",
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, `${JSON.stringify(staleState)}\n`);
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
  });
  supervisor.proxyHealth = async () => true;
  supervisor.stopStaleOwnedRuntime = async () => {
    throw new Error("daemon has 0 active HTTP turn(s) and 1 active browser turn(s)");
  };

  try {
    const result = await supervisor.startConfigured();
    assert.equal(result.status, "external");
    assert.match(result.detail, /1 active browser turn/);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), staleState);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher recovers a stale tunnel even when no stale Responses proxy is reachable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-stale-tunnel-only-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(launcherConfig(descriptorPath, {
    mode: "full",
    controlToken: "stale-tunnel-control-token-0123456789abcdef",
    tunnel: {
      binaryPath: path.join(root, "tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: path.join(root, "runtime.key"),
      profileDir: path.join(root, "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  }))}\n`);
  fs.writeFileSync(path.join(root, "runtime", "launcher-supervisor.json"), `${JSON.stringify({
    version: 1,
    ownerPid: 999_999_999,
    daemonPid: null,
    tunnelPid: process.pid,
    status: "degraded",
    updatedAt: new Date().toISOString(),
  })}\n`);
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
  });
  let recovered = 0;
  supervisor.proxyHealth = async () => false;
  supervisor.stopStaleOwnedRuntime = async () => {
    recovered += 1;
    return true;
  };
  supervisor.startTunnel = async () => {
    supervisor.tunnel = { pid: 123_456_780 };
  };
  supervisor.startDaemon = async () => {
    supervisor.daemon = { pid: 123_456_781 };
  };
  try {
    const result = await supervisor.startConfigured();
    assert.equal(result.status, "ready");
    assert.equal(recovered, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale ownership recovery stops a managed tmux runtime even though it has no PID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-stale-tmux-tunnel-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, `${JSON.stringify({
    version: 1,
    ownerPid: 999_999_999,
    daemonPid: null,
    tunnelPid: null,
    status: "ready",
    updatedAt: new Date().toISOString(),
  })}\n`);
  supervisor.proxyHealthPayload = async () => null;
  supervisor.waitForKnownTunnelStatus = async () => ({
    ready: true,
    pid: null,
    state: "ready",
    processRunning: true,
    healthy: true,
    absent: false,
    statusKnown: true,
    detail: "state=ready; process_running=true; healthy=true; ready=true; pid=missing",
  });
  let stops = 0;
  supervisor.runTunnelStopCommand = async () => {
    stops += 1;
    return { code: 0, output: "{}" };
  };
  supervisor.waitForTunnelStopped = async () => ({
    ready: false,
    pid: null,
    state: "stopped",
    processRunning: false,
    absent: false,
    statusKnown: true,
    detail: "state=stopped; process_running=false",
  });
  try {
    assert.equal(await supervisor.stopStaleOwnedRuntime({
      mode: "full",
      tunnel: { alias: "codex-chatgpt-web" },
    }), true);
    assert.equal(stops, 1);
    assert.equal(fs.existsSync(supervisor.statePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher fails closed on a corrupt runtime ownership marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-corrupt-runtime-state-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, "{\"version\":1}\n");
  try {
    assert.throws(() => supervisor.readState(), /ownership state is invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher clears an empty stale ownership marker when Windows reuses its PID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-reused-owner-pid-"));
  const pidOccupant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, `${JSON.stringify({
    version: 1,
    ownerPid: pidOccupant.pid,
    daemonPid: null,
    tunnelPid: null,
    status: "failed",
    updatedAt: new Date().toISOString(),
  })}\n`);
  try {
    assert.deepEqual(await supervisor.startConfigured(), { status: "not-configured" });
    assert.equal(fs.existsSync(supervisor.statePath), false);
  } finally {
    pidOccupant.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale recovery preserves an active-state marker owned by another live launcher", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-live-owner-recovery-"));
  const liveOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const state = {
    version: 1,
    ownerPid: liveOwner.pid,
    daemonPid: null,
    tunnelPid: null,
    status: "degraded",
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, `${JSON.stringify(state)}\n`);
  supervisor.proxyHealthPayload = async () => null;
  try {
    await assert.rejects(
      supervisor.stopStaleOwnedRuntime({ mode: "browser-only" }),
      /Another launcher process still owns the runtime/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(supervisor.statePath, "utf8")), state);
  } finally {
    liveOwner.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("missing config does not erase an active-state marker owned by another live launcher", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-live-owner-no-config-"));
  const liveOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const state = {
    version: 1,
    ownerPid: liveOwner.pid,
    daemonPid: null,
    tunnelPid: null,
    status: "starting",
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, `${JSON.stringify(state)}\n`);
  try {
    const result = await supervisor.startConfigured();
    assert.equal(result.status, "external");
    assert.match(result.detail, /ownership processes are still alive/);
    assert.deepEqual(JSON.parse(fs.readFileSync(supervisor.statePath, "utf8")), state);
  } finally {
    liveOwner.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ownership persistence failure stops every still-live launcher child", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-state-write-fail-closed-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const invocation = () => ({
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: root,
  });
  const daemon = supervisor.spawnChild("daemon", invocation());
  const tunnel = supervisor.spawnChild("tunnel", invocation());
  const exited = child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    child.once("exit", () => resolve(true));
    // Windows taskkill may complete before Node delivers both child exit events. Keep this bounded,
    // but allow the same five-second process-event budget used by launcher cleanup tests.
    setTimeout(() => resolve(false), 5_000);
  });
  const daemonExited = exited(daemon);
  const tunnelExited = exited(tunnel);
  supervisor.writeState = () => { throw new Error("disk unavailable"); };
  try {
    assert.equal(supervisor.tryWriteState("degraded", "daemon exited"), false);
    assert.equal(await daemonExited, true);
    assert.equal(await tunnelExited, true);
    assert.equal(supervisor.stopping, true);
  } finally {
    await supervisor.stopChild("daemon").catch(() => {});
    await supervisor.stopChild("tunnel").catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
