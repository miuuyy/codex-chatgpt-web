const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  DETACH_OWNED_CHILD,
  processRunning,
  terminateOwnedProcessTree,
} = require("../electron/process-tree.cjs");

const source = fs.readFileSync(path.resolve(__dirname, "..", "scripts", "dev.cjs"), "utf8");

test("development startup builds once before managing the browser-helper watcher", () => {
  const initialBuild = source.indexOf("const helperBuild = spawnSync");
  const watcher = source.indexOf("const helperWatcher = spawn");
  const vite = source.indexOf("const vite = spawn");
  assert.ok(initialBuild >= 0);
  assert.ok(watcher > initialBuild);
  assert.ok(vite > watcher);
  assert.match(source, /build-browser-helper\.ts", "--watch"/);
  assert.match(source, /detached: DETACH_OWNED_CHILD/);
  assert.match(source, /terminateOwnedProcessTree\(helperWatcher\)/);
  assert.doesNotMatch(source, /helperWatcher\.kill\("SIGTERM"\)/);
  assert.match(source, /helperWatcher\.once\("error"/);
  assert.match(source, /helperWatcher\.once\("exit"/);
});

test("owned watcher termination stops its descendant process", { timeout: 10_000 }, async () => {
  const wrapper = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    process.stdout.write(String(descendant.pid) + "\\n");
    setInterval(() => {}, 1000);
  `], {
    detached: DETACH_OWNED_CHILD,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let descendantPid;
  try {
    descendantPid = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Watcher wrapper did not report its descendant pid")), 3_000);
      wrapper.once("error", error => {
        clearTimeout(timer);
        reject(error);
      });
      wrapper.stdout.on("data", chunk => {
        output += chunk.toString();
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        clearTimeout(timer);
        resolve(Number.parseInt(output.slice(0, newline).trim(), 10));
      });
    });
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    assert.equal(processRunning(wrapper.pid), true);
    assert.equal(processRunning(descendantPid), true);

    terminateOwnedProcessTree(wrapper);
    const deadline = Date.now() + 5_000;
    while ((processRunning(wrapper.pid) || processRunning(descendantPid)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(processRunning(wrapper.pid), false);
    assert.equal(processRunning(descendantPid), false);
  } finally {
    try { terminateOwnedProcessTree(wrapper, "SIGKILL"); } catch {}
    if (Number.isInteger(descendantPid) && processRunning(descendantPid)) {
      try { process.kill(descendantPid, "SIGKILL"); } catch {}
    }
  }
});
