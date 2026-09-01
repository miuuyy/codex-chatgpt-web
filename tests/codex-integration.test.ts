import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateCodexIntegration,
  deactivateCodexIntegration,
  getCodexHome,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
  installCodexIntegration,
  inspectCodexIntegration,
  preflightCodexIntegration,
  readCodexSubagentProtocol,
  readCodexModelContextOverride,
  readCodexOpenAiBaseUrl,
  setCodexSubagentProtocol,
  uninstallCodexIntegration,
} from "../src/codex-integration";
import { defaultConfig, loadConfig, saveConfig } from "../src/config";
import {
  MANAGED_MULTI_AGENT_V2_LINE,
  managedAgentMaxDepthLine,
} from "../src/codex-integration-shared";

const roots: string[] = [];

function nativeConfig(mode: "browser-only" | "full") {
  const config = defaultConfig(mode);
  config.subagentProtocol = "native";
  return config;
}

function compatibilityV1Config(mode: "browser-only" | "full") {
  const config = defaultConfig(mode);
  config.subagentProtocol = "compatibility-v1";
  return config;
}

function fixture(): { root: string; codexHome: string; appHome: string } {
  const root = join(tmpdir(), `codex-chatgpt-web-integration-${process.pid}-${Date.now()}-${Math.random()}`);
  const codexHome = join(root, "codex");
  const appHome = join(root, "app");
  mkdirSync(codexHome, { recursive: true });
  roots.push(root);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  return { root, codexHome, appHome };
}

afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reversible native Codex route integration", () => {
  test("expands a configured tilde Codex home consistently with launcher paths", () => {
    process.env.CODEX_HOME = "~/custom-codex-home";
    expect(getCodexHome()).toBe(join(homedir(), "custom-codex-home"));
  });

  test("reads an explicit native context override without requiring a selected model", () => {
    const { codexHome } = fixture();
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        "model_context_window = 1_000_000 # explicit override",
        "model_auto_compact_token_limit = 900_000",
        "",
      ].join("\n"),
    );

    expect(readCodexModelContextOverride()).toEqual({
      contextWindow: 1_000_000,
    });
  });

  test("reads the existing Codex route for downstream passthrough", () => {
    const { codexHome } = fixture();
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'openai_base_url = "http://127.0.0.1:4202/_codex-router/private/v1"',
        "",
      ].join("\n"),
    );

    expect(readCodexOpenAiBaseUrl())
      .toBe("http://127.0.0.1:4202/_codex-router/private/v1");
  });

  test("keeps the built-in openai provider without changing native feature defaults", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = `model = "gpt-5.6-sol"\n\n[features]\nmulti_agent = false # user choice\ngoals = true\n`;
    writeFileSync(configPath, original);

    const journal = installCodexIntegration(nativeConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(journal.version).toBe(8);
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).not.toContain("remote_compaction_v2");
    expect(installed).toContain("multi_agent = false # user choice");
    expect(installed).not.toContain("multi_agent_v2");
    expect(installed).toContain("goals = true");
    expect(installed).not.toMatch(/^\s*model_provider\s*=/m);
    expect(installed).not.toMatch(/^\s*model_catalog_json\s*=/m);
    expect(installed).not.toContain("[model_providers.codex-chatgpt-web]");
    expect(readFileSync(getCodexJournalRecoveryPath(), "utf8"))
      .toBe(readFileSync(getCodexJournalPath(), "utf8"));

    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(getCodexJournalRecoveryPath())).toBe(false);
    expect(uninstallCodexIntegration()).toEqual({ changed: false });
  });

  test("routes Codex without changing native compact or multi-agent feature flags", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      "",
      "[features]",
      "remote_compaction_v2 = true # native choice",
      "multi_agent = false # native choice",
      "multi_agent_v2 = true # native choice",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    const journal = installCodexIntegration(nativeConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("remote_compaction_v2 = true # native choice");
    expect(installed).toContain("multi_agent = false # native choice");
    expect(installed).toContain("multi_agent_v2 = true # native choice");
    expect(journal.installed).toEqual({
      openai_base_url: "http://127.0.0.1:17841/v1",
      subagent_protocol: "native",
    });

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("Compatibility V1 owns both subagent feature flags and restores the exact user lines", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      "",
      "[features]",
      "multi_agent = false # user choice",
      "multi_agent_v2 = true # user choice",
      "goals = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    const journal = installCodexIntegration(compatibilityV1Config("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(journal).toMatchObject({
      version: 8,
      installed: { subagent_protocol: "compatibility-v1", agent_max_depth: 2 },
      previousMultiAgent: { rawLine: "multi_agent = false # user choice", value: "false" },
      previousMultiAgentV2: { rawLine: "multi_agent_v2 = true # user choice", value: "true" },
    });
    expect(installed).toContain("multi_agent = true # Managed by codex-chatgpt-web");
    expect(installed).toContain("multi_agent_v2 = false # Managed by codex-chatgpt-web");
    expect(installed).toContain(managedAgentMaxDepthLine(2));
    expect(installed).toContain("goals = true");

    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(activateCodexIntegration()).toEqual({ changed: true, active: true });
    expect(readFileSync(configPath, "utf8")).toContain("multi_agent_v2 = false # Managed by codex-chatgpt-web");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("Compatibility V1 preserves a structured multi_agent_v2 table", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      "",
      "[features]",
      "multi_agent = true # native choice",
      "",
      "[features.multi_agent_v2]",
      "enabled = true # native choice",
      "hide_spawn_agent_metadata = true",
      "",
      "[agents]",
      "max_depth = 4 # user choice",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    installCodexIntegration(compatibilityV1Config("full"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("enabled = false # Managed by codex-chatgpt-web");
    expect(installed).toContain("hide_spawn_agent_metadata = true");
    expect(installed).not.toMatch(/^multi_agent_v2\s*=/m);
    expect(installed).toContain(managedAgentMaxDepthLine(4));

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("switching an installed route back to native restores feature ownership", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent_v2 = true # native choice\n';
    writeFileSync(configPath, original);
    installCodexIntegration(compatibilityV1Config("browser-only"));

    const journal = installCodexIntegration(nativeConfig("browser-only"));
    expect(journal.installed.subagent_protocol).toBe("native");
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("multi_agent_v2 = true # native choice");
    expect(installed).not.toContain(MANAGED_MULTI_AGENT_V2_LINE);

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("the explicit subagent protocol control switches an active installation both ways", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent_v2 = true # native choice\n';
    writeFileSync(configPath, original);
    const config = nativeConfig("browser-only");
    saveConfig(config);
    installCodexIntegration(config);
    expect(readCodexSubagentProtocol()).toBe("native");

    expect(setCodexSubagentProtocol(config, "compatibility-v1").installed.subagent_protocol)
      .toBe("compatibility-v1");
    expect(readCodexSubagentProtocol()).toBe("compatibility-v1");
    expect(loadConfig().subagentProtocol).toBe("compatibility-v1");
    expect(readFileSync(configPath, "utf8")).toContain(MANAGED_MULTI_AGENT_V2_LINE);

    expect(setCodexSubagentProtocol(config, "native").installed.subagent_protocol).toBe("native");
    expect(loadConfig().subagentProtocol).toBe("native");
    expect(readFileSync(configPath, "utf8")).toContain("multi_agent_v2 = true # native choice");
    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("Compatibility V1 refuses to overwrite a newer agent depth edit", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(compatibilityV1Config("browser-only"));
    const edited = readFileSync(configPath, "utf8").replace(
      managedAgentMaxDepthLine(2),
      "max_depth = 3 # user changed this after setup",
    );
    writeFileSync(configPath, edited);

    expect(() => uninstallCodexIntegration()).toThrow("max_depth changed after Compatibility V1 setup");
    expect(readFileSync(configPath, "utf8")).toBe(edited);
  });

  test("restores a missing primary journal from its exact recovery copy", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(nativeConfig("browser-only"));
    const recovery = readFileSync(getCodexJournalRecoveryPath(), "utf8");
    rmSync(getCodexJournalPath());

    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true, errors: [] });
    expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(recovery);
  });

  test("refuses different journal baselines when both match the same config", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(nativeConfig("browser-only"));
    const recovery = JSON.parse(readFileSync(getCodexJournalRecoveryPath(), "utf8"));
    recovery.previous.model_provider = { present: false, rawLine: "different but inactive evidence" };
    writeFileSync(getCodexJournalRecoveryPath(), `${JSON.stringify(recovery, null, 2)}\n`);

    expect(() => inspectCodexIntegration()).toThrow("different baselines");
  });

  test("reconciles either side of a crash between recovery intent, config, and primary commit", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(nativeConfig("browser-only"));
    const activeConfig = readFileSync(configPath, "utf8");
    const activeJournal = readFileSync(getCodexJournalPath(), "utf8");

    deactivateCodexIntegration();
    const inactiveConfig = readFileSync(configPath, "utf8");
    const inactiveJournal = readFileSync(getCodexJournalRecoveryPath(), "utf8");

    // Recovery intent and config reached disk, but primary still describes the old active state.
    writeFileSync(getCodexJournalPath(), activeJournal);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(inactiveJournal);

    // Only the next active intent reached disk; physical config and primary are still inactive.
    writeFileSync(getCodexJournalRecoveryPath(), activeJournal);
    writeFileSync(configPath, inactiveConfig);
    writeFileSync(getCodexJournalPath(), inactiveJournal);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(readFileSync(getCodexJournalRecoveryPath(), "utf8")).toBe(inactiveJournal);
    expect(readFileSync(configPath, "utf8")).not.toBe(activeConfig);
  });

  test("accepts an explicitly persisted built-in openai provider and restores it exactly", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\nmodel_provider = "openai" # explicit built-in default\n';
    writeFileSync(configPath, original);

    expect(() => preflightCodexIntegration(nativeConfig("browser-only"))).not.toThrow();
    installCodexIntegration(nativeConfig("browser-only"));
    expect(readFileSync(configPath, "utf8")).toContain(
      'model_provider = "openai" # explicit built-in default',
    );

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("preserves an explicit remote_compaction_v2 setting byte-for-byte", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nremote_compaction_v2 = true # user choice\ngoals = true\n';
    writeFileSync(configPath, original);

    installCodexIntegration(nativeConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("remote_compaction_v2 = true # user choice");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("preserves an explicit multi_agent setting byte-for-byte", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent = false # user choice\ngoals = true\n';
    writeFileSync(configPath, original);

    installCodexIntegration(nativeConfig("full"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("multi_agent = false # user choice");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("preserves an explicit multi_agent_v2 setting byte-for-byte", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent_v2 = true # user choice\ngoals = true\n';
    writeFileSync(configPath, original);

    installCodexIntegration(nativeConfig("full"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("multi_agent_v2 = true # user choice");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("preserves the structured multi_agent_v2 feature table", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      "",
      "[features]",
      "multi_agent = true",
      "",
      "[features.multi_agent_v2]",
      "enabled = true # user choice",
      "hide_spawn_agent_metadata = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    installCodexIntegration(nativeConfig("full"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain("enabled = true # user choice");
    expect(installed).toContain("hide_spawn_agent_metadata = true");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("invalidates Codex's provider-agnostic model cache on install and uninstall", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const cachePath = getCodexModelsCachePath();
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    writeFileSync(cachePath, '{"models":["native-only"]}\n');

    installCodexIntegration(nativeConfig("browser-only"));
    expect(() => readFileSync(cachePath, "utf8")).toThrow();

    writeFileSync(cachePath, '{"models":["native-and-web"]}\n');
    uninstallCodexIntegration();
    expect(() => readFileSync(cachePath, "utf8")).toThrow();
  });

  test("requires explicit replacement and preserves every non-port route assignment", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = `model = "gpt-5.6-sol"\nmodel_provider = "existing-provider"\nopenai_base_url = "http://127.0.0.1:9999/v1"\nmodel_catalog_json = "/tmp/native.json"\n\n[features]\ngoals = true\n`;
    writeFileSync(configPath, original);
    const config = nativeConfig("full");

    expect(() => installCodexIntegration(config)).toThrow("--replace-codex-route");
    installCodexIntegration(config, { replaceExistingRoute: true });
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).toContain('model_provider = "existing-provider"');
    expect(installed).toContain('model_catalog_json = "/tmp/native.json"');

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("owns only openai_base_url while active", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      'model_provider = "first-provider"',
      'model_catalog_json = "/tmp/first.json"',
      "",
      "[features]",
      "multi_agent = true",
      "goals = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    installCodexIntegration(nativeConfig("full"));
    const userEdited = readFileSync(configPath, "utf8")
      .replace('model_provider = "first-provider"', 'model_provider = "second-provider"')
      .replace('model_catalog_json = "/tmp/first.json"', 'model_catalog_json = "/tmp/second.json"')
      .replace("multi_agent = true", "multi_agent = false");
    writeFileSync(configPath, userEdited);

    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    const restored = readFileSync(configPath, "utf8");
    expect(restored).not.toContain("openai_base_url");
    expect(restored).toContain('model_provider = "second-provider"');
    expect(restored).toContain('model_catalog_json = "/tmp/second.json"');
    expect(restored).toContain("multi_agent = false");
  });

  test("preflight detects route conflicts without changing Codex or creating a journal", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\nopenai_base_url = "http://127.0.0.1:9999/v1"\n';
    writeFileSync(configPath, original);

    expect(() => preflightCodexIntegration(nativeConfig("browser-only")))
      .toThrow(/--replace-codex-route.*OpenCodex or Headroom/s);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(() => readFileSync(getCodexJournalPath(), "utf8")).toThrow();
  });

  test("updates its own route idempotently without changing the preserved baseline", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    const first = nativeConfig("browser-only");
    installCodexIntegration(first);
    const second = nativeConfig("browser-only");
    second.port = 17842;
    installCodexIntegration(second);
    expect(readFileSync(configPath, "utf8")).toContain('openai_base_url = "http://127.0.0.1:17842/v1"');
    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe('model = "gpt-5.6-sol"\n');
  });

  test("disconnects and reconnects the bridge without losing the prior route or journal", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\napproval_policy = "never"\nopenai_base_url = "https://native.example/v1"\n';
    writeFileSync(configPath, original);

    installCodexIntegration(nativeConfig("browser-only"), { replaceExistingRoute: true });
    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false });
    expect(deactivateCodexIntegration()).toEqual({ changed: false, active: false });

    expect(activateCodexIntegration()).toEqual({ changed: true, active: true });
    const reconnected = readFileSync(configPath, "utf8");
    expect(reconnected).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(reconnected).not.toContain("remote_compaction_v2");
    expect(reconnected).not.toContain("multi_agent");
    expect(reconnected).toContain('approval_policy = "never"');
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true });
    expect(activateCodexIntegration()).toEqual({ changed: false, active: true });

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("keeps a disconnected bridge disabled across process-style journal reloads", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(nativeConfig("browser-only"));
    deactivateCodexIntegration();

    expect(JSON.parse(readFileSync(getCodexJournalPath(), "utf8"))).toMatchObject({
      version: 8,
      active: false,
    });
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(readFileSync(configPath, "utf8")).toBe('model = "gpt-5.6-sol"\n');
  });

  test("upgrades an existing v3 route journal when it is disconnected for the first time", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\ngoals = true\n';
    writeFileSync(configPath, original);
    installCodexIntegration(nativeConfig("browser-only"));
    const previous = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    const legacyInstalled = readFileSync(configPath, "utf8")
      .replace(/^(?:remote_compaction_v2 = false|multi_agent = true|multi_agent_v2 = false).*\n/gm, "");
    writeFileSync(configPath, legacyInstalled);
    delete previous.active;
    delete previous.previousRemoteCompactionV2;
    delete previous.previousMultiAgent;
    delete previous.previousMultiAgentV2;
    delete previous.installed.remote_compaction_v2;
    delete previous.installed.multi_agent;
    delete previous.installed.multi_agent_v2;
    previous.version = 3;
    const legacyJournal = `${JSON.stringify(previous, null, 2)}\n`;
    writeFileSync(getCodexJournalPath(), legacyJournal);
    writeFileSync(getCodexJournalRecoveryPath(), legacyJournal);

    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(getCodexJournalPath(), "utf8"))).toMatchObject({
      version: 4,
      active: false,
    });
  });

  test("upgrades an active v4 route journal without changing native features", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n\n[features]\ngoals = true\n');
    installCodexIntegration(nativeConfig("browser-only"));
    const legacy = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    delete legacy.previousRemoteCompactionV2;
    delete legacy.previousMultiAgent;
    delete legacy.previousMultiAgentV2;
    delete legacy.installed.remote_compaction_v2;
    delete legacy.installed.multi_agent;
    delete legacy.installed.multi_agent_v2;
    legacy.version = 4;
    const legacyJournal = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(getCodexJournalPath(), legacyJournal);
    writeFileSync(getCodexJournalRecoveryPath(), legacyJournal);
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8")
        .replace(/^(?:remote_compaction_v2 = false|multi_agent = true|multi_agent_v2 = false).*\n/gm, ""),
    );

    const upgraded = installCodexIntegration(nativeConfig("browser-only"));
    expect(upgraded.version).toBe(8);
    expect(readFileSync(configPath, "utf8")).toContain("goals = true");
    expect(readFileSync(configPath, "utf8")).not.toContain("remote_compaction_v2");
    expect(readFileSync(configPath, "utf8")).not.toContain("multi_agent");
  });

});
