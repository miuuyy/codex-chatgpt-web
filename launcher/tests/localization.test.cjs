const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");

const englishReadme = read("README.md");
const frenchReadme = read("README.fr.md");
const chineseReadme = read("README.zh-CN.md");
const japaneseReadme = read("README.ja.md");
const koreanReadme = read("README.ko.md");
const languages = require("../electron/languages.json");
const appSource = read("launcher", "src", "App.tsx");

function loadI18nModule() {
  const source = read("launcher", "src", "i18n.ts");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
    },
  }).outputText;
  const loaded = { exports: {} };
  Function("module", "exports", "require", output)(loaded, loaded.exports, require);
  return loaded.exports;
}

function loadNativeLocalization() {
  const main = read("launcher", "electron", "main.cjs");
  const copySource = main.slice(main.indexOf("const NATIVE_COPY ="), main.indexOf("function updateTrayMenu("));
  const validation = main.slice(main.indexOf("function validateLanguage("), main.indexOf("function validateBrowserInteractionMode("));
  return Function("languages", `${copySource}\n${validation}\nreturn {NATIVE_COPY, nativeCopyFor, validateLanguage};`)(languages);
}

function placeholders(value) {
  return [...value.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => match[1]).sort();
}

function commandFences(source) {
  return [...source.matchAll(/```(bash|powershell)\r?\n([\s\S]*?)```/g)]
    .map((match) => `${match[1]}\n${match[2].replace(/\r\n/g, "\n").trim()}`);
}

function linkTargets(source) {
  const markdown = [...source.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]);
  const html = [...source.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  return [...new Set([...markdown, ...html])].sort();
}

test("localized READMEs preserve every command block and link target from English", () => {
  for (const source of [frenchReadme, chineseReadme, japaneseReadme, koreanReadme]) {
    assert.deepEqual(commandFences(source), commandFences(englishReadme));
    assert.deepEqual(linkTargets(source), linkTargets(englishReadme));
  }
});


for (const language of Object.keys(languages).filter(language => language !== "en")) test(`${language} runtime localization preserves literal connector names and endpoints`, () => {
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  const copy = copyFor(language);
  const connectorNames = [
    "Codex Native2",
    "Native $&",
    "Native $'",
    "Native $`",
    "Native $1",
    'Native "quoted"',
    "Native \\path",
    "Native \u2028X",
    "Native \u2029X",
  ];

  for (const connectorName of connectorNames) {
    const message = `ChatGPT connector ${JSON.stringify(connectorName)} is available`;
    assert.equal(
      localizeRuntimeMessage(copy, message, "connector", language),
      copy.doctorConnectorAvailable.replace("{name}", () => connectorName),
    );
  }

  assert.equal(
    localizeRuntimeMessage(copy, "Responses proxy is healthy on 127.0.0.1:17841", "proxy", language),
    copy.doctorProxyHealthy.replace("{endpoint}", () => "127.0.0.1:17841"),
  );
});

