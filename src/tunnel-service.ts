import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, getConfigDir, isNgrokTunnel, isOpenAiTunnel } from "./config";
import { runCommand, runChecked } from "./process";

const LABEL = "io.github.codex-chatgpt-web.tunnel";
const SYSTEMD_UNIT = "codex-chatgpt-web-tunnel.service";

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

function unitPath(): string {
  return join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT);
}

function systemdArg(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

function settings(config: AppConfig) {
  if (config.mode !== "full" || !config.tunnel) throw new Error("Tunnel service requires full mode");
  return config.tunnel;
}

function assertManagedPlatform(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Managed tunnel services are supported on macOS and Linux");
  }
}

function serviceArguments(config: AppConfig): string[] {
  const tunnel = settings(config);
  if (isNgrokTunnel(tunnel)) {
    return [
      ...config.runtimeCommand,
      "ngrok-tunnel",
      "--ngrok", tunnel.binaryPath,
      "--broker-socket", config.brokerSocketPath,
      "--port", String(tunnel.port),
      "--url", tunnel.url,
    ];
  }
  return [tunnel.binaryPath, "run", "--profile-dir", tunnel.profileDir, "--profile", tunnel.profileName];
}

function launchdDefinition(config: AppConfig): string {
  const logDir = join(getConfigDir(), "logs");
  const args = serviceArguments(config);
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

function systemdDefinition(config: AppConfig): string {
  return `[Unit]
Description=Codex ChatGPT Web tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${serviceArguments(config).map(systemdArg).join(" ")}
Environment=${systemdArg(`CODEX_CHATGPT_WEB_HOME=${getConfigDir()}`)}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export function tunnelServiceDefinition(config: AppConfig, platform: NodeJS.Platform = process.platform): string {
  return platform === "linux" ? systemdDefinition(config) : launchdDefinition(config);
}

export function getTunnelServiceStatus(): TunnelServiceStatus {
  if (process.platform === "linux") {
    try {
      const result = runCommand("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT]);
      return {
        supported: true,
        installed: existsSync(unitPath()),
        loaded: result.status === 0,
        running: result.status === 0,
        label: SYSTEMD_UNIT,
        definitionPath: unitPath(),
      };
    } catch {
      return { supported: false, installed: false, loaded: false, running: false, label: SYSTEMD_UNIT };
    }
  }
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
  const path = process.platform === "linux" ? unitPath() : plistPath();
  return existsSync(path) && readFileSync(path, "utf8") === tunnelServiceDefinition(config);
}

export function installTunnelService(config: AppConfig): TunnelServiceStatus {
  assertManagedPlatform();
  const tunnel = settings(config);
  if (!existsSync(tunnel.binaryPath)) throw new Error(`Tunnel client is missing: ${tunnel.binaryPath}`);
  if (isOpenAiTunnel(tunnel)) {
    const profile = join(tunnel.profileDir, `${tunnel.profileName}.yaml`);
    if (!existsSync(profile)) throw new Error(`Tunnel profile is missing: ${profile}`);
  }
  const current = getTunnelServiceStatus();
  const next = tunnelServiceDefinition(config);
  const path = process.platform === "linux" ? unitPath() : plistPath();
  if (current.loaded && (!current.installed || readFileSync(path, "utf8") !== next)) {
    throw new Error("Refusing to replace a loaded tunnel service definition; stop it before installing the update");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(join(getConfigDir(), "logs"), { recursive: true, mode: 0o700 });
  if (!current.installed || readFileSync(path, "utf8") !== next) atomicWriteFile(path, next);
  if (process.platform === "linux") {
    runChecked("systemctl", ["--user", "daemon-reload"]);
    if (!current.loaded) runChecked("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
  } else if (!current.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), plistPath()]);
  return getTunnelServiceStatus();
}

export function startTunnelService(): TunnelServiceStatus {
  assertManagedPlatform();
  const path = process.platform === "linux" ? unitPath() : plistPath();
  if (!existsSync(path)) throw new Error("Tunnel service is not installed; rerun full setup");
  if (process.platform === "linux") {
    runChecked("systemctl", ["--user", "daemon-reload"]);
    if (!getTunnelServiceStatus().loaded) runChecked("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
  } else if (!getTunnelServiceStatus().loaded) runChecked("launchctl", ["bootstrap", launchDomain(), plistPath()]);
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
  assertManagedPlatform();
  if (getTunnelServiceStatus().loaded) {
    if (process.platform === "linux") runChecked("systemctl", ["--user", "stop", SYSTEMD_UNIT]);
    else {
      runChecked("launchctl", ["bootout", serviceTarget()]);
      await waitForTunnelServiceUnloaded();
    }
  }
  return getTunnelServiceStatus();
}

export async function restartTunnelService(): Promise<TunnelServiceStatus> {
  await stopTunnelService();
  return startTunnelService();
}

export async function uninstallTunnelService(): Promise<TunnelServiceStatus> {
  assertManagedPlatform();
  await stopTunnelService();
  if (process.platform === "linux") {
    runCommand("systemctl", ["--user", "disable", SYSTEMD_UNIT]);
    rmSync(unitPath(), { force: true });
    runChecked("systemctl", ["--user", "daemon-reload"]);
  } else rmSync(plistPath(), { force: true });
  return getTunnelServiceStatus();
}
