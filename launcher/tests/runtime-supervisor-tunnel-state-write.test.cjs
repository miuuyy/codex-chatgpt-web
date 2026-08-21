const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

function exited(child, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    child.once("exit", () => resolve(true));
    setTimeout(() => resolve(false), timeoutMs).unref?.();
  });
}

async function stopTestChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const didExit = exited(child);
  child.kill("SIGKILL");
  await didExit;
}

async function runMonitorTick(tick) {
  tick();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test("tunnel monitor persistence failure stops the still-referenced tunnel and daemon", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-monitor-state-write-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const invocation = {
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: root,
  };
  const daemon = supervisor.spawnChild("daemon", invocation);
  const tunnel = supervisor.spawnChild("tunnel", invocation);
  const daemonExited = exited(daemon);
  const tunnelExited = exited(tunnel);
  const originalSetInterval = global.setInterval;
  let monitorTick;
  global.setInterval = (callback) => {
    monitorTick = callback;
    return originalSetInterval(() => {}, 60_000);
  };
  supervisor.observeTunnelForMonitor = async () => ({
    ready: false,
    statusKnown: true,
    detail: "state=degraded",
  });
  try {
    supervisor.startTunnelMonitor({ mode: "full" });
  } finally {
    global.setInterval = originalSetInterval;
  }
  supervisor.writeState = () => { throw new Error("monitor disk failure"); };
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runMonitorTick(monitorTick);
    }
    assert.equal(await daemonExited, true);
    assert.equal(await tunnelExited, true);
  } finally {
    supervisor.stopTunnelMonitor();
    await stopTestChild(daemon);
    await stopTestChild(tunnel);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
