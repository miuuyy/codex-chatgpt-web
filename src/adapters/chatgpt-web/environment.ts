import { isAbsolute, relative, resolve } from "node:path";
import type { CodexContentPart, CodexParsedRequest, CodexTool } from "../../types";

export type ChatGptSandboxPolicy =
  | { type: "dangerFullAccess" }
  | { type: "readOnly"; networkAccess: boolean }
  | { type: "workspaceWrite"; writableRoots: string[]; networkAccess: boolean };

export interface ChatGptTurnEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: ChatGptSandboxPolicy;
  tools: CodexTool[];
  /** Native Codex model enforced for read-only worker processes launched by an Ultra coordinator. */
  ultraWorkerModel?: string;
}

export interface ChatGptTurnIdentity {
  threadId?: string;
  turnId?: string;
  promptCacheKey?: string;
}

export class MissingTrustedCodexEnvironmentError extends Error {
  constructor(field: string) {
    super(`ChatGPT web turn is missing ${field} in trusted Codex environment context`);
    this.name = "MissingTrustedCodexEnvironmentError";
  }
}

function contentText(content: string | CodexContentPart[]): string {
  if (typeof content === "string") return content;
  return content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function clientTurnMetadata(parsed: CodexParsedRequest): Record<string, unknown> | undefined {
  const body = record(parsed._rawBody);
  const metadata = record(body?.client_metadata);
  const raw = metadata?.["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try { return record(JSON.parse(raw)); }
    catch { return undefined; }
  }
  return record(raw);
}

function itemTurnId(value: unknown): string | undefined {
  const turnId = record(record(value)?.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof turnId === "string" ? turnId : undefined;
}

function environmentBeforeUser(input: unknown[], userIndex: number, expectedTurnId?: string): string | undefined {
  if (userIndex <= 0) return undefined;
  const user = record(input[userIndex]);
  const candidate = record(input[userIndex - 1]);
  if (user?.type !== "message" || user.role !== "user") return undefined;
  if (candidate?.type !== "message" || candidate.role !== "user") return undefined;

  const userTurnId = itemTurnId(user);
  const candidateTurnId = itemTurnId(candidate);
  if (!userTurnId || candidateTurnId !== userTurnId) return undefined;
  if (expectedTurnId && userTurnId !== expectedTurnId) return undefined;

  const content = Array.isArray(candidate.content) ? candidate.content : [];
  for (const part of content) {
    const text = record(part)?.text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (/^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed)) return trimmed;
  }
  return undefined;
}

function sandboxTypeFromEnvironment(text: string): ChatGptSandboxPolicy["type"] | undefined {
  const restrictedFileSystem = managedRestrictedFileSystem(text);
  const restrictedHasWrite = restrictedFileSystem !== undefined
    && /<entry\s+[^>]*access=["']write["'][^>]*>/i.test(restrictedFileSystem);
  const unrestricted = /<permission_profile\s+type=["']disabled["'][^>]*>[\s\S]*?<file_system\s+type=["']unrestricted["'][^>]*\/?\s*>/i.test(text)
    || /<sandbox_mode>danger-full-access<\/sandbox_mode>/i.test(text);
  const workspaceWrite = /<sandbox_mode>workspace-write<\/sandbox_mode>/i.test(text)
    || /<file_system\s+type=["']workspace-write["'][^>]*\/?\s*>/i.test(text)
    || restrictedHasWrite;
  const readOnly = /<sandbox_mode>read-only<\/sandbox_mode>/i.test(text)
    || /<file_system\s+type=["']read-only["'][^>]*\/?\s*>/i.test(text)
    || (restrictedFileSystem !== undefined && !restrictedHasWrite);
  if (Number(unrestricted) + Number(workspaceWrite) + Number(readOnly) !== 1) return undefined;
  return unrestricted ? "dangerFullAccess" : workspaceWrite ? "workspaceWrite" : "readOnly";
}

function managedRestrictedFileSystem(text: string): string | undefined {
  const profiles = [...text.matchAll(
    /<permission_profile\s+type=["']managed["'][^>]*>([\s\S]*?)<\/permission_profile>/gi,
  )];
  const fileSystems = profiles.flatMap(profile => [...profile[1]!.matchAll(
    /<file_system\s+type=["']restricted["'][^>]*>([\s\S]*?)<\/file_system>/gi,
  )].map(match => match[1] ?? ""));
  return fileSystems.length === 1 ? fileSystems[0] : undefined;
}

function restrictedWritableRoots(text: string, roots: string[]): string[] | undefined {
  const fileSystem = managedRestrictedFileSystem(text);
  if (fileSystem === undefined) return undefined;

  const writableEntries = [...fileSystem.matchAll(
    /<entry\s+[^>]*access=["']write["'][^>]*>([\s\S]*?)<\/entry>/gi,
  )].map(match => match[1] ?? "");
  const writesRoot = writableEntries.some(entry => /<special>\s*:root\s*<\/special>/i.test(entry));
  const paths = writableEntries
    .flatMap(entry => [...entry.matchAll(/<path>([^<]+)<\/path>/gi)].map(match => decodeXmlText(match[1]!.trim())))
    .filter(isAbsolute)
    .map(path => resolve(path));
  const writableRoots = writesRoot ? [...roots] : [];
  for (const path of paths) {
    for (const root of roots) {
      if (matchesPath(path, root)) writableRoots.push(root);
      else if (matchesPath(root, path)) writableRoots.push(path);
    }
  }
  return [...new Set(writableRoots)];
}

function sandboxTypeFromMetadata(value: unknown): ChatGptSandboxPolicy["type"] | undefined {
  const candidate = typeof value === "string" ? value : record(value)?.type;
  if (typeof candidate !== "string") return undefined;
  const normalized = candidate.trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replaceAll("_", "-");
  switch (normalized) {
    case "none":
    case "unrestricted":
    case "danger-full-access":
      return "dangerFullAccess";
    case "workspace-write":
      return "workspaceWrite";
    case "read-only":
      return "readOnly";
    default:
      return undefined;
  }
}

function workspaceMetadataEnvironmentBeforeUser(
  input: unknown[],
  userIndex: number,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (userIndex <= 0 || !metadata) return undefined;
  const workspaces = record(metadata.workspaces);
  const metadataSandbox = sandboxTypeFromMetadata(metadata.sandbox);
  if (!workspaces || !metadataSandbox) return undefined;
  const metadataRoots = Object.keys(workspaces);
  if (metadataRoots.length === 0 || metadataRoots.some(path => !isAbsolute(path))) return undefined;
  const normalizedMetadataRoots = [...new Set(metadataRoots.map(path => resolve(path)))];

  const user = record(input[userIndex]);
  const candidate = record(input[userIndex - 1]);
  if (user?.type !== "message" || user.role !== "user" || typeof user.id !== "string") return undefined;
  if (candidate?.type !== "message" || candidate.role !== "user" || typeof candidate.id !== "string") return undefined;

  const content = Array.isArray(candidate.content) ? candidate.content : [];
  for (const part of content) {
    const text = record(part)?.text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!/^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed)) continue;

    const cwdMatches = [...trimmed.matchAll(/<cwd>([^<]+)<\/cwd>/g)].map(match => decodeXmlText(match[1]!.trim()));
    if (cwdMatches.length !== 1 || !isAbsolute(cwdMatches[0]!)) continue;
    const rootMatches = [...trimmed.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/g)]
      .flatMap(section => [...section[0].matchAll(/<root>([^<]+)<\/root>/g)].map(match => decodeXmlText(match[1]!.trim())));
    const declaredRoots = [...new Set((rootMatches.length > 0 ? rootMatches : cwdMatches).map(path => resolve(path)))];
    if (declaredRoots.some(path => !normalizedMetadataRoots.includes(path))) continue;
    if (!normalizedMetadataRoots.some(root => matchesPath(root, resolve(cwdMatches[0]!)))) continue;
    if (sandboxTypeFromEnvironment(trimmed) !== metadataSandbox) continue;
    return trimmed;
  }
  return undefined;
}

function hasAssistantOutputBetween(input: unknown[], startIndex: number, endIndex: number): boolean {
  for (let index = startIndex; index < endIndex; index += 1) {
    const item = record(input[index]);
    if (!item) continue;
    if (item.type === "message" && item.role === "assistant") return true;
    if (item.type === "function_call" || item.type === "reasoning") return true;
  }
  return false;
}

function rawEnvironmentText(parsed: CodexParsedRequest): string | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  let activeUserIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (record(input[index])?.role === "user") {
      activeUserIndex = index;
      break;
    }
  }
  const turnId = clientTurnMetadata(parsed)?.turn_id;
  const currentByTurn = environmentBeforeUser(
    input,
    activeUserIndex,
    typeof turnId === "string" ? turnId : undefined,
  );
  if (currentByTurn) return currentByTurn;

  const current = workspaceMetadataEnvironmentBeforeUser(input, activeUserIndex, clientTurnMetadata(parsed));
  if (current) return current;

  const replayPrefixLen = Math.min(parsed._replayPrefixLen ?? 0, input.length);
  for (let index = replayPrefixLen - 1; index > 0; index -= 1) {
    const replayed = environmentBeforeUser(input, index);
    if (replayed) return replayed;
  }

  // Codex can resume a local task by explicitly replaying its native transcript instead of
  // sending previous_response_id. In that shape, accept a historical environment/user pair only
  // when both items carry the same native turn_id and completed assistant output separates that
  // historical turn from the active user. A user-authored <environment_context> inside one chat
  // message cannot satisfy this provenance structure.
  const currentTurnId = typeof turnId === "string" ? turnId : undefined;
  for (let index = activeUserIndex - 1; index > 0; index -= 1) {
    const historicalTurnId = itemTurnId(input[index]);
    if (!historicalTurnId || historicalTurnId === currentTurnId) continue;
    const historical = environmentBeforeUser(input, index);
    if (!historical) continue;
    if (hasAssistantOutputBetween(input, index + 1, activeUserIndex)) return historical;
  }
  return undefined;
}

function trustedEnvironmentText(parsed: CodexParsedRequest): string {
  const raw = rawEnvironmentText(parsed);
  if (raw) return raw;
  const system = parsed.context.systemPrompt ?? [];
  const developer = parsed.context.messages
    .filter(message => message.role === "developer")
    .map(message => contentText(message.content));
  return [...system, ...developer].join("\n");
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function uniqueAbsolutePaths(values: string[], field: string): string[] {
  const decoded = values.map(value => decodeXmlText(value.trim()));
  if (decoded.length === 0) throw new MissingTrustedCodexEnvironmentError(field);
  if (decoded.some(path => !isAbsolute(path))) throw new Error(`ChatGPT web ${field} must contain absolute paths`);
  return [...new Set(decoded.map(path => resolve(path)))];
}

function matchesPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function extractChatGptTurnEnvironment(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
  const text = trustedEnvironmentText(parsed);
  const cwdMatches = [...text.matchAll(/<cwd>([^<]+)<\/cwd>/g)].map(match => match[1] ?? "");
  const cwdCandidates = uniqueAbsolutePaths(cwdMatches, "cwd");
  if (cwdCandidates.length !== 1) throw new Error("ChatGPT web turn has conflicting trusted Codex cwd values");
  const cwd = cwdCandidates[0]!;

  const rootMatches = [...text.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/g)]
    .flatMap(section => [...section[0].matchAll(/<root>([^<]+)<\/root>/g)].map(match => match[1] ?? ""));
  const roots = rootMatches.length > 0 ? uniqueAbsolutePaths(rootMatches, "workspace_roots") : [cwd];
  if (!roots.some(root => matchesPath(root, cwd))) {
    throw new Error("ChatGPT web cwd is outside the trusted Codex workspace roots");
  }

  const sandboxType = sandboxTypeFromEnvironment(text);
  const networkAccess = /<network_access>enabled<\/network_access>/i.test(text)
    || /network access is enabled/i.test(text);

  if (!sandboxType) {
    throw new Error("ChatGPT web turn requires one explicit trusted Codex sandbox mode");
  }
  if (sandboxType === "dangerFullAccess") {
    return { cwd, roots, writableRoots: roots, sandboxPolicy: { type: "dangerFullAccess" }, tools: parsed.context.tools ?? [] };
  }
  if (sandboxType === "workspaceWrite") {
    const writableRoots = restrictedWritableRoots(text, roots) ?? roots;
    return {
      cwd,
      roots,
      writableRoots,
      sandboxPolicy: { type: "workspaceWrite", writableRoots, networkAccess },
      tools: parsed.context.tools ?? [],
    };
  }
  return { cwd, roots, writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess }, tools: parsed.context.tools ?? [] };
}

export function extractChatGptTurnIdentity(parsed: CodexParsedRequest): ChatGptTurnIdentity {
  const body = record(parsed._rawBody);
  const metadata = clientTurnMetadata(parsed);
  return {
    ...(typeof metadata?.thread_id === "string" ? { threadId: metadata.thread_id } : {}),
    ...(typeof metadata?.turn_id === "string" ? { turnId: metadata.turn_id } : {}),
    ...(typeof body?.prompt_cache_key === "string" ? { promptCacheKey: body.prompt_cache_key } : {}),
  };
}
