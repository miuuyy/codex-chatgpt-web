const test = require("node:test");
const assert = require("node:assert/strict");
const { RuntimeHost } = require("../electron/runtime.cjs");

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const events = [];
  const host = new RuntimeHost({
    app: { getPath: () => require("node:os").tmpdir() },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: "/unused",
    browserDescriptorPath: "/unused/launcher-browser.json",
    publishOperation: event => events.push(event),
    supervisor: {
      stopForSetup: async () => {},
      startIfConfigured: async () => ({ status: "ready" }),
    },
  });
  host.command = () => ({ executable: process.execPath, args: ["-e", "process.stdout.write('step done\\n')"] });
  host.runtimeConfigSnapshot = () => ({ configured: true, owner: "launcher" });
  host.captureSetupCheckpoint = () => ({});
  host.setupCheckpointChanged = () => false;
  host.restoreSetupCheckpoint = () => {};
  host.restorePreviousRuntime = async () => {};
  return { host, events };
}

test("setup stays busy after preflight and CLI exit until the runtime is ready", async () => {
  const { host, events } = fixture();
  const stopping = gate();
  const stopped = gate();
  const starting = gate();
  const ready = gate();
  host.supervisor.stopForSetup = async () => { stopping.resolve(); await stopped.promise; };
  host.supervisor.startIfConfigured = async () => { starting.resolve(); await ready.promise; return { status: "ready" }; };
  const setup = host.runSetup("core-setup", ["setup"], { successMessage: "Installed" });
  try {
    await stopping.promise;
    assert.equal(host.currentOperation(), "core-setup");
    assert.equal(events.at(-1).status, "running");
    await assert.rejects(host.setupCore(), /Another launcher operation is active: core-setup/);
    stopped.resolve();
    await starting.promise;
    assert.equal(host.currentOperation(), "core-setup");
    assert.equal(events.at(-1).status, "running");
  } finally {
    stopped.resolve();
    ready.resolve();
    await setup;
  }
  assert.equal(host.currentOperation(), null);
  assert.deepEqual(events.filter(event => event.status !== "running"), [
    { name: "core-setup", status: "completed", message: "Installed" },
  ]);
});

test("failed setup stays busy through rollback and allows a later retry", async () => {
  const { host, events } = fixture();
  const restoring = gate();
  const restored = gate();
  host.command = args => ({
    executable: process.execPath,
    args: ["-e", args.includes("--preflight-only") ? "process.exit(0)" : "process.stderr.write('setup failed');process.exit(1)"],
  });
  host.restorePreviousRuntime = async () => { restoring.resolve(); await restored.promise; };
  const setup = host.runSetup("core-setup", ["setup"], {});
  const rejected = assert.rejects(setup, /setup failed/);
  try {
    await restoring.promise;
    assert.equal(host.currentOperation(), "core-setup");
    assert.equal(events.at(-1).status, "running");
  } finally {
    restored.resolve();
    await rejected;
  }
  assert.equal(host.currentOperation(), null);
  assert.equal(events.at(-1).status, "failed");
  assert.equal(events.some(event => event.status === "completed"), false);
  host.command = () => ({ executable: process.execPath, args: ["-e", "process.exit(0)"] });
  await host.runSetup("core-setup", ["setup"], {});
  assert.equal(events.at(-1).status, "completed");
  assert.equal(host.currentOperation(), null);
});

test("standalone commands still publish completion", async () => {
  const { host, events } = fixture();
  await host.run("doctor", ["doctor"]);
  assert.equal(events.at(-1).status, "completed");
});
