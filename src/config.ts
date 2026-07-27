import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, renameSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { CodexProviderConfig } from "./types";
import { VERSION } from "./version";
import { defaultBrowserExecutable, type BrowserEngine } from "./browser-engine";

export type RuntimeMode = "browser-only" | "full";

export interface OpenAiTunnelConfig {
  provider: "openai";
  binaryPath: string;
  tunnelId: string;
  runtimeKeyFile: string;
  profileDir: string;
  profileName: string;
  alias: string;
}

export interface NgrokTunnelConfig {
  provider: "ngrok";
  binaryPath: string;
  url: string;
  port: number;
}

export type TunnelConfig = OpenAiTunnelConfig | NgrokTunnelConfig;

export function isOpenAiTunnel(tunnel: TunnelConfig): tunnel is OpenAiTunnelConfig {
  return tunnel.provider === "openai";
}

export function isNgrokTunnel(tunnel: TunnelConfig): tunnel is NgrokTunnelConfig {
  return tunnel.provider === "ngrok";
}

export interface AppConfig {
  version: 2;
  releaseVersion: string;
  mode: RuntimeMode;
  host: "127.0.0.1";
  port: number;
  contextWindow: number;
  appName: string;
  browserEngine: BrowserEngine;
  browserExecutablePath?: string;
  storageStatePath: string;
  brokerSocketPath: string;
  headed: boolean;
  proAvailable: boolean;
  autoApproveToolCalls: boolean;
  controlToken: string;
  runtimeCommand: string[];
  acknowledgedUnofficialAt?: string;
  tunnel?: TunnelConfig;
}

export function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

export function getConfigDir(): string {
  const configured = process.env.CODEX_CHATGPT_WEB_HOME?.trim();
  return resolve(expandUserPath(configured || join(homedir(), ".codex-chatgpt-web")));
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function atomicWriteFile(path: string, data: string | Uint8Array): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    renameSync(temp, path);
  } catch (error) {
    try { closeSync(fd); } catch {}
    rmSync(temp, { force: true });
    throw error;
  }
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are managed by the installer. */ }
}

export function defaultConfig(mode: RuntimeMode = "browser-only"): AppConfig {
  const home = getConfigDir();
  return {
    version: 2,
    releaseVersion: VERSION,
    mode,
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserEngine: "chromium",
    browserExecutablePath: defaultBrowserExecutable("chromium"),
    storageStatePath: join(home, "browser", "storage-state.json"),
    brokerSocketPath: join(home, "runtime", "turn-broker.sock"),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: randomBytes(32).toString("base64url"),
    runtimeCommand: currentRuntimeCommand(),
  };
}

export function currentRuntimeCommand(): string[] {
  const launcher = process.env.CODEX_CHATGPT_WEB_LAUNCHER?.trim();
  if (launcher) {
    const command = [resolve(launcher)];
    assertDurableRuntimeCommand(command);
    return command;
  }
  const executable = resolve(process.execPath);
  const executableName = basename(executable).toLowerCase();
  if (executableName === "bun" || executableName === "bun.exe") {
    const entry = typeof Bun !== "undefined" ? Bun.main : process.argv[1];
    if (!entry || entry.endsWith("/[eval]") || entry === "[eval]") {
      throw new Error("Cannot install a service from an evaluated Bun script");
    }
    return [executable, resolve(entry)];
  }
  return [executable];
}

function inside(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

export function assertDurableRuntimeCommand(command: string[]): void {
  if (command.length === 0) throw new Error("Runtime command is empty");
  const executable = command[0]!;
  if (!isAbsolute(executable)) throw new Error(`Runtime executable must be absolute: ${executable}`);
  const ephemeralRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];
  for (const part of command) {
    if (!isAbsolute(part)) continue;
    if (ephemeralRoots.some(root => inside(part, root))) {
      throw new Error(`Runtime command must not reference an ephemeral path: ${part}`);
    }
  }
  if (!existsSync(executable)) throw new Error(`Runtime executable does not exist: ${executable}`);
}

export function loadConfig(): AppConfig {
  const path = getConfigPath();
  if (!existsSync(path)) throw new Error(`Configuration is missing: ${path}. Run codex-chatgpt-web setup first.`);
  return parseConfig(JSON.parse(readFileSync(path, "utf8")), path);
}

