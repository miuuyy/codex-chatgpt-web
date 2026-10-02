const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { resolveLauncherProfile } = require("../electron/profile.cjs");

test("DEV launcher profile isolates every durable home from production", () => {
  const homeDir = path.resolve("/Users/tester");
  const production = resolveLauncherProfile({
    argv: ["electron", "."],
    env: {},
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });
  const development = resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {},
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });

  assert.equal(production.kind, "production");
  assert.equal(development.kind, "development");
  assert.notEqual(development.coreHome, production.coreHome);
  assert.notEqual(development.codexHome, production.codexHome);
  assert.notEqual(development.userData, production.userData);
  assert.notEqual(development.browserPartition, production.browserPartition);
  assert.equal(development.userData, path.join(development.coreHome, "launcher"));
  assert.equal(development.codexHome, path.join(development.coreHome, "codex-home"));
});

test("DEV launcher refuses an explicit home collision with production", () => {
  const homeDir = path.resolve("/Users/tester");
  const shared = path.join(homeDir, "shared");
  assert.throws(() => resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {
      CODEX_WEB_GPT_DEV_HOME: shared,
      CODEX_CHATGPT_WEB_HOME: shared,
    },
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  }), /must differ from the production/);
});

test("DEV launcher ignores generic production path overrides", () => {
  const homeDir = path.resolve("/Users/tester");
  const development = resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: {
      CODEX_CHATGPT_WEB_HOME: path.join(homeDir, "production-core"),
      CODEX_HOME: path.join(homeDir, "production-codex"),
      CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(homeDir, "production-launcher"),
      CODEX_WEB_GPT_DEV_HOME: path.join(homeDir, "isolated-dev"),
    },
    homeDir,
    appData: path.join(homeDir, "Library", "Application Support"),
  });

  assert.equal(development.coreHome, path.join(homeDir, "isolated-dev"));
  assert.equal(development.codexHome, path.join(homeDir, "isolated-dev", "codex-home"));
  assert.equal(development.userData, path.join(homeDir, "isolated-dev", "launcher"));
});

test("custom production homes have separate default launcher data and partitions", () => {
  const homeDir = path.resolve("/Users/tester");
  const appData = path.join(homeDir, "AppData");
  const ordinary = resolveLauncherProfile({ argv: [], env: {}, homeDir, appData });
  const custom = resolveLauncherProfile({ argv: [], env: { CODEX_CHATGPT_WEB_HOME: path.join(homeDir, "custom") }, homeDir, appData });
  assert.notEqual(custom.userData, ordinary.userData);
  assert.notEqual(custom.browserPartition, ordinary.browserPartition);
  assert.equal(custom.userData, path.join(custom.coreHome, "launcher"));
});

test("a launcher-data-only override also isolates account configuration and secrets", () => {
  const homeDir = path.resolve("/Users/tester");
  const appData = path.join(homeDir, "AppData");
  const userData = path.join(homeDir, "custom-launcher");
  const custom = resolveLauncherProfile({ argv: [], env: { CODEX_WEB_GPT_LAUNCHER_DATA_DIR: userData }, homeDir, appData });
  assert.equal(custom.coreHome, path.join(userData, "core"));
  assert.notEqual(custom.browserPartition, "persist:codex-web-gpt-chatgpt");
});

test("explicit custom profiles reject either production storage collision", () => {
  const homeDir = path.resolve("/Users/tester");
  const appData = path.join(homeDir, "AppData");
  for (const env of [
    { CODEX_CHATGPT_WEB_HOME: path.join(homeDir, ".codex-chatgpt-web"), CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(homeDir, "custom-launcher") },
    { CODEX_CHATGPT_WEB_HOME: path.join(homeDir, "custom-core"), CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(appData, "Codex Web GPT") },
  ]) {
    assert.throws(() => resolveLauncherProfile({ argv: [], env, homeDir, appData }), /separate core and launcher data homes/);
  }
});

test("DEV home collision detection follows Windows case-insensitive paths", {skip:process.platform !== "win32"}, () => {
  const homeDir = path.resolve("/Users/tester");
  const shared = path.join(homeDir, "production-core");
  assert.throws(() => resolveLauncherProfile({
    argv: ["electron", ".", "--dev-profile"],
    env: { CODEX_CHATGPT_WEB_HOME: shared, CODEX_WEB_GPT_DEV_HOME: shared.toUpperCase() },
    homeDir, appData: path.join(homeDir, "AppData"),
  }), /must differ from the production/);
});
