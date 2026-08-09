const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  installationStatus,
  platformExecutablePath,
} = require("../scripts/ensure-electron.cjs");

function temporaryPackageRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-electron-test-"));
}

function writeMarker(root, relativePath, value) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, value);
}

test("Electron installation status rejects missing install markers", () => {
  const packageRoot = temporaryPackageRoot();
  const result = installationStatus({ manifest: { version: "41.7.1" }, packageRoot });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "Electron's install markers are missing");
});

test("Electron installation status accepts a complete platform runtime", () => {
  const packageRoot = temporaryPackageRoot();
  const installedPath = platformExecutablePath("darwin");
  writeMarker(packageRoot, "path.txt", `${installedPath}\n`);
  writeMarker(packageRoot, "dist/version", "v41.7.1\n");
  writeMarker(packageRoot, path.join("dist", installedPath), "runtime\n");

  assert.deepEqual(
    installationStatus({ manifest: { version: "41.7.1" }, packageRoot }),
    {
      ok: true,
      executable: path.join(packageRoot, "dist", installedPath),
    },
  );
});

test("Electron installation status identifies a missing executable after valid markers", () => {
  const packageRoot = temporaryPackageRoot();
  const installedPath = platformExecutablePath("darwin");
  writeMarker(packageRoot, "path.txt", `${installedPath}\n`);
  writeMarker(packageRoot, "dist/version", "v41.7.1\n");

  const result = installationStatus({ manifest: { version: "41.7.1" }, packageRoot });

  assert.equal(result.ok, false);
  assert.match(result.reason, /Electron executable is missing/);
});
