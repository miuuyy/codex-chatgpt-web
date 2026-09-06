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

  assert.equal(localizeRuntimeMessage(copy, "Checking ChatGPT connector"), "ChatGPT コネクタを確認中");
  assert.equal(
    localizeRuntimeMessage(copy, "Responses proxy is healthy on 127.0.0.1:7841", "proxy"),
    "Responses プロキシは 127.0.0.1:7841 で正常に動作しています",
  );
  assert.equal(
    localizeRuntimeMessage(copy, "Pinned openai/tunnel-client binary is installed", "tunnel-binary"),
    "固定バージョンの openai/tunnel-client バイナリがインストールされています",
  );
  assert.equal(
    localizeRuntimeMessage(copy, "Tunnel runtime key is stored privately", "tunnel-key"),
    "トンネルのランタイムキーは安全に保存されています",
  );
  assert.equal(
    localizeRuntimeMessage(copy, "Launcher owns the tunnel runtime", "tunnel-service"),
    "ランチャーがトンネルランタイムを管理しています",
  );
  assert.equal(
    localizeRuntimeMessage(copy, "Tunnel runtime reports healthy and ready", "tunnel-runtime"),
    "トンネルランタイムは正常で、使用可能です",
  );
  assert.equal(
    localizeRuntimeMessage(copy, 'ChatGPT connector "Codex Native2" is available', "connector"),
    "ChatGPT コネクタ「Codex Native2」を利用できます",
  );
});

test("runtime message localization preserves other languages and unknown backend messages", () => {
  const { copyFor, localizeRuntimeMessage } = loadI18nModule();
  const connector = 'ChatGPT connector "Codex Native2" is available';

  assert.equal(localizeRuntimeMessage(copyFor("en"), connector, "connector"), connector);
  assert.equal(localizeRuntimeMessage(copyFor("zh-CN"), connector, "connector"), connector);
  assert.equal(
    localizeRuntimeMessage(copyFor("ja"), "Tunnel runtime is not ready", "tunnel-runtime"),
    "Tunnel runtime is not ready",
  );
  assert.equal(
    localizeRuntimeMessage(copyFor("ja"), "Unexpected connector diagnostic", "connector"),
    "Unexpected connector diagnostic",
  );
});

test("launcher UI localizes MCP verification progress and doctor check messages", () => {
  assert.match(appSource, /localizeRuntimeMessage\(copy, operation\.message\)/);
  assert.match(appSource, /localizeRuntimeMessage\(copy, check\.message, check\.id\)/);
});
