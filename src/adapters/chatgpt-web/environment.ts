import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isReadableCompactionSummaryText, OPAQUE_COMPACTION_NOTE } from "../../responses/compaction";
import { isNativeAgentsMdContext, readNativeThreadDelegation } from "../../responses/native-context";
import type { CodexContentPart, CodexParsedRequest, CodexTool } from "../../types";
import { isAcceptedCompactionContinuation, recoverCompactionInstruction } from "./compaction-continuation";

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
}

export interface ChatGptTurnIdentity {
  threadId?: string;
  turnId?: string;
  parentThreadId?: string;
  agentName?: string;
  subagentKind?: string;
  promptCacheKey?: string;
}

export interface ChatGptThreadSpawnLineage {
  threadId: string;
  parentThreadId: string;
  agentName: string;
  sandboxType: ChatGptSandboxPolicy["type"];
  workspaceRoots: string[];
}

export interface ChatGptRootThreadMetadata {
  threadId: string;
  sandboxType: ChatGptSandboxPolicy["type"] | "platform";
  workspaceRoots: string[];
}

export interface ChatGptTurnUserRevision {
  content: unknown;
  turnId?: string;
  itemId?: string;
}

export const CHATGPT_TURN_REVISION_CONFLICT_MESSAGE =
  "ChatGPT web current user message conflicts with native Codex turn_id metadata";

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

function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function clientTurnMetadataFromBody(value: unknown): Record<string, unknown> | undefined {
  const body = record(value);
  const metadata = record(body?.client_metadata);
  const raw = metadata?.["x-codex-turn-metadata"];
  if (typeof raw === "string") {
    try { return record(JSON.parse(raw)); }
    catch { return undefined; }
  }
  return record(raw);
}

function clientTurnMetadata(parsed: CodexParsedRequest): Record<string, unknown> | undefined {
  return clientTurnMetadataFromBody(parsed._rawBody);
}

/** Codex supplies this lifecycle marker on its ephemeral composer-prediction turn. */
export function isCodexComposerPrediction(value: unknown): boolean {
  const metadata = clientTurnMetadataFromBody(value);
  return metadata?.request_kind === "turn" && metadata.turn_trigger === "composer_predictions";
}

