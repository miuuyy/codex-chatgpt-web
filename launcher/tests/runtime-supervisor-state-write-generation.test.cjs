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

test("each ownership persistence failure stops children from its own runtime generation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-state-write-generations-"));
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
  const originalWriteState = supervisor.writeState.bind(supervisor);
  let first;
  let second;
  try {
    first = supervisor.spawnChild("daemon", invocation);
    const firstExited = exited(first);
    supervisor.writeState = () => { throw new Error("first disk failure"); };
    assert.equal(supervisor.tryWriteState("degraded", "first generation"), false);
    assert.equal(await firstExited, true);

    supervisor.writeState = originalWriteState;
    supervisor.stopping = false;
    second = supervisor.spawnChild("daemon", invocation);
    const secondExited = exited(second);
    supervisor.writeState = () => { throw new Error("second disk failure"); };
    assert.equal(supervisor.tryWriteState("degraded", "second generation"), false);
    assert.equal(await secondExited, true);
  } finally {
    await stopTestChild(first);
    await stopTestChild(second);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
