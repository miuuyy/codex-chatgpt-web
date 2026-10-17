import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AppConfig, SubagentProtocol } from "./config";
import { atomicWriteFile, expandUserPath, getConfigDir } from "./config";

export const MANAGED_COMMENT = "# Managed by codex-chatgpt-web; `codex-chatgpt-web uninstall` restores prior values.";
export const MANAGED_ROUTE_COMMENT =
  "# Managed by codex-chatgpt-web: Responses use the local bridge; Voice stays on ChatGPT.";
export const CODEX_REALTIME_WEBRTC_CALL_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const MANAGED_REMOTE_COMPACTION_LINE =
  "remote_compaction_v2 = false # Managed by codex-chatgpt-web: bounds retained Web image history.";
export const MANAGED_MULTI_AGENT_LINE =
  "multi_agent = true # Managed by codex-chatgpt-web: enables routed Web subagents.";
export const MANAGED_MULTI_AGENT_V2_LINE =
  "multi_agent_v2 = false # Managed by codex-chatgpt-web: keeps routed Web subagent payloads readable.";
export const MANAGED_MULTI_AGENT_V2_TABLE_LINE =
  "enabled = false # Managed by codex-chatgpt-web: keeps routed Web subagent payloads readable.";
export const MIN_COMPATIBILITY_V1_AGENT_DEPTH = 2;
export function managedAgentMaxDepthLine(value: number): string {
  return `max_depth = ${value} # Managed by codex-chatgpt-web: allows nested routed Web subagents in Compatibility V1.`;
}

export interface PreviousAssignment {
  present: boolean;
  rawLine?: string;
  value?: string;
  index?: number;
}
export type ManagedAssignmentKey = "openai_base_url" | "model_provider" | "model_catalog_json";

export interface PreviousFeatureAssignment extends PreviousAssignment {
  tablePresent: boolean;
  tableName?: "features" | "features.multi_agent_v2";
  inlineTable?: boolean;
  separatorInserted?: boolean;
}

export interface PreviousAgentAssignment extends PreviousAssignment {
  tablePresent: boolean;
  separatorInserted?: boolean;
}

export interface InstalledCodexInterruptHook {
  command: string;
  groupIndex: number;
  stateKey: string;
  trustedHash: string;
  fragment: string;
}

interface RouteRecoveryState {
  /** Present only when the launcher disconnected an active route after runtime failure. */
  reconnectOnStartup?: true;
}