function itemTurnId(value: unknown): string | undefined {
  const turnId = record(record(value)?.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof turnId === "string" ? turnId : undefined;
}

function rawMessageText(value: Record<string, unknown>): string {
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content
    .map(part => record(part)?.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

/** Native context is a user fragment, never an XML mention in an answer, tool result or request. */
function hasEnvironmentContextFragment(item: Record<string, unknown> | undefined): item is Record<string, unknown> {
  if (item?.type !== "message" || item.role !== "user") return false;
  const kinds = record(item.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  // Keep explicitly typed native fragments fail-closed even when their XML is malformed.
  if (Array.isArray(kinds) && kinds.includes("environments.environment_context")) return true;
  const texts = typeof item.content === "string" ? [item.content]
    : Array.isArray(item.content) ? item.content.map(part => record(part)?.text) : [];
  // Older wire messages have no content kind. A fragment starting an environment tag is
  // still an attempted update when truncated; prose mentions and fenced examples are not.
  return texts.some(text => typeof text === "string"
    && /^<\/?environment_context\b/i.test(text.trimStart()));
}

/** True when the raw Responses input attempted to carry an environment envelope, valid or not. */
export function hasRawChatGptEnvironmentContext(parsed: CodexParsedRequest): boolean {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.some(value => hasEnvironmentContextFragment(record(value)));
}

/** Historical XML is not a current environment update, including in old untagged rollouts. */
export function hasCurrentChatGptEnvironmentContext(parsed: CodexParsedRequest): boolean {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!turnId) return hasRawChatGptEnvironmentContext(parsed);
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  let laterAssistantOutput = false;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (!item) continue;
    if ((item.type === "message" && item.role === "assistant")
      || item.type === "function_call" || item.type === "reasoning" || item.type === "compaction") {
      laterAssistantOutput = true;
    }
    if (!hasEnvironmentContextFragment(item)) continue;
    const owner = itemTurnId(item);
    if (owner === turnId || (owner === undefined && !laterAssistantOutput)) return true;
  }
  return false;
}

export interface ChatGptUnattributedEnvironmentMessage {
  id: string;
  content: unknown;
}

/** These are claims to locate in native history, never a source of filesystem authority. */
export function unattributedChatGptEnvironmentMessages(
  parsed: CodexParsedRequest,
): ChatGptUnattributedEnvironmentMessage[] | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const currentTurnId = extractChatGptTurnIdentity(parsed).turnId;
  const messages: ChatGptUnattributedEnvironmentMessage[] = [];
  for (const value of input) {
    const item = record(value);
    if (!hasEnvironmentContextFragment(item)) continue;
    // Explicit current provenance must keep the normal current-update rejection. A native item
    // without provenance is historical only if the canonical rollout proves that exact message.
    const owner = itemTurnId(item);
    if (owner !== undefined && owner !== currentTurnId) continue;
    if (owner !== undefined || item.role !== "user"
      || typeof item.id !== "string" || !item.id) return undefined;
    messages.push({ id: item.id, content: item.content });
  }
  return messages.length > 0 ? messages : undefined;
}

function contextualUserMessage(value: Record<string, unknown>): boolean {
  const text = rawMessageText(value).trim();
  return hasEnvironmentContextFragment(value)
    || isNativeAgentsMdContext(value)
    || isNativeOpenPageContext(value)
    || /^<subagent_notification>[\s\S]*<\/subagent_notification>$/.test(text)
    || isReadableCompactionSummaryText(text)
    || text === OPAQUE_COMPACTION_NOTE;
}

/** Page context is not an instruction; literal wrappers in ordinary user text still are. */
function isNativeOpenPageContext(item: Record<string, unknown> | undefined): boolean {
  if (item?.type !== "message" || item.role !== "user"
    || typeof item.id !== "string" || !item.id || !itemTurnId(item)?.trim()) return false;
  const kinds = record(item.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  return Array.isArray(kinds) && kinds.length === 1 && kinds[0] === "additional_content.codex_apps_open_page";
}

function compactionSummaryMessage(value: Record<string, unknown>): boolean {
  if (value.type !== "message" || value.role !== "user") return false;
  const text = rawMessageText(value).trim();
  return isReadableCompactionSummaryText(text) || text === OPAQUE_COMPACTION_NOTE;
}

/** The desktop injects cross-task messages as synthetic tool outputs without a call_id. */
function isDelegatedInstruction(item: Record<string, unknown> | undefined): boolean {
  return item !== undefined && readNativeThreadDelegation(item) !== undefined;
}

/** V2 agent_message instructions must still come from this child's direct parent. */
function isNativeInstruction(
  item: Record<string, unknown> | undefined,
  metadata?: Record<string, unknown>,
): item is Record<string, unknown> {
  if (item?.type === "message" && item.role === "user") return !contextualUserMessage(item);
  if (isDelegatedInstruction(item)) return true;
  if (item?.type !== "agent_message" || typeof item.id !== "string" || !item.id
    || metadata?.subagent_kind !== "thread_spawn"
    || (metadata.request_kind !== "turn" && metadata.request_kind !== "compaction")
    || typeof metadata.thread_id !== "string" || !metadata.thread_id
    || typeof metadata.parent_thread_id !== "string" || !metadata.parent_thread_id
    || metadata.thread_id === metadata.parent_thread_id) return false;
  const agentName = metadata.agent_name;
  return typeof agentName === "string" && /^\/root\/(?:[^/]+\/)*[^/]+$/.test(agentName)
    && item.recipient === agentName
    && item.author === agentName.slice(0, agentName.lastIndexOf("/"));
}

function isTurnAbortedNotice(value: Record<string, unknown>): boolean {
  return /^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(rawMessageText(value).trim());
}

/** Native turn ids that Codex has authoritatively marked as interrupted in this thread. */
export function priorChatGptAbortedTurnIds(parsed: CodexParsedRequest): string[] {
  const currentTurnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!currentTurnId) return [];
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  return [...new Set(input.flatMap(value => {
    const item = record(value);
    const abortedTurnId = item ? itemTurnId(item) : undefined;
    return item?.type === "message"
      && item.role === "user"
      && isTurnAbortedNotice(item)
      && abortedTurnId !== undefined
      && abortedTurnId !== currentTurnId
      ? [abortedTurnId]
      : [];
  }))];
}

/**
 * Return the latest instruction owned by the current native Codex turn.
 *
 * Provider rounds replay the same instruction and steering appends a newer one. Remote
 * compaction uses this revision to identify and stop the superseded browser response; once Codex
 * installs the replacement history, the immediate continuation starts a fresh browser response
 * under the same logical task revision.
 */
export function extractChatGptTurnUserRevision(parsed: CodexParsedRequest): unknown {
  const identity = extractChatGptTurnIdentity(parsed);
  const turnId = identity.turnId;
  if (!turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const revision = latestChatGptTurnUserRevision(parsed, turnId);
  if (!revision) throw new Error("ChatGPT web requires a current-turn user message for browser-session replay");
  // A pre-turn compact may summarize an earlier user message before native Codex continues
  // under its new turn id without adding a new human message. Accept only our exact completed
  // checkpoint; an arbitrary older prompt is still not a new instruction or a valid handoff.
  if (revision.turnId !== undefined && revision.turnId !== turnId
    && (priorChatGptAbortedTurnIds(parsed).includes(revision.turnId)
      || !isAcceptedCompactionContinuation(parsed, identity, revision))) {
    throw new Error(CHATGPT_TURN_REVISION_CONFLICT_MESSAGE);
  }
  return revision.content;
}

function latestChatGptTurnUserRevision(parsed: CodexParsedRequest, expectedTurnId?: string, recoverCheckpoint = true): ChatGptTurnUserRevision | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  const recovered = recoverCheckpoint ? recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed)) : undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const revision = userRevision(input[index], expectedTurnId, metadata);
    if (revision) {
      // Native compaction retains older human messages but drops goals and delegations. Recover the
      // actual task only for an exact producer-authenticated retained representation before
      // our checkpoint. New steering and rewritten history keep their normal validation.
      return recovered?.sourceWasSyntheticInstruction && index < recovered.summaryIndex
        && isAcceptedCompactionContinuation(parsed, extractChatGptTurnIdentity(parsed), revision)
        ? recovered.source : revision;
    }
  }
  return recovered?.source;
}

function userRevision(value: unknown, expectedTurnId?: string, metadata?: Record<string, unknown>): ChatGptTurnUserRevision | undefined {
  const item = record(value);
  if (!isNativeInstruction(item, metadata)) return undefined;
  const messageTurnId = itemTurnId(item);
  // An abort notice is contextual only when native metadata identifies its earlier turn.
  if (item.type === "message" && isTurnAbortedNotice(item) && expectedTurnId !== undefined
    && messageTurnId !== undefined && messageTurnId !== expectedTurnId) return undefined;
  const itemId = typeof item.id === "string" && item.id.length > 0 ? item.id : undefined;
  if (messageTurnId === undefined && itemId === undefined) return undefined;
  return { content: item.type === "function_call_output" ? item.output : item.content,
    ...(messageTurnId ? { turnId: messageTurnId } : {}),
    ...(itemId ? { itemId } : {}) };
}

/** Canonical instruction order distinguishes new steering from a delayed older request. */
export function chatGptTurnUserRevisionHistory(parsed: CodexParsedRequest): ChatGptTurnUserRevision[] {
  const body = record(parsed._rawBody);
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const metadata = clientTurnMetadata(parsed);
  const recovered = recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed));
  const input = Array.isArray(body?.input) ? body.input : [];
  const prefix = recovered?.sourceWasSyntheticInstruction ? input.slice(0, recovered.summaryIndex) : [];
  const retained = prefix.map(value => userRevision(value, turnId, metadata)).filter(value => value !== undefined).at(-1);
  const recoverSyntheticInstruction = recovered?.sourceWasSyntheticInstruction && (!retained
    || isAcceptedCompactionContinuation(parsed, extractChatGptTurnIdentity(parsed), retained));
  const revisions = input.slice(recoverSyntheticInstruction ? recovered!.summaryIndex + 1 : 0).flatMap(value => {
    const revision = userRevision(value, turnId, metadata);
    return revision ? [revision] : [];
  });
  if (recoverSyntheticInstruction) return [recovered!.source, ...revisions];
  return revisions.length > 0 ? revisions : recovered ? [recovered.source] : [];
}

