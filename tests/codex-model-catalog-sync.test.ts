import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { syncCodexProfileCatalogs } from "../src/codex-model-catalog-sync";

const previousHome = process.env.CODEX_HOME;
const previousBridge = process.env.CODEX_CHATGPT_WEB_HOME;
const roots: string[] = [];
afterEach(() => {
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (previousBridge === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = previousBridge;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codex-catalog-sync-")));
  roots.push(root);
  const home = join(root, "codex");
  const orca = join(root, "orca", "account", "home");
  const bridge = join(root, "bridge");
  for (const dir of [home, orca, join(bridge, "runtime")]) mkdirSync(dir, { recursive: true });
  process.env.CODEX_HOME = home;
  process.env.CODEX_CHATGPT_WEB_HOME = bridge;
  writeFileSync(join(bridge, "runtime", "codex-homes.json"), JSON.stringify({ version: 1, homes: [home, orca] }));
  const catalog = join(home, "gpt.json");
  const original = {
    revision: "keep",
    models: [
      { slug: "gpt-6-astra", context_window: 272_000, priority: 1, custom: "native" },
      { slug: "chatgpt-web/pro", context_window: 336_579, auto_compact_token_limit: 285_000, priority: 8, custom: "web" },
      { slug: "chatgpt-web/extra-high", priority: 7 },
    ],
  };
  writeFileSync(catalog, JSON.stringify(original));
  const base = 'model = "gpt-6-astra"\n';
  writeFileSync(join(home, "config.toml"), base);
  writeFileSync(join(home, "gpt.config.toml"), `openai_base_url = "http://127.0.0.1:17841/v1"\nmodel_catalog_json = "gpt.json"\n`);
  writeFileSync(join(orca, "gpt.config.toml"), `model_provider = "chatgpt-web"\nmodel_catalog_json = ${JSON.stringify(catalog)}\n[model_providers.chatgpt-web]\nbase_url = "http://127.0.0.1:17841/v1"\n`);
  const config = { ...defaultConfig("full"), solAvailable: true, extraHighAvailable: true, proAvailable: true };
  return { home, orca, catalog, original, config, base };
}

test("reconciles shared Orca catalogs in both context modes without changing native rows or profiles", () => {
  const { home, orca, catalog, original, config, base } = fixture();
  const profile = readFileSync(join(orca, "gpt.config.toml"), "utf8");
  for (const bigger of [false, true, false]) {
    const next = { ...config, experimentalBiggerContext: bigger };
    expect(syncCodexProfileCatalogs(next)).toEqual([catalog]);
    const updated = JSON.parse(readFileSync(catalog, "utf8"));
    expect(updated.revision).toBe(original.revision);
    expect(updated.models[0]).toEqual(original.models[0]);
    expect(updated.models.map((model: { slug: string }) => model.slug)).toEqual(original.models.map(model => model.slug));
    expect(updated.models[1]).toMatchObject({
      priority: 8, custom: "web",
      context_window: bigger ? 336_579 : 112_193,
      auto_compact_token_limit: bigger ? 270_750 : 90_250,
    });
    expect(updated.models[2]).toMatchObject({
      priority: 7,
      context_window: bigger ? 333_579 : 111_193,
      auto_compact_token_limit: bigger ? 270_750 : 90_250,
    });
    expect(syncCodexProfileCatalogs(next)).toEqual([]);
  }
  expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(base);
  expect(readFileSync(join(orca, "gpt.config.toml"), "utf8")).toBe(profile);
});

test("validates all catalogs before applying any updates", () => {
  const { orca, catalog, config } = fixture();
  const before = readFileSync(catalog, "utf8");
  writeFileSync(join(orca, "bad.json"), "{invalid");
  writeFileSync(join(orca, "gpt.config.toml"), 'openai_base_url = "http://127.0.0.1:17841/v1"\nmodel_catalog_json = "bad.json"\n');
  expect(() => syncCodexProfileCatalogs(config)).toThrow();
  expect(readFileSync(catalog, "utf8")).toBe(before);
});

test("skips another bridge's profile and preserves an inherited native-only catalog", () => {
  const { home, orca, catalog, config } = fixture();
  writeFileSync(join(orca, "gpt.config.toml"), 'openai_base_url = "http://127.0.0.1:17842/v1"\nmodel_catalog_json = "missing.json"\n');
  writeFileSync(join(home, "config.toml"), 'model_catalog_json = "gpt.json"\n');
  writeFileSync(join(home, "gpt.config.toml"), 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
  const native = '{"models":[{"slug":"gpt-6-astra","context_window":272000}]}';
  writeFileSync(catalog, native);
  expect(syncCodexProfileCatalogs(config)).toEqual([]);
  expect(readFileSync(catalog, "utf8")).toBe(native);
});
