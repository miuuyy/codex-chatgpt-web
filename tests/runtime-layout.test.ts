import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDurableRuntimeCommand, defaultConfig, loadConfig, loadConfigForSetup } from "../src/config";
import { removeLegacyRuntimeArtifacts } from "../src/service";

const roots: string[] = [];
afterEach(() => {
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("managed runtime commands reject every ephemeral path component", () => {
  expect(() => assertDurableRuntimeCommand(["/private/tmp/codex-chatgpt-web"])).toThrow("ephemeral path");
  expect(() => assertDurableRuntimeCommand([process.execPath, "/tmp/build/app/cli.js"])).toThrow("ephemeral path");
  expect(() => assertDurableRuntimeCommand([process.execPath])).not.toThrow();
});

test("setup explicitly migrates v1 pro-only config to v2 browser-only", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-config-migration-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "config.json"), `${JSON.stringify({
    version: 1,
    releaseVersion: "0.1.0",
    mode: "pro-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    chromeExecutablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    storageStatePath: join(root, "browser", "storage-state.json"),
    brokerSocketPath: join(root, "runtime", "turn-broker.sock"),
    headed: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "config-migration-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
  })}\n`);

  expect(() => loadConfig()).toThrow("rerun setup to migrate");
  expect(loadConfigForSetup()).toMatchObject({ version: 2, mode: "browser-only" });
  expect(loadConfigForSetup()).toMatchObject({
    browserEngine: "chromium",
    browserExecutablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
});

test("legacy temp-path wrapper and vendor are removed only after runtime ownership changes", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-legacy-runtime-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  const wrapper = join(root, "bin", "serve-with-playwright.sh");
  const vendorFile = join(root, "vendor", "node_modules", "playwright-core", "package.json");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "vendor", "node_modules", "playwright-core"), { recursive: true });
  writeFileSync(wrapper, "#!/bin/sh\n");
  writeFileSync(vendorFile, "{}\n");

  const config = defaultConfig("browser-only");
  config.runtimeCommand = [wrapper];
  expect(() => removeLegacyRuntimeArtifacts(config)).toThrow("still references");
  expect(existsSync(wrapper)).toBe(true);
  config.runtimeCommand = [process.execPath];
  removeLegacyRuntimeArtifacts(config);
  expect(existsSync(wrapper)).toBe(false);
  expect(existsSync(join(root, "vendor"))).toBe(false);
});