/** A remote compaction may summarize an instruction from an earlier turn. */
export function extractChatGptCompactionSourceRevision(
  parsed: CodexParsedRequest,
  options: { recoverCheckpoint?: boolean } = {},
): ChatGptTurnUserRevision {
  const revision = findChatGptCompactionSourceRevision(parsed, options);
  if (!revision) throw new Error("ChatGPT web compaction requires a source user message");
  return revision;
}

/** A retained representation can have context but no instruction; it adds no source alias. */
export function findChatGptCompactionSourceRevision(
  parsed: CodexParsedRequest,
  options: { recoverCheckpoint?: boolean } = {},
): ChatGptTurnUserRevision | undefined {
  if (!parsed._compactionRequest) throw new Error("ChatGPT web compaction source requires a compaction request");
  return latestChatGptTurnUserRevision(parsed, extractChatGptTurnIdentity(parsed).turnId, options.recoverCheckpoint !== false);
}

/** A completed checkpoint identifies the current turn's rebuilt environment preamble. */
export function isChatGptCompactionContinuation(parsed: CodexParsedRequest): boolean {
  const identity = extractChatGptTurnIdentity(parsed);
  const revision = latestChatGptTurnUserRevision(parsed, identity.turnId);
  return revision?.turnId !== undefined && identity.turnId !== undefined
    && !priorChatGptAbortedTurnIds(parsed).includes(revision.turnId)
    // Pre-turn compaction can append the new instruction after the checkpoint. It still
    // rebuilds the preamble before the retained older instruction; the store must validate
    // that claim against the current native rollout just as for an older-source continuation.
    && (revision.turnId === identity.turnId
      ? recoverCompactionInstruction(parsed, identity) !== undefined
      : isAcceptedCompactionContinuation(parsed, identity, revision));
}

export interface ChatGptCalendarEnvironmentDelta {
  workspaceRoots: string[][];
  filesystemProfiles: string[];
}

export interface ChatGptEnvironmentClaim {
  /** A filesystem-only update names allowed roots, not the task's working directory. */
  environment: Omit<ChatGptTurnEnvironment, "cwd"> & { cwd?: string };
  /**
   * Codex's permission-profile envelope states filesystem access only; the network policy lives
   * in the native turn context. Only the legacy sandbox_mode envelope carried a network statement.
   */
  statesNetworkAccess: boolean;
  /** Later calendar fragments remain claims until the current rollout corroborates them. */
  calendarDelta?: ChatGptCalendarEnvironmentDelta;
  /** The exact rendered element, comparable only with Codex's own current world state. */
  filesystemXml?: string;
}

function environmentClaim(parsed: CodexParsedRequest, text: string): ChatGptEnvironmentClaim {
  const filesystem = text.match(/<filesystem>[\s\S]*?<\/filesystem>/g);
  return {
    environment: parseChatGptEnvironmentText(parsed, text),
    statesNetworkAccess: /<network_access\b/i.test(text) || /network access is /i.test(text),
    ...(filesystem?.length === 1 ? { filesystemXml: filesystem[0] } : {}),
  };
}

/** Parse a claim only: the caller must compare it with this turn's native rollout authority. */
export function extractChatGptContinuationEnvironmentClaim(parsed: CodexParsedRequest): ChatGptEnvironmentClaim {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const body = record(parsed._rawBody);
  const updates = (Array.isArray(body?.input) ? body.input : []).flatMap((value, index) => {
    const item = record(value);
    if (item?.type !== "message" || item.role !== "user" || itemTurnId(item) !== turnId
      || typeof item.id !== "string" || !item.id) return [];
    // Native compaction groups plugins, instructions and environment into sibling content parts.
    // Read the environment part without treating the surrounding preamble as part of its XML.
    const parts = typeof item.content === "string" ? [item.content]
      : Array.isArray(item.content) ? item.content.map(part => record(part)?.text) : [];
    return parts.flatMap(value => {
      if (typeof value !== "string") return [];
      const text = value.trim();
      return /^<environment_context>[\s\S]*<\/environment_context>$/.test(text) ? [{ text, index }] : [];
    });
  });
  if (updates.length === 1) return environmentClaim(parsed, updates[0]!.text);
  // A rebuilt full preamble followed by midnight's date-only fragment is one
  // environment plus a delta, not two competing complete grants. Every later
  // fragment must pass the existing strict calendar parser, and the store must
  // still compare its roots/profile with the exact current native rollout.
  const first = updates[0];
  if (first && updates.some((update, index) => index > 0 && update.index === first.index)) {
    throw new Error("Compaction continuation requires one current native environment claim");
  }
  const calendarDelta = first && extractChatGptCalendarEnvironmentDelta(parsed, { afterEnvironmentIndex: first.index });
  if (!first || !calendarDelta) throw new Error("Compaction continuation requires one current native environment claim");
  return { ...environmentClaim(parsed, first.text), calendarDelta };
}

/**
 * Pre-turn native compaction can rebuild the current preamble before retained older
 * instructions, without a bridge-owned checkpoint. These items are claims only;
 * the rollout reader must match both against its latest native replacement history.
 */
export function extractChatGptNativeCompactionEnvironment(parsed: CodexParsedRequest): {
  claim: ChatGptEnvironmentClaim;
  items: Record<string, unknown>[];
} | undefined {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  if (!turnId) return undefined;
  const claims = input.flatMap((value, index) => {
    const item = record(value);
    return hasEnvironmentContextFragment(item) && (itemTurnId(item) === undefined || itemTurnId(item) === turnId)
      ? [{ item, index }] : [];
  });
  if (claims.length !== 1) return undefined;
  const { item, index } = claims[0]!;
  const kinds = record(item.internal_chat_message_metadata_passthrough)?.content_item_kinds;
  if (itemTurnId(item) !== turnId || typeof item.id !== "string" || !item.id
    || !Array.isArray(kinds) || !kinds.includes("environments.environment_context")) return undefined;
  const checkpoints = input.flatMap((value, index) => {
    const item = record(value);
    return item?.type === "compaction" ? [{ item, index }] : [];
  });
  if (checkpoints.length !== 1) return undefined;
  const checkpoint = checkpoints[0]!;
  const activeIndex = input.findLastIndex(value => isNativeInstruction(record(value), clientTurnMetadata(parsed)));
  if (checkpoint.index <= index || activeIndex <= checkpoint.index
    || itemTurnId(input[activeIndex]) !== turnId
    || typeof checkpoint.item.id !== "string" || !checkpoint.item.id
    || typeof checkpoint.item.encrypted_content !== "string" || !checkpoint.item.encrypted_content) return undefined;
  return { claim: extractChatGptContinuationEnvironmentClaim(parsed), items: [item, checkpoint.item] };
}

