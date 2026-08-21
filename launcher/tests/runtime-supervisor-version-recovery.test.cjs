const assert = require("node:assert/strict");
const test = require("node:test");

const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");

test("daemon recovery stops before spawn when configured release is stale", async () => {
  const operations = [];
  const states = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "2.1.6" },
    logger: { error() {}, info() {}, warn() {} },
    sourceRoot: "C:\\source",
    installedRuntimeRoot: "C:\\runtime",
    coreHome: "C:\\core",
    browserDescriptorPath: "C:\\browser.json",
    publishOperation: operation => operations.push(operation),
  });
  supervisor.readConfig = () => ({ releaseVersion: "2.1.5", mode: "browser-only" });
  supervisor.tryWriteState = (status, detail) => {
    states.push({ status, detail });
    return true;
  };
  supervisor.startDaemon = async () => assert.fail("stale release must not spawn a daemon");

  await supervisor.recover("daemon");

  assert.deepEqual(states, [{
    status: "needs-setup",
    detail: "Config requires 2.1.5; launcher is 2.1.6",
  }]);
  assert.deepEqual(operations.at(-1), {
    name: "runtime-recovery",
    status: "failed",
    message: "Config requires 2.1.5; launcher is 2.1.6",
  });
});
