const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");

const englishReadme = read("README.md");
const russianReadme = read("README.ru.md");
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
  for (const source of [russianReadme, chineseReadme, japaneseReadme, koreanReadme]) {
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
  assert.match(appSource, /localizeRuntimeMessage\(copy, operation\.message, undefined, language\)/);
  assert.match(
    appSource,
    /check\.status === "ok"\s*\?\s*localizeRuntimeMessage\(copy, check\.message, check\.id, language\)\s*:\s*check\.message/,
  );
});



test("native dialogs and IPC accept exactly the renderer's supported languages", () => {
  const main = read("launcher", "electron", "main.cjs");
  const copySource = main.slice(main.indexOf("const NATIVE_COPY ="), main.indexOf("function updateTrayMenu("));
  const validation = main.slice(main.indexOf("function validateLanguage("), main.indexOf("function validateBrowserInteractionMode("));
  const { nativeCopyFor, validateLanguage } = Function("languages", `${copySource}\n${validation}\nreturn {nativeCopyFor, validateLanguage};`)(languages);
  const english = nativeCopyFor("en");
  for (const language of Object.keys(languages)) {
    assert.equal(validateLanguage(language), language);
    const copy = nativeCopyFor(language);
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(english).sort());
    assert.ok(Object.values(copy).every(value => typeof value === "string" && value.trim()));
    if (language !== "en") for (const key of ["quit", "remove", "retry", "startupTitle"]) assert.notEqual(copy[key], english[key]);
  }
  for (const language of ["__proto__", "constructor", "unknown", null, [], {}]) assert.throws(() => validateLanguage(language), /Language must/);
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
  assert.equal(copyFor("ru").install, "Установить модели");
  assert.equal(copyFor("zh-TW").install, "安裝模型");
});
