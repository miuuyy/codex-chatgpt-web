import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, renameSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep, win32 } from "node:path";
import { tmpdir } from "node:os";
import type { CodexProviderConfig } from "./types";
import { VERSION } from "./version";

export type RuntimeMode = "browser-only" | "full";
export type BrowserHostMode = "managed-chrome" | "launcher";

/**
 * ChatGPT caches a connector's public MCP contract by connector identity. The direct turn-token
 * contract therefore has a new identity instead of mutating the retired connector in place.
 */
export const CHATGPT_CONNECTOR_NAME = "Codex Native2";
export const LEGACY_CHATGPT_CONNECTOR_NAMES = ["Codex Native"] as const;

export function isLegacyChatGptConnectorName(value: string): boolean {
  return (LEGACY_CHATGPT_CONNECTOR_NAMES as readonly string[]).includes(value);
}

export function legacyChatGptConnectorMigrationMessage(legacyName: string): string {
  return `Legacy ChatGPT connector ${JSON.stringify(legacyName)} was found, but this release requires`
    + ` a newly created connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)}. Create`
    + ` ${JSON.stringify(CHATGPT_CONNECTOR_NAME)} against the same tunnel with Authentication set to None;`
    + ` do not rename or refresh ${JSON.stringify(legacyName)}.`;
}

export function resolveSetupConnectorName(existingName?: string, requestedName?: string): string {
  if (requestedName !== undefined) {
    const requested = requestedName.trim();
    if (!requested || requested.length > 80) throw new Error("Connector name is invalid");
    if (isLegacyChatGptConnectorName(requested)) {
      throw new Error(legacyChatGptConnectorMigrationMessage(requested));
    }
    return requested;
  }
  const existing = existingName?.trim();
  if (!existing || isLegacyChatGptConnectorName(existing)) return CHATGPT_CONNECTOR_NAME;
  return existing;
}

export interface TunnelConfig {
  binaryPath: string;
  tunnelId: string;
  runtimeKeyFile: string;
  profileDir: string;
  profileName: string;
  alias: string;
}

export interface AppConfig {
  version: 3;
  releaseVersion: string;
  mode: RuntimeMode;
  host: "127.0.0.1";
  port: number;
  contextWindow: number;
  appName: string;
  browserHost: BrowserHostMode;
  browserHostDescriptorPath?: string;
  chromeExecutablePath: string;
  storageStatePath: string;
  brokerSocketPath: string;
  headed: boolean;
  solAvailable: boolean;
  proAvailable: boolean;
  autoApproveToolCalls: boolean;
  controlToken: string;
  runtimeCommand: string[];
  acknowledgedUnofficialAt?: string;
  tunnel?: TunnelConfig;
}

export function expandUserPath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

export function getConfigDir(): string {
  const configured = process.env.CODEX_CHATGPT_WEB_HOME?.trim();
  return resolve(expandUserPath(configured || join(homedir(), ".codex-chatgpt-web")));
}

export function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export function isWindowsPipeEndpoint(value: string): boolean {
  return /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(value);
}

export function defaultBrokerEndpoint(home = getConfigDir(), platform = process.platform): string {
  if (platform !== "win32") return join(home, "runtime", "turn-broker.sock");
  const identity = createHash("sha256").update(resolve(home).toLowerCase()).digest("hex").slice(0, 20);
  return `\\\\.\\pipe\\codex-chatgpt-web-${identity}`;
}

export function resolveBrokerEndpoint(value: string): string {
  const expanded = expandUserPath(value);
  return isWindowsPipeEndpoint(expanded) ? expanded : resolve(expanded);
}

const atomicWaitCell = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 150, 250, 350, 500] as const;

function renameAtomicFile(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsError = process.platform === "win32"
        && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (!transientWindowsError || delay === undefined) throw error;
      Atomics.wait(atomicWaitCell, 0, 0, delay);
    }
  }
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
    renameAtomicFile(temp, path);
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
    version: 3,
    releaseVersion: VERSION,
    mode,
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: CHATGPT_CONNECTOR_NAME,
    browserHost: "managed-chrome",
    chromeExecutablePath: defaultChromeExecutable(),
    storageStatePath: join(home, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(home),
    headed: true,
    solAvailable: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: randomBytes(32).toString("base64url"),
    runtimeCommand: currentRuntimeCommand(),
  };
}

export function currentRuntimeCommand(): string[] {
  const executableName = basename(process.execPath).toLowerCase();
  const bunExecutable = executableName === "bun" || executableName === "bun.exe"
    ? installedBunExecutable()
    : undefined;
  return runtimeCommandForProcess({
    launcher: process.env.CODEX_CHATGPT_WEB_LAUNCHER,
    executable: process.execPath,
    entry: typeof Bun !== "undefined" ? Bun.main : process.argv[1],
    bunExecutable,
  });
}

