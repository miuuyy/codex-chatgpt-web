import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  getCodexHome,
  getCodexModelsCachePath,
  patchCodexRouteText,
} from "./codex-integration";
import { atomicWriteFile, getConfigDir } from "./config";

const MAX_MANAGED_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_DISPLAY_NAME = "External Responses bridge";

interface FileSnapshot {
  exists: boolean;
  data?: string;
  mode?: number;
}

interface ExternalResponsesJournal {
  version: 1;
  active: true;
  baseUrl: string;
  displayName: string;
  previousLocalRouteActive: boolean;
  previous: {
    config: FileSnapshot;
    auth: FileSnapshot;
  };
  installed: {
    configSha256: string;
    authSha256: string;
  };
}

export interface ExternalResponsesIntegrationStatus {
  installed: boolean;
  active: boolean;
  baseUrl?: string;
  displayName?: string;
  previousLocalRouteActive?: boolean;
  errors: string[];
}

export interface InstallExternalResponsesOptions {
  baseUrl: string;
  apiKey: string;
  displayName?: string;
  previousLocalRouteActive?: boolean;
}

function configPath(): string {
  return join(getCodexHome(), "config.toml");
}

function authPath(): string {
  return join(getCodexHome(), "auth.json");
}

export function getExternalResponsesJournalPath(): string {
  return join(getConfigDir(), "codex", "external-responses-journal.json");
}

export function getExternalResponsesJournalRecoveryPath(): string {
  return join(getConfigDir(), "codex", "external-responses-journal.recovery.json");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(path: string): FileSnapshot {
  if (!existsSync(path)) return { exists: false };
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`Managed Codex path is not a regular file: ${path}`);
  if (stat.size > MAX_MANAGED_FILE_BYTES) {
    throw new Error(`Managed Codex file exceeds ${MAX_MANAGED_FILE_BYTES} bytes: ${path}`);
  }
  return {
    exists: true,
    data: readFileSync(path).toString("base64"),
    mode: stat.mode & 0o777,
  };
}

function snapshotBytes(value: FileSnapshot): Buffer {
  if (!value.exists) return Buffer.alloc(0);
  if (typeof value.data !== "string") throw new Error("Integration journal is missing file snapshot data");
  return Buffer.from(value.data, "base64");
}

function restore(path: string, value: FileSnapshot): void {
  if (!value.exists) {
    rmSync(path, { force: true });
    return;
  }
  atomicWriteFile(path, snapshotBytes(value));
  if (process.platform !== "win32" && Number.isInteger(value.mode)) chmodSync(path, value.mode!);
}

function currentSha(path: string): string | null {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_MANAGED_FILE_BYTES) return null;
  return sha256(readFileSync(path));
}

function snapshotSha(value: FileSnapshot): string | null {
  return value.exists ? sha256(snapshotBytes(value)) : null;
}

function matchesPrevious(journal: ExternalResponsesJournal): boolean {
  return currentSha(configPath()) === snapshotSha(journal.previous.config)
    && currentSha(authPath()) === snapshotSha(journal.previous.auth);
}

function filesAreKnownTransitionState(journal: ExternalResponsesJournal): boolean {
  const configSha = currentSha(configPath());
  const authSha = currentSha(authPath());
  return [snapshotSha(journal.previous.config), journal.installed.configSha256].includes(configSha)
    && [snapshotSha(journal.previous.auth), journal.installed.authSha256].includes(authSha);
}

function finishInterruptedRestore(journal: ExternalResponsesJournal): void {
  restore(configPath(), journal.previous.config);
  restore(authPath(), journal.previous.auth);
  rmSync(getCodexModelsCachePath(), { force: true });
  rmSync(getExternalResponsesJournalPath(), { force: true });
  rmSync(getExternalResponsesJournalRecoveryPath(), { force: true });
}

