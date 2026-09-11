import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDurableRuntimeCommand,
  CHATGPT_CONNECTOR_NAME,
  DEV_CHATGPT_CONNECTOR_NAME,
  defaultBrokerEndpoint,
  defaultConfig,
  expandUserPath,
  isWindowsPipeEndpoint,
  installedBunExecutable,
  loadConfig,
  loadConfigForSetup,
  providerConfig,
  resolveBrokerEndpoint,
  resolveInteractionConnectorIdentities,
  runtimeCommandForProcess,
  ZERO_RISK_CHATGPT_CONNECTOR_NAME,
} from "../src/config";
import { removeLegacyRuntimeArtifacts } from "../src/service";
import { processRunning } from "../src/process";
import {
  CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
  CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
} from "../src/chatgpt-web-models";

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

test("Windows Bun shims resolve to the installed Bun executable before service setup", () => {
  const ephemeralBun = join(tmpdir(), "bun-node-test", "bun");
  expect(runtimeCommandForProcess({
    executable: ephemeralBun,
    bunExecutable: process.execPath,
    entry: import.meta.path,
  })).toEqual([process.execPath, import.meta.path]);
  expect(() => runtimeCommandForProcess({
    executable: ephemeralBun,
    entry: import.meta.path,
  })).toThrow("ephemeral path");
});

test("installed Bun discovery ignores a temporary self-extract executable", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-bun-discovery-${process.pid}-${Date.now()}`);
  const ephemeralBun = join(root, "bun-node-test", "bun.exe");
  roots.push(root);
  mkdirSync(join(root, "bun-node-test"), { recursive: true });
  writeFileSync(ephemeralBun, "");
  expect(installedBunExecutable({
    platform: "win32",
    pathValue: "",
    candidates: [ephemeralBun, process.execPath],
  })).toBe(process.execPath);
});

test("Windows uses a stable native named pipe for the outer Codex tool broker", () => {
  const first = defaultBrokerEndpoint("C:\\Users\\alice\\.codex-chatgpt-web", "win32");
  const second = defaultBrokerEndpoint("C:\\Users\\alice\\.codex-chatgpt-web", "win32");
  expect(first).toBe(second);
  expect(isWindowsPipeEndpoint(first)).toBe(true);
  expect(resolveBrokerEndpoint(first)).toBe(first);
  expect(defaultBrokerEndpoint("/home/alice/.codex-chatgpt-web", "linux")).toEndWith(join("runtime", "turn-broker.sock"));
});

test("permission-denied process probes preserve ownership evidence", () => {
  expect(processRunning(123, () => {
    const error = new Error("access denied") as NodeJS.ErrnoException;
    error.code = "EPERM";
    throw error;
  })).toBe(true);
  expect(processRunning(123, () => {
    const error = new Error("not found") as NodeJS.ErrnoException;
    error.code = "ESRCH";
    throw error;
  })).toBe(false);
  expect(processRunning(0)).toBe(false);
});

test("user-home expansion accepts native Unix and Windows separators", () => {
  expect(expandUserPath("~/runtime")).toBe(join(homedir(), "runtime"));
  expect(expandUserPath("~\\runtime")).toBe(join(homedir(), "runtime"));
});

test("default setup uses the fixed production connector identities", () => {
  expect(defaultConfig("full").appName).toBe(CHATGPT_CONNECTOR_NAME);
  expect(defaultConfig("full").automaticAppName).toBe(CHATGPT_CONNECTOR_NAME);
  expect(defaultConfig("full").manualAppName).toBe(ZERO_RISK_CHATGPT_CONNECTOR_NAME);
  expect(defaultConfig("full").subagentProtocol).toBe("compatibility-v1");
  expect(defaultConfig("full").browserInteractionMode).toBe("automatic");
  expect(defaultConfig("full").zeroRiskProEnabled).toBe(false);
  expect(defaultConfig("full").integrationMode).toBe("direct");
});

test.each([
  ["production", CHATGPT_CONNECTOR_NAME],
  ["development", DEV_CHATGPT_CONNECTOR_NAME],
] as const)("%s setup preserves its fixed automatic identity across Zero Risk", (profile, automaticAppName) => {
  expect(resolveInteractionConnectorIdentities("manual", profile)).toEqual({
    appName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
    automaticAppName,
    manualAppName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
  });
  expect(resolveInteractionConnectorIdentities("automatic", profile)).toEqual({
    appName: automaticAppName,
    automaticAppName,
    manualAppName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
  });
});

test("setup repairs a legacy automatic connector name that collides with Zero Risk", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-connector-collision-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const collided = defaultConfig("browser-only");
  collided.appName = ZERO_RISK_CHATGPT_CONNECTOR_NAME;
  collided.automaticAppName = ZERO_RISK_CHATGPT_CONNECTOR_NAME;
  writeFileSync(join(root, "config.json"), `${JSON.stringify(collided)}\n`);

  expect(() => loadConfig()).toThrow(/Automatic and Zero Risk connector names must differ/);
  expect(loadConfigForSetup()).toMatchObject({
    appName: CHATGPT_CONNECTOR_NAME,
    automaticAppName: CHATGPT_CONNECTOR_NAME,
    manualAppName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
  });
});

test("setup explicitly migrates v1 pro-only config to v3 managed browser-only", () => {
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
    brokerSocketPath: defaultBrokerEndpoint(root),
    headed: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "config-migration-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
  })}\n`);

  expect(() => loadConfig()).toThrow("rerun setup to migrate");
  expect(loadConfigForSetup()).toMatchObject({
    version: 3,
    mode: "browser-only",
    browserHost: "managed-chrome",
    browserInteractionMode: "automatic",
    subagentProtocol: "compatibility-v1",
    solAvailable: true,
  });
});

