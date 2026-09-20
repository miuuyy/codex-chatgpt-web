import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { unzipSync } from "fflate";
import type { AppConfig, BrowserInteractionMode, TunnelConfig } from "./config";
import { atomicWriteFile, getConfigDir } from "./config";
import { processRunning, runCommand, runChecked } from "./process";

export const TUNNEL_VERSION = "0.0.12";
const MIGRATABLE_TUNNEL_VERSIONS = new Set(["0.0.10"]);
const RELEASE_BASE = `https://github.com/openai/tunnel-client/releases/download/v${TUNNEL_VERSION}`;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const TUNNEL_READY_TIMEOUT_MS = 120_000;
const TUNNEL_STATUS_POLL_INTERVAL_MS = 1_000;
const WINDOWS_REMOVE_RETRY_DELAYS_MS = [100, 200, 500, 1_000, 2_000] as const;

interface TunnelInstallManifest {
  version: 1;
  tunnelClientVersion: string;
  asset: string;
  archiveSha256: string;
  binarySha256: string;
}

export function tunnelClientInstallAction(installedVersion: string): "reuse" | "upgrade" {
  if (installedVersion === TUNNEL_VERSION) return "reuse";
  if (MIGRATABLE_TUNNEL_VERSIONS.has(installedVersion)) return "upgrade";
  throw new Error(`Installed tunnel-client version ${installedVersion} is not a trusted upgrade source`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function platformAsset(platform = process.platform, architecture = process.arch): string {
  const os = platform === "darwin" ? "darwin"
    : platform === "linux" ? "linux"
      : platform === "win32" ? "windows"
        : undefined;
  const arch = architecture === "arm64" ? "arm64" : architecture === "x64" ? "amd64" : undefined;
  if (!os || !arch) throw new Error(`openai/tunnel-client has no pinned build for ${platform}/${architecture}`);
  return `tunnel-client-v${TUNNEL_VERSION}-${os}-${arch}.zip`;
}

async function fetchBytes(url: string, timeoutMs = 120_000): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes: ${url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes: ${url}`);
    return bytes;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Download timed out after ${timeoutMs}ms: ${url}`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseExpectedChecksum(text: string, asset: string): string {
  const line = text.split(/\r?\n/).find(candidate => candidate.trim().endsWith(asset));
  const checksum = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!checksum || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`SHA256SUMS.txt has no valid entry for ${asset}`);
  return checksum;
}

function binaryPath(configDir = getConfigDir(), platform = process.platform): string {
  return join(configDir, "bin", platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
}

function manifestPath(configDir = getConfigDir()): string {
  return join(configDir, "bin", "tunnel-client-manifest.json");
}

interface TunnelInstallOptions {
  platform?: NodeJS.Platform;
  architecture?: NodeJS.Architecture;
  configDir?: string;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  runChecked?: typeof runChecked;
  randomUUID?: () => string;
  removeOptions?: Parameters<typeof removeTunnelInstallFile>[1];
}

export async function removeTunnelInstallFile(
  path: string,
  options: {
    platform?: NodeJS.Platform;
    remove?: (path: string) => void;
    wait?: (delayMs: number) => Promise<void>;
    retryDelaysMs?: readonly number[];
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const remove = options.remove ?? (target => rmSync(target, { force: true }));
  const wait = options.wait ?? (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
  const retryDelays = options.retryDelaysMs ?? WINDOWS_REMOVE_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      remove(path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = platform === "win32" && (code === "EBUSY" || code === "EPERM");
      if (!retryable || attempt >= retryDelays.length) throw error;
      await wait(retryDelays[attempt]);
    }
  }
}

function tunnelInstallCleanupError(primary: unknown, cleanupFailures: unknown[], context: string): Error {
  const primaryMessage = primary instanceof Error ? primary.message : String(primary);
  const cleanupMessage = cleanupFailures
    .map(error => error instanceof Error ? error.message : String(error))
    .join("; ");
  return new AggregateError(
    [primary, ...cleanupFailures],
    `${primaryMessage}; ${context}: ${cleanupMessage}`,
    { cause: primary },
  );
}

async function removeStaleTunnelInstallFiles(
  executable: string,
  removeFile: (path: string) => Promise<void>,
): Promise<void> {
  const directory = dirname(executable);
  if (!existsSync(directory)) return;
  const prefix = `${basename(executable)}.install-`;
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix)) continue;
    const ownerPid = Number(entry.slice(prefix.length).split("-", 1)[0]);
    if (Number.isInteger(ownerPid) && ownerPid !== process.pid && processRunning(ownerPid)) continue;
    await removeFile(join(directory, entry));
  }
}

export async function installTunnelClient(options: TunnelInstallOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const configDir = options.configDir ?? getConfigDir();
  const download = options.fetchBytes ?? fetchBytes;
  const execute = options.runChecked ?? runChecked;
  const createId = options.randomUUID ?? randomUUID;
  const removeFile = (path: string) => removeTunnelInstallFile(path, {
    ...options.removeOptions,
    platform,
  });
  const executable = binaryPath(configDir, platform);
  const manifestFile = manifestPath(configDir);
  let previousInstallation: { binary: Uint8Array; manifestText: string } | undefined;
  if (existsSync(executable) && existsSync(manifestFile)) {
    const manifestText = readFileSync(manifestFile, "utf8");
    const manifest = JSON.parse(manifestText) as Partial<TunnelInstallManifest>;
    const installedBinary = new Uint8Array(readFileSync(executable));
    const actual = sha256(installedBinary);
    if (manifest.version !== 1 || typeof manifest.tunnelClientVersion !== "string"
      || manifest.binarySha256 !== actual) {
      throw new Error(`Existing tunnel-client failed integrity validation: ${executable}`);
    }
    if (platform !== "win32" && (statSync(executable).mode & 0o111) === 0) {
      throw new Error(`Existing tunnel-client is not executable: ${executable}`);
    }
    const action = tunnelClientInstallAction(manifest.tunnelClientVersion);
    const installedVersion = execute(executable, ["--version"], { timeout: 10_000 });
    if (!installedVersion.stdout.includes(manifest.tunnelClientVersion)
      && !installedVersion.stderr.includes(manifest.tunnelClientVersion)) {
      throw new Error(`Existing tunnel-client did not report version ${manifest.tunnelClientVersion}`);
    }
    if (action === "reuse") return executable;
    previousInstallation = { binary: installedBinary, manifestText };
  }
  const untrackedBinary = !existsSync(manifestFile) && existsSync(executable)
    ? new Uint8Array(readFileSync(executable))
    : undefined;
  await removeStaleTunnelInstallFiles(executable, removeFile);
  if (!previousInstallation && existsSync(manifestFile)) await removeFile(manifestFile);

  const asset = platformAsset(platform, architecture);
  const [archive, sums] = await Promise.all([
    download(`${RELEASE_BASE}/${asset}`),
    download(`${RELEASE_BASE}/SHA256SUMS.txt`),
  ]);
  const expected = parseExpectedChecksum(new TextDecoder().decode(sums), asset);
  const archiveHash = sha256(archive);
  if (archiveHash !== expected) throw new Error(`Checksum mismatch for ${asset}`);
  const files = unzipSync(archive);
  const expectedName = platform === "win32" ? "tunnel-client.exe" : "tunnel-client";
  const entry = Object.entries(files).find(([name]) => basename(name) === expectedName);
  if (!entry) throw new Error(`${asset} does not contain ${expectedName}`);
  const binary = entry[1];
  const binaryHash = sha256(binary);
  const manifest: TunnelInstallManifest = {
    version: 1,
    tunnelClientVersion: TUNNEL_VERSION,
    asset,
    archiveSha256: archiveHash,
    binarySha256: binaryHash,
  };
  if (untrackedBinary && sha256(untrackedBinary) === binaryHash) {
    const installedVersion = execute(executable, ["--version"], { timeout: 10_000 });
    if (installedVersion.stdout.includes(TUNNEL_VERSION) || installedVersion.stderr.includes(TUNNEL_VERSION)) {
      atomicWriteFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
      return executable;
    }
  }
  if (!previousInstallation && existsSync(executable)) await removeFile(executable);
  mkdirSync(dirname(executable), { recursive: true, mode: 0o700 });
  const stagedExecutable = `${executable}.install-${process.pid}-${createId()}${platform === "win32" ? ".exe" : ""}`;
  atomicWriteFile(stagedExecutable, binary);
  let verificationError: unknown;
  try {
    if (platform !== "win32") chmodSync(stagedExecutable, 0o700);
    const version = execute(stagedExecutable, ["--version"], { timeout: 10_000 });
    if (!version.stdout.includes(TUNNEL_VERSION) && !version.stderr.includes(TUNNEL_VERSION)) {
      throw new Error(`Installed tunnel-client did not report version ${TUNNEL_VERSION}`);
    }
  } catch (error) {
    verificationError = error;
  }
  try {
    await removeFile(stagedExecutable);
  } catch (cleanupError) {
    if (verificationError) {
      throw tunnelInstallCleanupError(
        verificationError,
        [cleanupError],
        "temporary tunnel-client cleanup also failed",
      );
    }
    throw cleanupError;
  }
  if (verificationError) throw verificationError;
  try {
    atomicWriteFile(executable, binary);
    if (platform !== "win32") chmodSync(executable, 0o700);
    atomicWriteFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    const rollbackFailures: unknown[] = [];
    if (previousInstallation) {
      try {
        atomicWriteFile(executable, previousInstallation.binary);
        if (platform !== "win32") chmodSync(executable, 0o700);
        atomicWriteFile(manifestFile, previousInstallation.manifestText);
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    } else {
      for (const path of [executable, manifestFile]) {
        try {
          await removeFile(path);
        } catch (cleanupError) {
          rollbackFailures.push(cleanupError);
        }
      }
    }
    if (rollbackFailures.length > 0) {
      throw tunnelInstallCleanupError(error, rollbackFailures, "tunnel-client install rollback also failed");
    }
    throw error;
  }
  return executable;
}

export function installRuntimeKey(
  sourcePath: string,
  interactionMode: BrowserInteractionMode = "automatic",
): string {
  if (!existsSync(sourcePath)) throw new Error(`Tunnel runtime key file does not exist: ${sourcePath}`);
  const key = readFileSync(sourcePath);
  if (key.byteLength === 0 || key.byteLength > 64 * 1024) throw new Error("Tunnel runtime key file is empty or unexpectedly large");
  return installRuntimeKeyBytes(key, interactionMode);
}

export function managedRuntimeKeyPath(interactionMode: BrowserInteractionMode = "automatic"): string {
  const fileName = interactionMode === "manual"
    ? "tunnel-runtime-zero-risk.key"
    : "tunnel-runtime-automatic.key";
  return join(getConfigDir(), "secrets", fileName);
}

export function installRuntimeKeyBytes(
  key: Uint8Array | string,
  interactionMode: BrowserInteractionMode = "automatic",
): string {
  const bytes = typeof key === "string" ? new TextEncoder().encode(key.trim()) : key;
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) throw new Error("Tunnel runtime key is empty or unexpectedly large");
  const destination = managedRuntimeKeyPath(interactionMode);
  atomicWriteFile(destination, bytes);
  return destination;
}

export function createTunnelConfig(options: {
  binaryPath: string;
  tunnelId: string;
  runtimeKeyFile: string;
  profileName?: string;
  alias?: string;
}): TunnelConfig {
  if (!/^tunnel_[a-f0-9]{32}$/.test(options.tunnelId)) throw new Error("--tunnel-id must be tunnel_ followed by 32 lowercase hexadecimal characters");
  const profileName = options.profileName ?? "codex-chatgpt-web";
  const alias = options.alias ?? "codex-chatgpt-web";
  if (!/^[A-Za-z0-9._-]+$/.test(profileName) || !/^[A-Za-z0-9._-]+$/.test(alias)) {
    throw new Error("Tunnel profile and alias may contain only letters, digits, dot, underscore, and dash");
  }
  return {
    binaryPath: options.binaryPath,
    tunnelId: options.tunnelId,
    runtimeKeyFile: options.runtimeKeyFile,
    profileDir: join(getConfigDir(), "tunnel", "profiles"),
    profileName,
    alias,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function tunnelCommandQuoted(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("Tunnel MCP command values must not contain newlines");
  // tunnel-client parses mcp.command with backslash escapes on every platform.
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function mcpCommand(config: AppConfig, platform = process.platform): string {
  const contract = config.browserInteractionMode === "manual" ? "safe" : "native";
  const command = [
    ...config.runtimeCommand,
    "mcp",
    "--contract",
    contract,
    "--broker-socket",
    config.brokerSocketPath,
  ];
  if (platform === "win32") {
    return command.map(tunnelCommandQuoted).join(" ");
  }
  return command.map(shellQuote).join(" ");
}

function tunnel(config: AppConfig): TunnelConfig {
  if (config.mode !== "full" || !config.tunnel) throw new Error("Tunnel commands require full mode");
  return config.tunnel;
}

export function connectTunnel(config: AppConfig): void {
  const settings = tunnel(config);
  mkdirSync(settings.profileDir, { recursive: true, mode: 0o700 });
  const result = runCommand(settings.binaryPath, [
    "runtimes", "connect",
    "--alias", settings.alias,
    "--profile", settings.profileName,
    "--profile-dir", settings.profileDir,
    "--tunnel-client-bin", settings.binaryPath,
    "--tunnel-id", settings.tunnelId,
    "--runtime-api-key", `file:${settings.runtimeKeyFile}`,
    "--mcp-command", mcpCommand(config),
    "--json",
  ], { timeout: TUNNEL_READY_TIMEOUT_MS });
  const structuredOutput = result.stdout.trim();
  const launchError = structuredOutput
    ? tunnelConnectLaunchError(structuredOutput)
    : undefined;
  if (result.status !== 0) {
    const detail = launchError && launchError !== "tunnel-client returned non-JSON connect output"
      ? launchError
      : safeTunnelDetail(tunnelCommandOutput(result) || `exit ${result.status}`);
    throw new Error(`Tunnel managed startup failed: ${detail}`);
  }
  if (launchError) throw new Error(`Tunnel runtime exited during launch: ${launchError}`);
}

export function stopTunnel(config: AppConfig): void {
  const settings = tunnel(config);
  const result = runCommand(
    settings.binaryPath,
    ["runtimes", "stop", settings.alias, "--json"],
    { timeout: 15_000 },
  );
  if (result.status !== 0
    && !/not found|not running|unknown alias|\balias\b[^\r\n]{0,160}\bis not known\b/i.test(
      `${result.stdout}\n${result.stderr}`,
    )) {
    throw new Error(`Failed to stop tunnel runtime: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

export interface TunnelRuntimeStatus {
  ok: boolean;
  processRunning: boolean;
  healthy: boolean;
  ready: boolean;
  state?: string;
  detail: string;
}

export function tunnelCommandOutput(result: {
  status: number;
  stdout: string;
  stderr: string;
}): string {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  return result.status === 0
    ? (stdout || stderr)
    : [stderr, stdout].filter(Boolean).join("\n");
}

function safeTunnelDetail(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text
    .replace(/tunnel_[a-f0-9]{32}/g, "[tunnel-id]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted-key]")
    .slice(0, 2_000);
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : undefined;
}

function runtimeLogTail(parsed: Record<string, unknown>): string | undefined {
  const launchTail = nestedRecord(parsed, "launch_diagnostics")?.log_tail;
  if (typeof launchTail === "string" && launchTail.trim()) return launchTail.trim();
  const statusTail = nestedRecord(nestedRecord(parsed, "local"), "log")?.tail;
  return typeof statusTail === "string" && statusTail.trim() ? statusTail.trim() : undefined;
}

export function tunnelConnectLaunchError(output: string): string | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch {
    return "tunnel-client returned non-JSON connect output";
  }
  const running = parsed.running === true;
  const healthy = parsed.healthy === true;
  const ready = parsed.ready === true;
  if (running && healthy) return undefined;
  const diagnostics = nestedRecord(parsed, "launch_diagnostics");
  const exitCode = typeof parsed.exit_code === "number" ? parsed.exit_code
    : typeof diagnostics?.exit_code === "number" ? diagnostics.exit_code
      : undefined;
  const remoteError = typeof parsed.remote_error === "string" && parsed.remote_error.trim()
    ? parsed.remote_error.trim()
    : undefined;
  const logTail = runtimeLogTail(parsed);
  return safeTunnelDetail([
    `running=${running}`,
    `healthy=${healthy}`,
    `ready=${ready}`,
    ...(exitCode !== undefined ? [`exit_code=${exitCode}`] : []),
    ...(remoteError ? [`remote_error=${remoteError}`] : []),
    ...(logTail ? [`runtime_log=${logTail}`] : []),
    ...(!remoteError && !logTail ? ["runtime did not complete a healthy launch"] : []),
  ].join("; "));
}

export function parseTunnelStatus(output: string, alias: string, exitStatus = 0): TunnelRuntimeStatus {
  if (exitStatus !== 0) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: safeTunnelDetail(output) };
  }
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    if (!Array.isArray(parsed.entries)) throw new Error("local inventory has no entries array");
    const matches = parsed.entries.filter(entry => entry?.alias === alias);
    if (matches.length > 1) throw new Error("local inventory contains duplicate aliases");
    const state = matches.length === 0 ? "stopped" : matches[0].runtime_state;
    if (!["stopped", "starting", "healthy", "ready"].includes(state)) {
      throw new Error("local inventory has an unsupported runtime state");
    }
    // tunnel-client 0.0.12 derives these states from the live process and local healthz/readyz
    // probes. It does not need the optional remote control-plane lookup made by `status`.
    const processRunning = state !== "stopped";
    const healthy = state === "healthy" || state === "ready";
    const ready = state === "ready";
    const ok = processRunning && healthy && ready;
    const detail = ok
      ? "process_running=true healthy=true ready=true"
      : safeTunnelDetail([
        `process_running=${processRunning}`,
        `healthy=${healthy}`,
        `ready=${ready}`,
        `state=${state}`,
        ...(matches.length === 0 ? ["local_inventory=absent"] : []),
      ].join("; "));
    return { ok, processRunning, healthy, ready, state, detail };
  } catch (error) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: `tunnel-client returned invalid local inventory: ${safeTunnelDetail(error instanceof Error ? error.message : String(error))}` };
  }
}

export function tunnelStatus(config: AppConfig): TunnelRuntimeStatus {
  const settings = tunnel(config);
  if (!existsSync(settings.binaryPath)) {
    return { ok: false, processRunning: false, healthy: false, ready: false, detail: `Missing ${settings.binaryPath}` };
  }
  const result = runCommand(
    settings.binaryPath,
    ["runtimes", "cleanup", "--json"],
    { timeout: 10_000 },
  );
  return parseTunnelStatus(tunnelCommandOutput(result), settings.alias, result.status);
}

export async function waitForTunnelReady(
  config: AppConfig,
  timeoutMs = TUNNEL_READY_TIMEOUT_MS,
): Promise<TunnelRuntimeStatus> {
  const deadline = Date.now() + timeoutMs;
  let status = tunnelStatus(config);
  while (!status.ok && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, TUNNEL_STATUS_POLL_INTERVAL_MS));
    status = tunnelStatus(config);
  }
  return status;
}
