const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");

const launcherRoot = path.resolve(__dirname, "..");

function loadTypeScriptModule(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filePath,
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, []);

  const loaded = new Module(filePath, module);
  loaded.filename = filePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(filePath));
  loaded._compile(result.outputText, filePath);
  return loaded.exports;
}

test("Japanese copy is complete and preserves established product terminology", () => {
  const { copyFor } = loadTypeScriptModule(path.join(launcherRoot, "src", "i18n.ts"));
  const english = copyFor("en");
  const chinese = copyFor("zh-CN");
  const japanese = copyFor("ja");

  assert.deepEqual(Object.keys(japanese).sort(), Object.keys(english).sort());
  assert.equal(english.setup, "Setup");
  assert.equal(chinese.setup, "设置");
  assert.equal(japanese.setup, "セットアップ");
  assert.equal(japanese.language, "言語");
  assert.equal(japanese.japanese, "日本語");
  assert.equal(japanese.install, "モデルをインストール");
  assert.equal(japanese.healthy, "正常");
  assert.equal(japanese.updateAvailable, "更新あり：");
  assert.match(japanese.mcpStepThreeBody, /Authentication（認証）をNone/);
  assert.match(japanese.mcpStepThreeBody, /Allow all actions（すべての操作を許可）/);
  assert.match(japanese.mcpStepThreeBody, /Allow low-risk actions（低リスク操作のみ許可）/);
});

test("onboarding, settings, and Electron validation accept Japanese", () => {
  const appSource = fs.readFileSync(path.join(launcherRoot, "src", "App.tsx"), "utf8");
  const typeSource = fs.readFileSync(path.join(launcherRoot, "src", "types.ts"), "utf8");
  const electronMain = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");

  assert.match(typeSource, /Language = "en" \| "zh-CN" \| "ja"/);
  assert.match(appSource, /active=\{selectedLanguage === "ja"\}[\s\S]*?marker="日"[\s\S]*?setSelectedLanguage\("ja"\)/);
  assert.match(appSource, /\{ label: copy\.japanese, value: "ja" \}/);
  assert.match(appSource, /<LanguageMenu copy=\{copy\} language=\{language\}/);
  assert.match(electronMain, /if \(!isValidLanguage\(value\)\)/);
  assert.match(electronMain, /stateStore\.update\(\{ language: validateLanguage\(language\) \}\)[\s\S]*?refreshTrayMenuSafely\(state\.language, logger\)/);
  assert.match(electronMain, /language === "ja"[\s\S]*?Codex Web GPTを削除/);
});
