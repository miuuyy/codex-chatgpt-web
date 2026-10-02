import { isDeepStrictEqual } from "node:util";
import { getCodexHome } from "../../codex-integration-shared";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { rememberCompactionContinuation } from "./compaction-continuation";
import { NativeSnapshotPendingError, readCurrentCodexCompactionSnapshot } from "./codex-rollout-environment";
import { watch } from "node:fs";
import { ChatGptWebAdapterError } from "./adapter-error";
import {
  chatGptTurnUserRevisionHistory, extractChatGptRootThreadMetadata, extractChatGptThreadSpawnLineage,
  extractChatGptTurnIdentity, type ChatGptTurnEnvironment,
} from "./environment";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function checkpoint(input: unknown[], turnId: string): { summary: string; index: number } | undefined {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = record(input[index]);
    if (!item) continue;
    let summary: string | null | undefined;
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
      summary = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
    } else if (item.type === "message" && item.role === "user") {
      const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
        ? item.content.map(part => record(part)?.text ?? "").join("\n") : "";
      if (!isReadableCompactionSummaryText(text)) continue;
      summary = text.slice(SUMMARY_PREFIX.length + 1);
    } else continue;
    const owner = record(item.internal_chat_message_metadata_passthrough)?.turn_id;
    return summary && (owner === undefined || owner === turnId) ? { summary, index } : undefined;
  }
  return undefined;
}

const snapshots = new WeakMap<CodexParsedRequest, { body: unknown; environment: ChatGptTurnEnvironment }>();

/** Internal request-scoped authority; caller-controlled request flags cannot supply this proof. */
export function admittedNativeCompactionEnvironment(parsed: CodexParsedRequest): ChatGptTurnEnvironment | undefined {
  const snapshot = snapshots.get(parsed);
  if (!snapshot || !isDeepStrictEqual(snapshot.body, parsed._rawBody)) return undefined;
  return { ...structuredClone(snapshot.environment), tools: parsed.context.tools ?? [] };
}

/**
 * Read native control records before interpreting the transcript. The native installed checkpoint
 * survives transport reconnects and daemon restarts; process-local handoff caches are an optimization.
 * This restores neither a tool call nor browser work, and never synthesizes a missing instruction.
 */
export function admitNativeCompactionContinuation(parsed: CodexParsedRequest, codexHome = getCodexHome(), sqliteHome?: string, rejectPending = false): boolean {
  snapshots.delete(parsed);
  if (parsed._compactionRequest) return false;
  const body = record(parsed._rawBody);
  const input = body?.input;
  const identity = extractChatGptTurnIdentity(parsed);
  const lineage = extractChatGptThreadSpawnLineage(parsed) ?? extractChatGptRootThreadMetadata(parsed);
  if (!Array.isArray(input) || typeof body?.model !== "string" || !identity.turnId || !lineage) return false;
  const requestedCheckpoint = checkpoint(input, identity.turnId);
  if (!requestedCheckpoint) return false;
  try {
    const native = readCurrentCodexCompactionSnapshot({codexHome, ...(sqliteHome ? {sqliteHome} : {}),
      lineage, turnId: identity.turnId, model: body.model, reasoning: parsed.options.reasoning, tools: parsed.context.tools, rejectPending});
    if (!native) return false;
    const installedCheckpoint = checkpoint(native.history, identity.turnId);
    if (installedCheckpoint?.summary !== requestedCheckpoint.summary) return false;
    const revisions = (items: unknown[]) => chatGptTurnUserRevisionHistory({...parsed, _rawBody:{...body, input:items}});
    const source = revisions(input.slice(0, requestedCheckpoint.index + 1)).at(-1);
    const nativeSource = revisions(native.history.slice(0, installedCheckpoint.index + 1)).at(-1);
    if (!source || !nativeSource || !isDeepStrictEqual(source, nativeSource)) return false;
    // A valid checkpoint does not freeze its instruction forever. Native Codex can append
    // human steering or a cross-task message after compaction. Authenticate the complete
    // instruction sequence after that checkpoint against the same active native task.
    const postCheckpoint = revisions(input.slice(requestedCheckpoint.index + 1));
    const nativePostCheckpoint = revisions(native.continuationItems);
    if (!isDeepStrictEqual(postCheckpoint, nativePostCheckpoint)
      || postCheckpoint.some(revision => revision.turnId !== identity.turnId)) return false;
    // Context claims must be the actual native preamble, not user-authored XML or a forged id.
    const nativeMessages = new Map([...native.history, ...native.continuationItems].flatMap(value => {
      const item = record(value);
      return item?.type === "message" && typeof item.id === "string" ? [[item.id, item] as const] : [];
    }));
    for (const value of input) {
      const item = record(value);
      if (item?.type !== "message" || item.role !== "user") continue;
      const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
        ? item.content.map(part => record(part)?.text ?? "").join("\n") : "";
      const metadata = record(item.internal_chat_message_metadata_passthrough);
      const kinds = metadata?.content_item_kinds;
      const context = (Array.isArray(kinds) && kinds.includes("environments.environment_context"))
        || /^<\/?environment_context\b/i.test(text.trimStart());
      if (context && metadata?.turn_id !== undefined && metadata.turn_id !== identity.turnId) continue;
      if (context && (typeof item.id !== "string" || !isDeepStrictEqual(item, nativeMessages.get(item.id)))) return false;
      if (/^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(text.trim())) return false;
    }
    rememberCompactionContinuation({...parsed, _compactionRequest:true}, identity, [nativeSource], requestedCheckpoint.summary);
    snapshots.set(parsed, {body:structuredClone(parsed._rawBody), environment:structuredClone(native.environment)});
    return true;
  } catch (error) {
    if (error instanceof NativeSnapshotPendingError) throw error;
    // Recovery never replaces normal validation errors with a guessed environment or checkpoint.
    return false;
  }
}

function waitForNativeAppend(file: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher?.close();
      signal?.removeEventListener("abort", abort);
      error === undefined ? resolve() : reject(error);
    };
    const abort = () => finish(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    try {
      watcher = watch(file, () => finish());
      watcher.once("error", () => finish());
    } catch { /* The next authenticated read detects replacement or removal. */ }
    timer = setTimeout(() => finish(), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Await only incomplete native writes; never retry conflicting control evidence. */
export async function prepareNativeCompactionContinuation(
  parsed: CodexParsedRequest,
  options: { codexHome?: string; sqliteHome?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, Math.min(1_000, options.timeoutMs ?? 1_000));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (options.signal?.aborted) throw options.signal.reason;
    try {
      return admitNativeCompactionContinuation(parsed, options.codexHome, options.sqliteHome, true);
    } catch (error) {
      if (!(error instanceof NativeSnapshotPendingError)) throw error;
      const remaining = deadline - Date.now();
      if (attempt === 2 || remaining <= 0) break;
      await waitForNativeAppend(error.rolloutPath, Math.min(500, remaining), options.signal);
    }
  }
  throw new ChatGptWebAdapterError("Native Codex control records are still being written. Retry when the snapshot is complete.", {
    status: 503, errorType: "server_error", code: "native_snapshot_not_ready", retryable: true,
  });
}
