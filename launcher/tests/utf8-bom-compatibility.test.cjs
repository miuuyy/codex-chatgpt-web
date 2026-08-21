const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readJsonFile } = require("../electron/json-file.cjs");
const { RuntimeSupervisor } = require("../electron/runtime-supervisor.cjs");
const { createStateStore } = require("../electron/state.cjs");

test("launcher JSON readers accept one leading UTF-8 BOM", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-bom-"));
  try {
    const generic = path.join(root, "generic.json");
    fs.writeFileSync(generic, "\uFEFF{\"ok\":true}\n");
    assert.deepEqual(readJsonFile(generic), { ok: true });

    const statePath = path.join(root, "state.json");
    fs.writeFileSync(statePath, "\uFEFF{\"version\":1,\"language\":\"en\"}\n");
    assert.equal(createStateStore(statePath).read().language, "en");

    const configPath = path.join(root, "config.json");
    fs.writeFileSync(configPath, "\uFEFF{\"mode\":\"browser-only\"}\n");
    const supervisor = new RuntimeSupervisor({
      app: {},
      logger: {},
      sourceRoot: root,
      installedRuntimeRoot: root,
      runtimeRootProvider: () => root,
      coreHome: root,
      browserDescriptorPath: path.join(root, "browser.json"),
      publishOperation: () => {},
    });
    assert.equal(supervisor.readSetupConfig().mode, "browser-only");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