test("runtime message localization preserves other languages and unknown backend messages", () => {
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  const connectorNames = ["Codex Native2", "Native $&", "Native $'", "Native $`", 'Native "quoted"', "Native \\path"];

  for (const language of ["en"]) {
    for (const connectorName of connectorNames) {
      const connector = `ChatGPT connector ${JSON.stringify(connectorName)} is available`;
      assert.equal(localizeRuntimeMessage(copyFor(language), connector, "connector", language), connector);
    }
    assert.equal(
      localizeRuntimeMessage(copyFor(language), "Checking ChatGPT connector", undefined, language),
      "Checking ChatGPT connector",
    );
  }
  assert.equal(
    localizeRuntimeMessage(copyFor("ja"), "Tunnel runtime is not ready", "tunnel-runtime", "ja"),
    "Tunnel runtime is not ready",
  );
  assert.equal(
    localizeRuntimeMessage(copyFor("ja"), "Unexpected connector diagnostic", "connector", "ja"),
    "Unexpected connector diagnostic",
  );
  assert.equal(
    localizeRuntimeMessage(copyFor("ja"), 'ChatGPT connector "unterminated is available', "connector", "ja"),
    'ChatGPT connector "unterminated is available',
  );
  assert.equal(
    localizeRuntimeMessage(copyFor("ja"), 'ChatGPT connector "Codex Native2" is available', "wrong-id", "ja"),
    'ChatGPT connector "Codex Native2" is available',
  );
  assert.equal(
    localizeRuntimeMessage(copyFor("ja"), "Checking ChatGPT connector", "unknown-check", "ja"),
    "Checking ChatGPT connector",
  );
  assert.equal(
    localizeRuntimeMessage(copyFor("ja"), 'ChatGPT connector "Codex Native2" is available (warning)', "connector", "ja"),
    'ChatGPT connector "Codex Native2" is available (warning)',
  );
});

test("launcher UI localizes MCP verification progress and doctor check messages", () => {
  assert.match(appSource, /localizeMessage\(localizeRuntimeMessage\(copy, operation\.message, undefined, language\), language\)/);
  assert.match(
    appSource,
    /localizeMessage\(localizeRuntimeMessage\(copy, check\.message, check\.id, language\), language\)/,
  );
  assert.doesNotMatch(appSource, /check\.status === "ok"\s*\?\s*localizeRuntimeMessage/);
});



test("native dialogs and IPC accept exactly the renderer's supported languages", () => {
  const { NATIVE_COPY, nativeCopyFor, validateLanguage } = loadNativeLocalization();
  assert.deepEqual(Object.keys(NATIVE_COPY).sort(), Object.keys(languages).sort());
  assert.deepEqual(languages.fr, { label: "Français", marker: "FR", locale: "fr-FR" });
  const english = nativeCopyFor("en");
  assert.ok(Object.isFrozen(NATIVE_COPY));
  for (const language of Object.keys(languages)) {
    assert.equal(validateLanguage(language), language);
    const copy = nativeCopyFor(language);
    assert.ok(Object.isFrozen(copy));
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(english).sort());
    for (const [key, value] of Object.entries(copy)) {
      assert.ok(typeof value === "string" && value.trim(), `${language}.${key} must be translated`);
      assert.deepEqual(placeholders(value), placeholders(english[key]), `${language}.${key} must preserve placeholders`);
      if (language !== "en") assert.notEqual(value, english[key], `${language}.${key} must not fall back to English`);
    }
  }
  for (const language of ["__proto__", "constructor", "toString", "unknown", null, [], {}, 42]) {
    assert.throws(() => validateLanguage(language), /Language must/);
    assert.equal(nativeCopyFor(language), english);
  }
});

test("renderer catalogs preserve every key and placeholder in all registered languages", () => {
  const { copyFor } = loadI18nModule();
  const english = copyFor("en");
  for (const language of Object.keys(languages)) {
    const copy = copyFor(language);
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(english).sort(), `${language} keys`);
    for (const [key, value] of Object.entries(copy)) {
      assert.ok(typeof value === "string" && value.trim(), `${language}.${key} must not be blank`);
      assert.deepEqual(placeholders(value), placeholders(english[key]), `${language}.${key} placeholders`);
    }
    if (language !== "en") {
      for (const key of ["chooseLanguage", "setupTitle", "settings", "continue", "install"]) {
        assert.notEqual(copy[key], english[key], `${language}.${key} must not silently use English`);
      }
    }
  }
});

