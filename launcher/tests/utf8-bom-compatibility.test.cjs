const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStateStore } = require("../electron/state.cjs");
const { readWindowState } = require("../electron/window-state.cjs");

function withFile(text, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launcher-json-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, text, "utf8");
    run(file);
    assert.equal(fs.readFileSync(file, "utf8"), text, "reading must not rewrite the file");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const settings = {
  version: 1,
  language: "en",
  onboardingComplete: true,
  coreSetupComplete: true,
  autoStart: false,
  useSavedChats: false,
  autoApproveToolCalls: false,
  browserInteractionMode: "manual",
  browserSmokeVersion: "6.1.13\uFEFF-local",
};
const windowState = {
  bounds: { x: 30, y: 40, width: 1280, height: 800 },
  maximized: true,
  fullscreen: true,
};

for (const prefix of ["", "\uFEFF"]) {
  const encoding = prefix ? "with a leading UTF-8 BOM" : "without a BOM";
  test(`launcher settings retain explicit preferences ${encoding}`, () => {
    withFile(`${prefix}${JSON.stringify(settings)}\r\n`, file => {
      const restored = createStateStore(file).read();
      for (const [key, value] of Object.entries(settings)) assert.equal(restored[key], value, key);
    });
  });

  test(`window geometry and mode survive ${encoding}`, () => {
    withFile(`${prefix}${JSON.stringify(windowState)}\n`, file => {
      assert.deepEqual(readWindowState(file), windowState);
    });
  });
}

test("BOM-prefixed settings still validate fields and schema version", () => {
  const invalidFields = { ...settings, autoStart: "false", useSavedChats: "false", language: "invalid" };
  withFile(`\uFEFF${JSON.stringify(invalidFields)}`, file => {
    const state = createStateStore(file).read();
    assert.equal(state.autoStart, true);
    assert.equal(state.useSavedChats, true);
    assert.equal(state.language, null);
    assert.equal(state.onboardingComplete, true, "unrelated valid fields must survive");
    assert.equal(state.browserInteractionMode, "manual");
  });
  withFile(`\uFEFF${JSON.stringify({ ...settings, version: 2 })}`, file => {
    const state = createStateStore(file).read();
    assert.equal(state.onboardingComplete, false);
    assert.equal(state.browserInteractionMode, "automatic");
  });
});

test("BOM-prefixed window state still clamps bounds and validates mode flags", () => {
  withFile('\uFEFF{"bounds":{"width":1,"height":2},"maximized":"true","fullscreen":true}', file => {
    assert.deepEqual(readWindowState(file), {
      bounds: { width: 720, height: 600 }, maximized: false, fullscreen: true,
    });
  });
});

for (const text of ["{broken", "\uFEFF{broken", `\uFEFF\uFEFF${JSON.stringify(settings)}`]) {
  test(`malformed JSON retains the existing fallback (${JSON.stringify(text.slice(0,12))})`, () => {
    withFile(text, file => {
      const defaults = createStateStore(path.join(path.dirname(file), "missing.json")).read();
      assert.deepEqual(createStateStore(file).read(), defaults);
      assert.deepEqual(readWindowState(file), readWindowState(path.join(path.dirname(file), "missing.json")));
    });
  });
}
