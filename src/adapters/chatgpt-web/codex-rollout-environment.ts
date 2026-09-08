import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expandUserPath } from "../../config";
import { findTopLevelAssignment } from "../../codex-integration-document";
import type { CodexTool } from "../../types";
import type {
  ChatGptRootThreadMetadata,
  ChatGptThreadSpawnLineage,
  ChatGptTurnEnvironment,
} from "./environment";

type RolloutIdentity = ChatGptRootThreadMetadata | ChatGptThreadSpawnLineage;

const CODEX_ID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CODEX_ID = new RegExp(`^${CODEX_ID_SOURCE}$`, "i");
const ROLLOUT_READ_CHUNK_BYTES = 64 * 1024;
const MAX_ROLLOUT_JSON_LINE_BYTES = 16 * 1024 * 1024;
const MAX_ROLLOUT_DIRECTORY_ENTRIES = 100_000;

type IndexedRollout =
  | { kind: "unavailable" }
  | { kind: "absent" }
  | { kind: "found"; path: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  if (process.platform !== "win32") return normalized;
  const comparable = normalized.startsWith("\\\\?\\UNC\\")
    ? `\\\\${normalized.slice(8)}`
    : normalized.startsWith("\\\\?\\")
      ? normalized.slice(4)
      : normalized;
  return comparable.toLowerCase();
}

