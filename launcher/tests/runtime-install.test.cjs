const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runtimeInvocation } = require("../electron/runtime-command.cjs");
const {
  ensurePackagedRuntime,
  validateRuntimeBundle,
  waitForPackagedRuntimeSource,
} = require("../electron/runtime-install.cjs");

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function manifestFiles(source) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(source, absolutePath).split(path.sep).join("/");
      if (relativePath === "manifest.json") continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      const content = fs.readFileSync(absolutePath);
      files.push({
        path: relativePath,
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  };
  visit(source);
  return files.sort((left, right) => comparePaths(left.path, right.path));
}

function bundleIdFor(files) {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function writeRuntimeManifest(source, version = "0.2.0") {
  const files = manifestFiles(source);
  fs.writeFileSync(path.join(source, "manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    appVersion: version,
    bundleId: bundleIdFor(files),
    bunVersion: "1.4.0",
    platform: process.platform,
    arch: process.arch,
    launcher: `bin/${process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`,
    entrypoint: "app/cli.js",
    playwright: "1.62.0",
    files,
  })}\n`);
}

function runtimeFixture(root, version = "0.2.0") {
  const source = path.join(root, "resources", "runtime");
  const executable = path.join(source, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.join(source, "app"), { recursive: true });
  fs.writeFileSync(executable, "bun");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  fs.writeFileSync(path.join(source, "app", "cli.js"), "cli");
  fs.writeFileSync(path.join(source, "app", "browser-helper.cjs"), "helper");
  fs.mkdirSync(path.join(source, "app", "node_modules", "zod", "v4"), { recursive: true });
  fs.writeFileSync(path.join(source, "app", "node_modules", "zod", "v4", "index.js"), "zod-v4");
  if (process.platform !== "win32") {
    fs.mkdirSync(path.join(source, "app", "node_modules", ".bin"), { recursive: true });
    fs.symlinkSync("../zod/v4/index.js", path.join(source, "app", "node_modules", ".bin", "zod-v4"));
  }
  fs.mkdirSync(path.join(source, "app", "node_modules", "nested-dependency", "dist", "runtime"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "app", "node_modules", "nested-dependency", "dist", "runtime", "worker.js"),
    "nested-worker",
  );
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(source, "bin", process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"),
    "launcher",
  );
  writeRuntimeManifest(source, version);
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

test("packaged runtime rejects a missing executable before creating durable state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-missing-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const executable = path.join(
    resourcesPath,
    "runtime",
    "runtime",
    process.platform === "win32" ? "bun.exe" : "bun",
  );
  fs.rmSync(executable);
  try {
    assert.throws(
      () => ensurePackagedRuntime({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        coreHome,
        resourcesPath,
      }),
      /Runtime bundle file is missing/,
    );
    assert.equal(fs.existsSync(coreHome), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const relativePath of [
  ["app", "node_modules", "zod", "v4", "index.js"],
  ["app", "node_modules", "nested-dependency", "dist", "runtime", "worker.js"],
]) {
  test(`packaged runtime rejects a missing nested dependency: ${relativePath.join("/")}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-dependency-"));
    const resourcesPath = runtimeFixture(root);
    const coreHome = path.join(root, "core-home");
    fs.rmSync(path.join(resourcesPath, "runtime", ...relativePath));
    try {
      assert.throws(
        () => ensurePackagedRuntime({
          app: { isPackaged: true, getVersion: () => "0.2.0" },
          coreHome,
          resourcesPath,
        }),
        /Runtime bundle file is missing/,
      );
      assert.equal(fs.existsSync(coreHome), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("packaged runtime rejects same-count content corruption", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-corrupt-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const dependency = path.join(resourcesPath, "runtime", "app", "node_modules", "zod", "v4", "index.js");
  fs.writeFileSync(dependency, "bad-v4");
  try {
    assert.throws(
      () => ensurePackagedRuntime({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        coreHome,
        resourcesPath,
      }),
      /checksum mismatch/,
    );
    assert.equal(fs.existsSync(coreHome), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime source wait accepts a delayed final dependency within its bound", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-delayed-"));
  const resourcesPath = runtimeFixture(root);
  const delayed = path.join(
    resourcesPath,
    "runtime",
    "app",
    "node_modules",
    "nested-dependency",
    "dist",
    "runtime",
    "worker.js",
  );
  const content = fs.readFileSync(delayed);
  fs.rmSync(delayed);
  const materialize = setTimeout(() => fs.writeFileSync(delayed, content), 40);
  try {
    assert.equal(
      await waitForPackagedRuntimeSource({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        resourcesPath,
        timeoutMs: 500,
        intervalMs: 10,
      }),
      path.join(resourcesPath, "runtime"),
    );
  } finally {
    clearTimeout(materialize);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime source wait fails closed when materialization exceeds its bound", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-timeout-"));
  const resourcesPath = runtimeFixture(root);
  fs.rmSync(path.join(resourcesPath, "runtime", "app", "node_modules", "zod", "v4", "index.js"));
  try {
    await assert.rejects(
      waitForPackagedRuntimeSource({
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        resourcesPath,
        timeoutMs: 30,
        intervalMs: 5,
      }),
      /did not fully materialize within 30ms.*Runtime bundle file is missing/,
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
    const dependency = path.join(
      installed,
      "app",
      "node_modules",
      "nested-dependency",
      "dist",
      "runtime",
      "worker.js",
    );
    fs.rmSync(dependency);
    fs.writeFileSync(path.join(installed, "corrupt.partial"), "interrupted copy");

    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.equal(fs.readFileSync(dependency, "utf8"), "nested-worker");
    assert.equal(fs.existsSync(path.join(installed, "corrupt.partial")), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(installed)).filter(name => name.includes(".previous-") || name.includes(".tmp-")),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed candidate validation preserves the previous validated runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-preserve-"));
  const resourcesPath = runtimeFixture(root);
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  const originalCopy = fs.cpSync;
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    const source = path.join(resourcesPath, "runtime");
    fs.writeFileSync(path.join(source, "app", "cli.js"), "new cli");
    writeRuntimeManifest(source);

    fs.cpSync = (from, to, options) => {
      originalCopy(from, to, options);
      fs.rmSync(path.join(to, "app", "node_modules", "zod", "v4", "index.js"));
    };
    assert.throws(
      () => ensurePackagedRuntime({ app, coreHome, resourcesPath }),
      /Runtime bundle file is missing/,
    );
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "cli");
    assert.equal(
      validateRuntimeBundle(installed, {
        version: "0.2.0",
        platform: process.platform,
        arch: process.arch,
      }),
      installed,
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(installed)).filter(name => name.includes(".previous-") || name.includes(".tmp-")),
      [],
    );
  } finally {
    fs.cpSync = originalCopy;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime replaces stale files when a release is refreshed under the same version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-refresh-"));
  const resourcesPath = runtimeFixture(root, "0.2.0");
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    fs.writeFileSync(path.join(installed, "old-release-marker"), "old");

    const source = path.join(resourcesPath, "runtime");
    fs.writeFileSync(path.join(source, "app", "cli.js"), "new cli");
    writeRuntimeManifest(source);

    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), installed);
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "new cli");
    assert.equal(fs.existsSync(path.join(installed, "old-release-marker")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged runtime repairs beside a Windows-locked same-version runtime", {
  skip: process.platform !== "win32",
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-runtime-locked-refresh-"));
  const resourcesPath = runtimeFixture(root, "0.2.0");
  const coreHome = path.join(root, "core-home");
  const app = { isPackaged: true, getVersion: () => "0.2.0" };
  const originalRename = fs.renameSync;
  try {
    const installed = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    const source = path.join(resourcesPath, "runtime");
    fs.writeFileSync(path.join(source, "app", "cli.js"), "new cli");
    writeRuntimeManifest(source);

    fs.renameSync = (from, to) => {
      if (from === installed && to.includes(".previous-")) {
        const error = new Error("runtime is in use");
        error.code = "EPERM";
        throw error;
      }
      return originalRename(from, to);
    };

    const repaired = ensurePackagedRuntime({ app, coreHome, resourcesPath });
    assert.notEqual(repaired, installed);
    assert.match(repaired, /\.bundle-[a-f0-9]{16}$/);
    assert.equal(fs.readFileSync(path.join(installed, "app", "cli.js"), "utf8"), "cli");
    assert.equal(fs.readFileSync(path.join(repaired, "app", "cli.js"), "utf8"), "new cli");
    assert.equal(ensurePackagedRuntime({ app, coreHome, resourcesPath }), repaired);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