export interface CodexIntegrationJournal extends RouteRecoveryState {
  version: 10;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
    experimental_realtime_webrtc_call_base_url: string;
    subagent_protocol: SubagentProtocol;
    agent_max_depth?: number;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  previousRealtimeWebrtcCallBaseUrl: PreviousAssignment;
  interruptHook: InstalledCodexInterruptHook;
  previousMultiAgent?: PreviousFeatureAssignment;
  previousMultiAgentV2?: PreviousFeatureAssignment;
  previousAgentMaxDepth?: PreviousAgentAssignment;
  format?: {
    lineEnding: "\n" | "\r\n" | "\r";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV9 extends RouteRecoveryState {
  version: 9;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
    experimental_realtime_webrtc_call_base_url: string;
    subagent_protocol: SubagentProtocol;
    agent_max_depth?: number;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  previousRealtimeWebrtcCallBaseUrl: PreviousAssignment;
  previousMultiAgent?: PreviousFeatureAssignment;
  previousMultiAgentV2?: PreviousFeatureAssignment;
  previousAgentMaxDepth?: PreviousAgentAssignment;
  format?: {
    lineEnding: "\n" | "\r\n" | "\r";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV8 extends RouteRecoveryState {
  version: 8;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
    subagent_protocol: SubagentProtocol;
    agent_max_depth?: number;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  previousMultiAgent?: PreviousFeatureAssignment;
  previousMultiAgentV2?: PreviousFeatureAssignment;
  previousAgentMaxDepth?: PreviousAgentAssignment;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV7 extends RouteRecoveryState {
  version: 7;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV6 extends RouteRecoveryState {
  version: 6;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
    remote_compaction_v2: false;
    multi_agent: true;
    multi_agent_v2: false;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  previousRemoteCompactionV2: PreviousFeatureAssignment;
  previousMultiAgent: PreviousFeatureAssignment;
  previousMultiAgentV2: PreviousFeatureAssignment;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV5 extends RouteRecoveryState {
  version: 5;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
    remote_compaction_v2: false;
    multi_agent: true;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  previousRemoteCompactionV2: PreviousFeatureAssignment;
  previousMultiAgent: PreviousFeatureAssignment;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV4 extends RouteRecoveryState {
  version: 4;
  active: boolean;
  configPath: string;
  installed: {
    openai_base_url: string;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournalV3 extends RouteRecoveryState {
  version: 3;
  configPath: string;
  installed: {
    openai_base_url: string;
  };
  previous: Record<ManagedAssignmentKey, PreviousAssignment>;
  format?: {
    lineEnding: "\n" | "\r\n";
    trailingNewline: boolean;
  };
}

export interface LegacyCodexIntegrationJournal {
  version: 2;
  configPath: string;
  catalogPath: string;
  catalogSha256: string;
  providerBlock: string;
  installed: {
    model_provider: string;
    model_catalog_json: string;
  };
  previous: {
    model_provider: PreviousAssignment;
    model_catalog_json: PreviousAssignment;
  };
}

export type ManagedRouteJournal =
  | CodexIntegrationJournal
  | LegacyCodexIntegrationJournalV9
  | LegacyCodexIntegrationJournalV8
  | LegacyCodexIntegrationJournalV7
  | LegacyCodexIntegrationJournalV6
  | LegacyCodexIntegrationJournalV5
  | LegacyCodexIntegrationJournalV4
  | LegacyCodexIntegrationJournalV3;
export type AnyCodexIntegrationJournal = ManagedRouteJournal | LegacyCodexIntegrationJournal;

export interface FileSnapshot {
  path: string;
  exists: boolean;
  data?: Buffer;
  symlink?: { link: string; target: string; mode: number };
}

export interface InstallCodexIntegrationOptions {
  replaceExistingRoute?: boolean;
  preserveDisconnectedRoute?: boolean;
}

export interface UninstallCodexIntegrationResult {
  changed: boolean;
}

export interface SetCodexIntegrationActiveResult {
  changed: boolean;
  active: boolean;
}

export interface CodexModelContextOverride {
  contextWindow: number;
}

export function getCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return resolve(expandUserPath(configured || join(homedir(), ".codex")));
}

/** Extra, operator-authorized local Codex state roots. Never derive these from a request. */
export function getAdditionalTrustedCodexHomes(): string[] {
  const raw = process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES?.trim();
  if (!raw) return [];
  if (raw.length > 4096) throw new Error("Trusted Codex homes configuration is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES must be a JSON array of absolute paths");
  }
  if (!Array.isArray(parsed) || parsed.length > 7
    || parsed.some(path => typeof path !== "string" || !isAbsolute(path) || !path.trim() || /^(?:\\\\|\/\/)/.test(path))) {
    throw new Error("CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES must contain at most seven absolute paths");
  }
  const primary = getCodexHome();
  const seen = new Set([process.platform === "win32" ? primary.toLowerCase() : primary]);
  const additional: string[] = [];
  for (const configured of parsed as string[]) {
    const path = resolve(configured);
    const identity = process.platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(identity)) continue;
    if (!existsSync(path) || !lstatSync(path).isDirectory()) {
      throw new Error("Configured trusted Codex home is not a local directory");
    }
    seen.add(identity);
    additional.push(path);
  }
  return additional;
}

export function getCodexConfigPath(): string {
  return join(getCodexHome(), "config.toml");
}

export function getCodexModelsCachePath(): string {
  return join(getCodexHome(), "models_cache.json");
}

export function getCodexJournalPath(): string {
  return join(getConfigDir(), "codex", "integration-journal.json");
}

export function getCodexJournalRecoveryPath(): string {
  return join(getConfigDir(), "codex", "integration-journal.recovery.json");
}

export function routeUrl(config: AppConfig): string {
  return `http://${config.host}:${config.port}/v1`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function snapshotFile(path: string, options?: { followSymlink?: boolean }): FileSnapshot {
  if (options?.followSymlink) {
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink()) {
      const link = readlinkSync(path);
      const target = realpathSync(path);
      const targetStat = lstatSync(target);
      if (!targetStat.isFile()) throw new Error(`Codex config symlink target is not a regular file: ${path}`);
      return { path, exists: true, data: readFileSync(target), symlink: { link, target, mode: targetStat.mode & 0o777 } };
    }
  }
  return existsSync(path)
    ? { path, exists: true, data: readFileSync(path) }
    : { path, exists: false };
}

/** Write the snapshotted config target, never replace its symbolic link or follow a new target. */
export function writeFileSnapshot(snapshot: FileSnapshot, data: string | Uint8Array): void {
  const symlink = snapshot.symlink;
  if (!symlink) {
    atomicWriteFile(snapshot.path, data);
    return;
  }
  if (!lstatSync(snapshot.path).isSymbolicLink()
    || readlinkSync(snapshot.path) !== symlink.link
    || realpathSync(snapshot.path) !== symlink.target) {
    throw new Error(`Codex config symlink changed during the operation: ${snapshot.path}`);
  }
  atomicWriteFile(symlink.target, data, { mode: symlink.mode, protectDirectory: false });
}

export function restoreFileSnapshot(snapshot: FileSnapshot): void {
  if (snapshot.exists) {
    if (!snapshot.data) throw new Error(`File snapshot is missing data: ${snapshot.path}`);
    writeFileSnapshot(snapshot, snapshot.data);
  } else {
    rmSync(snapshot.path, { force: true });
  }
}

export function writeFilesWithCompensation(
  writes: Array<{ path: string; data: string | Uint8Array; followSymlink?: boolean }>,
  removals: string[] = [],
): void {
  const paths = [...new Set([...writes.map(write => write.path), ...removals])];
  const snapshots = new Map(paths.map(path => [path, snapshotFile(path, {
    followSymlink: writes.some(write => write.path === path && write.followSymlink === true),
  })]));
  try {
    for (const write of writes) writeFileSnapshot(snapshots.get(write.path)!, write.data);
    for (const removal of removals) rmSync(removal, { force: true });
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [...snapshots.values()].reverse()) {
      try {
        restoreFileSnapshot(snapshot);
      } catch (rollbackError) {
        rollbackFailures.push(`${snapshot.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(
      rollbackFailures.length > 0
        ? `${primary}; Codex integration rollback also failed: ${rollbackFailures.join("; ")}`
        : primary,
    );
  }
}

export function serializeJournal(journal: AnyCodexIntegrationJournal): string {
  return `${JSON.stringify(journal, null, 2)}\n`;
}

export function writeIntegrationState(
  journal: AnyCodexIntegrationJournal,
  configWrite?: { path: string; data: string },
  removals: string[] = [],
): void {
  const data = serializeJournal(journal);
  // The recovery copy records intent and the primary copy records commit. If the process stops
  // between those writes, the physical config unambiguously selects the completed state.
  writeFilesWithCompensation([
    { path: getCodexJournalRecoveryPath(), data },
    ...(configWrite ? [{ ...configWrite, followSymlink: true }] : []),
    { path: getCodexJournalPath(), data },
  ], removals);
}
