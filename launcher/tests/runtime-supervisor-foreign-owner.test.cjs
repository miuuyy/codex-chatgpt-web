const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

function exited(child, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    child.once("exit", () => resolve(true));
    setTimeout(() => resolve(false), timeoutMs).unref?.();
  });
}

test("setup stop preserves ownership held by another live launcher when config is missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-stop-live-owner-"));
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
    status: "ready",
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, `${JSON.stringify(state)}\n`);
  try {
    await assert.rejects(
      supervisor.stopForSetup(),
      /Another launcher process still owns the runtime/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(supervisor.statePath, "utf8")), state);
  } finally {
    const ownerExited = exited(liveOwner);
    liveOwner.kill("SIGKILL");
    await ownerExited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
