import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AppConfig, expandUserPath, getConfigDir, preserveUtf8Bom, stripUtf8Bom } from "./config";
import { getCodexHome, routeUrl, writeFilesWithCompensation } from "./codex-integration-shared";
import { registeredCodexHomes } from "./adapters/chatgpt-web/thread-environment";
import { refreshChatGptWebCatalogContext } from "./model-catalog";

interface ProfileConfig {
  model_catalog_json?: string;
  model_provider?: string;
  openai_base_url?: string;
  model_providers?: Record<string, { base_url?: string }>;
}

function readProfile(path: string): ProfileConfig {
  return existsSync(path) ? Bun.TOML.parse(stripUtf8Bom(readFileSync(path, "utf8"))) : {};
}

/** Static profile catalogs bypass /models, so reconcile them whenever the runtime is configured. */
export function syncCodexProfileCatalogs(config: AppConfig): string[] {
  if (config.purpose === "dev-harness") return [];
  const statePath = join(getConfigDir(), "runtime", "thread-environments.json");
  const homes = new Set([getCodexHome(), ...registeredCodexHomes(statePath)]);
  const catalogs = new Set<string>();
  for (const home of homes) {
    const profilePath = join(home, "gpt.config.toml");
    if (!existsSync(profilePath)) continue;
    const profile = readProfile(profilePath);
    const base = readProfile(join(home, "config.toml"));
    const provider = profile.model_provider ?? base.model_provider ?? "openai";
    const url = provider === "openai"
      ? profile.openai_base_url ?? base.openai_base_url
      : profile.model_providers?.[provider]?.base_url ?? base.model_providers?.[provider]?.base_url;
    // A registered account can also have a profile belonging to another bridge installation.
    if (url?.replace(/\/+$/, "") !== routeUrl(config)) continue;
    const catalog = profile.model_catalog_json ?? base.model_catalog_json;
    if (catalog === undefined) continue;
    if (typeof catalog !== "string" || !catalog.trim()) {
      throw new Error(`Invalid model_catalog_json in ${profilePath}`);
    }
    catalogs.add(realpathSync(resolve(home, expandUserPath(catalog))));
  }

  // Validate every catalog before writing any; shared catalogs are updated only once.
  const writes: Array<{ path: string; data: string }> = [];
  for (const path of catalogs) {
    const text = readFileSync(path, "utf8");
    const before = JSON.parse(stripUtf8Bom(text));
    const after = refreshChatGptWebCatalogContext(before, config);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      writes.push({ path, data: preserveUtf8Bom(`${JSON.stringify(after, null, 2)}\n`, text) });
    }
  }
  writeFilesWithCompensation(writes);
  return writes.map(write => write.path);
}
