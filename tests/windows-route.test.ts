import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test.skipIf(process.platform !== "win32")("Windows recovery switches between bridge and native without Bun", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-route-"));
  const bridgeHome = join(root, "bridge");
  const codexHome = join(root, "codex");
  const configPath = join(codexHome, "config.toml");
  const script = resolve(import.meta.dir, "../scripts/windows-route.ps1");
  try {
    mkdirSync(join(bridgeHome, "codex"), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(configPath, [
      'openai_base_url = "http://127.0.0.1:17841/v1"',
      '# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.',
      'model = "gpt-5.6-sol"',
      "",
    ].join("\r\n"));
    writeFileSync(join(bridgeHome, "codex", "integration-journal.json"), JSON.stringify({
      version: 3,
      configPath,
      installed: { openai_base_url: "http://127.0.0.1:17841/v1" },
      previous: {
        openai_base_url: { present: false },
        model_provider: { present: false },
        model_catalog_json: { present: false },
      },
    }));

    const run = (mode: "Native" | "Bridge") => Bun.spawnSync([
      "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", script, "-Mode", mode, "-BridgeHome", bridgeHome, "-CodexHome", codexHome,
    ], { stdout: "pipe", stderr: "pipe" });

    const native = run("Native");
    expect(native.exitCode, native.stderr.toString()).toBe(0);
    expect(readFileSync(configPath, "utf8")).not.toContain("openai_base_url");

    const bridge = run("Bridge");
    expect(bridge.exitCode, bridge.stderr.toString()).toBe(0);
    expect(readFileSync(configPath, "utf8")).toContain('openai_base_url = "http://127.0.0.1:17841/v1"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("Windows recovery restores and validates every prior route assignment", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-route-prior-"));
  const bridgeHome = join(root, "bridge");
  const codexHome = join(root, "codex");
  const configPath = join(codexHome, "config.toml");
  const script = resolve(import.meta.dir, "../scripts/windows-route.ps1");
  const original = [
    'model = "gpt-5.6-sol"',
    'model_provider = "prior-provider"',
    'openai_base_url = "http://127.0.0.1:9999/v1"',
    'model_catalog_json = "C:\\\\catalogs\\\\native.json"',
    "",
    "[features]",
    "goals = true",
    "",
  ].join("\r\n");
  try {
    mkdirSync(join(bridgeHome, "codex"), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(configPath, [
      'model = "gpt-5.6-sol"',
      'openai_base_url = "http://127.0.0.1:17841/v1"',
      '# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.',
      "",
      "[features]",
      "goals = true",
      "",
    ].join("\r\n"));
    writeFileSync(join(bridgeHome, "codex", "integration-journal.json"), JSON.stringify({
      version: 3,
      configPath,
      installed: { openai_base_url: "http://127.0.0.1:17841/v1" },
      previous: {
        openai_base_url: { present: true, index: 2, rawLine: 'openai_base_url = "http://127.0.0.1:9999/v1"' },
        model_provider: { present: true, index: 1, rawLine: 'model_provider = "prior-provider"' },
        model_catalog_json: { present: true, index: 3, rawLine: 'model_catalog_json = "C:\\\\catalogs\\\\native.json"' },
      },
    }));

    const run = (mode: "Native" | "Bridge") => Bun.spawnSync([
      "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", script, "-Mode", mode, "-BridgeHome", bridgeHome, "-CodexHome", codexHome,
    ], { stdout: "pipe", stderr: "pipe" });

    const native = run("Native");
    expect(native.exitCode, native.stderr.toString()).toBe(0);
    expect(readFileSync(configPath, "utf8").replace(/\r\n/g, "\n")).toBe(original.replace(/\r\n/g, "\n"));

    const bridge = run("Bridge");
    expect(bridge.exitCode, bridge.stderr.toString()).toBe(0);
    expect(readFileSync(configPath, "utf8")).not.toContain("prior-provider");
    expect(readFileSync(configPath, "utf8")).not.toContain("model_catalog_json");

    expect(run("Native").exitCode).toBe(0);
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace('model_provider = "prior-provider"\r\n', ""));
    const refused = run("Bridge");
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr.toString()).toContain("model_provider changed while the bridge was disabled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