export function installedBunExecutable({
  platform = process.platform,
  pathValue = process.env.PATH || process.env.Path || "",
  candidates = [],
}: {
  platform?: NodeJS.Platform;
  pathValue?: string;
  candidates?: Array<string | null | undefined>;
} = {}): string {
  const executableName = platform === "win32" ? "bun.exe" : "bun";
  const pathDelimiter = platform === "win32" ? ";" : delimiter;
  const pathCandidates = pathValue
    .split(pathDelimiter)
    .map(part => part.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .map(part => join(part, executableName));
  const discovered = [
    process.env.CODEX_CHATGPT_WEB_BUN,
    process.env.CODEX_WEB_GPT_BUN,
    ...candidates,
    ...pathCandidates,
    typeof Bun !== "undefined" ? Bun.which("bun") : undefined,
    process.execPath,
  ];
  for (const candidate of discovered) {
    if (!candidate?.trim()) continue;
    const executable = resolve(candidate.trim());
    try {
      assertDurableRuntimeCommand([executable]);
      return executable;
    } catch {
      // Candidate discovery is exhaustive; the final error remains explicit.
    }
  }
  throw new Error("A durable installed Bun executable was not found outside temporary directories");
}

export function runtimeCommandForProcess({
  launcher,
  executable,
  entry,
  bunExecutable,
}: {
  launcher?: string;
  executable: string;
  entry?: string;
  bunExecutable?: string | null;
}): string[] {
  launcher = launcher?.trim();
  if (launcher) {
    const command = [resolve(launcher)];
    assertDurableRuntimeCommand(command);
    return command;
  }
  executable = resolve(executable);
  const executableName = basename(executable).toLowerCase();
  if (executableName === "bun" || executableName === "bun.exe") {
    if (!entry || entry.endsWith("/[eval]") || entry === "[eval]") {
      throw new Error("Cannot install a service from an evaluated Bun script");
    }
    const command = [resolve(bunExecutable?.trim() || executable), resolve(entry)];
    assertDurableRuntimeCommand(command);
    return command;
  }
  const command = [executable];
  assertDurableRuntimeCommand(command);
  return command;
}

function inside(path: string, root: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(root);
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

export function defaultChromeExecutable(
  platform = process.platform,
  programFiles = process.env.PROGRAMFILES,
): string {
  if (platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (platform === "win32") {
    return win32.join(programFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  }
  return "/usr/bin/google-chrome";
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
  if (raw.version === 2) {
    raw.version = 3;
    raw.browserHost = "managed-chrome";
  }
  return parseConfig(raw, path);
}

function parseConfig(value: unknown, path: string): AppConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid configuration object in ${path}`);
  const parsed = value as Partial<AppConfig>;
  if (parsed.version !== 3) throw new Error(`Unsupported configuration version in ${path}; rerun setup to migrate it`);
  if (typeof parsed.releaseVersion !== "string" || !parsed.releaseVersion.trim()) throw new Error(`Missing releaseVersion in ${path}`);
  if (parsed.mode !== "browser-only" && parsed.mode !== "full") throw new Error(`Invalid runtime mode in ${path}`);
  if (parsed.host !== "127.0.0.1") throw new Error("The Responses proxy must bind to 127.0.0.1");
  if (parsed.browserHost !== "managed-chrome" && parsed.browserHost !== "launcher") {
    throw new Error(`Invalid browserHost in ${path}`);
  }
  if (!Number.isInteger(parsed.port) || parsed.port! < 1 || parsed.port! > 65_535) throw new Error(`Invalid port in ${path}`);
  if (!Number.isSafeInteger(parsed.contextWindow) || parsed.contextWindow! <= 0) {
    throw new Error(`Invalid contextWindow in ${path}`);
  }
  if (typeof parsed.headed !== "boolean") throw new Error(`Invalid headed in ${path}`);
  if (typeof parsed.autoApproveToolCalls !== "boolean") {
    throw new Error(`Invalid autoApproveToolCalls in ${path}`);
  }
  const requiredStrings: Array<keyof AppConfig> = [
    "appName", "chromeExecutablePath", "storageStatePath", "brokerSocketPath", "controlToken",
  ];
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== "string" || !(parsed[key] as string).trim()) throw new Error(`Missing ${key} in ${path}`);
  }
  if (parsed.appName!.length > 80) throw new Error(`appName is too long in ${path}`);
  if (parsed.browserHost === "launcher"
    && (typeof parsed.browserHostDescriptorPath !== "string" || !parsed.browserHostDescriptorPath.trim())) {
    throw new Error(`Launcher browser host requires browserHostDescriptorPath in ${path}`);
  }
  if (parsed.browserHost === "launcher"
    && !isAbsolute(expandUserPath(parsed.browserHostDescriptorPath!))) {
    throw new Error(`Launcher browserHostDescriptorPath must be absolute in ${path}`);
  }
  const brokerEndpoint = expandUserPath(parsed.brokerSocketPath!);
  if (process.platform === "win32") {
    if (!isWindowsPipeEndpoint(brokerEndpoint)) {
      throw new Error(`Windows brokerSocketPath must be a named pipe in ${path}`);
    }
  } else if (!isAbsolute(brokerEndpoint) || isWindowsPipeEndpoint(brokerEndpoint)) {
    throw new Error(`brokerSocketPath must be an absolute Unix socket path in ${path}`);
  }
  if (!/^[A-Za-z0-9_-]{40,}$/.test(parsed.controlToken!)) throw new Error(`Invalid controlToken in ${path}`);
  if (parsed.mode === "full") {
    if (!parsed.tunnel || typeof parsed.tunnel !== "object") throw new Error("Full mode requires tunnel configuration");
    for (const key of ["binaryPath", "tunnelId", "runtimeKeyFile", "profileDir", "profileName", "alias"] as const) {
      if (typeof parsed.tunnel[key] !== "string" || !parsed.tunnel[key].trim()) {
        throw new Error(`Missing tunnel.${key} in ${path}`);
      }
    }
    if (!/^tunnel_[a-f0-9]{32}$/.test(parsed.tunnel.tunnelId)) {
      throw new Error(`Invalid tunnel.tunnelId in ${path}`);
    }
    for (const key of ["profileName", "alias"] as const) {
      if (!/^[A-Za-z0-9._-]+$/.test(parsed.tunnel[key])) {
        throw new Error(`Invalid tunnel.${key} in ${path}`);
      }
    }
    for (const key of ["binaryPath", "runtimeKeyFile", "profileDir"] as const) {
      if (!isAbsolute(expandUserPath(parsed.tunnel[key]))) {
        throw new Error(`tunnel.${key} must be absolute in ${path}`);
      }
    }
  }
  if (!Array.isArray(parsed.runtimeCommand) || parsed.runtimeCommand.length === 0
    || parsed.runtimeCommand.some(part => typeof part !== "string" || !part.trim())) {
    throw new Error(`Invalid runtimeCommand in ${path}`);
  }
  assertDurableRuntimeCommand(parsed.runtimeCommand as string[]);
  if (parsed.proAvailable !== undefined && typeof parsed.proAvailable !== "boolean") {
    throw new Error(`Invalid proAvailable in ${path}`);
  }
  if (parsed.solAvailable !== undefined && typeof parsed.solAvailable !== "boolean") {
    throw new Error(`Invalid solAvailable in ${path}`);
  }
  const solAvailable = parsed.solAvailable !== false;
  const proAvailable = parsed.proAvailable === true;
  if (proAvailable && !solAvailable) {
    throw new Error(`Invalid ChatGPT account capabilities in ${path}: Pro requires Sol`);
  }
  return { ...parsed, solAvailable, proAvailable } as AppConfig;
}

export function saveConfig(config: AppConfig): void {
  atomicWriteFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

export function providerConfig(config: AppConfig): CodexProviderConfig {
  const model = config.solAvailable ? "gpt-5.6-sol" : "gpt-5.6-luna";
  const models = [model];
  const efforts = config.solAvailable
    ? ["low", "medium", "high", "xhigh", ...(config.proAvailable ? ["max"] : [])]
    : ["low"];
  return {
    adapter: "chatgpt-web",
    baseUrl: "https://chatgpt.com",
    models,
    liveModels: false,
    defaultModel: model,
    contextWindow: config.contextWindow,
    modelInputModalities: Object.fromEntries(models.map(model => [model, ["text", "image"]])),
    modelReasoningEfforts: { [model]: efforts },
    modelDefaultReasoningEfforts: { [model]: config.solAvailable ? "high" : "low" },
    noReasoningModels: [],
    chatgptWeb: {
      appName: config.appName,
      browserHost: config.browserHost,
      browserHostDescriptorPath: config.browserHostDescriptorPath,
      storageStatePath: config.storageStatePath,
      chromeExecutablePath: config.chromeExecutablePath,
      brokerSocketPath: config.brokerSocketPath,
      threadEnvironmentStatePath: join(getConfigDir(), "runtime", "thread-environments.json"),
      lunaCheckpointStatePath: join(getConfigDir(), "runtime", "luna-checkpoints.json"),
      headed: config.headed,
      localToolsEnabled: config.mode === "full",
      solAvailable: config.solAvailable,
      proAvailable: config.proAvailable,
      autoApproveToolCalls: config.autoApproveToolCalls,
    },
  };
}
