import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandUserPath } from "./config";

export const CODEX_CONFIG_BACKUP_DIRNAME = "backup-codex-chatgpt-web";

export interface CodexConfigBackupManifest {
  scriptVersion: string;
  installedAt: string;
  originalConfigExisted: boolean;
  configPath: string;
  codexHome: string;
  routeUrl?: string;
}

function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  if (configured) return expandUserPath(configured);
  return join(homedir(), ".codex");
}

function resolveCodexConfigPath(codexHome = resolveCodexHome()): string {
  return join(codexHome, "config.toml");
}

export function getCodexConfigBackupDir(codexHome = resolveCodexHome()): string {
  return join(codexHome, CODEX_CONFIG_BACKUP_DIRNAME);
}

export function getCodexConfigBackupPath(codexHome = resolveCodexHome()): string {
  return join(getCodexConfigBackupDir(codexHome), "config.toml");
}

export function getCodexConfigBackupManifestPath(codexHome = resolveCodexHome()): string {
  return join(getCodexConfigBackupDir(codexHome), "manifest.txt");
}

function formatInstalledAt(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort on platforms without POSIX modes.
  }
}

export function parseCodexConfigBackupManifest(text: string): CodexConfigBackupManifest {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("---")) break;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    values.set(line.slice(0, index), line.slice(index + 1));
  }
  const original = values.get("original_config_existed");
  if (original !== "0" && original !== "1") {
    throw new Error("Codex config backup manifest is missing original_config_existed");
  }
  const configPath = values.get("config_path");
  const codexHome = values.get("codex_home");
  if (!configPath || !codexHome) {
    throw new Error("Codex config backup manifest is missing config_path or codex_home");
  }
  return {
    scriptVersion: values.get("script_version") || "unknown",
    installedAt: values.get("installed_at") || "unknown",
    originalConfigExisted: original === "1",
    configPath,
    codexHome,
    ...(values.get("route_url") ? { routeUrl: values.get("route_url") } : {}),
  };
}

function writeManifest(path: string, manifest: CodexConfigBackupManifest, report: string[] = []): void {
  const lines = [
    `script_version=${manifest.scriptVersion}`,
    `installed_at=${manifest.installedAt}`,
    `original_config_existed=${manifest.originalConfigExisted ? "1" : "0"}`,
    `config_path=${manifest.configPath}`,
    `codex_home=${manifest.codexHome}`,
    ...(manifest.routeUrl ? [`route_url=${manifest.routeUrl}`] : []),
    "--- changes made to config.toml ---",
    ...report,
    "",
  ];
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
  chmodBestEffort(path, 0o600);
}

/**
 * DeepSeek-style full-file backup of ~/.codex/config.toml.
 * Creates the backup only on the first install; later updates keep the original snapshot.
 */
export function ensureCodexConfigBackup(options: {
  routeUrl?: string;
  report?: string[];
  version?: string;
} = {}): { created: boolean; path: string; originalConfigExisted: boolean } {
  const codexHome = resolveCodexHome();
  const configPath = resolveCodexConfigPath(codexHome);
  const backupDir = getCodexConfigBackupDir(codexHome);
  const backupPath = getCodexConfigBackupPath(codexHome);
  const manifestPath = getCodexConfigBackupManifestPath(codexHome);

  if (existsSync(backupDir)) {
    if (!existsSync(manifestPath)) {
      throw new Error(
        `Codex config backup directory exists but is incomplete: ${backupDir}. `
        + "Restore or delete it before running setup again.",
      );
    }
    const manifest = parseCodexConfigBackupManifest(readFileSync(manifestPath, "utf8"));
    if (manifest.originalConfigExisted && !existsSync(backupPath)) {
      throw new Error(`Codex config backup is corrupted: missing ${backupPath}`);
    }
    return {
      created: false,
      path: backupDir,
      originalConfigExisted: manifest.originalConfigExisted,
    };
  }

  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodBestEffort(backupDir, 0o700);

  const originalConfigExisted = existsSync(configPath);
  if (originalConfigExisted) {
    copyFileSync(configPath, backupPath);
    chmodBestEffort(backupPath, 0o600);
  }

  writeManifest(manifestPath, {
    scriptVersion: options.version || "1.1.1",
    installedAt: formatInstalledAt(),
    originalConfigExisted,
    configPath,
    codexHome,
    ...(options.routeUrl ? { routeUrl: options.routeUrl } : {}),
  }, options.report || [
    "Saved a full copy of config.toml before codex-chatgpt-web modified the Codex route.",
  ]);

  return { created: true, path: backupDir, originalConfigExisted };
}

/**
 * Restore ~/.codex/config.toml from the full-file backup and delete the backup directory.
 * Returns null when no backup exists (caller should fall back to journal restore).
 */
export function restoreCodexConfigBackup(): {
  restored: boolean;
  deletedConfig: boolean;
  backupDir: string;
} | null {
  const backupDir = getCodexConfigBackupDir();
  const backupPath = getCodexConfigBackupPath();
  const manifestPath = getCodexConfigBackupManifestPath();
  if (!existsSync(backupDir)) return null;
  if (!existsSync(manifestPath)) {
    throw new Error(`Codex config backup is corrupted: missing ${manifestPath}`);
  }

  const manifest = parseCodexConfigBackupManifest(readFileSync(manifestPath, "utf8"));
  const configPath = resolveCodexConfigPath();
  let deletedConfig = false;

  if (manifest.originalConfigExisted) {
    if (!existsSync(backupPath)) {
      throw new Error(`Codex config backup is corrupted: missing ${backupPath}`);
    }
    copyFileSync(backupPath, configPath);
    chmodBestEffort(configPath, 0o600);
  } else if (existsSync(configPath)) {
    rmSync(configPath);
    deletedConfig = true;
  }

  rmSync(backupDir, { recursive: true, force: true });
  return { restored: true, deletedConfig, backupDir };
}

export function discardCodexConfigBackup(): boolean {
  const backupDir = getCodexConfigBackupDir();
  if (!existsSync(backupDir)) return false;
  rmSync(backupDir, { recursive: true, force: true });
  return true;
}
