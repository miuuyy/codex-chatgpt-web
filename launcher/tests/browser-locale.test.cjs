const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const languages = require("../electron/languages.json");
const { localeForEmbeddedBrowser } = require("../electron/browser-locale.cjs");

test("embedded browser follows the configured launcher language", () => {
  for (const [language, details] of Object.entries(languages)) {
    const expected = language === "en" ? "en-US" : details.locale;
    assert.equal(localeForEmbeddedBrowser(language), expected);
  }
});

test("unconfigured or invalid language preserves Chromium's default", () => {
  for (const language of [null, undefined, "", "unknown", "__proto__", {}]) {
    assert.equal(localeForEmbeddedBrowser(language), null);
  }
});

test("Chromium locale is configured before Electron becomes ready", () => {
  const source = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  const localeSwitch = source.indexOf('app.commandLine.appendSwitch("lang", browserLocale)');
  assert.ok(localeSwitch >= 0);
  assert.ok(source.indexOf("const browserLocale = localeForEmbeddedBrowser(stateStore.read().language)") < localeSwitch);
  assert.ok(localeSwitch < source.indexOf("await app.whenReady()"));
});
