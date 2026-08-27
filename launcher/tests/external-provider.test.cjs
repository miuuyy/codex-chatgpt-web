const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  findTopLevelStringAssignment,
  inspectExternalProvider,
} = require("../electron/external-provider.cjs");

function fixtureConfig() {
  return {
    host: "127.0.0.1",
    port: 17841,
    solAvailable: true,
    proAvailable: true,
  };
}

function catalog(ids) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: ids.map((id) => ({ id })) }),
  });
}

test("top-level Codex route parsing ignores table-local lookalikes", () => {
  const text = [
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    "[provider.synthetic]",
    'openai_base_url = "https://ignored.example/v1"',
  ].join("\n");
  assert.equal(findTopLevelStringAssignment(text, "openai_base_url"), "http://127.0.0.1:10100/v1");
});

test("external provider is accepted only when one provider exposes every account-eligible web model", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-provider-"));
  try {
    fs.writeFileSync(path.join(root, "config.toml"), 'openai_base_url = "http://127.0.0.1:10100/v1"\n');
    const ids = ["light", "medium", "high", "extra-high", "pro"]
      .map((effort) => `cgw/chatgpt-web/${effort}`);
    const result = await inspectExternalProvider({
      codexHome: root,
      runtimeConfig: fixtureConfig(),
      fetchImpl: catalog(ids),
    });
    assert.equal(result.active, true);
    assert.equal(result.provider, "cgw");
    assert.deepEqual(result.verifiedModels, ids);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external provider verification fails closed for missing models, direct routes, and non-loopback routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-provider-negative-"));
  try {
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(configPath, 'openai_base_url = "http://127.0.0.1:10100/v1"\n');
    const missing = await inspectExternalProvider({
      codexHome: root,
      runtimeConfig: fixtureConfig(),
      fetchImpl: catalog(["cgw/chatgpt-web/light", "cgw/chatgpt-web/medium"]),
    });
    assert.equal(missing.active, false);
    assert.equal(missing.reason, "external-provider-models-missing");

    fs.writeFileSync(configPath, 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
    const direct = await inspectExternalProvider({
      codexHome: root,
      runtimeConfig: fixtureConfig(),
      fetchImpl: () => { throw new Error("must not fetch"); },
    });
    assert.equal(direct.reason, "direct-codex-route");

    fs.writeFileSync(configPath, 'openai_base_url = "https://provider.example/v1"\n');
    const remote = await inspectExternalProvider({
      codexHome: root,
      runtimeConfig: fixtureConfig(),
      fetchImpl: () => { throw new Error("must not fetch"); },
    });
    assert.equal(remote.reason, "external-provider-not-loopback");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