/**
 * Steering can separate the original environment/instruction pair from the active instruction.
 * Git workspace metadata need not list every native filesystem root. Return that earlier claim
 * only for a same-turn pair; the store must compare it with the current canonical rollout.
 */
export function extractChatGptSteeringEnvironmentClaim(parsed: CodexParsedRequest): ChatGptEnvironmentClaim | undefined {
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!turnId) return undefined;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const metadata = clientTurnMetadata(parsed);
  const activeIndex = input.findLastIndex(value => isNativeInstruction(record(value), metadata));
  const active = record(input[activeIndex]);
  if (itemTurnId(active) !== turnId || typeof active?.id !== "string" || !active.id) return undefined;

  // Do not skip an unrecognized update or use one of several competing envelopes. Older,
  // explicitly attributed history is not a current claim; untagged XML remains unproven.
  const claims = input.flatMap((value, index) => {
    const item = record(value);
    if (!hasEnvironmentContextFragment(item)) return [];
    const owner = itemTurnId(item);
    return owner === undefined || owner === turnId ? [{ item, index }] : [];
  });
  if (claims.length !== 1) return undefined;
  const claim = claims[0]!;
  if (claim.item.role !== "user" || itemTurnId(claim.item) !== turnId
    || typeof claim.item.id !== "string" || !claim.item.id) return undefined;
  const parts = Array.isArray(claim.item.content) ? claim.item.content : [];
  if (parts.filter(part => /<\/?environment_context\b/i.test(String(record(part)?.text ?? ""))).length !== 1) return undefined;

  for (let index = claim.index + 1; index < activeIndex; index += 1) {
    const instruction = record(input[index]);
    if (typeof instruction?.id !== "string" || !instruction.id) continue;
    const text = environmentBeforeUser(input, index, turnId, metadata);
    if (text) return environmentClaim(parsed, text);
  }
  return undefined;
}

/**
 * Native world-state diffs omit unchanged cwd/shell at midnight but repeat the filesystem
 * profile. Recognize the calendar fragment as a claim only: the store
 * still requires this exact turn's native rollout and corroborating current sandbox metadata.
 * Unknown profiles/fields are deliberately not classified as permission-neutral updates.
 */
