const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(launcherRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");

const appSource = read("launcher", "src", "App.tsx");
const i18nSource = read("launcher", "src", "i18n.ts");
const languageTypes = read("launcher", "src", "types.ts");
const electronMain = read("launcher", "electron", "main.cjs");
const stateSource = read("launcher", "electron", "state.cjs");
const englishReadme = read("README.md");
const chineseReadme = read("README.zh-CN.md");
const japaneseReadme = read("README.ja.md");

function commandFences(source) {
  return [...source.matchAll(/```(bash|powershell)\n([\s\S]*?)```/g)]
    .map((match) => `${match[1]}\n${match[2].trim()}`);
}

function linkTargets(source) {
  const markdown = [...source.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1]);
  const html = [...source.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1]);
  return [...new Set([...markdown, ...html])].sort();
}

test("Japanese is a complete launcher language across state, IPC, onboarding, and Settings", () => {
  assert.match(languageTypes, /export type Language = "en" \| "zh-CN" \| "ja";/);
  assert.match(stateSource, /state\.language !== "ja"/);
  assert.match(electronMain, /value !== "ja"/);
  assert.match(i18nSource, /const ja: Record<keyof typeof en, string> = \{/);
  assert.match(i18nSource, /if \(language === "ja"\) return ja as Copy;/);
  assert.match(appSource, /active=\{selectedLanguage === "ja"\}/);
  assert.match(appSource, /onClick=\{\(\) => setSelectedLanguage\("ja"\)\}/);
  assert.match(appSource, /\{ label: copy\.japanese, value: "ja" \}/);
  assert.match(appSource, /<LanguageMenu copy=\{copy\} language=\{language\}/);
  assert.match(appSource, /document\.documentElement\.lang = documentLanguage/);
  assert.match(appSource, /language === "ja" \? "ja-JP"/);
  assert.doesNotMatch(appSource, /aria-label="Close language menu"/);
  assert.doesNotMatch(appSource, /aria-label="Language"/);
});

test("native launcher dialogs and tray actions follow the persisted Japanese language", () => {
  assert.match(electronMain, /ja: Object\.freeze\(\{[\s\S]*?openLauncher: "Codex Web GPT を開く"/);
  assert.match(electronMain, /exportDiagnostics: "プライバシー保護済みの診断情報をエクスポート"/);
  assert.match(electronMain, /removeMessage: "Codex から ChatGPT Web モデルを削除し、以前のモデルルートを復元しますか？"/);
  assert.match(electronMain, /updateTrayMenu\(state\.language\)/);
  assert.match(electronMain, /createTray\(logger, stateStore\.read\(\)\.language\)/);
  assert.match(electronMain, /title: copy\.exportDiagnostics/);
  assert.match(electronMain, /buttons: \[copy\.cancel, copy\.remove\]/);
});

test("catalog refresh guidance distinguishes a full Codex restart from account login", () => {
  assert.match(i18nSource, /Signing out and back in or only closing the window is not a restart/);
  assert.match(i18nSource, /仅退出并重新登录账号或只关闭窗口不算重启/);
  assert.match(i18nSource, /サインアウト後の再ログインやウィンドウを閉じるだけでは再起動になりません/);
});

test("localized READMEs preserve every command block and link target from English", () => {
  for (const source of [chineseReadme, japaneseReadme]) {
    assert.deepEqual(commandFences(source), commandFences(englishReadme));
    assert.deepEqual(linkTargets(source), linkTargets(englishReadme));
  }
  assert.match(japaneseReadme, /Codex タスク ──Responses \+ SSE──▶/);
  assert.match(japaneseReadme, /ネイティブ UI、コンテキスト、画像、トレース、ツールライフサイクル/);
});
