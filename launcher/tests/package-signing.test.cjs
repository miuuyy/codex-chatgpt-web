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
  assert.ok(builderArgs.includes("--config.mac.sign=./scripts/sign-adhoc.cjs"));
});

test("credentialed builds retain the default PR signing protection", () => {
  for (const credentials of [{ CSC_LINK: "test-certificate" }, { CSC_NAME: "test-identity" }]) {
    const { env, builderArgs } = JSON.parse(signing("darwin", credentials));
    assert.equal(env.CSC_FOR_PULL_REQUEST, undefined);
    assert.ok(!builderArgs.includes("--config.mac.identity=-"));
    assert.ok(!builderArgs.some(arg => arg.startsWith("--config.mac.sign=")));
  }
});

test("non-macOS builds do not opt into PR signing", () => {
  for (const platform of ["win32", "linux"]) {
    const { env, builderArgs } = JSON.parse(signing(platform));
    assert.equal(env.CSC_FOR_PULL_REQUEST, undefined);
    assert.ok(!builderArgs.includes("--config.mac.identity=-"));
    assert.ok(!builderArgs.some(arg => arg.startsWith("--config.mac.sign=")));
  }
});

test("ad-hoc hook overrides a matched certificate and preserves other signing options", async () => {
  const hookPath = path.resolve(__dirname, "../scripts/sign-adhoc.cjs");
  let received;
  const context = {
    module: { exports: {} },
    require(name) {
      assert.equal(name, "@electron/osx-sign");
      return { signAsync: async options => { received = options; } };
    },
  };
  vm.runInNewContext(fs.readFileSync(hookPath, "utf8"), context);
  const options = {
    app: "/example/Test.app", platform: "darwin", identity: "Developer ID Application: Example-Team (TEST)",
    identityValidation: true, hardenedRuntime: true, entitlements: "/example/entitlements.plist",
  };
  await context.module.exports(options);
  assert.deepEqual({ ...received }, { ...options, identity: "-", identityValidation: false });
  assert.equal(options.identity, "Developer ID Application: Example-Team (TEST)");
});

test("ad-hoc hook propagates signing failures", async () => {
  const hookPath = path.resolve(__dirname, "../scripts/sign-adhoc.cjs");
  const failure = new Error("codesign failed");
  const context = {
    module: { exports: {} },
    require() { return { signAsync: async () => { throw failure; } }; },
  };
  vm.runInNewContext(fs.readFileSync(hookPath, "utf8"), context);
  await assert.rejects(context.module.exports({ app: "/example/Test.app" }), error => error === failure);
});
