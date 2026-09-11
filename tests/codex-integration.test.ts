import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  setCodexSubagentProtocol,
  uninstallCodexIntegration,
} from "../src/codex-integration";
import { defaultConfig, loadConfig, saveConfig } from "../src/config";
import {
  CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
  MANAGED_COMMENT,
  MANAGED_MULTI_AGENT_LINE,
  MANAGED_MULTI_AGENT_V2_LINE,
  MANAGED_ROUTE_COMMENT,
  managedAgentMaxDepthLine,
  restoreFileSnapshot,
  snapshotFile,
  writeFilesWithCompensation,
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

function tomlInterruptHook(journal: { interruptHook: { storage: string; fragment?: string } }): { fragment: string } {
  if (journal.interruptHook.storage !== "toml" || typeof journal.interruptHook.fragment !== "string") {
    throw new Error("Test requires a TOML-installed interrupt hook");
  }
  return { fragment: journal.interruptHook.fragment };
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
  test("uses an existing hooks.json without adding an inline hook definition", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const hooksPath = join(codexHome, "hooks.json");
    const originalConfig = 'model = "gpt-5.6-sol"\n';
    const originalHooks = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }] },
    });
    writeFileSync(configPath, originalConfig);
    writeFileSync(hooksPath, originalHooks);

    const journal = installCodexIntegration(nativeConfig("browser-only"));
    expect(journal.version).toBe(11);
    expect(journal.interruptHook.storage).toBe("json");
    expect(readFileSync(configPath, "utf8")).not.toContain("[[hooks.Interrupt]]");
    expect(readFileSync(configPath, "utf8")).toContain("[hooks.state.");
    expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toMatchObject({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }],
        Interrupt: [{ hooks: [{ type: "command", command: journal.interruptHook.command, timeout: 3 }] }],
      },
    });
    expect(inspectCodexIntegration().errors).toEqual([]);

    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual(JSON.parse(originalHooks));

    expect(activateCodexIntegration()).toEqual({ changed: true, active: true });
    expect(inspectCodexIntegration().errors).toEqual([]);
    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual(JSON.parse(originalHooks));
  });

  test("migrates a legacy TOML hook into an existing hooks.json", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const hooksPath = join(codexHome, "hooks.json");
    const originalConfig = 'model = "gpt-5.6-sol"\n';
    const originalHooks = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }] },
    });
    writeFileSync(configPath, originalConfig);
    const installed = installCodexIntegration(nativeConfig("browser-only"));
    expect(installed.interruptHook.storage).toBe("toml");

    const legacy = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    legacy.version = 10;
    delete legacy.interruptHook.storage;
    const legacyJournal = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(getCodexJournalPath(), legacyJournal);
    writeFileSync(getCodexJournalRecoveryPath(), legacyJournal);
    writeFileSync(hooksPath, originalHooks);

    const migrated = installCodexIntegration(nativeConfig("browser-only"));
    expect(migrated.version).toBe(11);
    expect(migrated.interruptHook.storage).toBe("json");
    expect(readFileSync(configPath, "utf8")).not.toContain("[[hooks.Interrupt]]");
    expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toMatchObject({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }],
        Interrupt: [{ hooks: [{ type: "command", command: migrated.interruptHook.command, timeout: 3 }] }],
      },
    });
    expect(inspectCodexIntegration().errors).toEqual([]);

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(JSON.parse(readFileSync(hooksPath, "utf8"))).toEqual(JSON.parse(originalHooks));
  });

  test("can run setup again after disconnecting a JSON-backed installation", () => {
    const { codexHome } = fixture();
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n');
    writeFileSync(join(codexHome, "hooks.json"), '{}\n');
    const config = nativeConfig("browser-only");
    installCodexIntegration(config);
    deactivateCodexIntegration();
    preflightCodexIntegration(config);
    installCodexIntegration(config);
    expect(inspectCodexIntegration()).toMatchObject({ active: true, errors: [] });
  });

  test("recovers a first JSON install interrupted before the JSON write", () => {
    const { codexHome } = fixture();
    const hooksPath = join(codexHome, "hooks.json");
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n');
    writeFileSync(hooksPath, '{}\n');
    installCodexIntegration(nativeConfig("browser-only"));
    rmSync(getCodexJournalPath());
    writeFileSync(hooksPath, '{}\n');
    expect(inspectCodexIntegration()).toMatchObject({ active: true, errors: [] });
    expect(readFileSync(hooksPath, "utf8")).toContain('"Interrupt"');
  });

  test("recovers an interrupted JSON update when the runtime command changes", () => {
    const { codexHome } = fixture();
    const hooksPath = join(codexHome, "hooks.json");
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n');
    writeFileSync(hooksPath, '{}\n');
    const config = nativeConfig("browser-only");
    installCodexIntegration(config);
    const previousHooks = readFileSync(hooksPath, "utf8");
    const previousJournal = readFileSync(getCodexJournalPath(), "utf8");
    const updated = installCodexIntegration({ ...config, runtimeCommand: ["/opt/new-runtime/bun", "/opt/new-runtime/cli.js"] });
    writeFileSync(getCodexJournalPath(), previousJournal);
    writeFileSync(hooksPath, previousHooks);
    expect(inspectCodexIntegration()).toMatchObject({ active: true, errors: [] });
    expect(readFileSync(hooksPath, "utf8")).toContain(updated.interruptHook.command);
  });

  test("preserves a symlinked hooks.json while applying and restoring the owned hook", () => {
    const { root, codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const target = join(root, "shared-hooks.json");
    const hooksPath = join(codexHome, "hooks.json");
    const originalHooks = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-stop"}]}]}}\n';
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    writeFileSync(target, originalHooks);
    symlinkSync(target, hooksPath);

    installCodexIntegration(nativeConfig("browser-only"));
    expect(lstatSync(hooksPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toContain('"Interrupt"');
    const journal = installCodexIntegration(nativeConfig("browser-only"));
    expect(journal.interruptHook.storage).toBe("json");
    if (journal.interruptHook.storage === "json") {
      expect(journal.interruptHook.stateKey).toBe(
        `${join(realpathSync.native(dirname(hooksPath)), "hooks.json")}:interrupt:0:0`,
      );
    }

    deactivateCodexIntegration();
    expect(lstatSync(hooksPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(JSON.parse(originalHooks));
    uninstallCodexIntegration();
    expect(lstatSync(hooksPath).isSymbolicLink()).toBe(true);
  });

  test("recovers a JSON hook write interrupted after the TOML commit", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const hooksPath = join(codexHome, "hooks.json");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    writeFileSync(hooksPath, '{"hooks":{}}\n');
    installCodexIntegration(nativeConfig("browser-only"));
    const activeConfig = readFileSync(configPath, "utf8");
    const activeJournal = readFileSync(getCodexJournalPath(), "utf8");
    deactivateCodexIntegration();
    const inactiveHooks = readFileSync(hooksPath, "utf8");
    const inactiveJournal = readFileSync(getCodexJournalPath(), "utf8");

    writeFileSync(getCodexJournalRecoveryPath(), activeJournal);
    writeFileSync(configPath, activeConfig);
    writeFileSync(getCodexJournalPath(), inactiveJournal);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true, errors: [] });
    expect(readFileSync(hooksPath, "utf8")).not.toBe(inactiveHooks);
    expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(activeJournal);
  });

  test("rejects a JSON hook journal that targets another Codex home", () => {
    const { codexHome } = fixture();
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n');
    writeFileSync(join(codexHome, "hooks.json"), '{"hooks":{}}\n');
    installCodexIntegration(nativeConfig("browser-only"));
    const journal = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    journal.interruptHook.hooksPath = join(codexHome, "elsewhere.json");
    const tampered = `${JSON.stringify(journal, null, 2)}\n`;
    writeFileSync(getCodexJournalPath(), tampered);
    writeFileSync(getCodexJournalRecoveryPath(), tampered);

    expect(inspectCodexIntegration().errors.join("\n")).toContain("active hooks JSON");
  });

  test("route install, update, switching and removal preserve a symlinked shared Codex config", () => {
    const { root, codexHome } = fixture();
    const shared = join(root, "shared");
    mkdirSync(shared, { mode: 0o750 });
    const target = join(shared, "config.toml");
    const alias = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\ngoals = true\n';
    writeFileSync(target, original, { mode: 0o640 });
    symlinkSync(join("..", "shared", "config.toml"), alias);
    const link = readlinkSync(alias);
    const linkInode = lstatSync(alias).ino;
    const directoryMode = statSync(shared).mode & 0o777;
    const fileMode = statSync(target).mode & 0o777;
    const config = nativeConfig("browser-only");
    for (const action of [
      () => installCodexIntegration(config),
      () => installCodexIntegration({ ...config, port: config.port + 1 }),
      () => deactivateCodexIntegration(),
      () => activateCodexIntegration(),
      () => setCodexSubagentProtocol(config, "compatibility-v1"),
      () => setCodexSubagentProtocol(config, "native"),
      () => uninstallCodexIntegration(),
    ]) {
      action();
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(lstatSync(alias).ino).toBe(linkInode);
      expect(readlinkSync(alias)).toBe(link);
      expect(statSync(shared).mode & 0o777).toBe(directoryMode);
      expect(statSync(target).mode & 0o777).toBe(fileMode);
      expect(inspectCodexIntegration().errors).toEqual([]);
    }
    expect(readFileSync(target, "utf8")).toBe(original);
  });

  test("config compensation preserves the link and refuses redirected or invalid targets", () => {
    const { root, codexHome } = fixture();
    const alias = join(codexHome, "config.toml");
    const target = join(root, "shared.toml");
    const other = join(root, "other.toml");
    const directory = join(root, "directory");
    writeFileSync(target, "original\n", { mode: 0o640 });
    writeFileSync(other, "other\n");
    mkdirSync(directory);
    symlinkSync(target, alias);
    const inode = lstatSync(alias).ino;
    const mode = statSync(target).mode & 0o777;
    expect(() => writeFilesWithCompensation(
      [{ path: alias, data: "changed\n", followSymlink: true }], [directory],
    )).toThrow();
    expect(readFileSync(target, "utf8")).toBe("original\n");
    expect(lstatSync(alias).ino).toBe(inode);
    expect(statSync(target).mode & 0o777).toBe(mode);

    const snapshot = snapshotFile(alias, { followSymlink: true });
    rmSync(alias);
    symlinkSync(other, alias);
    expect(() => restoreFileSnapshot(snapshot)).toThrow("symlink changed");
    expect(readFileSync(target, "utf8")).toBe("original\n");
    expect(readFileSync(other, "utf8")).toBe("other\n");
    for (const invalidTarget of [directory, join(root, "missing.toml"), alias]) {
      rmSync(alias);
      symlinkSync(invalidTarget, alias);
      expect(() => preflightCodexIntegration(nativeConfig("browser-only"))).toThrow();
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    }
  });

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

  test("keeps the built-in openai provider without changing native feature defaults", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = `model = "gpt-5.6-sol"\n\n[features]\nmulti_agent = false # user choice\ngoals = true\n`;
    writeFileSync(configPath, original);

    const journal = installCodexIntegration(nativeConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(journal.version).toBe(11);
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).toContain(
      `experimental_realtime_webrtc_call_base_url = ${JSON.stringify(CODEX_REALTIME_WEBRTC_CALL_BASE_URL)}`,
    );
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
      experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
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
      version: 11,
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

  test("Compatibility V1 preserves a multi_agent_v2 inline table byte-for-byte", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      "",
      "[features]",
      "multi_agent = true # native choice",
      'multi_agent_v2 = { enabled = true, hide_spawn_agent_metadata = false, root_agent_usage_hint_text = "Keep { context }, exactly." } # user choice',
      "goals = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    const journal = installCodexIntegration(compatibilityV1Config("full"));
    const installed = readFileSync(configPath, "utf8");
    expect(journal.previousMultiAgentV2).toMatchObject({
      inlineTable: true,
      value: "true",
      rawLine: 'multi_agent_v2 = { enabled = true, hide_spawn_agent_metadata = false, root_agent_usage_hint_text = "Keep { context }, exactly." } # user choice',
    });
    expect(installed).toContain(
      'multi_agent_v2 = { enabled = false, hide_spawn_agent_metadata = false, root_agent_usage_hint_text = "Keep { context }, exactly." } # user choice',
    );

    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(activateCodexIntegration()).toEqual({ changed: true, active: true });
    expect(readFileSync(configPath, "utf8")).toContain("multi_agent_v2 = { enabled = false,");
    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("Compatibility V1 adds enabled only inside an inline multi_agent_v2 table", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      "",
      "[features]",
      'multi_agent_v2 = { tool_namespace = "collaboration", hide_spawn_agent_metadata = true }',
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    installCodexIntegration(compatibilityV1Config("browser-only"));
    expect(readFileSync(configPath, "utf8")).toContain(
      'multi_agent_v2 = { tool_namespace = "collaboration", hide_spawn_agent_metadata = true, enabled = false }',
    );
    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("Compatibility V1 rejects a non-boolean inline multi_agent_v2 enabled value", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, "[features]\nmulti_agent_v2 = { enabled = \"false\" }\n");
    expect(() => installCodexIntegration(compatibilityV1Config("browser-only")))
      .toThrow("enabled in Codex [features].multi_agent_v2 inline table must be a boolean");
  });

  test("explicit replacement adopts a Codex-migrated inline multi_agent_v2 value", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(
      configPath,
      'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent_v2 = true # prior native choice\n',
    );
    const config = compatibilityV1Config("browser-only");
    installCodexIntegration(config);
    const migrated = readFileSync(configPath, "utf8").replace(
      MANAGED_MULTI_AGENT_V2_LINE,
      'multi_agent_v2 = { enabled = true, hide_spawn_agent_metadata = true } # migrated by Codex',
    );
    writeFileSync(configPath, migrated);

    expect(() => preflightCodexIntegration(config, { replaceExistingRoute: true })).not.toThrow();
    const journal = installCodexIntegration(config, { replaceExistingRoute: true });
    expect(journal.previousMultiAgentV2).toMatchObject({
      inlineTable: true,
      value: "true",
      rawLine: 'multi_agent_v2 = { enabled = true, hide_spawn_agent_metadata = true } # migrated by Codex',
    });
    expect(readFileSync(configPath, "utf8")).toContain(
      'multi_agent_v2 = { enabled = false, hide_spawn_agent_metadata = true } # migrated by Codex',
    );
    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toContain(
      'multi_agent_v2 = { enabled = true, hide_spawn_agent_metadata = true } # migrated by Codex',
    );
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

  test("routes Voice call creation separately and preserves every supported line ending", () => {
    for (const lineEnding of ["\n", "\r\n", "\r"] as const) {
      const { codexHome } = fixture();
      const configPath = join(codexHome, "config.toml");
      const original = ['model = "gpt-5.6-sol"', 'approval_policy = "never"', ""].join(lineEnding);
      writeFileSync(configPath, original);

      const journal = installCodexIntegration(nativeConfig("browser-only"));
      expect(journal).toMatchObject({
        version: 11,
        installed: {
          experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
        },
        previousRealtimeWebrtcCallBaseUrl: { present: false },
        format: { lineEnding, trailingNewline: true },
      });
      expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true, errors: [] });

      expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
      expect(readFileSync(configPath, "utf8")).toBe(original);
      expect(activateCodexIntegration()).toEqual({ changed: true, active: true });
      expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true, errors: [] });

      uninstallCodexIntegration();
      expect(readFileSync(configPath, "utf8")).toBe(original);
    }
  });

  test("adopts an identical explicit Voice route and restores its exact source line", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const priorVoiceLine = `experimental_realtime_webrtc_call_base_url = '${CODEX_REALTIME_WEBRTC_CALL_BASE_URL}' # user choice`;
    const original = `model = "gpt-5.6-sol"\n${priorVoiceLine}\n`;
    writeFileSync(configPath, original);

    const journal = installCodexIntegration(nativeConfig("browser-only"));
    expect(journal.previousRealtimeWebrtcCallBaseUrl).toMatchObject({
      present: true,
      rawLine: priorVoiceLine,
      value: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
    });
    expect(readFileSync(configPath, "utf8").match(/^experimental_realtime_webrtc_call_base_url\s*=/gm)).toHaveLength(1);

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("refuses a different Voice route unless replacement is explicit and reversible", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\nexperimental_realtime_webrtc_call_base_url = "https://voice.example/v1" # external owner\n';
    writeFileSync(configPath, original);

    expect(() => preflightCodexIntegration(nativeConfig("browser-only"))).toThrow("--replace-codex-route");
    expect(() => installCodexIntegration(nativeConfig("browser-only"))).toThrow("--replace-codex-route");
    expect(readFileSync(configPath, "utf8")).toBe(original);

    installCodexIntegration(nativeConfig("browser-only"), { replaceExistingRoute: true });
    expect(readFileSync(configPath, "utf8")).toContain(
      `experimental_realtime_webrtc_call_base_url = ${JSON.stringify(CODEX_REALTIME_WEBRTC_CALL_BASE_URL)}`,
    );
    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("refuses Voice route drift while connected or disconnected", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(nativeConfig("browser-only"));

    const activeEdit = readFileSync(configPath, "utf8").replace(
      CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
      "https://voice.example/changed",
    );
    writeFileSync(configPath, activeEdit);
    expect(() => deactivateCodexIntegration()).toThrow("realtime WebRTC call route changed after setup");

    writeFileSync(configPath, activeEdit.replace("https://voice.example/changed", CODEX_REALTIME_WEBRTC_CALL_BASE_URL));
    deactivateCodexIntegration();
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}experimental_realtime_webrtc_call_base_url = "https://voice.example/new"\n`);
    expect(() => activateCodexIntegration()).toThrow("realtime WebRTC call route changed while the bridge was disconnected");
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

  test("explicit setup restores a removed hook without discarding the current Codex config", () => {
    for (const ending of ["\n", "\r\n"]) {
      for (const keepRoute of [true, false]) {
        const { codexHome } = fixture();
        const configPath = join(codexHome, "config.toml");
        const original = [
          'model = "gpt-5.6-sol"',
          `experimental_realtime_webrtc_call_base_url = "${CODEX_REALTIME_WEBRTC_CALL_BASE_URL}"`,
          "", "[hooks.state]", "", "[mcp_servers.user_tool]",
          'command = "user-tool-never-executed"', "",
        ].join(ending);
        writeFileSync(configPath, original);
        const config = nativeConfig("full");
        saveConfig(config);
        const installed = installCodexIntegration(config);
        const current = keepRoute
          ? readFileSync(configPath, "utf8").replace(tomlInterruptHook(installed).fragment, "")
          : original;
        writeFileSync(configPath, current);
        const journal = readFileSync(getCodexJournalPath(), "utf8");
        const recovery = readFileSync(getCodexJournalRecoveryPath(), "utf8");

        expect(() => preflightCodexIntegration(config)).toThrow("changed after setup");
        expect(() => installCodexIntegration(config)).toThrow("changed after setup");
        expect(() => preflightCodexIntegration(config, { replaceExistingRoute: true })).not.toThrow();
        expect(readFileSync(configPath, "utf8")).toBe(current);
        expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(journal);
        expect(readFileSync(getCodexJournalRecoveryPath(), "utf8")).toBe(recovery);

        const repaired = installCodexIntegration(config, { replaceExistingRoute: true });
        const repairedText = readFileSync(configPath, "utf8");
        expect(inspectCodexIntegration().errors).toEqual([]);
        expect(repairedText.match(/^\[\[hooks\.Interrupt\]\]/gm)).toHaveLength(1);
        expect(repairedText).toContain(tomlInterruptHook(repaired).fragment);
        installCodexIntegration(config, { replaceExistingRoute: true });
        expect(readFileSync(configPath, "utf8")).toBe(repairedText);
        deactivateCodexIntegration();
        expect(readFileSync(configPath, "utf8")).toBe(original);
        activateCodexIntegration();
        expect(inspectCodexIntegration().errors).toEqual([]);
        uninstallCodexIntegration();
        expect(readFileSync(configPath, "utf8")).toBe(original);
      }
    }
  });

  test("explicit setup still refuses changed hooks, partial removal and invalid config", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n';
    writeFileSync(configPath, original);
    const config = nativeConfig("full");
    const installed = installCodexIntegration(config);
    const active = readFileSync(configPath, "utf8");
    const withoutHook = active.replace(tomlInterruptHook(installed).fragment, "");
    const journal = readFileSync(getCodexJournalPath(), "utf8");
    const recovery = readFileSync(getCodexJournalRecoveryPath(), "utf8");
    for (const current of [
      active.replace("timeout = 3", "timeout = 2"),
      active.replace(/^#.*interrupt.*\n/gm, ""),
      withoutHook + tomlInterruptHook(installed).fragment.split("[[hooks.Interrupt]]")[0],
      withoutHook + `\n[hooks.state.${JSON.stringify(installed.interruptHook.stateKey)}]\ntrusted_hash = ${JSON.stringify(installed.interruptHook.trustedHash)}\n`,
      withoutHook + '\n[[hooks.Interrupt]]\n[[hooks.Interrupt.hooks]]\ntype = "command"\ncommand = "user-modified-hook"\n',
      withoutHook + '\n[hooks]\nInterrupt = []\n',
      withoutHook + '\n[hooks]\nstate = "invalid"\n',
      withoutHook + '\n[mcp_servers.invalid\n',
    ]) {
      writeFileSync(configPath, current);
      expect(() => preflightCodexIntegration(config, { replaceExistingRoute: true })).toThrow();
      expect(() => installCodexIntegration(config, { replaceExistingRoute: true })).toThrow();
      expect(readFileSync(configPath, "utf8")).toBe(current);
      expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(journal);
      expect(readFileSync(getCodexJournalRecoveryPath(), "utf8")).toBe(recovery);
    }
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

  test("upgrades the released v9 route by adding the trusted Interrupt lifecycle hook", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n';
    writeFileSync(configPath, original);
    installCodexIntegration(nativeConfig("browser-only"));

    const legacy = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    const interruptFragment = legacy.interruptHook.fragment as string;
    const legacyConfig = readFileSync(configPath, "utf8").replace(interruptFragment, "");
    legacy.version = 9;
    delete legacy.interruptHook;
    const legacyJournal = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(configPath, legacyConfig);
    writeFileSync(getCodexJournalPath(), legacyJournal);
    writeFileSync(getCodexJournalRecoveryPath(), legacyJournal);

    preflightCodexIntegration(nativeConfig("browser-only"));
    expect(readFileSync(configPath, "utf8")).toBe(legacyConfig);
    const upgraded = installCodexIntegration(nativeConfig("browser-only"));
    expect(upgraded.version).toBe(11);
    expect(readFileSync(configPath, "utf8")).toContain(tomlInterruptHook(upgraded).fragment);
    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
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

  test("Compatibility V1 reconnect ignores unrelated keys added to a previously absent agents table", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n';
    const disconnected = `${original}\n[agents]\nenabled = true\n`;
    writeFileSync(configPath, original);

    installCodexIntegration(compatibilityV1Config("browser-only"));
    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    writeFileSync(configPath, disconnected);

    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(activateCodexIntegration()).toEqual({ changed: true, active: true });
    const active = readFileSync(configPath, "utf8");
    expect(active).toContain("enabled = true");
    expect(active).toContain(managedAgentMaxDepthLine(2));

    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(disconnected);
    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(disconnected);
  });

  test("Compatibility V1 reconnect ignores unrelated keys added to a previously absent features table", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n';
    const disconnected = `${original}\n[features]\nresponses_websockets_v2 = true\n`;
    writeFileSync(configPath, original);

    installCodexIntegration(compatibilityV1Config("browser-only"));
    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    writeFileSync(configPath, disconnected);

    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(activateCodexIntegration()).toEqual({ changed: true, active: true });
    const active = readFileSync(configPath, "utf8");
    expect(active).toContain("responses_websockets_v2 = true");
    expect(active).toContain(MANAGED_MULTI_AGENT_LINE);

    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(disconnected);
    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(disconnected);
  });

  test("keeps a disconnected bridge disabled across process-style journal reloads", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(nativeConfig("browser-only"));
    deactivateCodexIntegration();

    expect(JSON.parse(readFileSync(getCodexJournalPath(), "utf8"))).toMatchObject({
      version: 11,
      active: false,
    });
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(readFileSync(configPath, "utf8")).toBe('model = "gpt-5.6-sol"\n');
  });

  test("migrates v8 without silently taking ownership of a conflicting Voice route", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const customVoiceLine = 'experimental_realtime_webrtc_call_base_url = "https://voice.example/v1" # external owner';
    const original = `model = "gpt-5.6-sol"\n${customVoiceLine}\n`;
    writeFileSync(configPath, original);
    installCodexIntegration(nativeConfig("browser-only"), { replaceExistingRoute: true });

    const legacy = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    const interruptFragment = legacy.interruptHook.fragment as string;
    legacy.version = 8;
    delete legacy.interruptHook;
    delete legacy.installed.experimental_realtime_webrtc_call_base_url;
    delete legacy.previousRealtimeWebrtcCallBaseUrl;
    const legacyJournal = `${JSON.stringify(legacy, null, 2)}\n`;
    const legacyConfig = readFileSync(configPath, "utf8").replace(interruptFragment, "")
      .replace(MANAGED_ROUTE_COMMENT, MANAGED_COMMENT)
      .replace(/^experimental_realtime_webrtc_call_base_url\s*=.*$/m, customVoiceLine);
    writeFileSync(configPath, legacyConfig);
    writeFileSync(getCodexJournalPath(), legacyJournal);
    writeFileSync(getCodexJournalRecoveryPath(), legacyJournal);

    expect(() => preflightCodexIntegration(nativeConfig("browser-only"))).toThrow("--replace-codex-route");
    expect(() => installCodexIntegration(nativeConfig("browser-only"))).toThrow("--replace-codex-route");
    expect(readFileSync(configPath, "utf8")).toBe(legacyConfig);

    const upgraded = installCodexIntegration(
      nativeConfig("browser-only"),
      { replaceExistingRoute: true },
    );
    expect(upgraded.version).toBe(11);
    expect(upgraded.previousRealtimeWebrtcCallBaseUrl.rawLine).toBe(customVoiceLine);
    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("reconciles either side of a crash during the v8-to-v9 route upgrade", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(nativeConfig("browser-only"));
    const currentConfig = readFileSync(configPath, "utf8");
    const currentJournal = readFileSync(getCodexJournalPath(), "utf8");

    const legacy = JSON.parse(currentJournal);
    const interruptFragment = legacy.interruptHook.fragment as string;
    legacy.version = 8;
    delete legacy.interruptHook;
    delete legacy.installed.experimental_realtime_webrtc_call_base_url;
    delete legacy.previousRealtimeWebrtcCallBaseUrl;
    const legacyJournal = `${JSON.stringify(legacy, null, 2)}\n`;
    const legacyConfig = currentConfig.replace(interruptFragment, "")
      .replace(MANAGED_ROUTE_COMMENT, MANAGED_COMMENT)
      .replace(/^experimental_realtime_webrtc_call_base_url\s*=.*\n/gm, "");

    // Recovery intent reached disk, but the v8 config and primary journal are still authoritative.
    writeFileSync(configPath, legacyConfig);
    writeFileSync(getCodexJournalPath(), legacyJournal);
    writeFileSync(getCodexJournalRecoveryPath(), currentJournal);
    expect(inspectCodexIntegration().journal?.version).toBe(8);
    expect(readFileSync(getCodexJournalRecoveryPath(), "utf8")).toBe(legacyJournal);

    // Config reached v9 too, so the recovery journal is now the only matching owner record.
    writeFileSync(configPath, currentConfig);
    writeFileSync(getCodexJournalPath(), legacyJournal);
    writeFileSync(getCodexJournalRecoveryPath(), currentJournal);
    expect(inspectCodexIntegration().journal?.version).toBe(11);
    expect(readFileSync(getCodexJournalPath(), "utf8")).toBe(currentJournal);
  });

  test("upgrades an existing v3 route journal when it is disconnected for the first time", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\ngoals = true\n';
    writeFileSync(configPath, original);
    installCodexIntegration(nativeConfig("browser-only"));
    const previous = JSON.parse(readFileSync(getCodexJournalPath(), "utf8"));
    const interruptFragment = previous.interruptHook.fragment as string;
    const legacyInstalled = readFileSync(configPath, "utf8").replace(interruptFragment, "")
      .replace(MANAGED_ROUTE_COMMENT, MANAGED_COMMENT)
      .replace(/^experimental_realtime_webrtc_call_base_url\s*=.*\n/gm, "")
      .replace(/^(?:remote_compaction_v2 = false|multi_agent = true|multi_agent_v2 = false).*\n/gm, "");
    writeFileSync(configPath, legacyInstalled);
    delete previous.active;
    delete previous.previousRemoteCompactionV2;
    delete previous.previousMultiAgent;
    delete previous.previousMultiAgentV2;
    delete previous.previousRealtimeWebrtcCallBaseUrl;
    delete previous.interruptHook;
    delete previous.installed.remote_compaction_v2;
    delete previous.installed.multi_agent;
    delete previous.installed.multi_agent_v2;
    delete previous.installed.experimental_realtime_webrtc_call_base_url;
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
    const interruptFragment = legacy.interruptHook.fragment as string;
    delete legacy.interruptHook;
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
      readFileSync(configPath, "utf8").replace(interruptFragment, "")
        .replace(MANAGED_ROUTE_COMMENT, MANAGED_COMMENT)
        .replace(/^experimental_realtime_webrtc_call_base_url\s*=.*\n/gm, "")
        .replace(/^(?:remote_compaction_v2 = false|multi_agent = true|multi_agent_v2 = false).*\n/gm, ""),
    );

    const upgraded = installCodexIntegration(nativeConfig("browser-only"));
    expect(upgraded.version).toBe(11);
    expect(readFileSync(configPath, "utf8")).toContain("goals = true");
    expect(readFileSync(configPath, "utf8")).not.toContain("remote_compaction_v2");
    expect(readFileSync(configPath, "utf8")).not.toContain("multi_agent");
  });

});
