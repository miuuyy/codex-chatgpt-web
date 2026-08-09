const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { nodeBrowserLoginInvocation, runtimeInvocation } = require("../electron/runtime-command.cjs");
const { ensurePackagedRuntime } = require("../electron/runtime-install.cjs");

function runtimeFixture(root, version = "0.2.0", bundleId = "a".repeat(64)) {
  const source = path.join(root, "resources", "runtime");
  const executable = path.join(source, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.join(source, "app"), { recursive: true });
  fs.writeFileSync(executable, "bun");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(source, "app", "cli.js"), "cli");
  fs.writeFileSync(path.join(source, "app", "cli-node.cjs"), "node cli");
  fs.writeFileSync(path.join(source, "app", "browser-helper.cjs"), "helper");
  fs.writeFileSync(path.join(source, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    appVersion: version,
    bundleId,
    platform: process.platform,
    arch: process.arch,
  })}\n`);
  return path.join(root, "resources");
}

test("packaged runtime is installed once into a durable versioned directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-install-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    assert.equal(installed, path.join(coreHome, "versions", `0.2.0-${process.platform}-${process.arch}`));
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "cli");
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);

    const invocation = runtimeInvocation({
      app,
      sourceRoot: root,
      installedRuntimeRoot: installed,
      args: ["serve"],
    });
    assert.equal(invocation.cwd, installed);
    assert.equal(invocation.args[0], path.join(installed, "app", "cli.js"));
    assert.equal(invocation.args[1], "serve");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows browser login uses Node while the packaged runtime stays on Bun", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-node-login-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    const invocation = nodeBrowserLoginInvocation({
      app,
      sourceRoot: root,
      installedRuntimeRoot: installed,
      args: ["login", "--launcher-control"],
    });
    assert.equal(invocation.executable, process.execPath);
    assert.equal(invocation.args[0], path.join(installed, "app", "cli-node.cjs"));
    assert.equal(invocation.env.ELECTRON_RUN_AS_NODE, "1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime installation rejects a platform or version mismatch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-mismatch-"));
  const resourcesPath = runtimeFixture(root, "0.1.0");
  try {
    assert.throws(
      () => ensurePackagedRuntime({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        coreHome: path.join(root, "core-home"),
        resourcesPath,
      }),
      /identity mismatch/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime transactionally repairs an incomplete installed bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-repair-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    const entrypoint = path.join(installed, "app", "cli.js");
    fs.rmSync(entrypoint);
    fs.writeFileSync(path.join(installed, "corrupt.partial"), "interrupted copy");

    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.equal(fs.readFileSync(entrypoint, "utf8"), "cli");
    assert.equal(fs.existsSync(path.join(installed, "corrupt.partial")), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(installed)).filter(name => name.includes(".previous-") || name.includes(".tmp-")),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime replaces stale files when a release is refreshed under the same version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-refresh-"));
  const resourcesPath = runtimeFixture(root, "0.2.0", "a".repeat(64));
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    fs.writeFileSync(path.join(installed, "old-release-marker"), "old");

    const source = path.join(resourcesPath, "runtime");
    const manifestPath = path.join(source, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(path.join(source, "app", "cli.js"), "new cli");
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, bundleId: "b".repeat(64) })}\n`);

    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "new cli");
    assert.equal(fs.existsSync(path.join(installed, "old-release-marker")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
