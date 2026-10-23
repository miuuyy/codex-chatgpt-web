const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const childProcess = require("node:child_process");
const { once } = require("node:events");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");
const { DETACH_OWNED_CHILD, processRunning, terminateOwnedProcessTree } = require("../electron/process-tree.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-write-"));
  const errors = [];
  const operations = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error(event, detail) { errors.push({ event, ...detail }); } },
    sourceRoot: root, coreHome: root, browserDescriptorPath: path.join(root, "launcher.json"),
    publishOperation: operation => operations.push(operation),
  });
  return { root, supervisor, errors, operations };
}

async function until(predicate, message) {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(predicate(), message);
}

function failWrites(supervisor) {
  supervisor.writeState = () => { throw new Error("synthetic ownership ENOSPC"); };
}

test("ownership write failure stops each owned daemon generation without touching another process", async () => {
  const { root, supervisor, operations } = fixture();
  const foreign = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: root, detached: DETACH_OWNED_CHILD, stdio: "ignore", windowsHide: true,
  });
  await once(foreign, "spawn");
  const writeState = supervisor.writeState.bind(supervisor), stopChild = supervisor.stopChild.bind(supervisor);
  let idle = false, healthy = true, forcedStops = 0;
  supervisor.stopChild = (...args) => { forcedStops++; return stopChild(...args); };
  supervisor.readConfig = () => ({ mode: "full", tunnel: { alias: "owned-fixture" } });
  supervisor.proxyHealth = async () => healthy;
  supervisor.waitForPortRelease = async () => {};
  supervisor.control = async (_config, action) => {
    if (action === "shutdown") { supervisor.daemon.kill(); return { status: "ok" }; }
    return { accepting_turns: false, active_http_turns: idle ? 0 : 1, active_browser_turns: 0 };
  };
  supervisor.runTunnelStopCommand = async () => { assert(idle); assert.equal(supervisor.daemon, null); return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => ({ state: "stopped", processRunning: false });
  try {
    for (let generation = 0; generation < 2; generation += 1) {
      supervisor.stopping = false;
      supervisor.writeState = writeState;
      const child = supervisor.spawnChild("daemon", {
        executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: root,
      });
      await once(child, "spawn");
      idle = false;
      healthy = generation === 0;
      supervisor.tunnel = { pid: null, exitCode: null, signalCode: null, managed: true };
      failWrites(supervisor);
      supervisor.restartTimers.daemon = setTimeout(() => assert.fail("recovery must stay stopped"), 30_000);
      assert.equal(supervisor.tryWriteState("ready"), false);
      assert.equal(forcedStops, 0, "persistence failure must not synchronously force-stop a serving daemon");
      if (!healthy) {
        await Promise.all([...supervisor.stateWriteCleanups.values()]);
        await assert.rejects(supervisor.cleanupFailedStart(supervisor.readConfig()), /matching health/);
        assert(processRunning(child.pid) && supervisor.tunnel, "unverified health must preserve owned processes");
        healthy = true;
        supervisor.tryWriteState("ready");
      }
      await new Promise(resolve => setImmediate(resolve));
      assert(processRunning(child.pid), "active turns must retain their daemon and tunnel");
      assert(supervisor.tunnel);
      idle = true;
      assert.equal(supervisor.stopping, true);
      assert.equal(supervisor.restartTimers.daemon, null);
      await until(() => child.exitCode !== null || child.signalCode !== null, "owned daemon must exit after persistence fails");
      assert.equal(processRunning(child.pid), false);
      assert.equal(processRunning(foreign.pid), true, "unowned process must remain alive");
    }
    assert.ok(operations.some(operation => operation.status === "failed" && /ENOSPC/.test(operation.message)));
  } finally {
    await supervisor.stopChild("daemon").catch(() => {});
    if (foreign.exitCode === null && foreign.signalCode === null) {
      const exited = once(foreign, "exit");
      terminateOwnedProcessTree(foreign);
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed tunnel cleanup uses its native stop contract and coalesces repeated failed writes", async () => {
  const { root, supervisor } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const commands = [];
  let terminalChecks = 0;
  const managed = { pid: null, exitCode: null, signalCode: null, managed: true };
  supervisor.tunnel = managed;
  supervisor.readConfig = () => ({ tunnel: { alias: "owned-fixture" } });
  supervisor.runTunnelStopCommand = async config => { commands.push(config.tunnel.alias); await gate; return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => { terminalChecks += 1; return { state: "stopped", processRunning: false }; };
  failWrites(supervisor);
  try {
    assert.equal(supervisor.tryWriteState("ready"), false);
    assert.equal(supervisor.tryWriteState("degraded"), false);
    await until(() => commands.length > 0, "native managed tunnel stop must be requested");
    assert.deepEqual(commands, ["owned-fixture"]);
    assert.equal(supervisor.tunnel, managed, "retain ownership until terminal evidence");
    release();
    await until(() => supervisor.tunnel === null, "managed tunnel must have terminal proof before release");
    assert.equal(terminalChecks, 1);
    assert.equal(supervisor.stopping, true);
    assert.equal(supervisor.tunnelMonitorTimer, null);
  } finally {
    release();
    supervisor.stopTunnelMonitor();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed managed cleanup preserves ownership and reports the failure without PID termination", async () => {
  const { root, supervisor, errors } = fixture();
  const managed = {
    pid: null, exitCode: null, signalCode: null, managed: true,
    kill() { assert.fail("manager-owned metadata must not use child-process termination"); },
  };
  supervisor.tunnel = managed;
  supervisor.readConfig = () => ({ tunnel: { alias: "owned-fixture" } });
  supervisor.runTunnelStopCommand = async () => { throw new Error("synthetic manager unavailable"); };
  supervisor.startTunnelMonitor = () => { supervisor.tunnelMonitorTimer = setInterval(() => {}, 30_000); };
  failWrites(supervisor);
  try {
    assert.equal(supervisor.tryWriteState("ready"), false);
    await until(() => errors.some(error => error.event === "runtime.state_write_cleanup_failed"), "cleanup failure must remain observable");
    assert.equal(supervisor.tunnel, managed);
    assert.equal(supervisor.stopping, true);
    assert.equal(supervisor.tunnelMonitorTimer, null);
    assert.ok(errors.some(error => /synthetic manager unavailable/.test(error.message)));
  } finally {
    supervisor.stopTunnelMonitor();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const entry of ["stopForSetup", "forceStopOwnedRuntime"]) {
  for (const failure of ["command throws", "command refused", "terminal unproven"]) {
    test(`${entry} keeps failed ownership cleanup unmonitored after ${failure}`, async t => {
      const { root, supervisor, errors } = fixture();
      t.mock.timers.enable({ apis: ["setInterval"] });
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      let stops = 0;
      let terminalChecks = 0;
      let observations = 0;
      const managed = {
        pid: null, exitCode: null, signalCode: null, managed: true,
        kill() { assert.fail("managed ownership must use the native stop contract"); },
      };
      supervisor.tunnel = managed;
      supervisor.readConfig = () => ({ mode: "full", tunnel: { alias: "owned-fixture" } });
      supervisor.proxyHealth = async () => false;
      supervisor.observeTunnelForMonitor = async () => { observations += 1; return { statusKnown: false }; };
      supervisor.runTunnelStopCommand = async () => {
        stops += 1;
        if (stops === 2) await gate;
        if (failure === "command throws") throw new Error("synthetic native stop failed");
        return { code: failure === "command refused" ? 9 : 0, output: "synthetic native stop refused" };
      };
      supervisor.waitForTunnelStopped = async () => {
        terminalChecks += 1;
        throw new Error("synthetic native terminal state unproven");
      };
      failWrites(supervisor);
      try {
        let settled = false;
        const stopping = entry === "stopForSetup" ? supervisor.stopForSetup() : supervisor.forceStopOwnedRuntime(new Error("test shutdown"));
        const result = stopping.then(() => { settled = true; return null; }, error => { settled = true; return error; });
        await until(() => stops === 2, "ownership persistence failure must initiate native cleanup");
        assert.equal(stops, 2, "ownership persistence failure must retry through production native stop");
        assert.equal(settled, entry === "stopForSetup", "forced shutdown must await terminal proof");
        assert.equal(supervisor.stateWriteCleanups.has(managed), true);
        release();
        assert.match((await result)?.message || "", /synthetic native/);
        await Promise.all([...supervisor.stateWriteCleanups.values()]);
        assert.equal(supervisor.tunnel, managed, "failed native stop must retain the owned generation");
        assert.equal(terminalChecks, failure === "terminal unproven" ? 2 : 0);
        assert.ok(errors.some(error => error.event === "runtime.state_write_cleanup_failed"));
        assert.equal(supervisor.tunnelMonitorTimer, null, "ownership failure must stay fail-closed after outer stop settles");
        t.mock.timers.tick(10_000);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(observations, 0);
        assert.equal(supervisor.restartTimers.tunnel, null);
      } finally {
        release();
        await Promise.allSettled([...supervisor.recoveryTasks]);
        supervisor.stopTunnelMonitor();
        t.mock.timers.reset();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("explicit startup waits for an outstanding ownership-failure cleanup", async () => {
  const { root, supervisor } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let starts = 0;
  supervisor.tunnel = { pid: null, exitCode: null, signalCode: null, managed: true };
  supervisor.readConfig = () => ({ tunnel: { alias: "owned-fixture" } });
  supervisor.runTunnelStopCommand = async () => { await gate; return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => ({ state: "stopped", processRunning: false });
  supervisor.startConfigured = async () => { starts += 1; return { status: "not-configured" }; };
  failWrites(supervisor);
  let starting;
  try {
    supervisor.tryWriteState("ready");
    starting = supervisor.startIfConfigured();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 0, "do not replace a child whose cleanup is still pending");
    release();
    assert.deepEqual(await starting, { status: "not-configured" });
    assert.equal(starts, 1);
  } finally {
    release();
    await starting;
    await Promise.allSettled([...supervisor.recoveryTasks]);
    supervisor.stopTunnelMonitor();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("recovery failure joins the existing managed cleanup instead of issuing a second stop", async () => {
  const { root, supervisor } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let stops = 0;
  const config = { tunnel: { alias: "owned-fixture" } };
  supervisor.tunnel = { pid: null, exitCode: null, signalCode: null, managed: true };
  supervisor.readConfig = () => config;
  supervisor.runTunnelStopCommand = async () => { stops += 1; await gate; return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => ({ state: "stopped", processRunning: false });
  failWrites(supervisor);
  let cleanup;
  try {
    supervisor.tryWriteState("ready");
    cleanup = supervisor.cleanupFailedStart(config);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 1);
    release();
    await cleanup;
    assert.equal(supervisor.tunnel, null);
  } finally {
    release();
    await cleanup;
    await Promise.allSettled([...supervisor.recoveryTasks]);
    supervisor.stopTunnelMonitor();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed degraded-state write retains the monitored tunnel for native cleanup", async t => {
  const { root, supervisor } = fixture();
  t.mock.timers.enable({ apis: ["setInterval"] });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let stops = 0;
  const managed = { pid: null, exitCode: null, signalCode: null, managed: true };
  const config = { tunnel: { alias: "owned-fixture" } };
  supervisor.tunnel = managed;
  supervisor.readConfig = () => config;
  supervisor.observeTunnelForMonitor = async () => ({ statusKnown: true, ready: false, fatal: true, detail: "synthetic unhealthy tunnel" });
  supervisor.runTunnelStopCommand = async () => { stops += 1; await gate; return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => ({ state: "stopped", processRunning: false });
  failWrites(supervisor);
  try {
    supervisor.startTunnelMonitor(config);
    t.mock.timers.tick(10_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 1, "failed persistence must not discard the owned tunnel reference");
    assert.equal(supervisor.tunnel, managed);
    release();
    await until(() => supervisor.tunnel === null, "native stop must settle");
    assert.equal(supervisor.restartTimers.tunnel, null);
  } finally {
    release();
    await Promise.allSettled([...supervisor.recoveryTasks]);
    supervisor.stopTunnelMonitor();
    t.mock.timers.reset();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settled cleanup does not erase a newer managed tunnel reference", async () => {
  const { root, supervisor } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  supervisor.tunnel = { pid: null, exitCode: null, signalCode: null, managed: true };
  supervisor.readConfig = () => ({ tunnel: { alias: "owned-fixture" } });
  supervisor.runTunnelStopCommand = async () => { await gate; return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => ({ state: "stopped", processRunning: false });
  failWrites(supervisor);
  try {
    supervisor.tryWriteState("ready");
    // A recovery already in flight can publish a newer identity while stop is awaiting proof.
    const replacement = { pid: null, exitCode: null, signalCode: null, managed: true };
    supervisor.tunnel = replacement;
    release();
    await Promise.allSettled([...supervisor.recoveryTasks]);
    assert.equal(supervisor.tunnel, replacement);
  } finally {
    release();
    await Promise.allSettled([...supervisor.recoveryTasks]);
    supervisor.stopTunnelMonitor();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("successful persistence and foreign marker evidence do not authorize child cleanup", () => {
  const { root, supervisor } = fixture();
  let cleanup = 0;
  supervisor.stopChild = async () => { cleanup += 1; };
  supervisor.stopTunnelGracefully = async () => { cleanup += 1; };
  try {
    assert.equal(supervisor.tryWriteState("ready"), true);
    assert.equal(supervisor.stopping, false);
    supervisor.readState = () => ({ ownerPid: process.pid + 1, daemonPid: process.pid, tunnelPid: process.pid });
    failWrites(supervisor);
    assert.equal(supervisor.tryWriteState("degraded"), false);
    assert.equal(cleanup, 0, "disk marker PIDs alone cannot grant process ownership");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ["command throws", "command refused", "terminal unproven"]) {
  test(`failed cleanup preserves the newer monitor after ${failure}`, async t => {
    const { root, supervisor } = fixture();
    t.mock.timers.enable({ apis: ["setInterval"] });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const config = { tunnel: { alias: "old-owned-fixture" } };
    const replacementConfig = { tunnel: { alias: "new-owned-fixture" } };
    const managed = { pid: 101, exitCode: null, signalCode: null, managed: true };
    const replacement = { ...managed, pid: 202 };
    const observations = [];
    supervisor.tunnel = managed;
    supervisor.readConfig = () => config;
    supervisor.runTunnelStopCommand = async () => {
      await gate;
      if (failure === "command throws") throw new Error("synthetic native stop failed");
      return { code: failure === "command refused" ? 9 : 0, output: "synthetic native stop refused" };
    };
    supervisor.waitForTunnelStopped = async () => { throw new Error("synthetic terminal unproven"); };
    supervisor.observeTunnelForMonitor = async current => {
      observations.push(current.tunnel.alias);
      return { statusKnown: true, ready: true, pid: replacement.pid };
    };
    failWrites(supervisor);
    try {
      supervisor.tryWriteState("ready");
      // An already-running recovery can publish a replacement while native cleanup awaits.
      supervisor.tunnel = replacement;
      supervisor.stopping = false;
      supervisor.startTunnelMonitor(replacementConfig);
      const timer = supervisor.tunnelMonitorTimer;
      const generation = supervisor.tunnelMonitorGeneration;
      supervisor.tunnelMonitorFailures = 1;
      supervisor.tunnelMonitorObservationUnavailable = true;
      release();
      await Promise.all([...supervisor.stateWriteCleanups.values()]);
      assert.equal(supervisor.tunnel, replacement);
      assert.equal(supervisor.tunnelMonitorTimer, timer, "old cleanup cannot rebuild a replacement's monitor");
      assert.equal(supervisor.tunnelMonitorGeneration, generation);
      assert.equal(supervisor.tunnelMonitorFailures, 1);
      assert.equal(supervisor.tunnelMonitorObservationUnavailable, true);
      t.mock.timers.tick(10_000);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(observations, [replacementConfig.tunnel.alias]);
    } finally {
      release();
      await Promise.allSettled([...supervisor.recoveryTasks]);
      supervisor.stopTunnelMonitor();
      t.mock.timers.reset();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("repeated healthy polls preserve managed identity and coalesce the same native stop", async () => {
  const { root, supervisor } = fixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const config = { mode: "full", tunnel: { alias: "owned-fixture" } };
  let stops = 0;
  supervisor.readConfig = () => config;
  supervisor.readTunnelHealth = async () => ({ ready: true, pid: 4242 });
  supervisor.runTunnelStopCommand = async () => { stops += 1; await gate; return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => ({ state: "stopped", processRunning: false });
  failWrites(supervisor);
  try {
    await supervisor.waitForTunnel(config);
    const managed = supervisor.tunnel;
    supervisor.tryWriteState("ready");
    await supervisor.waitForTunnel(config);
    supervisor.tryWriteState("degraded");
    assert.equal(stops, 1, "the same native PID must not receive overlapping stop requests");
    assert.equal(supervisor.tunnel, managed);
    assert.equal(supervisor.stateWriteCleanups.size, 1);
    release();
    await Promise.all([...supervisor.stateWriteCleanups.values()]);
    assert.equal(supervisor.tunnel, null);
  } finally {
    release();
    await Promise.allSettled([...supervisor.recoveryTasks]);
    supervisor.stopTunnelMonitor();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const previous of [
  { pid: 101, exitCode: null, signalCode: null, managed: true },
  { pid: 202, exitCode: 0, signalCode: null, managed: true },
  { pid: 202, exitCode: null, signalCode: null, managed: false },
]) test(`healthy polling acquires a new identity for ${JSON.stringify(previous)}`, async () => {
  const { root, supervisor } = fixture();
  supervisor.tunnel = previous;
  supervisor.readTunnelHealth = async () => ({ ready: true, pid: 202 });
  try {
    await supervisor.waitForTunnel({ mode: "full" });
    assert.notEqual(supervisor.tunnel, previous);
    assert.deepEqual(supervisor.tunnel, { pid: 202, exitCode: null, signalCode: null, managed: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const restart of [false, true]) test(`overlapping recovery cleans late ownership (explicit restart: ${restart})`, async t => {
  const { root, supervisor } = fixture();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const config = { mode: "full", tunnel: { alias: "owned-fixture" } };
  let release, starting, connecting = false, failed = false, stops = 0, starts = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const write = supervisor.writeState.bind(supervisor);
  supervisor.readConfig = () => config;
  supervisor.assertTunnelClientReady = () => {};
  supervisor.waitForKnownTunnelStatus = async () => ({ state: "stopped", ready: false });
  supervisor.runTunnelStopCommand = async () => { stops++; return { code: 0 }; };
  supervisor.waitForTunnelStopped = async () => ({ state: "stopped", processRunning: false });
  supervisor.runTunnelConnectCommand = async () => { connecting = true; await gate; return { code: 0 }; };
  supervisor.readTunnelHealth = async () => ({ ready: true, pid: null });
  supervisor.waitForTunnelMcpTransport = async () => {};
  supervisor.waitForProxy = async () => new Promise(resolve => setImmediate(resolve));
  supervisor.proxyHealth = async () => true;
  supervisor.acquireDrain = async () => true;
  supervisor.control = async () => { supervisor.daemon.kill(); return { status: "ok" }; };
  supervisor.waitForPortRelease = async () => {};
  supervisor.runtimeCommand = () => ({ executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"], cwd: root });
  supervisor.writeState = (status, detail) => {
    if (status === "failed" && !failed) { failed = true; throw new Error("transient ownership failure"); }
    return write(status, detail);
  };
  try {
    supervisor.scheduleRecovery("tunnel");
    await until(() => connecting, "production tunnel recovery must reach the connect boundary");
    supervisor.scheduleRecovery("daemon");
    await until(() => supervisor.stopping, "overlapping daemon recovery must observe the write failure");
    await Promise.all([...supervisor.stateWriteCleanups.values()]);
    assert.equal(supervisor.daemon, null);
    if (restart) {
      supervisor.startConfigured = async () => { starts++; supervisor.stopping = false; return { status: "ready" }; };
      starting = supervisor.startIfConfigured();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(starts, 0, "explicit restart must join the in-flight acquisition first");
    }
    release();
    await Promise.all([...supervisor.recoveryTasks]);
    if (starting) assert.deepEqual(await starting, { status: "ready" });
    assert.equal(supervisor.tunnel, null, "late acquisition must not survive the failed ownership boundary");
    assert.equal(supervisor.tunnelMonitorTimer, null);
    assert.equal(stops, 2, "late managed ownership must use the native stop contract");
  } finally {
    supervisor.stopping = true;
    release();
    await starting;
    for (const timer of Object.values(supervisor.restartTimers)) clearTimeout(timer);
    await Promise.allSettled([...supervisor.recoveryTasks]);
    await supervisor.stopChild("daemon").catch(() => {});
    if (supervisor.tunnel) await supervisor.stopTunnelGracefully(config).catch(() => {});
    supervisor.stopTunnelMonitor();
    t.mock.timers.reset();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startup cannot commit ready after a transient monitored ownership failure", async t => {
  const { root, supervisor, operations } = fixture();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const config = { mode: "full", releaseVersion: "0.2.0", tunnel: { alias: "owned-fixture" } };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const write = supervisor.writeState.bind(supervisor);
  supervisor.readConfig = () => config;
  supervisor.proxyHealth = async () => false;
  supervisor.observeTunnelForMonitor = async () => ({ statusKnown: true, ready: false, fatal: true, detail: "controlled monitor failure" });
  supervisor.startTunnel = async () => {
    supervisor.tunnel = { pid: null, exitCode: null, signalCode: null, managed: true };
    supervisor.startTunnelMonitor(config);
  };
  supervisor.startDaemon = async () => {
    supervisor.spawnChild("daemon", { executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: root });
    await gate;
  };
  supervisor.writeState = (status, detail) => {
    if (status === "degraded") throw new Error("transient ownership failure");
    return write(status, detail);
  };
  const starting = supervisor.startConfigured();
  try {
    await until(() => Boolean(supervisor.daemon), "startup must reach the acquired daemon boundary");
    t.mock.timers.tick(10_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(supervisor.stopping, true);
    await Promise.all([...supervisor.stateWriteCleanups.values()]);
    release();
    await assert.rejects(starting, /startup was stopped/);
    assert.equal(supervisor.readState().status, "failed");
    assert(!operations.some(operation => operation.status === "completed"));
  } finally {
    release();
    await starting.catch(() => {});
    await Promise.allSettled([...supervisor.recoveryTasks]);
    await supervisor.stopChild("daemon");
    supervisor.stopTunnelMonitor();
    t.mock.timers.reset();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const refused of [false, true]) test(`control timeout awaits asynchronous tree termination (refused=${refused})`, async t => {
  const { root, supervisor } = fixture();
  const pidFile = path.join(root, "control.pid");
  let releaseKill, releaseProof, requests = 0, nativeFinished = false, settled = false;
  const killGate = new Promise(resolve => { releaseKill = resolve; });
  const proofGate = new Promise(resolve => { releaseProof = resolve; });
  const execFile = childProcess.execFile;
  if (process.platform === "win32") t.mock.method(childProcess, "execFile", (file, args, options, callback) => {
    requests++;
    assert.equal(path.basename(file).toLowerCase(), "taskkill.exe");
    assert.deepEqual(args.slice(2), ["/T", "/F"]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 10_000);
    void killGate.then(() => {
      const finish = (...result) => { nativeFinished = true; void proofGate.then(() => callback(...result)); };
      if (refused) finish(new Error("controlled tree termination refusal"));
      else execFile(file, args, options, finish);
    });
    return {};
  });
  const running = supervisor.runTunnelCommand({ tunnel: { binaryPath: process.execPath, profileDir: root } },
    ["-e", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`],
    1_000, "Owned cleanup probe").then(value => { settled = true; return value; }, error => { settled = true; return error; });
  let pid;
  try {
    await until(() => fs.existsSync(pidFile), "owned control process must publish its identity");
    pid = Number(fs.readFileSync(pidFile, "utf8"));
    if (process.platform === "win32") {
      await until(() => requests === 1, "timeout must use the nonblocking native termination boundary");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, "event loop must progress while termination is pending");
      assert(processRunning(pid));
      releaseKill();
      await until(() => nativeFinished, "native termination must complete");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, "process exit alone must not outrun the termination result");
      releaseProof();
    }
    const result = await running;
    assert.match(result.message || "", /Owned cleanup probe timed out/);
    if (process.platform === "win32" && refused) {
      assert.match(result.message, /controlled tree termination refusal/);
      assert(processRunning(pid), "refused termination must not be reported as terminal proof");
    } else await until(() => !processRunning(pid), "the owned control process must be gone");
  } finally {
    releaseKill(); releaseProof();
    await running;
    if (pid && processRunning(pid)) terminateOwnedProcessTree({ pid, exitCode: null, signalCode: null });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
