import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config";
import { assertDurableRuntimeCommand, atomicWriteFile, getConfigDir } from "./config";
import { runCommand, runChecked } from "./process";
import { fetchLoopback } from "./loopback-http";

const LABEL = "io.github.codex-chatgpt-web.daemon";
const SYSTEMD_UNIT = "codex-chatgpt-web.service";

export interface ServiceStatus {
  supported: boolean;
  installed: boolean;
  loaded: boolean;
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

async function bootstrapService(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown launchctl bootstrap failure";
  while (Date.now() < deadline) {
    const result = runCommand("launchctl", ["bootstrap", launchDomain(), path]);
    if (result.status === 0) return;
    lastError = result.stderr.trim() || result.stdout.trim() || `exit status ${result.status}`;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`launchctl bootstrap ${launchDomain()} ${path} failed after ${timeoutMs}ms: ${lastError}`);
}

async function waitForServiceUnloaded(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getServiceStatus().loaded && Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  if (getServiceStatus().loaded) throw new Error(`launchd did not unload ${LABEL} after ${timeoutMs}ms`);
}

function plist(config: AppConfig): string {
  const logDir = join(getConfigDir(), "logs");
  const args = [...config.runtimeCommand, "serve"];
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
  <string>${xml(join(logDir, "daemon.stdout.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logDir, "daemon.stderr.log"))}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function systemdUnit(config: AppConfig): string {
  const args = [...config.runtimeCommand, "serve"];
  const graphicalSession = config.headed
    ? "After=network-online.target graphical-session.target\nWants=network-online.target\nPartOf=graphical-session.target"
    : "After=network-online.target\nWants=network-online.target";
  const installTarget = config.headed ? "graphical-session.target" : "default.target";
  return `[Unit]
Description=Codex ChatGPT Web daemon
${graphicalSession}

[Service]
Type=simple
ExecStart=${args.map(systemdArg).join(" ")}
Environment=${systemdArg(`CODEX_CHATGPT_WEB_HOME=${getConfigDir()}`)}
Restart=always
RestartSec=10

[Install]
WantedBy=${installTarget}
`;
}

export function serviceDefinition(config: AppConfig, platform: NodeJS.Platform = process.platform): string {
  return platform === "linux" ? systemdUnit(config) : plist(config);
}

function assertManagedPlatform(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Managed background services are supported on macOS and Linux");
  }
}

export function getServiceStatus(): ServiceStatus {
  if (process.platform === "linux") {
    try {
      const result = runCommand("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT]);
      return {
        supported: true,
        installed: existsSync(unitPath()),
        loaded: result.status === 0,
        label: SYSTEMD_UNIT,
        definitionPath: unitPath(),
      };
    } catch {
      return { supported: false, installed: false, loaded: false, label: SYSTEMD_UNIT };
    }
  }
  if (process.platform !== "darwin") return { supported: false, installed: false, loaded: false, label: LABEL };
  const path = plistPath();
  const result = runCommand("launchctl", ["print", serviceTarget()]);
  return {
    supported: true,
    installed: existsSync(path),
    loaded: result.status === 0,
    label: LABEL,
    definitionPath: path,
  };
}

export function installService(config: AppConfig): ServiceStatus {
  assertManagedPlatform();
  assertDurableRuntimeCommand(config.runtimeCommand);
  if (process.platform === "linux") {
    const path = unitPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const next = systemdUnit(config);
    if (!existsSync(path) || readFileSync(path, "utf8") !== next) atomicWriteFile(path, next);
    runChecked("systemctl", ["--user", "daemon-reload"]);
    runChecked("systemctl", ["--user", "reenable", "--now", SYSTEMD_UNIT]);
    return getServiceStatus();
  }
  const path = plistPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(join(getConfigDir(), "logs"), { recursive: true, mode: 0o700 });
  const next = plist(config);
  if (!existsSync(path) || readFileSync(path, "utf8") !== next) atomicWriteFile(path, next);
  const status = getServiceStatus();
  if (!status.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), path]);
  return getServiceStatus();
}

export function startService(): ServiceStatus {
  assertManagedPlatform();
  if (process.platform === "linux") {
    if (!existsSync(unitPath())) throw new Error(`Service is not installed: ${unitPath()}`);
    runChecked("systemctl", ["--user", "daemon-reload"]);
    runChecked("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    return getServiceStatus();
  }
  const path = plistPath();
  if (!existsSync(path)) throw new Error(`Service is not installed: ${path}`);
  const status = getServiceStatus();
  if (!status.loaded) runChecked("launchctl", ["bootstrap", launchDomain(), path]);
  return getServiceStatus();
}

export interface DrainLease {
  release: () => Promise<void>;
}

async function control(config: AppConfig, action: "drain" | "resume" | "cancel-browser-turns"): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetchLoopback(`http://${config.host}:${config.port}/admin/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

export async function cancelBrowserTurns(config: AppConfig): Promise<number> {
  const result = await control(config, "cancel-browser-turns");
  const cancelled = result.cancelled_browser_turns;
  if (!Number.isInteger(cancelled) || (cancelled as number) < 0) {
    throw new Error("daemon did not acknowledge browser-turn cancellation");
  }
  return cancelled as number;
}

export async function negotiateDrain(
  controlAction: (action: "drain" | "resume") => Promise<Record<string, unknown>>,
): Promise<DrainLease> {
  let drained = false;
  let drainAttempted = false;
  try {
    drainAttempted = true;
    const health = await controlAction("drain");
    drained = true;
    const activeHttp = health.active_http_turns;
    const activeBrowser = health.active_browser_turns;
    if (!Number.isInteger(activeHttp) || !Number.isInteger(activeBrowser) || health.accepting_turns !== false) {
      throw new Error("daemon did not acknowledge the drain contract");
    }
    if ((activeHttp as number) > 0 || (activeBrowser as number) > 0) {
      throw new Error(`daemon has ${activeHttp} active HTTP turn(s) and ${activeBrowser} active browser turn(s)`);
    }
    return { release: async () => { if (drained) { await controlAction("resume"); drained = false; } } };
  } catch (error) {
    let resumeError: unknown;
    if (drainAttempted) {
      try {
        await controlAction("resume");
        drained = false;
      } catch (caught) {
        resumeError = caught;
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    const compensation = resumeError
      ? `; compensating resume also failed: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`
      : "";
    throw new Error(`Refusing to stop or restart because atomic idleness could not be proven: ${message}${compensation}`);
  }
}

async function acquireDrain(config: AppConfig): Promise<DrainLease> {
  if (!getServiceStatus().loaded) return { release: async () => {} };
  return negotiateDrain(action => control(config, action));
}

export async function assertServiceIdle(config: AppConfig): Promise<void> {
  const lease = await acquireDrain(config);
  await lease.release();
}

export async function restartService(config: AppConfig): Promise<ServiceStatus> {
  assertManagedPlatform();
  if (!getServiceStatus().loaded) return startService();
  const lease = await acquireDrain(config);
  if (process.platform === "linux") {
    try {
      runChecked("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
    } catch (error) {
      await lease.release().catch(() => {});
      throw error;
    }
    return getServiceStatus();
  }
  try {
    runChecked("launchctl", ["bootout", serviceTarget()]);
    await waitForServiceUnloaded();
    await bootstrapService(plistPath());
  } catch (error) {
    await lease.release().catch(() => {});
    throw error;
  }
  return getServiceStatus();
}

export function removeLegacyRuntimeArtifacts(config: AppConfig): void {
  const legacyWrapper = join(getConfigDir(), "bin", "serve-with-playwright.sh");
  const legacyVendor = join(getConfigDir(), "vendor");
  if (config.runtimeCommand.some(part => part === legacyWrapper || part.startsWith(`${legacyVendor}/`))) {
    throw new Error("Refusing to remove legacy runtime artifacts while the active service still references them");
  }
  rmSync(legacyWrapper, { force: true });
  rmSync(legacyVendor, { recursive: true, force: true });
}

export async function stopService(config: AppConfig): Promise<ServiceStatus> {
  assertManagedPlatform();
  if (getServiceStatus().loaded) {
    const lease = await acquireDrain(config);
    try {
      if (process.platform === "linux") runChecked("systemctl", ["--user", "stop", SYSTEMD_UNIT]);
      else {
        runChecked("launchctl", ["bootout", serviceTarget()]);
        await waitForServiceUnloaded();
      }
    } catch (error) {
      await lease.release().catch(() => {});
      throw error;
    }
  }
  return getServiceStatus();
}

export async function uninstallService(config: AppConfig): Promise<ServiceStatus> {
  assertManagedPlatform();
  if (getServiceStatus().loaded) {
    const lease = await acquireDrain(config);
    try {
      if (process.platform === "linux") runChecked("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
      else {
        runChecked("launchctl", ["bootout", serviceTarget()]);
        await waitForServiceUnloaded();
      }
    } catch (error) {
      await lease.release().catch(() => {});
      throw error;
    }
  }
  if (process.platform === "linux") {
    runCommand("systemctl", ["--user", "disable", SYSTEMD_UNIT]);
    rmSync(unitPath(), { force: true });
    runChecked("systemctl", ["--user", "daemon-reload"]);
  } else rmSync(plistPath(), { force: true });
  return getServiceStatus();
}