test("existing v3 configurations deterministically retain automatic browser interaction", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-v3-interaction-migration-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const legacyV3: Record<string, unknown> = { ...defaultConfig("browser-only") };
  delete legacyV3.browserInteractionMode;
  delete legacyV3.zeroRiskProEnabled;
  writeFileSync(join(root, "config.json"), `${JSON.stringify(legacyV3)}\n`);

  expect(loadConfig()).toMatchObject({
    browserInteractionMode: "automatic",
    zeroRiskProEnabled: false,
  });
  expect(loadConfigForSetup()).toMatchObject({
    appName: CHATGPT_CONNECTOR_NAME,
    automaticAppName: CHATGPT_CONNECTOR_NAME,
    manualAppName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
    browserInteractionMode: "automatic",
  });
});

test("Zero Risk fails closed without the Launcher browser host", () => {
  const root = join(tmpdir(), `codex-chatgpt-web-manual-host-${process.pid}-${Date.now()}`);
  roots.push(root);
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  mkdirSync(root, { recursive: true });
  const invalid = defaultConfig("full");
  invalid.browserInteractionMode = "manual";
  invalid.appName = ZERO_RISK_CHATGPT_CONNECTOR_NAME;
  writeFileSync(join(root, "config.json"), `${JSON.stringify(invalid)}\n`);

  expect(() => loadConfig()).toThrow("requires the launcher browser host");
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

test("launcher browser ownership is explicit in provider configuration", () => {
  const config = defaultConfig("browser-only");
  config.browserHost = "launcher";
  config.browserHostDescriptorPath = "/Users/example/.codex-chatgpt-web/runtime/launcher-browser.json";
  config.stallTimeoutSec = 900;
  expect(providerConfig(config).chatgptWeb).toMatchObject({
    browserHost: "launcher",
    browserHostDescriptorPath: config.browserHostDescriptorPath,
    solAvailable: true,
    stallTimeoutSec: 900,
  });
});

test("Luna-only provider configuration exposes only the Luna backend", () => {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  const provider = providerConfig(config);
  expect(provider.models).toEqual(["gpt-5.6-luna"]);
  expect(provider.defaultModel).toBe("gpt-5.6-luna");
  expect(provider.modelReasoningEfforts).toEqual({ "gpt-5.6-luna": ["low", "medium"] });
  expect(provider.chatgptWeb).toMatchObject({ solAvailable: false, proAvailable: false });
});

test("manual provider configuration preserves a distinct backend without guessing a ChatGPT model", () => {
  const config = defaultConfig("full");
  config.browserInteractionMode = "manual";
  config.solAvailable = true;
  config.proAvailable = true;
  const provider = providerConfig(config);

  expect(provider.models).toEqual([CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL]);
  expect(provider.defaultModel).toBe(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL);
  expect(provider.modelReasoningEfforts).toEqual({ [CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL]: ["low"] });
  expect(provider.modelDefaultReasoningEfforts).toEqual({ [CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL]: "low" });
  expect(provider.modelInputModalities).toEqual({ [CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL]: ["text"] });
  expect(provider.chatgptWeb).toMatchObject({
    appName: ZERO_RISK_CHATGPT_CONNECTOR_NAME,
    browserInteractionMode: "manual",
    solAvailable: false,
    proAvailable: false,
    experimentalBiggerContext: false,
  });

  config.zeroRiskProEnabled = true;
  const proProvider = providerConfig(config);
  expect(proProvider.models).toEqual([
    CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
    CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
  ]);
  expect(proProvider.modelReasoningEfforts).toEqual({
    [CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL]: ["low"],
    [CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL]: ["low"],
  });
});
