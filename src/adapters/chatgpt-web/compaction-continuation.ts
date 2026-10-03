import { createHash } from "node:crypto";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";

interface CompletedCheckpoint {
  summaryHash: string;
  sourceHashes: ReadonlySet<string>;
  source: ChatGptTurnUserRevision;
}

// Evidence of a checkpoint actually returned by this daemon, not authority inferred from text
// that happens to look like a summary. A new process must not invent a missing handoff.
const checkpoints = new Map<string, CompletedCheckpoint>();
const MAX_CHECKPOINTS = 256;

function scope(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): string | undefined {
  if (!identity.threadId || !identity.turnId) return undefined;
  return JSON.stringify([identity.threadId, identity.turnId, parsed.modelId, parsed.options.reasoning]);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceDigest(source: ChatGptTurnUserRevision): string {
  return digest([source.turnId, source.content]);
}

export function rememberCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  sources: readonly ChatGptTurnUserRevision[],
  summary: string,
): void {
  const key = scope(parsed, identity);
  if (!key || !parsed._compactionRequest || !summary || !sources[0]) return;
  checkpoints.delete(key);
  checkpoints.set(key, {
    summaryHash: digest(summary), sourceHashes: new Set(sources.map(sourceDigest)),
    source: structuredClone(sources[0]),
  });
  while (checkpoints.size > MAX_CHECKPOINTS) checkpoints.delete(checkpoints.keys().next().value!);
}

export function isAcceptedCompactionContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): boolean {
  return acceptedCheckpoint(parsed, identity)?.checkpoint.sourceHashes.has(sourceDigest(source)) === true;
}

/** A returned checkpoint does not revive a source explicitly interrupted afterward. */
export function isCompactionContinuationInterrupted(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): boolean {
  const accepted = acceptedCheckpoint(parsed, identity);
  if (!accepted) return false;
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  return (input || []).slice(accepted.summaryIndex + 1).some(value => {
    const item = value as Record<string, unknown> | null;
    if (!item || item.type !== "message" || item.role !== "user") return false;
    const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
      ? item.content.map(part => part?.text ?? "").join("\n") : "";
    const owner = (item.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined)?.turn_id;
    return /^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(text.trim())
      && (owner === identity.turnId || owner === accepted.checkpoint.source.turnId);
  });
}

/** Native compaction may retain only its summary; recover the task solely from our completed handoff. */
export function recoverCompactionInstruction(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): { source: ChatGptTurnUserRevision; summaryIndex: number } | undefined {
  const accepted = acceptedCheckpoint(parsed, identity);
  return accepted ? { source: structuredClone(accepted.checkpoint.source), summaryIndex: accepted.summaryIndex } : undefined;
}

function acceptedCheckpoint(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): { checkpoint: CompletedCheckpoint; summaryIndex: number } | undefined {
  const key = scope(parsed, identity);
  const checkpoint = key ? checkpoints.get(key) : undefined;
  if (!key || !checkpoint) return undefined;
  const input = (parsed._rawBody as { input?: unknown[] } | undefined)?.input;
  if (!Array.isArray(input)) return undefined;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") continue;
    let summary: string | null;
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(item.type))) {
      summary = typeof item.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null;
    } else {
      if (item.type !== "message" || item.role !== "user") continue;
      const text = typeof item.content === "string" ? item.content : Array.isArray(item.content)
        ? item.content.map(part => part?.text ?? "").join("\n") : "";
      if (!isReadableCompactionSummaryText(text)) continue;
      summary = text.slice(SUMMARY_PREFIX.length + 1);
    }
    const owner = (item.internal_chat_message_metadata_passthrough as { turn_id?: unknown } | undefined)?.turn_id;
    if (owner !== undefined && owner !== identity.turnId) return undefined;
    return summary !== null && acceptsSummary(key, checkpoint, summary) ? { checkpoint, summaryIndex: index } : undefined;
  }
  return undefined;
}

function acceptsSummary(key: string, checkpoint: CompletedCheckpoint, summary: string): boolean {
  if (digest(summary) !== checkpoint.summaryHash) return false;
  // A long-running continuation does not become invalid merely because time passed. Keep the
  // bounded registry ordered by actual use instead of expiring a still-active native turn.
  checkpoints.delete(key);
  checkpoints.set(key, checkpoint);
  return true;
}
