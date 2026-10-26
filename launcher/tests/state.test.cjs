const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  SESSION_REFRESH_REMINDER_INTERVAL_MS,
  createStateStore,
  nextSessionRefreshReminderAt,
  validateSidebarState,
} = require("../electron/state.cjs");

test("prediction setting starts on and remains off after reopening the state store", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-prediction-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.equal(store.read().composerPredictionsEnabled, true);
    assert.equal(store.read().archiveRetiredChats, false);
    store.update({ archiveRetiredChats: true });
    assert.equal(createStateStore(file).read().archiveRetiredChats, true);
    store.update({ composerPredictionsEnabled: false });
    assert.equal(createStateStore(file).read().composerPredictionsEnabled, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("retired saved-chat settings are discarded while other launcher settings survive", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-saved-chat-state-"));
  const file = path.join(root, "state.json");
  try {
    const original = { ...createStateStore(file).read(), language: "ja", composerPredictionsEnabled: false,
      experimentalFreshConversationPerTurn: true, autoStart: false };
    assert.equal(Object.hasOwn(original, "useSavedChats"), false);
    for (const useSavedChats of [undefined, false, true, "retired-value"]) {
      fs.writeFileSync(file, JSON.stringify({ ...original, useSavedChats }));
      const store = createStateStore(file);
      assert.deepEqual(store.read(), original);
      store.update({});
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), original);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("launcher state persists onboarding, language, and autostart atomically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-launcher-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.deepEqual(store.read(), {
      version: 1,
      language: null,
      onboardingComplete: false,
      githubOpened: false,
      xOpened: false,
      autoStart: true,
      keepRunningOnClose: true,
      showBrowserDuringTurns: true,
      archiveRetiredChats: false,
      autoApproveToolCalls: false,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      composerPredictionsEnabled: true,
      experimentalSkillAttachments: false,
      experimentalFreshConversationPerTurn: false,
      zeroRiskProEnabled: false,
      browserSmokePassed: false,
      browserSmokeVersion: null,
      sidebarOpen: true,
      sidebarWidth: 252,
      mcpGuideStep: 0,
      sessionRefreshReminderAt: null,
    });
    store.update({
      language: "zh-CN",
      onboardingComplete: true,
      keepRunningOnClose: false,
      browserSmokePassed: true,
      browserSmokeVersion: "0.2.0",
    });
    assert.deepEqual(createStateStore(file).read(), {
      version: 1,
      language: "zh-CN",
      onboardingComplete: true,
      githubOpened: false,
      xOpened: false,
      autoStart: true,
      keepRunningOnClose: false,
      showBrowserDuringTurns: true,
      archiveRetiredChats: false,
      autoApproveToolCalls: false,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      composerPredictionsEnabled: true,
      experimentalSkillAttachments: false,
      experimentalFreshConversationPerTurn: false,
      zeroRiskProEnabled: false,
      browserSmokePassed: true,
      browserSmokeVersion: "0.2.0",
      sidebarOpen: true,
      sidebarWidth: 252,
      mcpGuideStep: 0,
      sessionRefreshReminderAt: null,
    });
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.readdirSync(root).some(name => name.includes(".tmp-")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sidebar state accepts only bounded native shell dimensions", () => {
  assert.deepEqual(validateSidebarState({ open: false, width: 300.4 }), {
    sidebarOpen: false,
    sidebarWidth: 300,
  });
  assert.throws(() => validateSidebarState({ open: "yes", width: 300 }), /invalid/);
  assert.throws(() => validateSidebarState({ open: true, width: 100 }), /between 240 and 420/);
  assert.throws(() => validateSidebarState({ open: true, width: 900 }), /between 240 and 420/);
});

test("every supported launcher language survives a state update and reload", () => {
  const languages = require("../electron/languages.json");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-locale-state-"));
  const file = path.join(root, "state.json");
  try {
    for (const language of Object.keys(languages)) {
      const store = createStateStore(file);
      store.update({ language, onboardingComplete: true });
      assert.equal(createStateStore(file).read().language, language);
      assert.equal(createStateStore(file).read().onboardingComplete, true);
    }
    for (const language of ["__proto__", "constructor", "unknown", [], {}]) {
      fs.writeFileSync(file, JSON.stringify({ version: 1, language, onboardingComplete: true }));
      const state = createStateStore(file).read();
      assert.equal(state.language, null);
      assert.equal(state.onboardingComplete, true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("persisted sidebar corruption is repaired without changing the rest of launcher state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-sidebar-state-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      language: "zh-CN",
      onboardingComplete: "yes",
      autoStart: "yes",
      experimentalFreshConversationPerTurn: "true",
      bridgeEnabled: false,
      browserSmokePassed: "yes",
      browserSmokeVersion: { invalid: true },
      sidebarOpen: "yes",
      sidebarWidth: 900,
      mcpGuideStep: 99,
      sessionRefreshReminderAt: "not-a-date",
      coreSetupComplete: "yes",
    }));
    assert.deepEqual(createStateStore(file).read(), {
      version: 1,
      language: "zh-CN",
      onboardingComplete: false,
      githubOpened: false,
      xOpened: false,
      autoStart: true,
      keepRunningOnClose: true,
      showBrowserDuringTurns: true,
      archiveRetiredChats: false,
      autoApproveToolCalls: false,
      browserInteractionMode: "automatic",
      experimentalBiggerContext: false,
      composerPredictionsEnabled: true,
      experimentalSkillAttachments: false,
      experimentalFreshConversationPerTurn: false,
      zeroRiskProEnabled: false,
      browserSmokePassed: false,
      browserSmokeVersion: null,
      sidebarOpen: true,
      sidebarWidth: 252,
      mcpGuideStep: 0,
      sessionRefreshReminderAt: null,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser interaction defaults to Automatic and preserves a completed onboarding choice", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-interaction-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.equal(store.read().browserInteractionMode, "automatic");
    store.update({ browserInteractionMode: "manual", onboardingComplete: true });
    assert.equal(createStateStore(file).read().browserInteractionMode, "manual");
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, false);
    store.update({ coreSetupComplete: true, zeroRiskProEnabled: true, experimentalFreshConversationPerTurn: true });
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, true);
    assert.equal(createStateStore(file).read().experimentalFreshConversationPerTurn, true);
    store.update({ browserInteractionMode: "automatic" });
    assert.equal(createStateStore(file).read().experimentalFreshConversationPerTurn, true);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      browserInteractionMode: "manual",
      zeroRiskProEnabled: true,
    }));
    assert.equal(createStateStore(file).read().browserInteractionMode, "automatic");
    assert.equal(createStateStore(file).read().zeroRiskProEnabled, false);
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      onboardingComplete: true,
      browserInteractionMode: "manual",
    }));
    assert.equal(createStateStore(file).read().browserInteractionMode, "manual");
    fs.writeFileSync(file, JSON.stringify({ version: 1, browserInteractionMode: "unsafe" }));
    assert.equal(createStateStore(file).read().browserInteractionMode, "automatic");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session refresh reminders are deferred by exactly 48 hours", () => {
  const now = Date.UTC(2026, 7, 5, 12, 0, 0);
  assert.equal(SESSION_REFRESH_REMINDER_INTERVAL_MS, 48 * 60 * 60 * 1000);
  assert.equal(nextSessionRefreshReminderAt(now), "2026-08-07T12:00:00.000Z");
  assert.throws(() => nextSessionRefreshReminderAt(Number.NaN), /must be finite/);
});