function serialize(journal: ExternalResponsesJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

function parseJournal(path: string): ExternalResponsesJournal {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ExternalResponsesJournal>;
  if (parsed.version !== 1
    || parsed.active !== true
    || typeof parsed.baseUrl !== "string"
    || typeof parsed.displayName !== "string"
    || typeof parsed.previousLocalRouteActive !== "boolean"
    || !parsed.previous?.config
    || !parsed.previous?.auth
    || !/^[a-f0-9]{64}$/.test(parsed.installed?.configSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(parsed.installed?.authSha256 ?? "")) {
    throw new Error(`Invalid external Responses integration journal: ${path}`);
  }
  return parsed as ExternalResponsesJournal;
}

function matchesInstalled(journal: ExternalResponsesJournal): boolean {
  return currentSha(configPath()) === journal.installed.configSha256
    && currentSha(authPath()) === journal.installed.authSha256;
}

function readJournal(): ExternalResponsesJournal | undefined {
  const primaryPath = getExternalResponsesJournalPath();
  const recoveryPath = getExternalResponsesJournalRecoveryPath();
  const primary = existsSync(primaryPath) ? parseJournal(primaryPath) : undefined;
  const recovery = existsSync(recoveryPath) ? parseJournal(recoveryPath) : undefined;
  if (!primary && !recovery) return undefined;
  if (primary && recovery && serialize(primary) === serialize(recovery)) {
    if (matchesInstalled(primary)) return primary;
    if (filesAreKnownTransitionState(primary)) {
      finishInterruptedRestore(primary);
      return undefined;
    }
    throw new Error("External Responses journals do not match the active Codex files");
  }
  if (primary && !recovery) {
    if (!matchesInstalled(primary)) throw new Error("External Responses journal does not match the active Codex files");
    atomicWriteFile(recoveryPath, serialize(primary));
    return primary;
  }
  if (recovery && !primary) {
    if (matchesInstalled(recovery)) {
      atomicWriteFile(primaryPath, serialize(recovery));
      return recovery;
    }
    if (filesAreKnownTransitionState(recovery)) {
      finishInterruptedRestore(recovery);
      return undefined;
    }
    throw new Error("External Responses recovery journal does not match the active Codex files");
  }
  const primaryMatches = matchesInstalled(primary!);
  const recoveryMatches = matchesInstalled(recovery!);
  if (primaryMatches === recoveryMatches) {
    throw new Error("External Responses journal copies are inconsistent with the active Codex files");
  }
  const selected = primaryMatches ? primary! : recovery!;
  atomicWriteFile(primaryPath, serialize(selected));
  atomicWriteFile(recoveryPath, serialize(selected));
  return selected;
}

function validateDisplayName(value: string | undefined): string {
  const displayName = value?.trim() || DEFAULT_DISPLAY_NAME;
  if (displayName.length > 80 || /[\r\n\u0000-\u001f]/.test(displayName)) {
    throw new Error("External Responses display name is invalid");
  }
  return displayName;
}

function validateApiKey(value: string): string {
  const apiKey = value.trim();
  if (apiKey.length < 8 || apiKey.length > 8192 || /[\r\n\u0000-\u001f]/.test(apiKey)) {
    throw new Error("A valid downstream API key is required");
  }
  return apiKey;
}

export function normalizeExternalResponsesBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("External Responses endpoint must be a valid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("External Responses endpoint must use HTTPS");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("External Responses endpoint must not contain credentials, query parameters, or fragments");
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/v1")) throw new Error("External Responses endpoint must end in /v1");
  parsed.pathname = pathname;
  return parsed.toString().replace(/\/$/, "");
}

function writeInstallTransaction(
  journal: ExternalResponsesJournal,
  config: string,
  auth: string,
): void {
  const paths = [
    configPath(),
    authPath(),
    getExternalResponsesJournalPath(),
    getExternalResponsesJournalRecoveryPath(),
    getCodexModelsCachePath(),
  ];
  const before = paths.map(path => ({ path, value: snapshot(path) }));
  try {
    const data = serialize(journal);
    atomicWriteFile(getExternalResponsesJournalRecoveryPath(), data);
    atomicWriteFile(configPath(), config);
    atomicWriteFile(authPath(), auth);
    rmSync(getCodexModelsCachePath(), { force: true });
    atomicWriteFile(getExternalResponsesJournalPath(), data);
  } catch (error) {
    const failures: string[] = [];
    for (const entry of [...before].reverse()) {
      try { restore(entry.path, entry.value); }
      catch (caught) { failures.push(caught instanceof Error ? caught.message : String(caught)); }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(failures.length > 0 ? `${primary}; rollback failed: ${failures.join("; ")}` : primary);
  }
}

export function installExternalResponsesIntegration(
  options: InstallExternalResponsesOptions,
): ExternalResponsesIntegrationStatus {
  const baseUrl = normalizeExternalResponsesBaseUrl(options.baseUrl);
  const apiKey = validateApiKey(options.apiKey);
  const displayName = validateDisplayName(options.displayName);
  const existing = readJournal();
  if (existing && !matchesInstalled(existing)) {
    throw new Error("Codex config or auth changed after installation; refusing to overwrite newer values");
  }
  const previous = existing?.previous ?? {
    config: snapshot(configPath()),
    auth: snapshot(authPath()),
  };
  const baselineConfig = snapshotBytes(previous.config).toString("utf8");
  const installedConfig = patchCodexRouteText(baselineConfig, baseUrl, true);
  const installedAuth = `${JSON.stringify({ OPENAI_API_KEY: apiKey }, null, 2)}\n`;
  const journal: ExternalResponsesJournal = {
    version: 1,
    active: true,
    baseUrl,
    displayName,
    previousLocalRouteActive: existing?.previousLocalRouteActive
      ?? options.previousLocalRouteActive === true,
    previous,
    installed: {
      configSha256: sha256(installedConfig),
      authSha256: sha256(installedAuth),
    },
  };
  writeInstallTransaction(journal, installedConfig, installedAuth);
  return { installed: true, active: true, baseUrl, displayName, errors: [] };
}

export function uninstallExternalResponsesIntegration(): { changed: boolean } {
  const journal = readJournal();
  if (!journal) return { changed: false };
  if (!matchesInstalled(journal)) {
    throw new Error("Codex config or auth changed after installation; refusing to overwrite newer values");
  }
  const paths = [
    configPath(),
    authPath(),
    getExternalResponsesJournalPath(),
    getExternalResponsesJournalRecoveryPath(),
    getCodexModelsCachePath(),
  ];
  const before = paths.map(path => ({ path, value: snapshot(path) }));
  try {
    restore(configPath(), journal.previous.config);
    restore(authPath(), journal.previous.auth);
    rmSync(getCodexModelsCachePath(), { force: true });
    rmSync(getExternalResponsesJournalPath(), { force: true });
    rmSync(getExternalResponsesJournalRecoveryPath(), { force: true });
  } catch (error) {
    for (const entry of [...before].reverse()) {
      try { restore(entry.path, entry.value); } catch { /* Preserve the primary error. */ }
    }
    throw error;
  }
  return { changed: true };
}

export function inspectExternalResponsesIntegration(): ExternalResponsesIntegrationStatus {
  try {
    const journal = readJournal();
    if (!journal) return { installed: false, active: false, errors: [] };
    const errors = matchesInstalled(journal)
      ? []
      : ["Codex config or auth changed after installation"];
    return {
      installed: true,
      active: errors.length === 0,
      baseUrl: journal.baseUrl,
      displayName: journal.displayName,
      previousLocalRouteActive: journal.previousLocalRouteActive,
      errors,
    };
  } catch (error) {
    return {
      installed: true,
      active: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
