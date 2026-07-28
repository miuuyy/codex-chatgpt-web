import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCodexJournalPath,
  installCodexIntegration,
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
  test("reads the selected model's explicit context override from Codex config", () => {
    const { codexHome } = fixture();
    writeFileSync(
      join(codexHome, "config.toml"),
      'model = "gpt-5.6-sol"\nmodel_context_window = 371_851 # explicit override\n',
    );

    expect(readCodexModelContextOverride()).toEqual({
      model: "gpt-5.6-sol",
      contextWindow: 371_851,
    });
  });

  test("installs only openai_base_url and keeps the built-in openai provider", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = `model = "gpt-5.6-sol"\n\n[features]\ngoals = true\n`;
    writeFileSync(configPath, original);

    const journal = installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(journal.version).toBe(3);
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).not.toMatch(/^\s*model_provider\s*=/m);
    expect(installed).not.toMatch(/^\s*model_catalog_json\s*=/m);
    expect(installed).not.toContain("[model_providers.codex-chatgpt-web]");

    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(uninstallCodexIntegration()).toEqual({ changed: false });
  });

  test("requires explicit replacement and restores every prior route assignment", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = `model = "gpt-5.6-sol"\nmodel_provider = "existing-provider"\nopenai_base_url = "http://127.0.0.1:9999/v1"\nmodel_catalog_json = "/tmp/native.json"\n\n[features]\ngoals = true\n`;
    writeFileSync(configPath, original);
    const config = defaultConfig("full");

    expect(() => installCodexIntegration(config)).toThrow("--replace-codex-route");
    installCodexIntegration(config, { replaceExistingRoute: true });
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).not.toMatch(/^\s*model_provider\s*=/m);
    expect(installed).not.toMatch(/^\s*model_catalog_json\s*=/m);

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("updates its own route idempotently without changing the preserved baseline", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    const first = defaultConfig("browser-only");
    installCodexIntegration(first);
    const second = defaultConfig("browser-only");
    second.port = 17842;
    installCodexIntegration(second);
    expect(readFileSync(configPath, "utf8")).toContain('openai_base_url = "http://127.0.0.1:17842/v1"');
    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe('model = "gpt-5.6-sol"\n');
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
        model_catalog_json: { present: true, rawLine: 'model_catalog_json = "/missing/opencodex-catalog.json"', value: "/missing/opencodex-catalog.json" },
      },
    }));

    installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).not.toContain("opencodex-catalog");
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

  test("accepts the managed route marker after Windows rewrites config with CRLF", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\r\n';
    writeFileSync(configPath, original);
    installCodexIntegration(defaultConfig("browser-only"));
    const windowsText = readFileSync(configPath, "utf8").replace(/\r?\n/g, "\r\n");
    writeFileSync(configPath, windowsText);

    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });
});
