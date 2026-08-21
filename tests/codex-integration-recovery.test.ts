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
  readCodexModelContextOverride,
  uninstallCodexIntegration,
} from "../src/codex-integration";
import { defaultConfig } from "../src/config";

const roots: string[] = [];

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
  test("upgrades an active v5 journal and restores its managed feature baseline", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent_v2 = true # user choice\ngoals = true\n';
    writeFileSync(configPath, original);
    const routeJournal = installCodexIntegration(defaultConfig("full"));
    const installedUrl = "http://127.0.0.1:17841/v1";
    const managed = readFileSync(configPath, "utf8").replace(
      "[features]",
      `[features]\nremote_compaction_v2 = false # Managed by codex-chatgpt-web: bounds retained Web image history.\nmulti_agent = true # Managed by codex-chatgpt-web: enables routed Web subagents.`,
    );
    writeFileSync(configPath, managed);
    const legacy = {
      version: 5,
      active: true,
      configPath,
      installed: { openai_base_url: installedUrl, remote_compaction_v2: false, multi_agent: true },
      previous: routeJournal.previous,
      previousRemoteCompactionV2: { present: false, tablePresent: true, tableName: "features" },
      previousMultiAgent: { present: false, tablePresent: true, tableName: "features" },
      format: routeJournal.format,
    };
    const legacyJournal = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(getCodexJournalPath(), legacyJournal);
    writeFileSync(getCodexJournalRecoveryPath(), legacyJournal);

    const upgraded = installCodexIntegration(defaultConfig("full"));
    expect(upgraded.version).toBe(7);
    expect(readFileSync(configPath, "utf8")).toContain("multi_agent_v2 = true # user choice");
    expect(readFileSync(configPath, "utf8")).not.toContain("Managed by codex-chatgpt-web: enables routed Web subagents");

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("fails closed when the native route changes while the bridge is disconnected", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    deactivateCodexIntegration();
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\nopenai_base_url = "https://newer.example/v1"\n');

    expect(() => activateCodexIntegration()).toThrow("changed while the bridge was disconnected");
    expect(readFileSync(configPath, "utf8")).toContain("https://newer.example/v1");
  });

  test("uninstalls cleanly while the bridge is disconnected", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n';
    writeFileSync(configPath, original);
    installCodexIntegration(defaultConfig("browser-only"));
    deactivateCodexIntegration();

    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(inspectCodexIntegration()).toMatchObject({ installed: false, active: false });
  });

  test("does not apply one application home's journal to a different Codex home", () => {
    const { root, codexHome } = fixture();
    const firstConfig = join(codexHome, "config.toml");
    writeFileSync(firstConfig, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));

    const secondCodexHome = join(root, "other-codex");
    mkdirSync(secondCodexHome, { recursive: true });
    const secondConfig = join(secondCodexHome, "config.toml");
    writeFileSync(secondConfig, 'model = "gpt-5.5"\n');
    process.env.CODEX_HOME = secondCodexHome;

    expect(() => preflightCodexIntegration(defaultConfig("browser-only")))
      .toThrow("journal belongs");
    expect(readFileSync(secondConfig, "utf8")).toBe('model = "gpt-5.5"\n');
  });

  test("preserves Windows line endings and a missing final newline", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const windowsOriginal = 'model = "gpt-5.6-sol"\r\n\r\n[features]\r\ngoals = true';
    writeFileSync(configPath, windowsOriginal);

    installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain('\r\nopenai_base_url = "http://127.0.0.1:17841/v1"\r\n');
    expect(installed.endsWith("\n")).toBe(false);

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(windowsOriginal);
  });

  test("migrates the removed static-catalog integration without reviving a missing foreign catalog", () => {
    const { codexHome, appHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const managedCatalog = join(appHome, "codex", "model-catalog.json");
    mkdirSync(join(appHome, "codex"), { recursive: true });
    writeFileSync(managedCatalog, "managed\n");
    const providerBlock = '# BEGIN codex-chatgpt-web provider\n[model_providers.codex-chatgpt-web]\nname = "Codex + ChatGPT Web"\n# END codex-chatgpt-web provider';
    writeFileSync(configPath, `model = "gpt-5.6-sol"\nmodel_catalog_json = ${JSON.stringify(managedCatalog)}\nmodel_provider = "codex-chatgpt-web"\n\n${providerBlock}\n`);
    writeFileSync(getCodexJournalPath(), JSON.stringify({
      version: 2,
      configPath,
      catalogPath: managedCatalog,
      catalogSha256: new Bun.CryptoHasher("sha256").update("managed\n").digest("hex"),
      providerBlock,
      installed: { model_provider: "codex-chatgpt-web", model_catalog_json: managedCatalog },
      previous: {
        model_provider: { present: false },
        model_catalog_json: { present: true, rawLine: 'model_catalog_json = "/missing/custom-catalog.json"', value: "/missing/custom-catalog.json" },
      },
    }));

    installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).not.toContain("custom-catalog");
    expect(installed).not.toContain("model_catalog_json");
    expect(installed).not.toContain("model_provider");
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
  });

  test("fails closed when the installed route changed after setup", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    const changed = readFileSync(configPath, "utf8").replace("17841", "17842");
    writeFileSync(configPath, changed);
    expect(() => uninstallCodexIntegration()).toThrow("changed after setup");
    expect(readFileSync(configPath, "utf8")).toBe(changed);
  });

  test("explicit replacement adopts a newer Codex route as the reversible baseline", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      'openai_base_url = "https://first.example/v1"',
      "",
      "[features]",
      "remote_compaction_v2 = true # user choice",
      "multi_agent = false # user choice",
      "multi_agent_v2 = true # user choice",
      "goals = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    const config = defaultConfig("full");

    installCodexIntegration(config, { replaceExistingRoute: true });
    const changed = readFileSync(configPath, "utf8")
      .replace('openai_base_url = "http://127.0.0.1:17841/v1"', 'openai_base_url = "https://newer.example/v1"');
    writeFileSync(configPath, changed);

    expect(() => preflightCodexIntegration(config)).toThrow("changed after setup");
    expect(() => preflightCodexIntegration(config, { replaceExistingRoute: true })).not.toThrow();
    expect(readFileSync(configPath, "utf8")).toBe(changed);

    installCodexIntegration(config, { replaceExistingRoute: true });
    expect(readFileSync(configPath, "utf8")).toContain(
      'openai_base_url = "http://127.0.0.1:17841/v1"',
    );
    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(
      original.replace("https://first.example/v1", "https://newer.example/v1"),
    );
  });

  test("explicit replacement recovers a stale journal after Codex config was deleted", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    const config = defaultConfig("browser-only");
    installCodexIntegration(config);
    rmSync(configPath);

    expect(() => preflightCodexIntegration(config)).toThrow("Codex config is missing");
    expect(() => preflightCodexIntegration(config, { replaceExistingRoute: true })).not.toThrow();
    expect(() => readFileSync(configPath, "utf8")).toThrow();

    installCodexIntegration(config, { replaceExistingRoute: true });
    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe("");
  });

  test("plain setup stays fail-closed when a disconnected integration config was deleted", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    const config = defaultConfig("browser-only");
    installCodexIntegration(config);
    deactivateCodexIntegration();
    rmSync(configPath);

    expect(() => preflightCodexIntegration(config)).toThrow("Codex config is missing");
    expect(() => installCodexIntegration(config)).toThrow("Codex config is missing");
    expect(existsSync(configPath)).toBe(false);
  });

  test("explicit replacement restores still-owned provider fields while adopting a changed URL", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      'openai_base_url = "https://first.example/v1"',
      'model_provider = "openai"',
      'model_catalog_json = "/tmp/original-models.json"',
      "",
      "[features]",
      "goals = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    const config = defaultConfig("browser-only");
    installCodexIntegration(config, { replaceExistingRoute: true });
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        'openai_base_url = "http://127.0.0.1:17841/v1"',
        'openai_base_url = "https://newer.example/v1"',
      ),
    );

    installCodexIntegration(config, { replaceExistingRoute: true });
    deactivateCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(
      original.replace("https://first.example/v1", "https://newer.example/v1"),
    );
  });

  test("explicit replacement adopts a new provider while restoring the still-owned URL and catalog", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = [
      'model = "gpt-5.6-sol"',
      'openai_base_url = "https://first.example/v1"',
      'model_provider = "openai"',
      'model_catalog_json = "/tmp/original-models.json"',
      "",
      "[features]",
      "goals = true",
      "",
    ].join("\n");
    writeFileSync(configPath, original);
    const config = defaultConfig("browser-only");
    installCodexIntegration(config, { replaceExistingRoute: true });
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace(
        "\n[features]",
        '\nmodel_provider = "custom-provider"\n\n[features]',
      ),
    );

    installCodexIntegration(config, { replaceExistingRoute: true });
    deactivateCodexIntegration();
    const restored = readFileSync(configPath, "utf8");
    expect(restored).toContain('openai_base_url = "https://first.example/v1"');
    expect(restored).toContain('model_provider = "custom-provider"');
    expect(restored).toContain('model_catalog_json = "/tmp/original-models.json"');
    expect(restored).not.toContain("127.0.0.1:17841");
  });

  test("keeps every user line byte-for-byte when line endings are mixed", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\r\napproval_policy = "never"\n\r\n[features]\ngoals = true\r\n';
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    for (const line of [
      'model = "gpt-5.6-sol"\r\n',
      'approval_policy = "never"\n',
      "[features]\n",
      "goals = true\r\n",
    ]) {
      expect(installed).toContain(line);
    }
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });
});
