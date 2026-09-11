import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateCodexIntegration,
  installCodexIntegration,
  preflightCodexIntegration,
  uninstallCodexIntegration,
} from "../src/codex-integration";
import { defaultConfig } from "../src/config";
import { preflightSetup } from "../src/setup";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolate(): { root: string; codexHome: string } {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-external-route-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = join(root, "app");
  mkdirSync(join(root, "app"), { recursive: true });
  return { root, codexHome };
}

test("external-provider setup never writes Codex config or models cache", () => {
  const { codexHome } = isolate();
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  const fixture = `openai_base_url = "http://127.0.0.1:1455/v1"\nmodel_provider = "opencodex"\n`;
  writeFileSync(join(codexHome, "config.toml"), fixture);
  writeFileSync(join(process.env.CODEX_CHATGPT_WEB_HOME!, "config.json"), `${JSON.stringify(config)}\n`);

  expect(() => preflightCodexIntegration(config, { replaceExistingRoute: true }))
    .toThrow(/external-provider mode/);
  expect(() => installCodexIntegration(config, { replaceExistingRoute: true }))
    .toThrow(/external-provider mode/);
  expect(() => activateCodexIntegration()).toThrow(/external-provider mode/);
  expect(uninstallCodexIntegration(config)).toEqual({ changed: false });
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(fixture);
  expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
});

test("external-provider preflight refuses --replace-codex-route before any Codex write", () => {
  isolate();
  expect(() => preflightSetup({
    mode: "browser-only",
    integrationMode: "external-provider",
    replaceCodexRoute: true,
    acknowledgedUnofficial: true,
  })).toThrow(/cannot be used in external-provider mode/);
});

test("direct setup still owns Codex routing by default", () => {
  const { codexHome } = isolate();
  const config = defaultConfig("browser-only");
  writeFileSync(join(codexHome, "config.toml"), "model = \"gpt-5.6-sol\"\n");
  const journal = installCodexIntegration(config, { replaceExistingRoute: true });
  expect(journal.active).toBe(true);
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain("openai_base_url");
});
