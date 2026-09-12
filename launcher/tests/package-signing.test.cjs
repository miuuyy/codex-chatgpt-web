const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Execute the real packager setup, stopping before it creates staging files.
const scriptPath = path.resolve(__dirname, "../scripts/package.cjs");
const setup = fs.readFileSync(scriptPath, "utf8").split("const staging =")[0];
function signing(platform, overrides = {}) {
  const context = {
    require,
    __dirname: path.dirname(scriptPath),
    process: { platform, arch: "arm64", argv: ["node", scriptPath], env: { GITHUB_BASE_REF: "main", ...overrides } },
  };
  return vm.runInNewContext(`${setup}\nJSON.stringify({ env, builderArgs })`, context);
}

test("certificate-free macOS PR packages explicitly use ad-hoc signing", () => {
  const { env, builderArgs } = JSON.parse(signing("darwin"));
  assert.equal(env.CSC_FOR_PULL_REQUEST, "true");
  assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.ok(builderArgs.includes("--config.mac.identity=-"));
});

test("credentialed builds retain the default PR signing protection", () => {
  for (const credentials of [{ CSC_LINK: "test-certificate" }, { CSC_NAME: "test-identity" }]) {
    const { env, builderArgs } = JSON.parse(signing("darwin", credentials));
    assert.equal(env.CSC_FOR_PULL_REQUEST, undefined);
    assert.ok(!builderArgs.includes("--config.mac.identity=-"));
  }
});

test("non-macOS builds do not opt into PR signing", () => {
  for (const platform of ["win32", "linux"]) {
    const { env, builderArgs } = JSON.parse(signing(platform));
    assert.equal(env.CSC_FOR_PULL_REQUEST, undefined);
    assert.ok(!builderArgs.includes("--config.mac.identity=-"));
  }
});
