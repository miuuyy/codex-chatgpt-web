import { createHash } from "node:crypto";
import { isReadableCompactionSummaryText, OPAQUE_COMPACTION_NOTE } from "../../responses/compaction";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity } from "./environment";

/** Zero Risk creates a fresh manual owner after compaction, even though Automatic retains its chat. */
export function chatGptCompactionEpoch(parsed: CodexParsedRequest): unknown {
  const raw = parsed._rawBody as { input?: unknown[] } | undefined;
  return raw?.input?.findLast(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    if (["compaction", "compaction_summary", "context_compaction"].includes(String(record.type))) {
      return true;
    }
    if (record.role !== "user") return false;
    const content = record.content;
    const text = typeof content === "string" ? content : Array.isArray(content)
      ? content.flatMap(part => part && typeof part === "object" && typeof part.text === "string"
        ? [part.text] : []).join("\n")
      : "";
    return isReadableCompactionSummaryText(text);
  }) ?? null;
}

export function chatGptConversationKey(
  parsed: CodexParsedRequest,
  namespace: string,
): string | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.threadId) return undefined;
  return createHash("sha256").update(JSON.stringify({
    namespace,
    threadId: identity.threadId,
  })).digest("hex");
}

/** Full history remains canonical; an exact retained chat receives only messages it has not seen. */
export function retainedConversationResumeRequest(
  parsed: CodexParsedRequest,
): CodexParsedRequest | undefined {
  // After native compaction the replacement history can have no assistant response at all.
  // Its checkpoint was delivered in the same retained ChatGPT tab, so never resend the
  // potentially huge summary (v1 text or v2 opaque compaction item) into that tab.
  const lastCheckpoint = parsed.context.messages.findLastIndex(message => message.role === "user"
    && (typeof message.content === "string"
      ? isReadableCompactionSummaryText(message.content) || message.content === OPAQUE_COMPACTION_NOTE
      : message.content.some(part => part.type === "text"
        && (isReadableCompactionSummaryText(part.text) || part.text === OPAQUE_COMPACTION_NOTE))));
  const lastAssistant = parsed.context.messages.findLastIndex(message => message.role === "assistant");
  const lastSeen = Math.max(lastAssistant, lastCheckpoint);
  if (lastSeen < 0) return undefined;
  const suffix = parsed.context.messages.slice(lastSeen + 1);
  if (suffix.length === 0 && lastCheckpoint < 0) return undefined;
  return {
    ...parsed,
    context: {
      ...parsed.context,
      messages: suffix.length ? suffix : [{
        role: "user",
        content: "Codex compacted its local context. Continue the active task in this retained ChatGPT conversation.",
        timestamp: Date.now(),
      }],
    },
  };
}
