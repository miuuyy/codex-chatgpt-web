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

test("stopping a tunnel monitor invalidates results from its previous generation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-monitor-generation-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  try {
    const before = supervisor.tunnelMonitorGeneration;
    supervisor.stopTunnelMonitor();
    assert.equal(supervisor.tunnelMonitorGeneration, before + 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher shutdown reacquires a managed tunnel that was between monitor and recovery states", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-stop-reconcile-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const config = { mode: "full", tunnel: { alias: "codex-chatgpt-web" } };
  let stops = 0;
  let confirmations = 0;
  supervisor.readConfig = () => config;
  supervisor.readTunnelHealth = async () => ({
    ready: true,
    pid: 123_456_779,
    state: "ready",
    processRunning: true,
    healthy: true,
    absent: false,
    statusKnown: true,
    detail: "state=ready",
  });
  supervisor.runTunnelStopCommand = async () => {
    stops += 1;
    return { code: 0, output: "{}" };
  };
  supervisor.waitForTunnelStopped = async () => {
    confirmations += 1;
  };
  try {
    assert.deepEqual(await supervisor.stopForSetup(), { status: "stopped" });
    assert.equal(stops, 1);
    assert.equal(confirmations, 1);
    assert.equal(supervisor.tunnel, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("crash-loop diagnostics include the last redacted child failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-crash-loop-diagnostic-"));
  const operations = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
    publishOperation: operation => operations.push(operation),
  });
  supervisor.restartHistory.tunnel = Array.from(
    { length: MAX_RESTARTS_PER_WINDOW },
    () => Date.now(),
  );
  supervisor.lastChildFailure.tunnel = "tunnel exited (1): invalid profile for [tunnel-id]";
  try {
    supervisor.scheduleRecovery("tunnel");
    const failure = operations.at(-1);
    assert.equal(failure.status, "failed");
    assert.match(failure.message, /automatic restart is disabled/);
    assert.match(failure.message, /last failure: tunnel exited \(1\): invalid profile for \[tunnel-id\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher supervisor keeps admission open while a Codex turn is active", async () => {
  const actions = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.control = async (_config, action) => {
    actions.push(action);
    return {
      status: "busy",
      acquired: false,
      accepting_turns: true,
      active_http_turns: 1,
      active_browser_turns: 0,
    };
  };
  await assert.rejects(
    supervisor.acquireDrain({}, 0),
    /atomic idleness could not be proven.*1 active HTTP turn/,
  );
  assert.deepEqual(actions, ["drain-if-idle"]);
});

test("launcher compensates an uncertain atomic idle-drain delivery", async () => {
  const actions = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.control = async (_config, action) => {
    actions.push(action);
    if (action === "drain-if-idle") throw new Error("HTTP 404");
    return { status: "ok", accepting_turns: true, active_http_turns: 0, active_browser_turns: 0 };
  };

  await assert.rejects(
    supervisor.acquireDrain({}, 0),
    /atomic idleness could not be proven.*HTTP 404/,
  );
  assert.deepEqual(actions, ["drain-if-idle", "resume"]);
});

test("launcher supervisor atomically drains only after the in-flight HTTP turn finishes", async () => {
  const actions = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  let drainChecks = 0;
  supervisor.control = async (_config, action) => {
    actions.push(action);
    drainChecks += 1;
    return drainChecks === 1
      ? {
          status: "busy",
          acquired: false,
          accepting_turns: true,
          active_http_turns: 1,
          active_browser_turns: 0,
        }
      : {
          status: "ok",
          acquired: true,
          accepting_turns: false,
          active_http_turns: 0,
          active_browser_turns: 0,
        };
  };

  await supervisor.acquireDrain({}, 1_000);
  assert.deepEqual(actions, ["drain-if-idle", "drain-if-idle"]);
});

test("launcher supervisor accepts an existing idle drain acquired by the restart controller", async () => {
  const actions = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.control = async (_config, action) => {
    actions.push(action);
    return {
      status: "draining",
      acquired: false,
      accepting_turns: false,
      active_http_turns: 0,
      active_browser_turns: 0,
    };
  };

  await supervisor.acquireDrain({}, 0);
  assert.deepEqual(actions, ["drain-if-idle"]);
});

test("launcher resumes an owned drained daemon before reporting it ready", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  const child = { pid: 123_456_789, exitCode: null, signalCode: null };
  let accepting = false;
  const actions = [];
  supervisor.daemon = child;
  supervisor.proxyHealth = async (_config, _timeoutMs, expectedPid, requireAccepting) => (
    expectedPid === child.pid && (!requireAccepting || accepting)
  );
  supervisor.control = async (_config, action) => {
    actions.push(action);
    accepting = true;
    return { status: "ok", accepting_turns: true };
  };
  supervisor.waitForProxy = async () => {
    assert.equal(accepting, true);
  };

  await supervisor.startDaemon({});
  assert.deepEqual(actions, ["resume"]);
  assert.equal(supervisor.daemon, child);
});

test("launcher restarts the daemon when a failed stop already terminated the drained child", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  let portReleased = 0;
  let starts = 0;
  supervisor.daemon = null;
  supervisor.waitForPortRelease = async () => { portReleased += 1; };
  supervisor.startDaemon = async () => {
    starts += 1;
    supervisor.daemon = { pid: 123_456_782, exitCode: null, signalCode: null };
  };

  const result = await supervisor.restoreDrainedDaemon({});
  assert.deepEqual(result, { status: "restarted", pid: 123_456_782 });
  assert.equal(portReleased, 1);
  assert.equal(starts, 1);
});

test("launcher marks compensation ready only after both owned runtime processes pass health checks", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.daemon = { pid: 123_456_783, exitCode: null, signalCode: null };
  supervisor.proxyHealth = async () => true;
  assert.equal(await supervisor.ownedRuntimeReady({ mode: "browser-only" }), true);

  supervisor.tunnel = { pid: 123_456_784, exitCode: null, signalCode: null };
  supervisor.tunnelHealth = async () => false;
  assert.equal(await supervisor.ownedRuntimeReady({ mode: "full" }), false);
  supervisor.tunnelHealth = async () => true;
  assert.equal(await supervisor.ownedRuntimeReady({ mode: "full" }), true);
});

test("failed initial health checks stop their child without scheduling crash recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-startup-cleanup-"));
  const childPath = path.join(root, "child.cjs");
  fs.writeFileSync(childPath, "setInterval(() => {}, 1000);\n");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
    runtimeInvocationFactory: () => ({
      executable: process.execPath,
      args: [childPath],
      cwd: root,
    }),
  });
  let recoveries = 0;
  supervisor.waitForProxy = async () => {
    throw new Error("synthetic health failure");
  };
  supervisor.scheduleRecovery = () => {
    recoveries += 1;
  };
  try {
    await assert.rejects(supervisor.startDaemon({}), /synthetic health failure/);
    assert.equal(supervisor.daemon, null);
    assert.equal(recoveries, 0);
  } finally {
    await supervisor.stopChild("daemon").catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
