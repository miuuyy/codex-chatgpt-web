import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, getConfigDir } from "./config";
import { runCommand, runChecked } from "./process";
import { TUNNEL_MCP_CONNECTION_MAX_TTL } from "./tunnel";

const LABEL = "io.github.codex-chatgpt-web.tunnel";

export interface TunnelServiceStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  label: string;
  definitionPath?: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function launchDomain(): string {
  return `gui/${userInfo().uid}`;
}

function serviceTarget(): string {
  return `${launchDomain()}/${LABEL}`;
}

function settings(config: AppConfig) {
  if (config.mode !== "full" || !config.tunnel) throw new Error("Tunnel service requires full mode");
  return config.tunnel;
}

function assertMacOs(): void {
  if (process.platform !== "darwin") {
    throw new Error("Managed tunnel service installation is currently supported on macOS only");
  }
}

export function tunnelServiceDefinition(config: AppConfig): string {
  const tunnel = settings(config);
  const logDir = join(getConfigDir(), "logs");
  const args = [tunnel.binaryPath, "run", "--profile-dir", tunnel.profileDir, "--profile", tunnel.profileName];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_CHATGPT_WEB_HOME</key>
    <string>${xml(getConfigDir())}</string>
    <key>MCP_CONNECTION_MAX_TTL</key>
    <string>${TUNNEL_MCP_CONNECTION_MAX_TTL}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(logDir, "tunnel.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "tunnel.stderr.log"))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

export function getTunnelServiceStatus(): TunnelServiceStatus {
  if (process.platform !== "darwin") {
    return { supported: false, installed: false, loaded: false, running: false, label: LABEL };
  }
  const path = plistPath();
  const result = runCommand("launchctl", ["print", serviceTarget()]);
  return {
    supported: true,
    installed: existsSync(path),
    loaded: result.status === 0,
    running: result.status === 0 && /^\s*state = running\s*$/m.test(result.stdout),
    label: LABEL,
    definitionPath: path,
  };
}

export function tunnelServiceDefinitionMatches(config: AppConfig): boolean {
  const path = plistPath();
  return existsSync(path) && readFileSync(path, "utf8") === tunnelServiceDefinition(config);
}

export function installTunnelService(config: AppConfig): TunnelServiceStatus {
  assertMacOs();
  const tunnel = settings(config);
  const profile = join(tunnel.profileDir, `${tunnel.profileName}.yaml`);
  if (!existsSync(tunnel.binaryPath)) throw new Error(`Tunnel client is missing: ${tunnel.binaryPath}`);
  if (!existsSync(profile)) throw new Error(`Tunnel profile is missing: ${profile}`);
  const current = getTunnelServiceStatus();
  const next = tunnelServiceDefinition(config);
  if (current.loaded && (!current.installed || readFileSync(plistPath(), "utf8") !== next)) {
    throw new Error("Refusing to replace a loaded tunnel service definition; stop it before installing the update");
  }
  mkdirSync(dirname(plistPath()), { recursive: true, mode: 0o700 });
  mkdirSync(join(getConfigDir(), "logs"), { recursive: true, mode: 0o700 });
  if (!current.installed || readFileSync(plistPath(), "utf8") !== next) atomicWriteFile(plistPath(), next);
  if (!current.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), plistPath()]);
  return getTunnelServiceStatus();
}

export function startTunnelService(): TunnelServiceStatus {
  assertMacOs();
  if (!existsSync(plistPath())) throw new Error("Tunnel service is not installed; rerun full setup");
  if (!getTunnelServiceStatus().loaded) runChecked("launchctl", ["bootstrap", launchDomain(), plistPath()]);
  return getTunnelServiceStatus();
}

async function waitForTunnelServiceUnloaded(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getTunnelServiceStatus().loaded && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (getTunnelServiceStatus().loaded) throw new Error(`launchd did not unload ${LABEL} after ${timeoutMs}ms`);
}

export async function stopTunnelService(): Promise<TunnelServiceStatus> {
  assertMacOs();
  if (getTunnelServiceStatus().loaded) {
    runChecked("launchctl", ["bootout", serviceTarget()]);
    await waitForTunnelServiceUnloaded();
  }
  return getTunnelServiceStatus();
}

export async function restartTunnelService(): Promise<TunnelServiceStatus> {
  await stopTunnelService();
  return startTunnelService();
}

export async function uninstallTunnelService(): Promise<TunnelServiceStatus> {
  assertMacOs();
  await stopTunnelService();
  rmSync(plistPath(), { force: true });
  return getTunnelServiceStatus();
}
