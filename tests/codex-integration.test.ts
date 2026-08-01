import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateCodexIntegration,
  deactivateCodexIntegration,
  getCodexHome,
  getCodexJournalPath,
  getCodexModelsCachePath,
  installCodexIntegration,
  inspectCodexIntegration,
  preflightCodexIntegration,
  readCodexModelContextOverride,
  uninstallCodexIntegration,
} from "../src/codex-integration";
import { defaultConfig } from "../src/config";

const roots: string[] = [];

const MANAGED_COMMENT = "# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.";
const MANAGED_PROVIDER_BLOCK = [
  "# Managed by codex-chatgpt-web; the local route has no Responses WebSocket, so this pins HTTP/SSE.",
  "[model_providers.codex-chatgpt-web]",
  'name = "OpenAI"',
  'base_url = "http://127.0.0.1:17841/v1"',
  'wire_api = "responses"',
  "requires_openai_auth = true",
  "supports_websockets = false",
  "supports_standalone_web_search = true",
].join("\n");

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

  test("installs an HTTP-only managed provider so Codex never opens a WebSocket to the local route", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = `model = "gpt-5.6-sol"\n\n[features]\ngoals = true\n`;
    writeFileSync(configPath, original);

    const journal = installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(journal.version).toBe(5);
    expect(journal.installed.model_provider).toBe("codex-chatgpt-web");
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).toMatch(/^model_provider = "codex-chatgpt-web"$/m);
    expect(installed).toContain(MANAGED_PROVIDER_BLOCK);
    expect(installed).toContain("supports_websockets = false");
    // The managed provider must stay otherwise identical to the built-in `openai` provider.
    expect(installed).toContain('name = "OpenAI"');
    expect(installed).toContain("requires_openai_auth = true");
    expect(installed).toContain("supports_standalone_web_search = true");
    expect(installed).not.toMatch(/^\s*model_catalog_json\s*=/m);

    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(uninstallCodexIntegration()).toEqual({ changed: false });
  });

  test("invalidates Codex's provider-agnostic model cache on install and uninstall", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const cachePath = getCodexModelsCachePath();
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    writeFileSync(cachePath, '{"models":["native-only"]}\n');

    installCodexIntegration(defaultConfig("browser-only"));
    expect(() => readFileSync(cachePath, "utf8")).toThrow();

    writeFileSync(cachePath, '{"models":["native-and-web"]}\n');
    uninstallCodexIntegration();
    expect(() => readFileSync(cachePath, "utf8")).toThrow();
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
    expect(installed).toMatch(/^model_provider = "codex-chatgpt-web"$/m);
    expect(installed).not.toContain("existing-provider");
    expect(installed).not.toMatch(/^\s*model_catalog_json\s*=/m);

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("preflight detects route conflicts without changing Codex or creating a journal", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\nopenai_base_url = "http://127.0.0.1:9999/v1"\n';
    writeFileSync(configPath, original);

    expect(() => preflightCodexIntegration(defaultConfig("browser-only")))
      .toThrow("--replace-codex-route");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(() => readFileSync(getCodexJournalPath(), "utf8")).toThrow();
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

  test("disconnects and reconnects the bridge without losing the prior route or journal", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\napproval_policy = "never"\nopenai_base_url = "https://native.example/v1"\n';
    writeFileSync(configPath, original);

    installCodexIntegration(defaultConfig("browser-only"), { replaceExistingRoute: true });
    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false });
    expect(deactivateCodexIntegration()).toEqual({ changed: false, active: false });

    expect(activateCodexIntegration()).toEqual({ changed: true, active: true });
    const reconnected = readFileSync(configPath, "utf8");
    expect(reconnected).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
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
    installCodexIntegration(defaultConfig("browser-only"));
    deactivateCodexIntegration();

    expect(JSON.parse(readFileSync(getCodexJournalPath(), "utf8"))).toMatchObject({
      version: 5,
      active: false,
    });
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: false, errors: [] });
    expect(readFileSync(configPath, "utf8")).toBe('model = "gpt-5.6-sol"\n');
  });

  test("upgrades an existing v3 route journal when it is disconnected for the first time", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n';
    writeFileSync(configPath, original);
    // A v3 install only rewrote openai_base_url; it never wrote a managed provider.
    writeFileSync(
      configPath,
      `model = "gpt-5.6-sol"\n${MANAGED_COMMENT}\nopenai_base_url = "http://127.0.0.1:17841/v1"\n`,
    );
    mkdirSync(join(getCodexJournalPath(), ".."), { recursive: true });
    writeFileSync(getCodexJournalPath(), `${JSON.stringify({
      version: 3,
      configPath,
      installed: { openai_base_url: "http://127.0.0.1:17841/v1" },
      previous: {
        openai_base_url: { present: false },
        model_provider: { present: false },
        model_catalog_json: { present: false },
      },
      format: { lineEnding: "\n", trailingNewline: true },
    }, null, 2)}\n`);

    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(JSON.parse(readFileSync(getCodexJournalPath(), "utf8"))).toMatchObject({
      version: 5,
      active: false,
      installed: { model_provider: "codex-chatgpt-web" },
    });
  });

  test("upgrades a live v4 base-url-only route to the managed HTTP-only provider", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const original = 'model = "gpt-5.6-sol"\n';
    writeFileSync(configPath, original);
    writeFileSync(
      configPath,
      `model = "gpt-5.6-sol"\n${MANAGED_COMMENT}\nopenai_base_url = "http://127.0.0.1:17841/v1"\n`,
    );
    mkdirSync(join(getCodexJournalPath(), ".."), { recursive: true });
    writeFileSync(getCodexJournalPath(), `${JSON.stringify({
      version: 4,
      active: true,
      configPath,
      installed: { openai_base_url: "http://127.0.0.1:17841/v1" },
      previous: {
        openai_base_url: { present: false },
        model_provider: { present: false },
        model_catalog_json: { present: false },
      },
      format: { lineEnding: "\n", trailingNewline: true },
    }, null, 2)}\n`);

    const journal = installCodexIntegration(defaultConfig("browser-only"));
    expect(journal.version).toBe(5);
    const installed = readFileSync(configPath, "utf8");
    expect(installed).toMatch(/^model_provider = "codex-chatgpt-web"$/m);
    expect(installed).toContain(MANAGED_PROVIDER_BLOCK);
    expect(inspectCodexIntegration()).toMatchObject({ installed: true, active: true, errors: [] });

    uninstallCodexIntegration();
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("fails closed when the managed provider block is edited after setup", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installCodexIntegration(defaultConfig("browser-only"));
    const tampered = readFileSync(configPath, "utf8")
      .replace("[model_providers.codex-chatgpt-web]", "[model_providers.someone-else]");
    writeFileSync(configPath, tampered);

    expect(() => uninstallCodexIntegration()).toThrow("model provider block changed after setup");
    expect(readFileSync(configPath, "utf8")).toBe(tampered);
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
        model_catalog_json: { present: true, rawLine: 'model_catalog_json = "/missing/opencodex-catalog.json"', value: "/missing/opencodex-catalog.json" },
      },
    }));

    installCodexIntegration(defaultConfig("browser-only"));
    const installed = readFileSync(configPath, "utf8");
    expect(installed).not.toContain("opencodex-catalog");
    expect(installed).not.toContain("model_catalog_json");
    expect(installed).not.toContain('name = "Codex + ChatGPT Web"');
    expect(installed).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
    expect(installed).toMatch(/^model_provider = "codex-chatgpt-web"$/m);
    expect(installed).toContain(MANAGED_PROVIDER_BLOCK);
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
