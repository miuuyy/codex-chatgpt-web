import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateCodexIntegration,
  deactivateCodexIntegration,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  installCodexIntegration,
  uninstallCodexIntegration,
} from "../src/codex-integration";
import { defaultConfig } from "../src/config";

const roots: string[] = [];

afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const nested of [false, true]) {
  test(`upgrades a v6 journal and restores ${nested ? "table" : "scalar"} multi_agent_v2 exactly`, () => {
    const root = join(tmpdir(), `codex-chatgpt-web-v6-${process.pid}-${Date.now()}-${nested}`);
    const codexHome = join(root, "codex");
    const appHome = join(root, "app");
    roots.push(root);
    mkdirSync(codexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    process.env.CODEX_CHATGPT_WEB_HOME = appHome;
    const configPath = join(codexHome, "config.toml");
    const v2Original = nested
      ? "\n[features.multi_agent_v2]\nenabled = true # native v2 choice\nhide_spawn_agent_metadata = true\n"
      : "multi_agent_v2 = true # native v2 choice\n";
    const original = `model = "gpt-5.6-sol"\n\n[features]\nremote_compaction_v2 = true # native compact choice\nmulti_agent = false # native agent choice\n${v2Original}`;
    writeFileSync(configPath, original);
    const route = installCodexIntegration(defaultConfig("full"));
    const routed = readFileSync(configPath, "utf8");
    const managedV2 = nested
      ? "enabled = false # Managed by codex-chatgpt-web: keeps routed Web subagent payloads readable."
      : "multi_agent_v2 = false # Managed by codex-chatgpt-web: keeps routed Web subagent payloads readable.";
    const managed = routed
      .replace("remote_compaction_v2 = true # native compact choice", "remote_compaction_v2 = false # Managed by codex-chatgpt-web: bounds retained Web image history.")
      .replace("multi_agent = false # native agent choice", "multi_agent = true # Managed by codex-chatgpt-web: enables routed Web subagents.")
      .replace(nested ? "enabled = true # native v2 choice" : "multi_agent_v2 = true # native v2 choice", managedV2);
    writeFileSync(configPath, managed);
    const feature = (rawLine: string, tableName: "features" | "features.multi_agent_v2") => ({
      present: true,
      rawLine,
      value: "true",
      tablePresent: true,
      tableName,
    });
    const journal = {
      version: 6,
      active: true,
      configPath,
      installed: {
        openai_base_url: route.installed.openai_base_url,
        remote_compaction_v2: false,
        multi_agent: true,
        multi_agent_v2: false,
      },
      previous: route.previous,
      previousRemoteCompactionV2: feature("remote_compaction_v2 = true # native compact choice", "features"),
      previousMultiAgent: { ...feature("multi_agent = false # native agent choice", "features"), value: "false" },
      previousMultiAgentV2: feature(
        nested ? "enabled = true # native v2 choice" : "multi_agent_v2 = true # native v2 choice",
        nested ? "features.multi_agent_v2" : "features",
      ),
      format: route.format,
    };
    const serialized = `${JSON.stringify(journal, null, 2)}\n`;
    writeFileSync(getCodexJournalPath(), serialized);
    writeFileSync(getCodexJournalRecoveryPath(), serialized);

    expect(installCodexIntegration(defaultConfig("full")).version).toBe(7);
    expect(deactivateCodexIntegration()).toEqual({ changed: true, active: false });
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(activateCodexIntegration()).toEqual({ changed: true, active: true });
    expect(uninstallCodexIntegration()).toEqual({ changed: true });
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });
}