function contains(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonicalRolloutName(name: string, threadId: string): boolean {
  const escapedThreadId = threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-${escapedThreadId}(?:_${CODEX_ID_SOURCE})?\\.jsonl$`,
    "i",
  ).test(name);
}

function configuredSqliteHome(codexHome: string, explicit?: string): string {
  if (explicit) return resolve(explicit);

  const configPath = join(codexHome, "config.toml");
  if (existsSync(configPath)) {
    const configured = findTopLevelAssignment(
      readFileSync(configPath, "utf8").split(/\r\n|\n|\r/),
      "sqlite_home",
    );
    if (configured.present) {
      const value = configured.value?.trim();
      if (!value) throw new Error("sqlite_home in Codex config must not be empty");
      return resolve(codexHome, expandUserPath(value));
    }
  }

  const environmentValue = process.env.CODEX_SQLITE_HOME?.trim();
  return resolve(environmentValue ? expandUserPath(environmentValue) : codexHome);
}

function indexedRollout(
  sqliteHome: string,
  identity: RolloutIdentity,
): IndexedRollout {
  const databasePath = join(sqliteHome, "state_5.sqlite");
  if (!existsSync(databasePath)) return { kind: "unavailable" };
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true, strict: true });
    const row = database.query(`
      SELECT t.rollout_path, t.agent_path, e.parent_thread_id, e.status
      FROM threads AS t
      LEFT JOIN thread_spawn_edges AS e ON e.child_thread_id = t.id
      WHERE t.id = ?
      LIMIT 1
    `).get(identity.threadId) as {
      rollout_path?: unknown;
      agent_path?: unknown;
      parent_thread_id?: unknown;
      status?: unknown;
    } | null;
    if (!row) return { kind: "absent" };
    const child = "parentThreadId" in identity;
    const matchesOwner = child
      ? row.agent_path === identity.agentName && row.parent_thread_id === identity.parentThreadId && row.status === "open"
      : row.parent_thread_id == null && (row.agent_path == null || row.agent_path === "/root");
    if (typeof row.rollout_path !== "string" || !matchesOwner) {
      throw new Error(`Codex state does not authenticate the requested ${child ? "subagent" : "root thread"} rollout`);
    }
    return { kind: "found", path: row.rollout_path };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Codex state does not authenticate the requested ")) {
      throw error;
    }
    // State storage is optional in Codex. A missing/older schema does not create authority; the
    // canonical rollout itself can still prove the exact thread, its lineage, and current turn.
    return { kind: "unavailable" };
  } finally {
    database?.close();
  }
}

function validateRolloutPath(codexHome: string, candidate: string, threadId: string): string {
  if (!isAbsolute(candidate)) throw new Error("Codex state returned a non-absolute rollout path");
  const sessionsRoot = realpathSync(join(codexHome, "sessions"));
  if (lstatSync(candidate).isSymbolicLink()) throw new Error("Codex rollout path is a symbolic link");
  const rolloutPath = realpathSync(candidate);
  if (!lstatSync(rolloutPath).isFile()) throw new Error("Codex rollout path is not a regular file");
  if (!contains(sessionsRoot, rolloutPath)) throw new Error("Codex rollout path escapes the sessions directory");
  if (!canonicalRolloutName(basename(rolloutPath), threadId)) {
    throw new Error("Codex rollout filename does not belong to the requested thread");
  }
  return rolloutPath;
}

function scanCanonicalRollouts(codexHome: string, threadId: string): string[] {
  const sessionsRoot = join(codexHome, "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const matches: string[] = [];
  let visited = 0;
  const visitLevel = (path: string, depth: number): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_ROLLOUT_DIRECTORY_ENTRIES) {
        throw new Error("Codex sessions directory is too large for an unindexed rollout lookup");
      }
      if (entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (depth < 3) {
        if (entry.isDirectory() && /^\d+$/.test(entry.name)) visitLevel(child, depth + 1);
        continue;
      }
      if (entry.isFile() && canonicalRolloutName(entry.name, threadId)) matches.push(child);
    }
  };
  visitLevel(sessionsRoot, 0);
  return matches;
}

function parseJsonLine(line: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(line.toString("utf8").replace(/^\uFEFF/, ""));
    const item = record(parsed);
    if (!item) throw new Error("not an object");
    return item;
  } catch (error) {
    throw new Error("Codex rollout contains an invalid complete JSONL record", { cause: error });
  }
}

function firstRolloutRecord(fd: number, size: number): Record<string, unknown> {
  let position = 0;
  let buffered = Buffer.alloc(0);
  while (position < size) {
    const length = Math.min(ROLLOUT_READ_CHUNK_BYTES, size - position);
    const chunk = Buffer.alloc(length);
    const count = readSync(fd, chunk, 0, length, position);
    if (count <= 0) break;
    position += count;
    buffered = Buffer.concat([buffered, chunk.subarray(0, count)]);
    const newline = buffered.indexOf(0x0a);
    if (newline >= 0) return parseJsonLine(buffered.subarray(0, newline));
    if (buffered.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
      throw new Error("Codex rollout session metadata exceeds the bounded JSONL record size");
    }
  }
  throw new Error("Codex rollout has no complete session metadata record");
}

function latestTurnContext(fd: number, size: number): Record<string, unknown> | undefined {
  let position = size;
  let carry = Buffer.alloc(0);
  let firstSegmentAtEof = true;
  const fileEndsWithNewline = (() => {
    if (size === 0) return false;
    const byte = Buffer.alloc(1);
    return readSync(fd, byte, 0, 1, size - 1) === 1 && byte[0] === 0x0a;
  })();

  while (position > 0) {
    const length = Math.min(ROLLOUT_READ_CHUNK_BYTES, position);
    position -= length;
    const chunk = Buffer.alloc(length);
    const count = readSync(fd, chunk, 0, length, position);
    if (count !== length) throw new Error("Codex rollout changed during authority lookup");
    const data = Buffer.concat([chunk, carry]);
    let lineEnd = data.length;
    for (let index = data.length - 1; index >= 0; index -= 1) {
      if (data[index] !== 0x0a) continue;
      const line = data.subarray(index + 1, lineEnd);
      const trailingPartial = firstSegmentAtEof && !fileEndsWithNewline;
      firstSegmentAtEof = false;
      lineEnd = index;
      if (trailingPartial || line.length === 0) continue;
      if (line.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
        throw new Error("Codex rollout JSONL record exceeds the bounded record size");
      }
      const item = parseJsonLine(line);
      if (item.type === "turn_context") return record(item.payload);
    }
    carry = Buffer.from(data.subarray(0, lineEnd));
    if (carry.length > MAX_ROLLOUT_JSON_LINE_BYTES) {
      throw new Error("Codex rollout JSONL record exceeds the bounded record size");
    }
  }
  if (carry.length === 0) return undefined;
  const item = parseJsonLine(carry);
  return item.type === "turn_context" ? record(item.payload) : undefined;
}

function validateSessionMeta(
  item: Record<string, unknown>,
  identity: RolloutIdentity,
): void {
  const payload = record(item.payload);
  if (!("parentThreadId" in identity)) {
    if (item.type !== "session_meta" || payload?.id !== identity.threadId
      || typeof payload.source !== "string" || payload.source === "subagent"
      || payload.parent_thread_id != null || payload.thread_source === "subagent"
      || (payload.agent_path != null && payload.agent_path !== "/root")) {
      throw new Error("Codex rollout session metadata does not authenticate the requested root thread");
    }
    return;
  }
  const lineage = identity;
  const source = record(payload?.source);
  const subagent = record(source?.subagent);
  const spawn = record(subagent?.thread_spawn);
  if (item.type !== "session_meta"
    || payload?.id !== lineage.threadId
    || payload.parent_thread_id !== lineage.parentThreadId
    || payload.agent_path !== lineage.agentName
    || payload.thread_source !== "subagent"
    || spawn?.parent_thread_id !== lineage.parentThreadId
    || spawn.agent_path !== lineage.agentName) {
    throw new Error("Codex rollout session metadata does not authenticate the requested subagent");
  }
}

function absolutePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error(`Codex rollout ${field} is invalid`);
  }
  const unique = new Map<string, string>();
  for (const path of value as string[]) {
    const normalized = resolve(path);
    if (!unique.has(pathIdentity(normalized))) unique.set(pathIdentity(normalized), normalized);
  }
  return [...unique.values()];
}

function validGlobScanMaxDepth(value: unknown): boolean {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0);
}

function validRestrictiveEntry(entryValue: unknown): { rootRead: boolean } | undefined {
  const entry = record(entryValue);
  const path = record(entry?.path);
  if (!entry || !path
    || (entry.access !== "read" && entry.access !== "deny")
    || (entry.missing_path_behavior !== undefined && entry.missing_path_behavior !== "skip")) return undefined;
  if (path.type === "special") {
    const special = record(path.value)?.kind;
    if (typeof special !== "string" || !special) return undefined;
    return {
      rootRead: special === "root"
        && entry.access === "read"
        && entry.missing_path_behavior === undefined,
    };
  }
  if (path.type === "path") {
    return typeof path.path === "string" && isAbsolute(path.path) ? { rootRead: false } : undefined;
  }
  if (path.type === "glob_pattern") {
    return typeof path.pattern === "string" && path.pattern.length > 0 ? { rootRead: false } : undefined;
  }
  return undefined;
}

function exactManagedReadOnlyProfile(
  value: Record<string, unknown>,
  expectedNetwork: "enabled" | "restricted",
): boolean {
  const fileSystem = record(value.file_system);
  const entries = fileSystem?.entries;
  if (fileSystem?.type !== "restricted"
    || !validGlobScanMaxDepth(fileSystem.glob_scan_max_depth)
    || !Array.isArray(entries)
    || value.network !== expectedNetwork) return false;
  let rootReads = 0;
  for (const entry of entries) {
    const restrictive = validRestrictiveEntry(entry);
    if (!restrictive) return false;
    if (restrictive.rootRead) rootReads += 1;
  }
  return rootReads === 1;
}

function networkAccess(value: Record<string, unknown>, field: string): boolean {
  if (value.network_access !== undefined && typeof value.network_access !== "boolean") {
    throw new Error(`Codex rollout ${field} network_access is invalid`);
  }
  return value.network_access === true;
}

function splitPolicyMatchesProfile(
  splitValue: unknown,
  profileFileSystem: Record<string, unknown>,
): boolean {
  if (splitValue === undefined || splitValue === null) return true;
  const split = record(splitValue);
  if (!split) return false;
  const profileType = profileFileSystem.type;
  if (profileType !== "restricted" && profileType !== "unrestricted") return false;
  if (split.kind !== profileType) return false;
  if (profileType === "unrestricted") {
    return split.entries === undefined && split.glob_scan_max_depth === undefined;
  }
  return isDeepStrictEqual(split.entries, profileFileSystem.entries)
    && split.glob_scan_max_depth === profileFileSystem.glob_scan_max_depth;
}

function exactManagedWorkspaceWriteProfile(
  profile: Record<string, unknown>,
  roots: string[],
  cwd: string,
  sandbox: Record<string, unknown>,
): { networkAccess: boolean; writableRoots: string[] } | undefined {
  const fileSystem = record(profile.file_system);
  if (fileSystem?.type !== "restricted"
    || !validGlobScanMaxDepth(fileSystem.glob_scan_max_depth)
    || !Array.isArray(fileSystem.entries)
    || (profile.network !== "restricted" && profile.network !== "enabled")) return undefined;

  const rawWritableRoots = sandbox.writable_roots ?? [];
  if (!Array.isArray(rawWritableRoots)
    || rawWritableRoots.some(path => typeof path !== "string" || !isAbsolute(path))
    || (sandbox.exclude_tmpdir_env_var !== undefined && typeof sandbox.exclude_tmpdir_env_var !== "boolean")
    || (sandbox.exclude_slash_tmp !== undefined && typeof sandbox.exclude_slash_tmp !== "boolean")) return undefined;
  const expectedWritableRoots = [cwd, ...rawWritableRoots.map(path => resolve(path as string))];
  const uniqueExpectedWritableRoots = [...new Map(expectedWritableRoots.map(path => (
    [pathIdentity(path), path] as const
  ))).values()];
  if (uniqueExpectedWritableRoots.length !== expectedWritableRoots.length
    || uniqueExpectedWritableRoots.some(path => !roots.some(root => contains(root, path)))) return undefined;

  let rootRead = 0;
  let projectRootsWrite = 0;
  const directWrites: string[] = [];
  const specialWrites = new Set<string>();
  for (const value of fileSystem.entries) {
    const entry = record(value);
    const path = record(entry?.path);
    if (!entry || !path
      || (entry.access !== "read" && entry.access !== "write" && entry.access !== "deny")
      || (entry.missing_path_behavior !== undefined && entry.missing_path_behavior !== "skip")) return undefined;

    if (path.type === "special") {
      const special = record(path.value)?.kind;
      if (special === "root" && entry.access === "read" && entry.missing_path_behavior === undefined) {
        rootRead += 1;
        continue;
      }
      if (entry.access !== "write") {
        if (typeof special !== "string" || !special) return undefined;
        continue;
      }
      if (special === "project_roots" && entry.access === "write" && entry.missing_path_behavior === undefined) {
        projectRootsWrite += 1;
        continue;
      }
      if ((special === "slash_tmp" || special === "tmpdir")
        && entry.access === "write"
        && entry.missing_path_behavior === undefined
        && !specialWrites.has(special)) {
        specialWrites.add(special);
        continue;
      }
      return undefined;
    }

    // Read/deny entries only narrow the profile. Codex legitimately adds external worktree gitdirs
    // and protected metadata paths here, so they do not affect the writable authority recovered
    // by this bridge. Every write entry, in contrast, must be one of the exact legacy roots below.
    if (entry.access !== "write") {
      if (path.type === "path") {
        if (typeof path.path !== "string" || !isAbsolute(path.path)) return undefined;
      } else if (path.type === "glob_pattern") {
        if (typeof path.pattern !== "string" || !path.pattern) return undefined;
      } else {
        return undefined;
      }
      continue;
    }
    if (path.type !== "path"
      || typeof path.path !== "string"
      || !isAbsolute(path.path)
      || entry.missing_path_behavior !== undefined) return undefined;
    directWrites.push(resolve(path.path));
  }

  if (rootRead !== 1 || projectRootsWrite > 1) return undefined;
  const uniqueDirectWrites = [...new Map(directWrites.map(path => (
    [pathIdentity(path), path] as const
  ))).values()];
  if (uniqueDirectWrites.length !== directWrites.length) return undefined;
  const expectedIdentities = new Set(uniqueExpectedWritableRoots.map(pathIdentity));
  if (uniqueDirectWrites.some(path => !expectedIdentities.has(pathIdentity(path)))) return undefined;
  if (projectRootsWrite === 0 && uniqueDirectWrites.length !== uniqueExpectedWritableRoots.length) return undefined;
  if (projectRootsWrite === 1) {
    const rootIdentities = new Set(roots.map(pathIdentity));
    if (rootIdentities.size !== expectedIdentities.size
      || [...rootIdentities].some(path => !expectedIdentities.has(path))) return undefined;
  }

  const expectsSlashTmp = sandbox.exclude_slash_tmp !== true;
  const expectsTmpdir = sandbox.exclude_tmpdir_env_var !== true;
  if (specialWrites.has("slash_tmp") !== expectsSlashTmp
    || specialWrites.has("tmpdir") !== expectsTmpdir) return undefined;

  return {
    networkAccess: profile.network === "enabled",
    writableRoots: uniqueExpectedWritableRoots,
  };
}

function environmentFromTurnContext(
  payload: Record<string, unknown>,
  expectedTurnId: string,
  tools: readonly CodexTool[] | undefined,
): ChatGptTurnEnvironment {
  if (payload.turn_id !== expectedTurnId) {
    throw new Error("Latest Codex rollout turn context does not belong to the requested turn");
  }
  if (typeof payload.cwd !== "string" || !isAbsolute(payload.cwd)) {
    throw new Error("Codex rollout cwd is invalid");
  }
  const cwd = resolve(payload.cwd);
  const declaredRoots = payload.workspace_roots === undefined
    ? []
    : absolutePaths(payload.workspace_roots, "workspace_roots");
  const roots = declaredRoots.length > 0 ? declaredRoots : [cwd];
  if (!roots.some(root => contains(root, cwd))) {
    throw new Error("Codex rollout cwd is outside its workspace roots");
  }

  const permissionProfile = record(payload.permission_profile);
  const sandbox = record(payload.sandbox_policy);
  if (!permissionProfile || !sandbox) {
    throw new Error("Codex rollout is missing its authoritative permission profile");
  }
  if (permissionProfile.type === "disabled" && sandbox.type === "danger-full-access") {
    const split = payload.file_system_sandbox_policy;
    if (split !== undefined && split !== null) {
      const unrestricted = record(split);
      if (unrestricted?.kind !== "unrestricted"
        || unrestricted.entries !== undefined
        || unrestricted.glob_scan_max_depth !== undefined) {
        throw new Error("Codex rollout split filesystem policy conflicts with full access");
      }
    }
    return {
      cwd,
      roots,
      writableRoots: roots,
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [...(tools ?? [])],
    };
  }
  if (permissionProfile.type === "managed" && sandbox.type === "read-only") {
    const enabled = networkAccess(sandbox, "read-only");
    const expectedNetwork = enabled ? "enabled" : "restricted";
    const fileSystem = record(permissionProfile.file_system);
    if (!fileSystem
      || !exactManagedReadOnlyProfile(permissionProfile, expectedNetwork)
      || !splitPolicyMatchesProfile(payload.file_system_sandbox_policy, fileSystem)) {
      throw new Error("Codex rollout read-only permission profile is inconsistent");
    }
    return {
      cwd,
      roots,
      writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: enabled },
      tools: [...(tools ?? [])],
    };
  }
  if (permissionProfile.type === "managed" && sandbox.type === "workspace-write") {
    const fileSystem = record(permissionProfile.file_system);
    const workspace = exactManagedWorkspaceWriteProfile(permissionProfile, roots, cwd, sandbox);
    if (!fileSystem
      || !workspace
      || networkAccess(sandbox, "workspace-write") !== workspace.networkAccess
      || !splitPolicyMatchesProfile(payload.file_system_sandbox_policy, fileSystem)) {
      throw new Error("Codex rollout workspace-write permission profile is inconsistent");
    }
    return {
      cwd,
      roots,
      writableRoots: workspace.writableRoots,
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: workspace.writableRoots,
        networkAccess: workspace.networkAccess,
      },
      tools: [...(tools ?? [])],
    };
  }
  throw new Error("Codex rollout permission profile cannot be represented safely by the Web bridge");
}

function validateMetadataConsistency(
  lineage: RolloutIdentity,
  environment: ChatGptTurnEnvironment,
): void {
  // Request sandbox/workspace fields are diagnostic only. They narrow a rollout-derived authority
  // here and never create or expand it.
  const owner = "parentThreadId" in lineage ? "subagent" : "thread";
  if (lineage.sandboxType === "platform"
    ? environment.sandboxPolicy.type === "dangerFullAccess"
    : environment.sandboxPolicy.type !== lineage.sandboxType) {
    throw new Error(`ChatGPT Web ${owner} sandbox metadata conflicts with its Codex rollout`);
  }
  if (lineage.workspaceRoots.length > 0
    && !lineage.workspaceRoots.some(root => contains(root, environment.cwd))) {
    throw new Error(`ChatGPT Web ${owner} workspace metadata does not contain its Codex rollout cwd`);
  }
  if (lineage.workspaceRoots.some(root => !environment.roots.some(rolloutRoot => (
    contains(rolloutRoot, root) || contains(root, rolloutRoot)
  )))) {
    throw new Error(`ChatGPT Web ${owner} workspace metadata conflicts with its Codex rollout roots`);
  }
}

export function resolveCurrentCodexRolloutEnvironment(options: {
  codexHome: string;
  sqliteHome?: string;
  lineage: RolloutIdentity;
  turnId: string;
  compactionSourceTurnId?: string;
  tools?: readonly CodexTool[];
}): ChatGptTurnEnvironment | undefined {
  const { codexHome, lineage, turnId, tools, compactionSourceTurnId } = options;
  const nativeThreadId = CODEX_ID.test(lineage.threadId);
  const nativeTurnId = CODEX_ID.test(turnId);
  if (!nativeThreadId && !nativeTurnId) return undefined;
  if (!nativeThreadId || !nativeTurnId || (compactionSourceTurnId !== undefined && !CODEX_ID.test(compactionSourceTurnId))
    || ("parentThreadId" in lineage && !CODEX_ID.test(lineage.parentThreadId))) {
    throw new Error("Codex thread metadata contains an invalid native identifier");
  }

  const indexed = indexedRollout(configuredSqliteHome(codexHome, options.sqliteHome), lineage);
  const candidates = indexed.kind === "found"
    ? [indexed.path]
    : scanCanonicalRollouts(codexHome, lineage.threadId);
  if (candidates.length === 0) {
    if (!("parentThreadId" in lineage)) return undefined;
    throw new Error("Codex has no canonical rollout for the requested subagent thread");
  }

  const matching: ChatGptTurnEnvironment[] = [];
  for (const candidate of candidates) {
    const rolloutPath = validateRolloutPath(codexHome, candidate, lineage.threadId);
    const fd = openSync(rolloutPath, "r");
    try {
      const size = fstatSync(fd).size;
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Codex rollout is empty");
      validateSessionMeta(firstRolloutRecord(fd, size), lineage);
      const latest = latestTurnContext(fd, size);
      if (!latest) throw new Error("Codex rollout has no complete turn context");
      if (latest.turn_id !== turnId && (compactionSourceTurnId === undefined || latest.turn_id !== compactionSourceTurnId)) {
        if (indexed.kind === "found") {
          throw new Error("Latest Codex rollout turn context does not belong to the requested turn");
        }
        continue;
      }
      const environment = environmentFromTurnContext(latest, latest.turn_id as string, tools);
      validateMetadataConsistency(lineage, environment);
      matching.push(environment);
    } finally {
      closeSync(fd);
    }
  }
  if (matching.length === 0) {
    throw new Error("Codex has no canonical rollout for the requested current turn");
  }
  if (matching.length > 1) {
    throw new Error("Codex has multiple canonical rollouts for the requested current turn");
  }
  return matching[0]!;
}