test("tray labels update immediately for each registered language", () => {
  const main = read("launcher", "electron", "main.cjs");
  const { nativeCopyFor } = loadNativeLocalization();
  const source = main.slice(main.indexOf("function updateTrayMenu("), main.indexOf("function createTray("));
  let template;
  let opens = 0;
  let quits = 0;
  const updateTrayMenu = Function("tray", "Menu", "nativeCopyFor", "showMainWindow", "requestQuit",
    `${source}\nreturn updateTrayMenu;`)(
    { setContextMenu: value => { template = value; } },
    { buildFromTemplate: value => value },
    nativeCopyFor,
    () => { opens++; },
    async () => { quits++; },
  );
  for (const language of Object.keys(languages)) {
    updateTrayMenu(language);
    assert.deepEqual(template.map(item => item.label).filter(Boolean), [nativeCopyFor(language).openLauncher, nativeCopyFor(language).quit]);
    template[0].click();
    template[2].click();
  }
  assert.equal(opens, Object.keys(languages).length);
  assert.equal(quits, Object.keys(languages).length);
});

test("native export and removal dialogs use the selected language without changing file formats or actions", async () => {
  const main = read("launcher", "electron", "main.cjs");
  const { nativeCopyFor } = loadNativeLocalization();
  const exportSource = main.slice(main.indexOf('handle("launcher:export-logs",'), main.indexOf('handle("launcher:update-install",'));
  const removeSource = main.slice(main.indexOf('handle("launcher:uninstall-integration",'), main.indexOf('handle("launcher:setup-core",'));
  for (const language of Object.keys(languages)) {
    const handlers = new Map();
    const copy = nativeCopyFor(language);
    const dialogs = [];
    Function("handle", "stateStore", "nativeCopyFor", "dialog", "mainWindow", "app", "path", "IS_DEV_PROFILE",
      `${exportSource}\n${removeSource}`)(
      (channel, callback) => handlers.set(channel, callback),
      { read: () => ({ language }) }, nativeCopyFor,
      {
        showSaveDialog: async (_owner, options) => { dialogs.push(options); return { canceled: true }; },
        showMessageBox: async (_owner, options) => { dialogs.push(options); return { response: 0 }; },
      },
      {}, { getPath: () => "/synthetic-documents" }, path, false,
    );
    assert.equal(await handlers.get("launcher:export-logs")(), null);
    assert.deepEqual(await handlers.get("launcher:uninstall-integration")(), { cancelled: true });
    const [exportDialog, removeDialog] = dialogs;
    assert.equal(exportDialog.title, copy.exportDiagnostics);
    assert.equal(exportDialog.buttonLabel, copy.saveDiagnostics);
    assert.deepEqual(exportDialog.filters, [{ name: copy.diagnosticFileType, extensions: ["jsonl"] }]);
    assert.match(exportDialog.defaultPath, /codex-web-gpt-diagnostics-\d{4}-\d{2}-\d{2}\.jsonl$/);
    assert.equal(removeDialog.title, copy.removeTitle);
    assert.equal(removeDialog.message, copy.removeMessage);
    assert.equal(removeDialog.detail, copy.removeDetail);
    assert.deepEqual(removeDialog.buttons, [copy.cancel, copy.remove]);
    assert.equal(removeDialog.cancelId, 0);
    assert.equal(removeDialog.defaultId, 0);
  }
});