export function loadConfigForSetup(): AppConfig {
  const path = getConfigPath();
  if (!existsSync(path)) throw new Error(`Configuration is missing: ${path}. Run codex-chatgpt-web setup first.`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (raw.version === 1 && raw.mode === "pro-only") {
    raw.version = 2;
    raw.mode = "browser-only";
  }
  return parseConfig(raw, path);
}

function parseConfig(value: unknown, path: string): AppConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid configuration object in ${path}`);
  const parsed = value as Partial<AppConfig> & { chromeExecutablePath?: unknown };
  if (parsed.browserEngine === undefined) parsed.browserEngine = "chromium";
  if (parsed.browserExecutablePath === undefined && typeof parsed.chromeExecutablePath === "string") {
    parsed.browserExecutablePath = parsed.chromeExecutablePath;
  }
  delete parsed.chromeExecutablePath;
  if (parsed.version !== 2) throw new Error(`Unsupported configuration version in ${path}; rerun setup to migrate it`);
  if (typeof parsed.releaseVersion !== "string" || !parsed.releaseVersion.trim()) throw new Error(`Missing releaseVersion in ${path}`);
  if (parsed.mode !== "browser-only" && parsed.mode !== "full") throw new Error(`Invalid runtime mode in ${path}`);
  if (parsed.browserEngine !== "chromium" && parsed.browserEngine !== "firefox") throw new Error(`Invalid browserEngine in ${path}`);
  if (parsed.browserExecutablePath !== undefined
    && (typeof parsed.browserExecutablePath !== "string" || !parsed.browserExecutablePath.trim())) {
    throw new Error(`Invalid browserExecutablePath in ${path}`);
  }
  if (parsed.browserEngine === "chromium" && !parsed.browserExecutablePath) {
    throw new Error(`Missing browserExecutablePath in ${path}`);
  }
  if (parsed.host !== "127.0.0.1") throw new Error("The Responses proxy must bind to 127.0.0.1");
  if (!Number.isInteger(parsed.port) || parsed.port! < 1 || parsed.port! > 65_535) throw new Error(`Invalid port in ${path}`);
  const requiredStrings: Array<keyof AppConfig> = [
    "appName", "storageStatePath", "brokerSocketPath", "controlToken",
  ];
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== "string" || !(parsed[key] as string).trim()) throw new Error(`Missing ${key} in ${path}`);
  }
  if (!/^[A-Za-z0-9_-]{40,}$/.test(parsed.controlToken!)) throw new Error(`Invalid controlToken in ${path}`);
  if (parsed.mode === "full" && !parsed.tunnel) throw new Error("Full mode requires tunnel configuration");
  if (parsed.tunnel && !(parsed.tunnel as { provider?: string }).provider) {
    (parsed.tunnel as { provider: string }).provider = "openai";
  }
  if (parsed.tunnel && parsed.tunnel.provider !== "openai" && parsed.tunnel.provider !== "ngrok") {
    throw new Error(`Invalid tunnel provider in ${path}`);
  }
  if (!Array.isArray(parsed.runtimeCommand) || parsed.runtimeCommand.length === 0
    || parsed.runtimeCommand.some(part => typeof part !== "string" || !part.trim())) {
    throw new Error(`Invalid runtimeCommand in ${path}`);
  }
  assertDurableRuntimeCommand(parsed.runtimeCommand as string[]);
  if (parsed.proAvailable !== undefined && typeof parsed.proAvailable !== "boolean") {
    throw new Error(`Invalid proAvailable in ${path}`);
  }
  return { ...parsed, proAvailable: parsed.proAvailable === true } as AppConfig;
}

export function saveConfig(config: AppConfig): void {
  atomicWriteFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

export function providerConfig(config: AppConfig): CodexProviderConfig {
  const models = ["gpt-5.6-sol"];
  const efforts = ["low", "medium", "high", "xhigh", ...(config.proAvailable ? ["max"] : [])];
  return {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    models,
    liveModels: false,
    defaultModel: "gpt-5.6-sol",
    contextWindow: config.contextWindow,
    modelInputModalities: Object.fromEntries(models.map(model => [model, ["text", "image"]])),
    modelReasoningEfforts: { "gpt-5.6-sol": efforts },
    modelDefaultReasoningEfforts: { "gpt-5.6-sol": "high" },
    noReasoningModels: [],
    chatgptWeb: {
      appName: config.appName,
      storageStatePath: config.storageStatePath,
      browserEngine: config.browserEngine,
      browserExecutablePath: config.browserExecutablePath,
      brokerSocketPath: config.brokerSocketPath,
      threadEnvironmentStatePath: join(getConfigDir(), "runtime", "thread-environments.json"),
      headed: config.headed,
      localToolsEnabled: config.mode === "full",
      proAvailable: config.proAvailable,
      autoApproveToolCalls: config.autoApproveToolCalls,
    },
  };
}
