const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { runUntilSmokeMarker, killWindowsLauncher } = require("../scripts/smoke-process.cjs");

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cgw-smoke-process-test-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return { cwd, markerPath: path.join(cwd, "ready.json"), timeout: 5_000 };
}

test("smoke reports an early exit and its actual stderr instead of timing out", async t => {
  await assert.rejects(runUntilSmokeMarker(process.execPath,
    ["-e", "console.error('startup failed'); process.exit(7)"], fixture(t)),
  error => /status=7/.test(error.message) && /startup failed/.test(error.message));
});

test("smoke reports executable startup errors", async t => {
  const options = fixture(t);
  await assert.rejects(runUntilSmokeMarker(path.join(options.cwd, "does-not-exist"), [], options), /ENOENT/);
});

test("smoke accepts readiness and stops only its owned child", async t => {
  const options = fixture(t);
  await runUntilSmokeMarker(process.execPath, ["-e",
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1000)",
    options.markerPath,
  ], options);
  const pid = Number(fs.readFileSync(options.markerPath, "utf8"));
  assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
});

test("smoke terminates an owned child that never becomes ready", async t => {
  const options = { ...fixture(t), timeout: 200 };
  await assert.rejects(runUntilSmokeMarker(process.execPath, ["-e", "setInterval(()=>{},1000)"], options), /within 200ms/);
});

test("Windows installer cleanup matches exact executable paths, not image names", () => {
  let invocation;
  const executable = "C:\\Program Files\\Test' App\\Codex Web GPT.exe";
  killWindowsLauncher(executable, {}, (...args) => {
    invocation = args;
    return { status: 0 };
  });
  const [command, args, options] = invocation;
  assert.equal(command, "powershell.exe");
  assert.match(args.at(-1), /ExecutablePath/);
  assert.match(args.at(-1), /OrdinalIgnoreCase/);
  assert.doesNotMatch(args.at(-1), /Test' App/);
  assert.equal(options.env.CODEX_WEB_GPT_SMOKE_EXECUTABLE, executable);
  assert.ok(!args.includes("/IM"));
});

test("a failed Windows taskkill falls back to stopping the owned child", async t => {
  const options = fixture(t);
  let attempts = 0;
  const context = {
    module: { exports: {} }, process: { platform: "win32", env: process.env },
    setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name === "node:child_process") return {
        spawn: require(name).spawn,
        spawnSync: () => { attempts++; return { status: 1, stderr: "access denied" }; },
      };
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../scripts/smoke-process.cjs"), "utf8"), context);
  await context.module.exports.runUntilSmokeMarker(process.execPath, ["-e",
    "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)", options.markerPath,
  ], options);
  assert.equal(attempts, 1);
  assert.throws(() => process.kill(Number(fs.readFileSync(options.markerPath, "utf8")), 0), error => error.code === "ESRCH");
});