test("startup failure dialogs localize their message and retain the original diagnostic", async () => {
  const main = read("launcher", "electron", "main.cjs");
  const { nativeCopyFor } = loadNativeLocalization();
  const source = main.slice(main.indexOf("void start().catch(")).replace("void start()", "return start()");
  const failure = "Synthetic startup failure: C:\\sample $&\\file.json {status}";
  for (const language of Object.keys(languages)) {
    let options;
    let fatalLog;
    let exitCode;
    await Function("start", "app", "fs", "path", "browserHost", "browserControl", "mainWindow", "showMainWindow",
      "createStateStore", "nativeCopyFor", "process", "dialog", `let startupFailed = false; let quitting = false; ${source}`)(
      async () => { throw new Error(failure); },
      { getPath: () => "/synthetic-logs", whenReady: async () => {}, exit: code => { exitCode = code; } },
      { appendFileSync: (_path, value) => { fatalLog = value; } }, path,
      { destroy() {} }, { close: async () => {} }, { isDestroyed: () => false }, () => {},
      () => ({ read: () => ({ language }) }), nativeCopyFor, { argv: ["launcher"] },
      { showMessageBox: async (_owner, value) => { options = value; return { response: 1 }; } },
    );
    const copy = nativeCopyFor(language);
    assert.equal(options.title, copy.startupTitle);
    assert.equal(options.message, copy.startupMessage);
    assert.equal(options.detail, `${copy.startupDetail}\n${copy.technicalDetails}: ${failure}`);
    assert.deepEqual(options.buttons, [copy.retry, copy.quit]);
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 1);
    assert.equal(exitCode, 1);
    assert.ok(fatalLog.includes(failure), "the original error must remain available in the log");
  }
});

test("all locales translate known doctor success checks without changing literal diagnostic data", () => {
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  const fixturePath = "C:\\sample $&\\config.toml";
  const checks = [
    [undefined, "Checking local runtime", "checkingLocalRuntime"],
    [undefined, "Checking ChatGPT connector", "checkingChatGptConnector"],
    ["tunnel-binary", "Pinned openai/tunnel-client binary is installed", "doctorTunnelBinaryInstalled"],
    ["tunnel-key", "Tunnel runtime key is stored privately", "doctorTunnelKeyStored"],
    ["tunnel-service", "Launcher owns the tunnel runtime", "doctorTunnelRuntimeOwned"],
    ["tunnel-runtime", "Tunnel runtime reports healthy and ready", "doctorTunnelRuntimeReady"],
    ["config", `Configuration is valid (${fixturePath})`, "doctorConfigValid", "{path}", fixturePath],
    ["browser-host", "Embedded launcher browser is authenticated and reachable (pid 345)", "doctorBrowserReady", "{pid}", "345"],
    ["browser-host", "Embedded launcher browser is reachable for Zero Risk (pid 678)", "doctorManualBrowserReady", "{pid}", "678"],
    ["codex", "Codex native model route is installed", "doctorCodexInstalled"],
    ["service", "Launcher owns the background runtime", "doctorRuntimeOwned"],
    ["chrome", `Chrome executable found: ${fixturePath}`, "doctorChromeFound", "{path}", fixturePath],
    ["login", "ChatGPT login state has authenticated browser evidence", "doctorLoginVerified"],
    ["service", "macOS background service is loaded", "doctorMacServiceLoaded"],
    ["tunnel-service", "macOS tunnel service is installed, loaded, and running", "doctorMacTunnelRunning"],
  ];
  for (const language of Object.keys(languages)) {
    const copy = copyFor(language);
    for (const [id, message, key, placeholder, value] of checks) {
      const expected = placeholder ? copy[key].replace(placeholder, () => value) : copy[key];
      assert.equal(localizeRuntimeMessage(copy, message, id, language), expected);
      if (language !== "en") assert.notEqual(expected, message);
      assert.equal(localizeRuntimeMessage(copy, message, "wrong-check", language), message);
    }
    for (const message of ["Configuration is invalid", "Embedded launcher browser is unavailable", "Original error $& /private/path"]) {
      assert.equal(localizeRuntimeMessage(copy, message, "config", language), message);
    }
  }
  for (const language of Object.keys(languages)) {
    const copy = copyFor(language);
    assert.equal(localizeRuntimeMessage(copy, "Tunnel runtime is not ready", "tunnel-runtime", language), "Tunnel runtime is not ready");
    assert.equal(localizeRuntimeMessage(copy, "Unexpected connector diagnostic", "connector", language), "Unexpected connector diagnostic");
  }
  assert.equal(copyFor("ko").install, "모델 설치");
  assert.equal(copyFor("zh-TW").install, "安裝模型");
});
