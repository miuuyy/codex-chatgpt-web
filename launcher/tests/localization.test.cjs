const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");

const englishReadme = read("README.md");
const chineseReadme = read("README.zh-CN.md");
const japaneseReadme = read("README.ja.md");
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
  return [...source.matchAll(/```(bash|powershell)\n([\s\S]*?)```/g)]
    .map((match) => `${match[1]}\n${match[2].trim()}`);
}

function linkTargets(source) {
  const markdown = [...source.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]);
  const html = [...source.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  return [...new Set([...markdown, ...html])].sort();
}

test("localized READMEs preserve every command block and link target from English", () => {
  for (const source of [chineseReadme, japaneseReadme]) {
    assert.deepEqual(commandFences(source), commandFences(englishReadme));
    assert.deepEqual(linkTargets(source), linkTargets(englishReadme));
  }
});

test("Japanese launcher runtime messages localize connector verification and doctor success checks", () => {
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  const copy = copyFor("ja");

  assert.equal(localizeRuntimeMessage(copy, "Checking ChatGPT connector", undefined, "ja"), "ChatGPT コネクタを確認中");
  assert.equal(
    localizeRuntimeMessage(copy, "Responses proxy is healthy on 127.0.0.1:7841", "proxy", "ja"),
    "Responses プロキシは 127.0.0.1:7841 で正常に動作しています",
  );
  assert.equal(
    localizeRuntimeMessage(copy, "Pinned openai/tunnel-client binary is installed", "tunnel-binary", "ja"),
    "固定バージョンの openai/tunnel-client バイナリがインストールされています",
  );
  assert.equal(
    localizeRuntimeMessage(copy, "Tunnel runtime key is stored privately", "tunnel-key", "ja"),
    "トンネルのランタイムキーは安全に保存されています",
  );
  assert.equal(
    localizeRuntimeMessage(copy, "Launcher owns the tunnel runtime", "tunnel-service", "ja"),
    "ランチャーがトンネルランタイムを管理しています",
  );
  assert.equal(
    localizeRuntimeMessage(copy, "Tunnel runtime reports healthy and ready", "tunnel-runtime", "ja"),
    "トンネルランタイムは正常で、使用可能です",
  );
  assert.equal(
    localizeRuntimeMessage(copy, 'ChatGPT connector "Codex Native2" is available', "connector", "ja"),
    "ChatGPT コネクタ「Codex Native2」を利用できます",
  );
});

function localizedConnectorAvailable(language, connectorName) {
  if (language === "ja") return `ChatGPT コネクタ「${connectorName}」を利用できます`;
  if (language === "zh-TW") return `ChatGPT 連接器「${connectorName}」可用`;
  return `ChatGPT 连接器“${connectorName}”可用`;
}

function localizedProxyHealthy(language, endpoint) {
  if (language === "ja") return `Responses プロキシは ${endpoint} で正常に動作しています`;
  if (language === "zh-TW") return `Responses 代理在 ${endpoint} 上運作正常`;
  return `Responses 代理在 ${endpoint} 上运行正常`;
}

for (const language of ["ja", "zh-CN", "zh-TW"]) test(`${language} runtime localization preserves literal connector names and endpoints`, () => {
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
      localizedConnectorAvailable(language, connectorName),
    );
  }

  assert.equal(
    localizeRuntimeMessage(copy, "Responses proxy is healthy on 127.0.0.1:17841", "proxy", language),
    localizedProxyHealthy(language, "127.0.0.1:17841"),
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

test("Chinese diagnostics cover the same progress and successful checks as Japanese", () => {
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  const copy = copyFor("zh-CN");
  for (const [id, source, translated] of [
    [undefined, "Checking ChatGPT connector", "正在检查 ChatGPT 连接器"],
    ["tunnel-binary", "Pinned openai/tunnel-client binary is installed", "已安装固定版本的 openai/tunnel-client 二进制文件"],
    ["tunnel-key", "Tunnel runtime key is stored privately", "隧道运行时密钥已安全存储"],
    ["tunnel-service", "Launcher owns the tunnel runtime", "启动器正在管理隧道运行时"],
    ["tunnel-runtime", "Tunnel runtime reports healthy and ready", "隧道运行正常，可以使用"],
  ]) assert.equal(localizeRuntimeMessage(copy, source, id, "zh-CN"), translated);
  for (const language of ["ja", "zh-CN", "zh-TW"]) {
    assert.equal(localizeRuntimeMessage(copyFor(language), "Tunnel runtime is not ready", "tunnel-runtime", language), "Tunnel runtime is not ready");
    assert.equal(localizeRuntimeMessage(copyFor(language), "Unexpected connector diagnostic", "connector", language), "Unexpected connector diagnostic");
  }
});

test("Traditional Chinese diagnostics cover the same progress and successful checks", () => {
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  const copy = copyFor("zh-TW");
  for (const [id, source, translated] of [
    [undefined, "Checking ChatGPT connector", "正在檢查 ChatGPT 連接器"],
    ["tunnel-binary", "Pinned openai/tunnel-client binary is installed", "已安裝固定版本的 openai/tunnel-client 二進位檔"],
    ["tunnel-key", "Tunnel runtime key is stored privately", "隧道執行階段金鑰已安全儲存"],
    ["tunnel-service", "Launcher owns the tunnel runtime", "啟動器正在管理隧道執行階段"],
    ["tunnel-runtime", "Tunnel runtime reports healthy and ready", "隧道運作正常，可以使用"],
  ]) assert.equal(localizeRuntimeMessage(copy, source, id, "zh-TW"), translated);
});