export function extractChatGptCalendarEnvironmentDelta(
  parsed: CodexParsedRequest,
  options?: { afterEnvironmentIndex: number },
): ChatGptCalendarEnvironmentDelta | undefined {
  const metadata = clientTurnMetadata(parsed);
  const turnId = extractChatGptTurnIdentity(parsed).turnId;
  if (!metadata || !turnId) return undefined;
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : [];
  const activeIndex = options?.afterEnvironmentIndex
    ?? input.findLastIndex(value => isNativeInstruction(record(value), metadata));
  const active = record(input[activeIndex]);
  if (itemTurnId(active) !== turnId || typeof active?.id !== "string" || !active.id) return undefined;
  if (options) {
    const kinds = record(active.internal_chat_message_metadata_passthrough)?.content_item_kinds;
    if (active.type !== "message" || active.role !== "user" || !Array.isArray(kinds)
      || !kinds.includes("environments.environment_context")) return undefined;
  }

  // Match the whole native fragment, not just the presence of a permission profile: another
  // profile, a malformed cwd, or any additional permission declaration must fail closed.
  // Native midnight updates can also repeat a worker inventory. Its exact name-only
  // shape is contextual; it grants neither filesystem authority nor child ownership.
  const calendarFragment = (text: string) => /^<environment_context>\s*<current_date>\d{4}-\d{2}-\d{2}<\/current_date>\s*(?:<timezone>[^<>]+<\/timezone>\s*)?<filesystem>\s*(?:<workspace_roots>((?:\s*<root>[^<>]+<\/root>\s*)+)<\/workspace_roots>\s*)?(<permission_profile type="(?:disabled|managed)">[\s\S]*?<\/permission_profile>)\s*<\/filesystem>\s*(?:<subagents>\s*(?:<agent name="[^<>"\r\n]+"\s*\/>\s*)*<\/subagents>\s*)?<\/environment_context>$/.exec(text);
  const fragments: string[] = [];
  // Codex renders no workspace_roots for a turn that has none (#936). Such a fragment names
  // no root and no cwd, so it can precede the instruction; with roots it is an ordinary claim.
  const leading = options ? undefined : environmentBeforeUser(input, activeIndex, turnId, metadata);
  const leadingMatch = leading ? calendarFragment(leading) : null;
  if (leading && leadingMatch && leadingMatch[1] === undefined) fragments.push(leading);
  for (let index = activeIndex + 1; index < input.length; index += 1) {
    const item = record(input[index]);
    if (!hasEnvironmentContextFragment(item)) continue;
    if (item.role !== "user" || itemTurnId(item) !== turnId || typeof item.id !== "string" || !item.id) return undefined;
    fragments.push(rawMessageText(item).trim());
  }

  let deltas = 0;
  const workspaceRoots: string[][] = [];
  const filesystemProfiles: string[] = [];
  for (const text of fragments) {
    const match = calendarFragment(text);
    if (!match
      || !sandboxMetadataMatchesEnvironment(canonicalSandboxMetadata(metadata), text)
      || [metadata.sandbox_mode, metadata.sandbox].some(value => (
        value !== undefined && !sandboxMetadataMatchesEnvironment(value, text)
      ))) return undefined;
    // Compare the complete rendered profile against the native record in the store.
    // Only insignificant whitespace between XML tags is normalized.
    filesystemProfiles.push(match[2]!.replace(/>\s+</g, "><"));
    if (match[1]) {
      let roots: string[];
      try { roots = [...match[1].matchAll(/<root>([^<]+)<\/root>/g)].map(root => decodeXmlText(root[1]!.trim())); }
      catch { return undefined; }
      if (roots.some(root => !isAbsolute(root))) return undefined;
      workspaceRoots.push([...new Set(roots.map(pathIdentity))]);
    }
    deltas += 1;
  }
  // A native delta may precede the first assistant response (#812). Its current-turn
  // attribution permits verification, never authority: all repeated roots must agree
  // with the current rollout before the store can accept this update.
  return deltas > 0 ? { workspaceRoots, filesystemProfiles } : undefined;
}

function environmentBeforeUser(input: unknown[], userIndex: number, expectedTurnId?: string, metadata?: Record<string, unknown>): string | undefined {
  if (userIndex <= 0) return undefined;
  const user = record(input[userIndex]);
  if (!isNativeInstruction(user, metadata)) return undefined;

  const userTurnId = itemTurnId(user);
  if (!userTurnId || (expectedTurnId && userTurnId !== expectedTurnId)) return undefined;

  let candidateIndex = userIndex - 1;
  let candidate = record(input[candidateIndex]);
  while (candidate?.type === "message" && (candidate.role === "developer" || isNativeOpenPageContext(candidate))) {
    const developerTurnId = itemTurnId(candidate);
    if (developerTurnId !== userTurnId) return undefined;
    candidateIndex -= 1;
    candidate = record(input[candidateIndex]);
  }
  if (candidate?.type !== "message" || candidate.role !== "user") return undefined;

  const candidateTurnId = itemTurnId(candidate);
  if (candidateTurnId !== userTurnId) return undefined;

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
  const unrestricted = /<permission_profile\s+type=["']disabled["'][^>]*>[\s\S]*?<file_system\s+type=["']unrestricted["'][^>]*\/?\s*>/i.test(text)
    || /<sandbox_mode>danger-full-access<\/sandbox_mode>/i.test(text);
  const restrictedFileSystem = /<permission_profile\s+type=["']managed["'][^>]*>[\s\S]*?<file_system\s+type=["']restricted["'][^>]*>([\s\S]*?)<\/file_system>/i.exec(text);
  const restrictedHasWriteEntry = restrictedFileSystem !== null
    && /<entry\s+access=["']write["'][^>]*>/i.test(restrictedFileSystem[1]!);
  const workspaceWrite = /<sandbox_mode>workspace-write<\/sandbox_mode>/i.test(text)
    || restrictedHasWriteEntry;
  const readOnly = /<sandbox_mode>read-only<\/sandbox_mode>/i.test(text)
    || (restrictedFileSystem !== null && !restrictedHasWriteEntry);
  if (Number(unrestricted) + Number(workspaceWrite) + Number(readOnly) !== 1) return undefined;
  return unrestricted ? "dangerFullAccess" : workspaceWrite ? "workspaceWrite" : "readOnly";
}

type ChatGptMetadataSandbox = ChatGptSandboxPolicy["type"] | "platform";

function canonicalSandboxMetadata(metadata: Record<string, unknown>): unknown {
  return metadata.sandbox_mode ?? metadata.sandbox;
}

function sandboxTypeFromMetadata(value: unknown): ChatGptMetadataSandbox | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase().replaceAll("_", "-")) {
    case "none":
    case "unrestricted":
    case "danger-full-access":
      return "dangerFullAccess";
    case "workspace-write":
      return "workspaceWrite";
    case "read-only":
      return "readOnly";
    // Codex CLI reports the host sandbox mechanism here, while the XML envelope carries the
    // effective filesystem policy. Keep the platform tag as a separate class and validate the
    // actual policy below instead of guessing write access from the platform name.
    case "windows-sandbox":
    case "windows-elevated":
    case "seatbelt":
    case "seccomp":
      return "platform";
    default:
      return undefined;
  }
}

function sandboxMetadataMatchesEnvironment(
  metadataValue: unknown,
  environmentText: string,
): boolean {
  const metadataSandbox = sandboxTypeFromMetadata(metadataValue);
  const environmentSandbox = sandboxTypeFromEnvironment(environmentText);
  if (!metadataSandbox || !environmentSandbox) return false;
  if (metadataSandbox === "platform") {
    return environmentSandbox === "workspaceWrite" || environmentSandbox === "readOnly";
  }
  return metadataSandbox === environmentSandbox;
}

function environmentMatchesCanonicalMetadata(
  environmentText: string,
  metadata: Record<string, unknown>,
  requireMetadataBoundRoots: boolean,
): boolean {
  const metadataSandboxValue = canonicalSandboxMetadata(metadata);
  const metadataSandbox = sandboxTypeFromMetadata(metadataSandboxValue);
  if (!metadataSandbox) return false;
  const workspaces = record(metadata.workspaces);
  const metadataRoots = workspaces ? Object.keys(workspaces) : [];
  if (metadataRoots.some(path => !isAbsolute(path))) return false;
  const normalizedMetadataRoots = [...new Set(metadataRoots.map(pathIdentity))];

  let paths: ReturnType<typeof environmentPaths>;
  try {
    paths = environmentPaths(environmentText, normalizedMetadataRoots);
  } catch {
    return false;
  }
  const declaredRoots = paths.roots.map(pathIdentity);
  // Without a stated cwd this is only a partial claim. The store must obtain
  // the cwd from the current native rollout and validate its workspace metadata.
  if (paths.cwd !== undefined && normalizedMetadataRoots.length > 0
    && !normalizedMetadataRoots.some(root => matchesPath(root, paths.cwd!))) return false;
  if (requireMetadataBoundRoots && (
    normalizedMetadataRoots.length === 0
    || declaredRoots.some(root => (
      !normalizedMetadataRoots.some(metadataRoot => matchesPath(metadataRoot, root))
      && !isCurrentOrParentThreadVisualizationRoot(root, metadata)
    ))
  )) return false;
  return sandboxMetadataMatchesEnvironment(metadataSandboxValue, environmentText);
}

function isCurrentOrParentThreadVisualizationRoot(path: string, metadata: Record<string, unknown>): boolean {
  const threadIds = [metadata.thread_id, metadata.parent_thread_id]
    .filter((value): value is string => typeof value === "string")
    .map(value => process.platform === "win32" ? value.trim().toLowerCase() : value.trim())
    .filter(Boolean);
  if (threadIds.length === 0) return false;

  // Codex advertises its task-scoped visualization output directory in workspace_roots but omits
  // it from Git-oriented turn metadata. Authenticate that one auxiliary shape by both its private
  // Codex home and current or parent thread id; arbitrary roots and unrelated output remain untrusted.
  const configuredCodexHome = process.env.CODEX_HOME?.trim();
  const codexHome = resolve(configuredCodexHome || join(homedir(), ".codex"));
  const visualizationBase = pathIdentity(join(codexHome, "visualizations"));
  const rel = relative(visualizationBase, pathIdentity(path));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;

  const parts = rel.split(sep);
  return parts.length === 4
    && /^\d{4}$/.test(parts[0]!)
    && /^(?:0[1-9]|1[0-2])$/.test(parts[1]!)
    && /^(?:0[1-9]|[12]\d|3[01])$/.test(parts[2]!)
    && threadIds.includes(parts[3]!);
}

function canonicalMetadataEnvironmentBeforeUser(
  input: unknown[],
  userIndex: number,
  metadata: Record<string, unknown> | undefined,
  requireMetadataBoundRoots = false,
): string | undefined {
  if (userIndex <= 0 || !metadata) return undefined;
  const metadataTurnId = typeof metadata.turn_id === "string" ? metadata.turn_id.trim() : "";
  const metadataSandbox = sandboxTypeFromMetadata(canonicalSandboxMetadata(metadata));
  if (!metadataTurnId || !metadataSandbox) return undefined;

  const user = record(input[userIndex]);
  if (!isNativeInstruction(user, metadata) || typeof user.id !== "string" || !user.id) return undefined;
  const userTurnId = itemTurnId(user);
  if (userTurnId !== undefined && userTurnId !== metadataTurnId) return undefined;

  return canonicalMetadataEnvironmentBefore(input, userIndex, metadata, requireMetadataBoundRoots);
}

/** Read an envelope before a proven instruction or completed checkpoint, never as the instruction. */
function canonicalMetadataEnvironmentBefore(
  input: unknown[],
  anchorIndex: number,
  metadata: Record<string, unknown>,
  requireMetadataBoundRoots = false,
): string | undefined {
  const metadataTurnId = metadata.turn_id;
  if (typeof metadataTurnId !== "string" || !metadataTurnId.trim()) return undefined;

  let candidateIndex = anchorIndex - 1;
  let candidate = record(input[candidateIndex]);
  while (candidate?.type === "message" && (candidate.role === "developer"
    || compactionSummaryMessage(candidate) || isNativeOpenPageContext(candidate))) {
    const developerTurnId = itemTurnId(candidate);
    const serverOwnedId = typeof candidate.id === "string" && candidate.id.length > 0;
    if (developerTurnId === undefined ? !serverOwnedId : developerTurnId !== metadataTurnId) return undefined;
    candidateIndex -= 1;
    candidate = record(input[candidateIndex]);
  }
  if (candidate?.type !== "message" || candidate.role !== "user" || typeof candidate.id !== "string" || !candidate.id) return undefined;
  const candidateTurnId = itemTurnId(candidate);
  if (candidateTurnId !== undefined && candidateTurnId !== metadataTurnId) return undefined;

  const content = Array.isArray(candidate.content) ? candidate.content : [];
  for (const part of content) {
    const text = record(part)?.text;
    if (typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!/^<environment_context>[\s\S]*<\/environment_context>$/.test(trimmed)) continue;
    // Current Codex stamps server-owned item IDs but not per-item turn IDs on the initial request,
    // and canonical workspaces contains Git enrichment rather than filesystem authority. Bind the
    // structurally adjacent context (allowing provenance-checked developer and native page items) to
    // canonical turn/sandbox metadata; when Git roots are present, require the primary cwd to agree
    // with them as an additional check.
    if (!environmentMatchesCanonicalMetadata(trimmed, metadata, requireMetadataBoundRoots)) continue;
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
  const metadata = clientTurnMetadata(parsed);
  let activeUserIndex = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (isNativeInstruction(item, metadata)) {
      activeUserIndex = index;
      break;
    }
  }
  const checkpoint = activeUserIndex < 0 ? recoverCompactionInstruction(parsed, extractChatGptTurnIdentity(parsed)) : undefined;
  const anchorIndex = checkpoint?.summaryIndex ?? activeUserIndex;
  const turnId = metadata?.turn_id;
  // A mid-turn update supersedes the start envelope too. Do not return that earlier authority
  // before the store can authenticate the delta against the current native turn context.
  if (input.slice(anchorIndex + 1).some(value => {
    const item = record(value);
    return hasEnvironmentContextFragment(item)
      && (itemTurnId(item) === undefined || itemTurnId(item) === turnId);
  })) return undefined;
  const currentByTurn = environmentBeforeUser(
    input,
    activeUserIndex,
    typeof turnId === "string" ? turnId : undefined,
    metadata,
  );
  if (currentByTurn) return currentByTurn;

  const current = checkpoint && metadata
    ? canonicalMetadataEnvironmentBefore(input, checkpoint.summaryIndex, metadata)
    : canonicalMetadataEnvironmentBeforeUser(input, activeUserIndex, metadata);
  if (current) return current;

  // A skill invocation appends another server-owned user item after the real instruction. Recover
  // the earlier current-turn environment/prompt pair only through canonical metadata, and bind all
  // declared roots to metadata workspaces so user-authored XML cannot widen filesystem authority.
  let crossedAssistantOutput = false;
  for (let index = activeUserIndex - 1; index > 0; index -= 1) {
    crossedAssistantOutput ||= hasAssistantOutputBetween(input, index, index + 1);
    // Replayed untagged history is not a same-turn skill invocation. Only explicit current-turn
    // provenance may cross an assistant response; otherwise resolve from the native rollout.
    if (crossedAssistantOutput && itemTurnId(input[index]) !== turnId) continue;
    const sameTurn = canonicalMetadataEnvironmentBeforeUser(input, index, metadata, true);
    if (sameTurn) return sameTurn;
  }

  // An attempted current update takes precedence over all older authority, even when its native
  // item metadata is incomplete. Never mask malformed permissions/cwd with a previous turn.
  if (hasCurrentChatGptEnvironmentContext(parsed)) return undefined;

  const replayPrefixLen = Math.min(parsed._replayPrefixLen ?? 0, input.length);
  for (let index = replayPrefixLen - 1; index > 0; index -= 1) {
    const replayed = environmentBeforeUser(input, index, undefined, metadata);
    if (replayed) return replayed;
  }

  // Codex can resume a local task by explicitly replaying its native transcript instead of
  // sending previous_response_id. In that shape, accept a historical environment/user pair only
  // when both items carry the same native turn_id and either completed assistant output separates
  // that turn from the active user or the complete historical pair is server-owned and its
  // filesystem authority still matches the current thread's canonical workspace/sandbox metadata.
  // A user-authored <environment_context> inside one chat message cannot satisfy this structure.
  const currentTurnId = typeof turnId === "string" ? turnId : undefined;
  const currentThreadId = typeof metadata?.thread_id === "string" && metadata.thread_id.trim()
    ? metadata.thread_id
    : undefined;
  const activeUser = record(input[activeUserIndex]);
  const activeUserOwned = isNativeInstruction(activeUser, metadata)
    && typeof activeUser.id === "string"
    && activeUser.id.length > 0
    && itemTurnId(activeUser) === currentTurnId;
  if (currentTurnId && itemTurnId(activeUser) === currentTurnId) {
    for (let index = activeUserIndex - 1; index > 0; index -= 1) {
      const historicalUser = record(input[index]);
      const historicalTurnId = itemTurnId(historicalUser);
      if (!historicalTurnId || historicalTurnId === currentTurnId) continue;
      const historical = environmentBeforeUser(input, index, undefined, metadata);
      if (!historical) continue;
      if (hasAssistantOutputBetween(input, index + 1, activeUserIndex)) return historical;
      if (!currentThreadId || !metadata || !activeUserOwned) continue;
      const bounded = canonicalMetadataEnvironmentBeforeUser(
        input,
        index,
        { ...metadata, turn_id: historicalTurnId, sandbox: canonicalSandboxMetadata(metadata) },
        true,
      );
      if (bounded === historical) return bounded;
    }
  }
  return undefined;
}

function clientMetadataWorkspaceRoots(parsed: CodexParsedRequest): string[] {
  const workspaces = record(clientTurnMetadata(parsed)?.workspaces);
  if (!workspaces) return [];
  const roots = Object.keys(workspaces);
  if (roots.some(path => !isAbsolute(path))) return [];
  return [...new Set(roots.map(pathIdentity))];
}

function trustedEnvironmentText(parsed: CodexParsedRequest): string {
  const raw = rawEnvironmentText(parsed);
  if (raw) return raw;
  // A real Responses request always has `_rawBody`. Parsed system/developer text has already lost
  // the wire provenance needed to distinguish Codex context from user-authored XML, so it must
  // never become filesystem authority for a raw request.
  if (parsed._rawBody !== undefined) return "";
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

function environmentCwdMatches(text: string, preferredRoots: string[] = []): string[] {
  const sections = [...text.matchAll(/<environments>([\s\S]*?)<\/environments>/gi)];
  if (sections.length === 0) {
    return [...text.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map(match => match[1] ?? "");
  }
  if (sections.length !== 1) return [];

  const section = sections[0]!;
  const outside = text.replace(section[0], "");
  if (/<cwd>[^<]*<\/cwd>/i.test(outside)) return [];

  const environments = [...section[1]!.matchAll(/<environment\b([^>]*)>([\s\S]*?)<\/environment>/gi)];
  const primary = environments.filter(match => /\bprimary\s*=\s*["']true["']/i.test(match[1] ?? ""));
  if (primary.length === 1) {
    return [...primary[0]![2]!.matchAll(/<cwd>([^<]+)<\/cwd>/gi)].map(match => match[1] ?? "");
  }
  if (primary.length > 1) return [];

  // Codex 0.146.x emitted multiple environments without a primary attribute. Only use that
  // legacy shape when canonical workspace metadata identifies one candidate; never pick by order.
  const candidates = environments.flatMap(environment => {
    const cwdMatches = [...environment[2]!.matchAll(/<cwd>([^<]+)<\/cwd>/gi)]
      .map(match => match[1] ?? "");
    return cwdMatches.length === 1 ? cwdMatches : [];
  });
  if (candidates.length === 1) return candidates;
  if (preferredRoots.length === 0) return [];

  const exact = candidates.filter(candidate => preferredRoots
    .some(root => pathIdentity(root) === pathIdentity(candidate)));
  if (exact.length === 1) return exact;
  const contained = candidates.filter(candidate => preferredRoots
    .some(root => matchesPath(root, candidate)));
  return contained.length === 1 ? contained : [];
}

function uniqueAbsolutePaths(values: string[], field: string): string[] {
  const decoded = values.map(value => decodeXmlText(value.trim()));
  if (decoded.length === 0) throw new MissingTrustedCodexEnvironmentError(field);
  if (decoded.some(path => !isAbsolute(path))) throw new Error(`ChatGPT web ${field} must contain absolute paths`);
  const unique = new Map<string, string>();
  for (const path of decoded.map(value => resolve(value))) {
    if (!unique.has(pathIdentity(path))) unique.set(pathIdentity(path), path);
  }
  return [...unique.values()];
}

function matchesPath(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function extractChatGptTurnEnvironment(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
  const environment = extractChatGptTurnEnvironmentClaim(parsed).environment;
  if (environment.cwd === undefined) throw new MissingTrustedCodexEnvironmentError("cwd");
  if (!environment.roots.some(root => matchesPath(root, environment.cwd!))) {
    throw new MissingTrustedCodexEnvironmentError("current native worktree authority");
  }
  return { ...environment, cwd: environment.cwd };
}

export function extractChatGptTurnEnvironmentClaim(parsed: CodexParsedRequest): ChatGptEnvironmentClaim {
  return environmentClaim(parsed, trustedEnvironmentText(parsed));
}

function environmentPaths(text: string, preferredRoots: string[]): { cwd?: string; roots: string[] } {
  const cwdMatches = environmentCwdMatches(text, preferredRoots);
  const rootSections = [...text.matchAll(/<workspace_roots>[\s\S]*?<\/workspace_roots>/g)];
  const rootMatches = rootSections
    .flatMap(section => [...section[0].matchAll(/<root>([^<]+)<\/root>/g)].map(match => match[1] ?? ""));
  if (cwdMatches.length === 0) {
    // Only a well-formed filesystem-only update may omit cwd. Malformed cwd,
    // ambiguous environments, and incomplete root lists remain invalid claims.
    if (/<\/?(?:cwd|environments)\b/i.test(text) || rootSections.length !== 1 || rootMatches.length === 0
      || [...text.matchAll(/<workspace_roots\b[^>]*>/gi)].length !== 1
      || [...text.matchAll(/<\/workspace_roots\s*>/gi)].length !== 1
      || [...rootSections[0]![0].matchAll(/<root\b[^>]*>/gi)].length !== rootMatches.length
      || [...rootSections[0]![0].matchAll(/<\/root\s*>/gi)].length !== rootMatches.length) {
      throw new MissingTrustedCodexEnvironmentError("cwd");
    }
    return { roots: uniqueAbsolutePaths(rootMatches, "workspace_roots") };
  }
  const cwdCandidates = uniqueAbsolutePaths(cwdMatches, "cwd");
  if (cwdCandidates.length !== 1) throw new Error("ChatGPT web turn has conflicting trusted Codex cwd values");
  const cwd = cwdCandidates[0]!;
  const roots = rootMatches.length > 0 ? uniqueAbsolutePaths(rootMatches, "workspace_roots") : [cwd];
  if (!roots.some(root => matchesPath(root, cwd)) && sandboxTypeFromEnvironment(text) !== "dangerFullAccess") {
    throw new Error("ChatGPT web cwd is outside the trusted Codex workspace roots");
  }
  return { cwd, roots };
}

function parseChatGptEnvironmentText(parsed: CodexParsedRequest, text: string): ChatGptEnvironmentClaim["environment"] {
  const paths = environmentPaths(text, clientMetadataWorkspaceRoots(parsed));
  const { roots } = paths;
  const sandboxType = sandboxTypeFromEnvironment(text);
  const networkAccess = /<network_access>enabled<\/network_access>/i.test(text)
    || /network access is enabled/i.test(text);

  if (!sandboxType) {
    throw new Error("ChatGPT web turn requires one explicit trusted Codex sandbox mode");
  }
  if (sandboxType === "dangerFullAccess") {
    return { ...paths, writableRoots: roots, sandboxPolicy: { type: "dangerFullAccess" }, tools: parsed.context.tools ?? [] };
  }
  if (sandboxType === "workspaceWrite") {
    return {
      ...paths,
      writableRoots: roots,
      sandboxPolicy: { type: "workspaceWrite", writableRoots: roots, networkAccess },
      tools: parsed.context.tools ?? [],
    };
  }
  return { ...paths, writableRoots: [], sandboxPolicy: { type: "readOnly", networkAccess }, tools: parsed.context.tools ?? [] };
}

export function extractChatGptTurnIdentity(parsed: CodexParsedRequest): ChatGptTurnIdentity {
  const body = record(parsed._rawBody);
  return {
    ...extractCodexTurnIdentityFromBody(body),
    ...(typeof body?.prompt_cache_key === "string" ? { promptCacheKey: body.prompt_cache_key } : {}),
  };
}

/** Read only Codex-owned lifecycle identity without interpreting or rewriting the provider body. */
export function extractCodexTurnIdentityFromBody(value: unknown): ChatGptTurnIdentity {
  const metadata = clientTurnMetadataFromBody(value);
  return {
    ...(typeof metadata?.thread_id === "string" ? { threadId: metadata.thread_id } : {}),
    ...(typeof metadata?.turn_id === "string" ? { turnId: metadata.turn_id } : {}),
    ...(typeof metadata?.parent_thread_id === "string" ? { parentThreadId: metadata.parent_thread_id } : {}),
    ...(typeof metadata?.agent_name === "string" ? { agentName: metadata.agent_name } : {}),
    ...(typeof metadata?.subagent_kind === "string" ? { subagentKind: metadata.subagent_kind } : {}),
  };
}

/**
 * Return the canonical parent link carried by a native Codex thread-spawn request.
 * This is deliberately stricter than generic metadata parsing: only a real child turn with an
 * agent name, explicit turn purpose, sandbox policy, and absolute workspace evidence can inherit
 * filesystem authority from a previously verified parent thread.
 */
export function extractChatGptThreadSpawnLineage(
  parsed: CodexParsedRequest,
): ChatGptThreadSpawnLineage | undefined {
  const metadata = clientTurnMetadata(parsed);
  if (!metadata || !isEnvironmentRequest(metadata, parsed) || metadata.subagent_kind !== "thread_spawn") return undefined;
  const threadId = typeof metadata.thread_id === "string" ? metadata.thread_id.trim() : "";
  const parentThreadId = typeof metadata.parent_thread_id === "string" ? metadata.parent_thread_id.trim() : "";
  const agentName = typeof metadata.agent_name === "string" ? metadata.agent_name.trim() : "";
  if (!threadId || !parentThreadId || threadId === parentThreadId
    || (agentName !== "/root" && !/^\/root\/.+/.test(agentName))) return undefined;

  const sandboxType = sandboxTypeFromMetadata(canonicalSandboxMetadata(metadata));
  if (!sandboxType || sandboxType === "platform") return undefined;
  const workspaces = record(metadata.workspaces);
  const workspacePaths = workspaces ? Object.keys(workspaces) : [];
  if (workspacePaths.some(path => !isAbsolute(path))) return undefined;
  const workspaceRoots = [...new Set(workspacePaths.map(path => resolve(path)))];
  return { threadId, parentThreadId, agentName, sandboxType, workspaceRoots };
}

/** Root tasks have no spawn edge; their canonical session and current turn must prove authority. */
export function extractChatGptRootThreadMetadata(parsed: CodexParsedRequest): ChatGptRootThreadMetadata | undefined {
  const metadata = clientTurnMetadata(parsed);
  if (!metadata || !isEnvironmentRequest(metadata, parsed)
    || metadata.parent_thread_id != null || metadata.subagent_kind != null
    || (metadata.agent_name != null && metadata.agent_name !== "/root")) return undefined;
  const threadId = typeof metadata.thread_id === "string" ? metadata.thread_id.trim() : "";
  const sandboxType = sandboxTypeFromMetadata(canonicalSandboxMetadata(metadata));
  const workspaces = record(metadata.workspaces);
  const workspacePaths = workspaces ? Object.keys(workspaces) : [];
  if (!threadId || !sandboxType || workspacePaths.some(path => !isAbsolute(path))) return undefined;
  return { threadId, sandboxType, workspaceRoots: [...new Set(workspacePaths.map(path => resolve(path)))] };
}

function isEnvironmentRequest(metadata: Record<string, unknown>, parsed: CodexParsedRequest): boolean {
  return metadata.request_kind === "turn"
    || (parsed._compactionRequest === true && metadata.request_kind === "compaction");
}
