const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
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

function linkedProfileFixture(t, linkType) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-profile-identity-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codex-profile-identity-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const homeDir = path.join(root, "home");
  const appData = path.join(root, "app-data");
  const core = path.join(homeDir, ".codex-chatgpt-web");
  const data = path.join(appData, "Codex Web GPT");
  fs.mkdirSync(core, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const coreAlias = path.join(root, "core-alias");
  const dataAlias = path.join(root, "data-alias");
  fs.symlinkSync(core, coreAlias, linkType);
  fs.symlinkSync(data, dataAlias, linkType);
  return { root, homeDir, appData, core, data, coreAlias, dataAlias, linkType };
}

for (const [label, linkType, skip] of [
  ["POSIX symlink", "dir", process.platform === "win32"],
  ["Windows junction", "junction", process.platform !== "win32"],
]) {
  test(`${label} aliases of production storage retain production identity`, { skip }, t => {
    const f = linkedProfileFixture(t, linkType);
    const ordinary = resolveLauncherProfile({ argv: [], env: {}, ...f });
    for (const env of [
      { CODEX_CHATGPT_WEB_HOME: f.coreAlias },
      { CODEX_WEB_GPT_LAUNCHER_DATA_DIR: f.dataAlias },
      { CODEX_CHATGPT_WEB_HOME: f.coreAlias, CODEX_WEB_GPT_LAUNCHER_DATA_DIR: f.dataAlias },
    ]) {
      const aliased = resolveLauncherProfile({ argv: [], env, ...f });
      assert.equal(aliased.coreHome, ordinary.coreHome);
      assert.equal(aliased.userData, ordinary.userData);
      assert.equal(aliased.browserPartition, ordinary.browserPartition);
    }
  });

  test(`${label} aliases cannot conceal either custom profile collision`, { skip }, t => {
    const f = linkedProfileFixture(t, linkType);
    for (const env of [
      { CODEX_CHATGPT_WEB_HOME: f.coreAlias, CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(f.root, "custom-data") },
      { CODEX_CHATGPT_WEB_HOME: path.join(f.root, "custom-core"), CODEX_WEB_GPT_LAUNCHER_DATA_DIR: f.dataAlias },
    ]) assert.throws(() => resolveLauncherProfile({ argv: [], env, ...f }), /separate core and launcher data homes/);
  });

  test(`${label} canonicalizes missing descendants before namespace hashing`, { skip }, t => {
    const f = linkedProfileFixture(t, linkType);
    const actual = resolveLauncherProfile({ argv: [], env: { CODEX_CHATGPT_WEB_HOME: path.join(f.core, "missing", "leaf") }, ...f });
    const aliased = resolveLauncherProfile({ argv: [], env: { CODEX_CHATGPT_WEB_HOME: path.join(f.coreAlias, "missing", "leaf") }, ...f });
    assert.equal(aliased.coreHome, actual.coreHome);
    assert.equal(aliased.userData, actual.userData);
    assert.equal(aliased.browserPartition, actual.browserPartition);
    assert.equal(fs.existsSync(actual.coreHome), false);
  });

  test(`${label} cannot share DEV core or launcher data with production`, { skip }, t => {
    const f = linkedProfileFixture(t, linkType);
    assert.throws(() => resolveLauncherProfile({ argv: ["--dev-profile"], env: { CODEX_WEB_GPT_DEV_HOME: f.coreAlias }, ...f }), /must differ from the production/);
    const devHome = path.join(f.root, "dev");
    fs.mkdirSync(devHome);
    fs.symlinkSync(f.data, path.join(devHome, "launcher"), linkType);
    assert.throws(() => resolveLauncherProfile({ argv: ["--dev-profile"], env: { CODEX_WEB_GPT_DEV_HOME: devHome }, ...f }), /must differ from the production/);
  });
}

test("POSIX case-sensitive custom homes retain distinct namespaces", { skip: process.platform === "win32" }, t => {
  const f = linkedProfileFixture(t, "dir");
  const lower = resolveLauncherProfile({ argv: [], env: { CODEX_CHATGPT_WEB_HOME: path.join(f.root, "custom") }, ...f });
  const upper = resolveLauncherProfile({ argv: [], env: { CODEX_CHATGPT_WEB_HOME: path.join(f.root, "CUSTOM") }, ...f });
  assert.notEqual(lower.browserPartition, upper.browserPartition);
});
