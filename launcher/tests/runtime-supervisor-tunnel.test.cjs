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
    controlToken: "runtime-supervisor-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
    ...overrides,
  };
}

test("steady tunnel monitoring uses the runtime local health endpoints without a control-plane status lookup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-local-tunnel-health-"));
  const health = await localHealthServer();
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.tunnel = { pid: process.pid, managed: true };
  supervisor.tunnelHealthBaseUrl = health.baseUrl;
  supervisor.readTunnelHealth = async () => {
    throw new Error("control-plane lookup must not run for a healthy local runtime");
  };
  try {
    const observation = await supervisor.observeTunnelForMonitor({ tunnel: {} });
    assert.equal(observation.ready, true);
    assert.equal(observation.statusKnown, true);
    assert.match(observation.detail, /healthz returned HTTP 200/);
    assert.match(observation.detail, /readyz returned HTTP 200/);
  } finally {
    await health.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable local probe plus a stalled native status is unknown, not proof that the tunnel died", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-unknown-tunnel-health-"));
  const port = await freePort();
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.tunnelHealthBaseUrl = `http://127.0.0.1:${port}`;
  supervisor.readTunnelHealth = async () => {
    throw new Error("Tunnel health probe timed out after 5000ms");
  };
  try {
    const observation = await supervisor.observeTunnelForMonitor({ tunnel: {} });
    assert.equal(observation.ready, false);
    assert.equal(observation.statusKnown, false);
    assert.match(observation.detail, /native status unavailable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("an explicit local readiness failure remains actionable tunnel evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-degraded-tunnel-health-"));
  const health = await localHealthServer(pathname => pathname === "/readyz" ? 503 : 200);
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.tunnelHealthBaseUrl = health.baseUrl;
  try {
    const observation = await supervisor.readLocalTunnelHealth();
    assert.equal(observation.ready, false);
    assert.equal(observation.statusKnown, true);
    assert.equal(observation.state, "degraded");
    assert.match(observation.detail, /readyz returned HTTP 503/);
  } finally {
    await health.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel readiness accepts the official tmux status without inventing a PID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-health-tmux-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.runTunnelCommand = async () => ({
    code: 0,
    output: JSON.stringify({
      entries: [{
        alias: "codex-chatgpt-web",
        runtime_state: "ready",
        classification: "active_runtime",
        live_runtime: { found: true, base_url: "http://127.0.0.1:12345" },
      }],
    }),
  });
  try {
    const health = await supervisor.readTunnelHealth({
      tunnel: { alias: "codex-chatgpt-web" },
    });
    assert.equal(health.ready, true);
    assert.equal(health.pid, null);
    await supervisor.waitForTunnel({ tunnel: { alias: "codex-chatgpt-web" } }, 1);
    assert.equal(supervisor.tunnel?.managed, true);
    assert.equal(supervisor.tunnel?.pid, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a clean machine reports the official unknown-alias status as an absent runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-absent-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.runTunnelCommand = async () => ({
    code: 0,
    output: JSON.stringify({ entries: [] }),
  });
  try {
    const health = await supervisor.readTunnelHealth({
      tunnel: { alias: "codex-chatgpt-web" },
    });
    assert.equal(health.ready, false);
    assert.equal(health.absent, true);
    assert.equal(health.statusKnown, true);
    assert.equal(health.pid, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed startup fails immediately when native status reports a stopped runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-stopped-start-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.readTunnelHealth = async () => ({
    ready: false,
    pid: null,
    state: "stopped",
    processRunning: false,
    healthy: false,
    absent: false,
    detail: "state=stopped; process_running=false",
  });
  try {
    await assert.rejects(
      supervisor.waitForTunnel({ tunnel: {} }, 120_000),
      /stopped during startup/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher adopts a healthy native managed tunnel without spawning a foreground wrapper", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-managed-tunnel-adopt-"));
  const binaryPath = path.join(root, "tunnel-client");
  const runtimeKeyFile = path.join(root, "runtime.key");
  const profileDir = path.join(root, "profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(binaryPath, "binary");
  fs.writeFileSync(runtimeKeyFile, "runtime-key");
  fs.writeFileSync(path.join(profileDir, "codex-chatgpt-web.yaml"), "profile");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  let connects = 0;
  let monitors = 0;
  supervisor.readTunnelHealth = async () => ({
    ready: true,
    pid: 123_456_778,
    statusKnown: true,
    detail: "ready",
  });
  supervisor.runTunnelConnectCommand = async () => {
    connects += 1;
    return { code: 0, output: "{}" };
  };
  supervisor.startTunnelMonitor = () => { monitors += 1; };
  try {
    await supervisor.startTunnel({
      mode: "full",
      tunnel: {
        binaryPath,
        runtimeKeyFile,
        profileDir,
        profileName: "codex-chatgpt-web",
      },
    });
    assert.equal(connects, 0);
    assert.equal(monitors, 1);
    assert.equal(supervisor.tunnel?.pid, 123_456_778);
    assert.equal(supervisor.tunnel?.managed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher stops an unhealthy managed runtime before reconnecting the alias", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-managed-tunnel-reconnect-"));
  const binaryPath = path.join(root, "tunnel-client");
  const runtimeKeyFile = path.join(root, "runtime.key");
  const profileDir = path.join(root, "profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(binaryPath, "binary");
  fs.writeFileSync(runtimeKeyFile, "runtime-key");
  fs.writeFileSync(path.join(profileDir, "codex-chatgpt-web.yaml"), "profile");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const events = [];
  let reads = 0;
  supervisor.readTunnelHealth = async () => {
    reads += 1;
    return reads === 1
      ? { ready: false, pid: 123_456_777, statusKnown: true, detail: "state=degraded" }
      : { ready: true, pid: 123_456_776, statusKnown: true, detail: "state=ready" };
  };
  supervisor.runTunnelStopCommand = async () => {
    events.push("stop");
    return { code: 0, output: "{}" };
  };
  supervisor.waitForTunnelStopped = async () => {
    events.push("stopped");
  };
  supervisor.runTunnelConnectCommand = async () => {
    events.push("connect");
    return { code: 0, output: "{}" };
  };
  supervisor.startTunnelMonitor = () => { events.push("monitor"); };
  try {
    await supervisor.startTunnel({
      mode: "full",
      tunnel: {
        binaryPath,
        runtimeKeyFile,
        profileDir,
        profileName: "codex-chatgpt-web",
      },
    });
    assert.deepEqual(events, [
      "stop",
      "stopped",
      "connect",
      "monitor",
    ]);
    assert.equal(supervisor.tunnel?.pid, 123_456_776);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed tunnel startup accepts an absent alias only after its recorded process has exited", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-dead-cleanup-"));
  const binaryPath = path.join(root, "tunnel-client");
  const runtimeKeyFile = path.join(root, "runtime.key");
  fs.writeFileSync(binaryPath, "binary");
  fs.writeFileSync(runtimeKeyFile, "runtime-key");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.waitForKnownTunnelStatus = async () => ({
    ready: false,
    pid: null,
    state: undefined,
    processRunning: undefined,
    healthy: undefined,
    absent: true,
    statusKnown: true,
    detail: "alias is not known",
  });
  supervisor.runTunnelStopCommand = async () => ({
    code: 1,
    stdout: "",
    stderr: "alias codex-chatgpt-web is not known",
    output: "alias codex-chatgpt-web is not known",
  });
  supervisor.runTunnelConnectCommand = async () => {
    supervisor.tunnel = {
      pid: 999_999_999,
      exitCode: null,
      signalCode: null,
      managed: true,
    };
    throw new Error("synthetic connect failure");
  };
  try {
    await assert.rejects(
      supervisor.startTunnel({
        mode: "full",
        runtimeCommand: [process.execPath],
        brokerSocketPath: path.join(root, "broker.sock"),
        tunnel: {
          binaryPath,
          runtimeKeyFile,
          profileDir: root,
          profileName: "codex-chatgpt-web",
          alias: "codex-chatgpt-web",
          tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        },
      }),
      (error) => {
        assert.match(error.message, /synthetic connect failure/);
        assert.doesNotMatch(error.message, /startup cleanup failed/);
        return true;
      },
    );
    assert.equal(supervisor.tunnel, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("graceful tunnel stop uses the native status contract instead of killing a recorded PID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-wrapper-stop-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const child = { pid: 123_456_781, exitCode: null, signalCode: null, managed: true };
  const confirmations = [];
  supervisor.tunnel = child;
  supervisor.runTunnelStopCommand = async () => ({ code: 0, output: "{}" });
  supervisor.waitForTunnelStopped = async (_config, timeoutMs) => {
    confirmations.push(timeoutMs);
  };
  try {
    await supervisor.stopTunnelGracefully({ tunnel: {} }, 10);
    assert.deepEqual(confirmations, [10]);
    assert.equal(supervisor.tunnel, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed native tunnel shutdown keeps the managed runtime monitored", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-stop-refused-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const child = { pid: 123_456_780, exitCode: null, signalCode: null };
  let monitorRestarts = 0;
  supervisor.tunnel = child;
  supervisor.runTunnelStopCommand = async () => ({ code: 9, output: "runtime refused stop" });
  supervisor.startTunnelMonitor = () => { monitorRestarts += 1; };
  try {
    await assert.rejects(
      supervisor.stopTunnelGracefully({ tunnel: {} }, 10),
      /runtime refused stop/,
    );
    assert.equal(supervisor.tunnel, child);
    assert.equal(monitorRestarts, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an accepted tunnel stop without terminal proof keeps the alias supervised", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-stop-unconfirmed-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const managed = { pid: null, exitCode: null, signalCode: null, managed: true };
  let monitorRestarts = 0;
  supervisor.tunnel = managed;
  supervisor.runTunnelStopCommand = async () => ({ code: 0, output: "{}" });
  supervisor.waitForTunnelStopped = async () => {
    throw new Error("native status remained ambiguous");
  };
  supervisor.startTunnelMonitor = () => { monitorRestarts += 1; };
  try {
    await assert.rejects(
      supervisor.stopTunnelGracefully({ tunnel: {} }, 10),
      /native status remained ambiguous/,
    );
    assert.equal(supervisor.tunnel, managed);
    assert.equal(monitorRestarts, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
