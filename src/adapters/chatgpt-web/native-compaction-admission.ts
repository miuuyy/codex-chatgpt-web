import { isDeepStrictEqual } from "node:util";
import { getCodexHome } from "../../codex-integration-shared";
import { decodeCompactionSummary, isReadableCompactionSummaryText, SUMMARY_PREFIX } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { rememberCompactionContinuation } from "./compaction-continuation";
import { readCurrentCodexCompactionSnapshot } from "./codex-rollout-environment";
import {
  chatGptTurnUserRevisionHistory, extractChatGptRootThreadMetadata, extractChatGptThreadSpawnLineage,
  extractChatGptTurnIdentity, type ChatGptTurnEnvironment,
} from "./environment";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function checkpoint(input: unknown[], turnId: string): string | undefined {
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
    return summary && (owner === undefined || owner === turnId) ? summary : undefined;
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
export function admitNativeCompactionContinuation(parsed: CodexParsedRequest, codexHome = getCodexHome(), sqliteHome?: string): boolean {
  snapshots.delete(parsed);
  if (parsed._compactionRequest) return false;
  const body = record(parsed._rawBody);
  const input = body?.input;
  const identity = extractChatGptTurnIdentity(parsed);
  const lineage = extractChatGptThreadSpawnLineage(parsed) ?? extractChatGptRootThreadMetadata(parsed);
  if (!Array.isArray(input) || typeof body?.model !== "string" || !identity.turnId || !lineage) return false;
  const summary = checkpoint(input, identity.turnId);
  if (!summary) return false;
  try {
    const native = readCurrentCodexCompactionSnapshot({codexHome, ...(sqliteHome ? {sqliteHome} : {}),
      lineage, turnId: identity.turnId, model: body.model, reasoning: parsed.options.reasoning, tools: parsed.context.tools});
    if (!native || checkpoint(native.history, identity.turnId) !== summary) return false;
    const source = chatGptTurnUserRevisionHistory(parsed).at(-1);
    const nativeSource = chatGptTurnUserRevisionHistory({...parsed, _rawBody:{...body, input:native.history}}).at(-1);
    if (!source || !nativeSource || !isDeepStrictEqual(source, nativeSource)) return false;
    // Context claims must be the actual native preamble, not user-authored XML or a forged id.
    const nativeMessages = new Map(native.history.flatMap(value => {
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
    rememberCompactionContinuation({...parsed, _compactionRequest:true}, identity, [nativeSource], summary);
    snapshots.set(parsed, {body:structuredClone(parsed._rawBody), environment:structuredClone(native.environment)});
    return true;
  } catch {
    // Recovery never replaces normal validation errors with a guessed environment or checkpoint.
    return false;
  }
}
