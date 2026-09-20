const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolvePreparedAppImageTools, REQUIRED_LIBNOTIFY_SYMBOL } = require("../scripts/prepare-linux-appimage-tools.cjs");

const canCompile = process.platform === "linux" && spawnSync("cc", ["--version"]).status === 0;
test("local packaging selects a validated owned toolset and honors explicit overrides", { skip: !canCompile }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appimage-tools-test-"));
  const makeTools = (name, symbol) => {
    const tools = path.join(root, name);
    const library = path.join(tools, "lib", "x64", "libnotify.so.4");
    fs.mkdirSync(path.dirname(library), { recursive: true });
    const built = spawnSync("cc", ["-shared", "-fPIC", "-x", "c", "-", "-o", library], {
      input: `void ${symbol}(void) {}\n`, encoding: "utf8",
    });
    assert.equal(built.status, 0, built.stderr);
    return tools;
  };
  try {
    const owned = makeTools("owned", REQUIRED_LIBNOTIFY_SYMBOL);
    const custom = makeTools("custom", REQUIRED_LIBNOTIFY_SYMBOL);
    const obsolete = makeTools("obsolete", "unrelated_symbol");
    assert.equal(resolvePreparedAppImageTools({}, owned), owned);
    assert.equal(resolvePreparedAppImageTools({ APPIMAGE_TOOLS_PATH: custom }, owned), custom);
    assert.throws(() => resolvePreparedAppImageTools({ APPIMAGE_TOOLS_PATH: obsolete }, owned), /does not export/);
    assert.throws(() => resolvePreparedAppImageTools({ APPIMAGE_TOOLS_PATH: path.join(root, "missing") }, owned), /No prepared AppImage libnotify/);
    assert.throws(() => resolvePreparedAppImageTools({}, path.join(root, "missing")), /prepare-linux-libnotify/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
