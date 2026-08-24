import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getExternalResponsesJournalPath,
  getExternalResponsesJournalRecoveryPath,
  inspectExternalResponsesIntegration,
  installExternalResponsesIntegration,
  normalizeExternalResponsesBaseUrl,
  uninstallExternalResponsesIntegration,
} from "../src/external-responses-integration";

const roots: string[] = [];

function fixture(): { root: string; codexHome: string; appHome: string } {
  const root = join(tmpdir(), `codex-external-responses-${process.pid}-${Date.now()}-${Math.random()}`);
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

describe("external Responses provider integration", () => {
  test("accepts only credential-free HTTPS /v1 endpoints", () => {
    expect(normalizeExternalResponsesBaseUrl("https://gateway.example/v1/")).toBe("https://gateway.example/v1");
    for (const value of [
      "http://gateway.example/v1",
      "https://user:secret@gateway.example/v1",
      "https://gateway.example/v1?key=secret",
      "https://gateway.example/v1#secret",
      "https://gateway.example/api",
    ]) {
      expect(() => normalizeExternalResponsesBaseUrl(value)).toThrow();
    }
  });

  test("installs the route and API key reversibly without writing the new key to its journal", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const authPath = join(codexHome, "auth.json");
    const cachePath = join(codexHome, "models_cache.json");
    const originalConfig = [
      'model = "gpt-5.6-sol"',
      'model_provider = "custom"',
      'model_catalog_json = "/tmp/custom-models.json"',
      "",
      "[features]",
      "goals = true",
      "",
    ].join("\n");
    const originalAuth = `${JSON.stringify({ OPENAI_API_KEY: "prior-api-key", tokens: { access_token: "prior-oauth" } }, null, 2)}\n`;
    writeFileSync(configPath, originalConfig, { mode: 0o600 });
    writeFileSync(authPath, originalAuth, { mode: 0o600 });
    writeFileSync(cachePath, "stale catalog\n", { mode: 0o600 });

    const result = installExternalResponsesIntegration({
      baseUrl: "https://gateway.example/v1",
      apiKey: "downstream-secret-key",
      displayName: "Example Responses bridge",
      previousLocalRouteActive: true,
    });

    expect(result).toMatchObject({ active: true, baseUrl: "https://gateway.example/v1" });
    const installedConfig = readFileSync(configPath, "utf8");
    expect(installedConfig).toContain('openai_base_url = "https://gateway.example/v1"');
    expect(installedConfig).toContain('model_provider = "custom"');
    expect(installedConfig).toContain('model_catalog_json = "/tmp/custom-models.json"');
    expect(installedConfig).toContain("goals = true");
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({ OPENAI_API_KEY: "downstream-secret-key" });
    expect(existsSync(cachePath)).toBe(false);

    const journalPath = getExternalResponsesJournalPath();
    const journal = readFileSync(journalPath, "utf8");
    expect(journal).not.toContain("downstream-secret-key");
    const parsedJournal = JSON.parse(journal);
    expect(Buffer.from(parsedJournal.previous.auth.data, "base64").toString("utf8")).toBe(originalAuth);
    if (process.platform !== "win32") expect(statSync(journalPath).mode & 0o777).toBe(0o600);
    expect(inspectExternalResponsesIntegration()).toMatchObject({
      installed: true,
      active: true,
      baseUrl: "https://gateway.example/v1",
      displayName: "Example Responses bridge",
      previousLocalRouteActive: true,
      errors: [],
    });

    expect(uninstallExternalResponsesIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(readFileSync(authPath, "utf8")).toBe(originalAuth);
    expect(existsSync(journalPath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  test("restores files that did not exist before installation", () => {
    const { codexHome } = fixture();
    installExternalResponsesIntegration({
      baseUrl: "https://gateway.example/v1",
      apiKey: "downstream-secret-key",
    });

    expect(existsSync(join(codexHome, "config.toml"))).toBe(true);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(true);
    uninstallExternalResponsesIntegration();
    expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
  });

  test("fails closed instead of overwriting newer Codex edits", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    writeFileSync(configPath, 'model = "gpt-5.6-sol"\n');
    installExternalResponsesIntegration({
      baseUrl: "https://gateway.example/v1",
      apiKey: "downstream-secret-key",
    });
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}network_access = "restricted"\n`);

    expect(() => uninstallExternalResponsesIntegration()).toThrow("do not match the active Codex files");
    expect(existsSync(getExternalResponsesJournalPath())).toBe(true);
  });

  test("rolls back an interrupted install recorded only in the recovery journal", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const authPath = join(codexHome, "auth.json");
    const originalConfig = 'model = "gpt-5.6-sol"\n';
    const originalAuth = '{"OPENAI_API_KEY":"prior"}\n';
    writeFileSync(configPath, originalConfig);
    writeFileSync(authPath, originalAuth);
    installExternalResponsesIntegration({
      baseUrl: "https://gateway.example/v1",
      apiKey: "downstream-secret-key",
    });
    const journal = JSON.parse(readFileSync(getExternalResponsesJournalRecoveryPath(), "utf8"));
    writeFileSync(configPath, Buffer.from(journal.previous.config.data, "base64"));
    writeFileSync(authPath, Buffer.from(journal.previous.auth.data, "base64"));
    rmSync(getExternalResponsesJournalPath());

    expect(inspectExternalResponsesIntegration()).toEqual({ installed: false, active: false, errors: [] });
    expect(readFileSync(configPath, "utf8")).toBe(originalConfig);
    expect(readFileSync(authPath, "utf8")).toBe(originalAuth);
    expect(existsSync(getExternalResponsesJournalRecoveryPath())).toBe(false);
  });

  test("finishes an interrupted uninstall when both journals remain", () => {
    const { codexHome } = fixture();
    const configPath = join(codexHome, "config.toml");
    const authPath = join(codexHome, "auth.json");
    const originalConfig = 'model = "gpt-5.6-sol"\n';
    const originalAuth = '{"OPENAI_API_KEY":"prior"}\n';
    writeFileSync(configPath, originalConfig);
    writeFileSync(authPath, originalAuth);
    installExternalResponsesIntegration({
      baseUrl: "https://gateway.example/v1",
      apiKey: "downstream-secret-key",
    });
    const journal = JSON.parse(readFileSync(getExternalResponsesJournalPath(), "utf8"));
    writeFileSync(configPath, Buffer.from(journal.previous.config.data, "base64"));
    writeFileSync(authPath, Buffer.from(journal.previous.auth.data, "base64"));

    expect(inspectExternalResponsesIntegration()).toEqual({ installed: false, active: false, errors: [] });
    expect(existsSync(getExternalResponsesJournalPath())).toBe(false);
    expect(existsSync(getExternalResponsesJournalRecoveryPath())).toBe(false);
  });
});
