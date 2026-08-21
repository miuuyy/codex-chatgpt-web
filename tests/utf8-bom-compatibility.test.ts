import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCodexJournalPath,
  installCodexIntegration,
  preflightCodexIntegration,
  uninstallCodexIntegration,
} from "../src/codex-integration";
import { defaultConfig, getConfigPath, loadConfig, saveConfig, stripUtf8Bom } from "../src/config";

const BOM = "\uFEFF";
const roots: string[] = [];

function fixture() {
  const root = join(tmpdir(), `codex-chatgpt-web-bom-${process.pid}-${Date.now()}-${Math.random()}`);
  const codexHome = join(root, "codex");
  const appHome = join(root, "app");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(appHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  roots.push(root);
  return { codexHome, appHome };
}

afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("UTF-8 BOM compatibility", () => {
  test("strips only one leading UTF-8 BOM", () => {
    expect(stripUtf8Bom(`${BOM}{}`)).toBe("{}");
    expect(stripUtf8Bom(`x${BOM}y`)).toBe(`x${BOM}y`);
  });

  test("loads and saves bridge configuration without changing its BOM convention", () => {
    fixture();
    const config = defaultConfig("browser-only");
    writeFileSync(getConfigPath(), `${BOM}${JSON.stringify(config, null, 2)}\n`);

    const loaded = loadConfig();
    saveConfig(loaded);

    expect(readFileSync(getConfigPath(), "utf8").startsWith(BOM)).toBe(true);
  });

  test("preserves a Codex TOML BOM through install, preflight, and uninstall", () => {
    const { codexHome } = fixture();
    const path = join(codexHome, "config.toml");
    const original = `${BOM}model = "gpt-5.6-sol"\n`;
    writeFileSync(path, original);
    const config = defaultConfig("browser-only");

    installCodexIntegration(config);
    expect(readFileSync(path, "utf8").startsWith(BOM)).toBe(true);
    preflightCodexIntegration(config);
    writeFileSync(getCodexJournalPath(), `${BOM}${readFileSync(getCodexJournalPath(), "utf8")}`);
    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});
