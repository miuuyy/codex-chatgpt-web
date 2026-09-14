const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const { RuntimeHost } = require("../electron/runtime.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const source = (file) => fs.readFileSync(path.join(launcherRoot, file), "utf8");
function compile(input) {
  const output = ts.transpileModule(input, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  Function("module", "exports", "require", output)(loaded, loaded.exports, require);
  return loaded.exports;
}

function fixture(t, development = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-compaction-model-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "config.json");
  const original = {
    mode: "full", browserHost: "launcher", browserInteractionMode: "automatic",
    proAvailable: true, appName: "Codex Native2", tunnel: { id: "preserve-fixture" },
    ...(development ? { purpose: "dev-harness" } : {}),
  };
  fs.writeFileSync(configPath, JSON.stringify(original));
  const read = () => JSON.parse(fs.readFileSync(configPath, "utf8"));
  const host = new RuntimeHost({
    app: { getPath: () => directory, getVersion: () => "5.0.6" },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: directory, coreHome: directory,
    browserDescriptorPath: path.join(directory, "launcher-browser.json"),
    launcherProfile: development ? "development" : "production",
    supervisor: {
      readConfig: read, readSetupConfig: read,
      stopForSetup: async () => assert.fail("a preference must not stop the runtime"),
      startIfConfigured: async () => assert.fail("a preference must not restart the runtime"),
    },
    getBrowserInteractionMode: () => "automatic",
  });
  host.launcherControlEnvironment = () => ({ CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: "fixture-token" });
  const calls = [];
  // The CLI subprocess is the only external boundary; the getter reads actual persisted JSON.
  host.run = async (name, args, options) => {
    calls.push({ name, args, options });
    const value = args[development ? 3 : 2];
    const config = read();
    if (value === "follow") delete config.compactionModel;
    else config.compactionModel = value;
    fs.writeFileSync(configPath, JSON.stringify(config));
    return { code: 0, stdout: "", stderr: "" };
  };
  return { host, calls, read, original, directory };
}

test("compaction model choices roundtrip through config-only production and DEV commands", async (t) => {
  for (const development of [false, true]) {
    const { host, calls, read, original, directory } = fixture(t, development);
    const prefix = development ? ["dev"] : [];
    assert.equal(host.compactionModel(), null);
    for (const value of ["extra-high", "5.6-pro", "5.5-pro", null]) {
      assert.deepEqual(await host.setCompactionModel(value), { compactionModel: value });
      const call = calls.at(-1);
      assert.deepEqual(call.args, [...prefix, "config", "compaction-model", value ?? "follow", "--launcher-control"]);
      assert.equal(call.options.env.CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN, "fixture-token");
      if (development) {
        assert.equal(call.options.embedded, true);
        assert.equal(call.options.environment.CODEX_WEB_GPT_DEV_HOME, directory);
      }
      assert.deepEqual(read(), { ...original, ...(value ? { compactionModel: value } : {}) });
    }
    assert.equal(calls.length, 4);
    assert.deepEqual(await host.setCompactionModel(null), { compactionModel: null });
    assert.equal(calls.length, 4, "saving the already-selected default is a no-op");
  }
});

test("compaction model rejects invalid values and verifies persistence instead of trusting command output", async (t) => {
  const { host, read, original } = fixture(t);
  host.run = async () => assert.fail("invalid values must not invoke the CLI");
  for (const value of [undefined, "follow", "xhigh", "pro", "6-pro", 1, {}]) {
    await assert.rejects(host.setCompactionModel(value), /Compaction model must be/);
  }
  host.run = async () => ({ code: 0, stdout: '{"compactionModel":"5.6-pro"}', stderr: "" });
  await assert.rejects(host.setCompactionModel("5.6-pro"), /did not persist/);
  assert.deepEqual(read(), original);
  host.runtimeConfigSnapshot = () => ({ configured: false });
  await assert.rejects(host.setCompactionModel("extra-high"), /Install the Codex integration/);
});

test("preload and main IPC validate and persist all compaction model choices", async (t) => {
  const { host, read, original, calls } = fixture(t);
  const parsed = ts.createSourceFile("main.cjs", source("electron/main.cjs"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const validator = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "validateCompactionModel");
  const register = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "registerIpc");
  const registration = register.body.statements.find((node) => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression)
    && node.expression.arguments[0]?.text === "launcher:compaction-model");
  assert.ok(validator && registration, "the production validation and IPC handler must exist");
  const handlers = new Map();
  // Execute production registration without Electron startup or browser/network side effects.
  Function("handle", "runtimeHost", `${validator.getText(parsed)}\n${registration.getText(parsed)}`)(
    (channel, handler) => handlers.set(channel, handler), host,
  );
  let api;
  Function("require", source("electron/preload.cjs"))((name) => {
    assert.equal(name, "electron");
    return {
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
      ipcRenderer: { invoke: async (channel, value) => handlers.get(channel)({}, value) },
    };
  });
  for (const value of ["extra-high", "5.6-pro", "5.5-pro", null]) {
    assert.deepEqual(await api.setCompactionModel(value), { compactionModel: value });
    assert.equal(read().compactionModel ?? null, value);
  }
  const callsBeforeInvalid = calls.length;
  for (const invalid of [undefined, "follow", "xhigh", "pro", "6-pro", {}]) {
    await assert.rejects(api.setCompactionModel(invalid), /Compaction model must be/);
  }
  assert.equal(calls.length, callsBeforeInvalid);
  assert.deepEqual(read(), original);
});

test("native compaction model menu renders localized choices and preserves selected values", () => {
  const { copyFor } = compile(source("src/i18n.ts"));
  const parsed = ts.createSourceFile("App.tsx", source("src/App.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const menu = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "CompactionModelMenu");
  assert.ok(menu, "the renderer compaction model menu must exist");
  const { CompactionModelMenu } = compile(`export ${menu.getText(parsed)}`);
  for (const language of ["en", "zh-CN", "ja"]) {
    const copy = copyFor(language);
    const selected = [];
    const element = CompactionModelMenu({ copy, disabled: false, value: null, onChange: (value) => selected.push(value) });
    assert.equal(element.props["aria-label"], copy.compactionModel);
    assert.equal(element.props.value, "");
    assert.deepEqual(element.props.children.map((option) => option.props.value), ["", "extra-high", "5.6-pro", "5.5-pro"]);
    assert.equal(copy.compactionModelExtraHigh, "GPT-5.6 Extra High");
    assert.equal(copy.compactionModel56Pro, "GPT-5.6 Pro");
    assert.equal(copy.compactionModel55Pro, "GPT-5.5 Pro");
    assert.ok(copy.compactionModelFollow.length > 0);
    assert.match(renderToStaticMarkup(element), /value="" selected=""/);
    for (const value of ["extra-high", "5.6-pro", "5.5-pro", ""]) element.props.onChange({ target: { value } });
    assert.deepEqual(selected, ["extra-high", "5.6-pro", "5.5-pro", null]);
    const disabled = CompactionModelMenu({ copy, disabled: true, value: "5.5-pro", onChange() {} });
    assert.match(renderToStaticMarkup(disabled), /disabled=""/);
    assert.match(renderToStaticMarkup(disabled), /value="5.5-pro" selected=""/);
  }
});
