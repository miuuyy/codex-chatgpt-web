import { createHash } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import type { ChatGptTurnIdentity, ChatGptTurnUserRevision } from "./environment";

interface RetryableTurnHandoff {
  failedTurnId: string;
  sourceHash: string;
  successorTurnId?: string;
}

// Evidence of a retryable failure actually emitted by this daemon. This is intentionally
// process-local: a restarted daemon must not infer that an older user message is safe to replay.
const handoffs = new Map<string, RetryableTurnHandoff>();
const MAX_HANDOFFS = 256;

function scope(parsed: CodexParsedRequest, identity: ChatGptTurnIdentity): string | undefined {
  if (!identity.threadId) return undefined;
  return JSON.stringify([identity.threadId, parsed.modelId, parsed.options.reasoning]);
}

function sourceDigest(source: ChatGptTurnUserRevision): string {
  return createHash("sha256")
    .update(JSON.stringify([source.turnId ?? null, source.itemId ?? null, source.content]))
    .digest("hex");
}

/** A fresh native user instruction invalidates any pending retry handoff for this route. */
export function clearRetryableTurnHandoff(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
): void {
  const key = scope(parsed, identity);
  if (key) handoffs.delete(key);
}

/**
 * Record a retryable failure only when its instruction belongs to this turn, or when this turn
 * was itself an already-authenticated retry successor for the exact same instruction.
 */
export function rememberRetryableTurnFailure(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): void {
  const key = scope(parsed, identity);
  if (!key || !identity.turnId || !source.turnId) return;
  const hash = sourceDigest(source);
  const existing = handoffs.get(key);
  const ownsInstruction = source.turnId === identity.turnId;
  const isAuthenticatedSuccessor = existing?.sourceHash === hash
    && existing.successorTurnId === identity.turnId;
  if (!ownsInstruction && !isAuthenticatedSuccessor) return;

  handoffs.delete(key);
  handoffs.set(key, { failedTurnId: identity.turnId, sourceHash: hash });
  while (handoffs.size > MAX_HANDOFFS) handoffs.delete(handoffs.keys().next().value!);
}

/**
 * Bind one successor native turn to the exact user instruction from the immediately failed turn.
 * Repeated provider rounds inside that successor remain valid, while another successor does not.
 */
export function isAcceptedRetryContinuation(
  parsed: CodexParsedRequest,
  identity: ChatGptTurnIdentity,
  source: ChatGptTurnUserRevision,
): boolean {
  const key = scope(parsed, identity);
  const handoff = key ? handoffs.get(key) : undefined;
  if (!key || !handoff || !identity.turnId || !source.turnId) return false;
  if (identity.turnId === handoff.failedTurnId) return false;
  if (handoff.sourceHash !== sourceDigest(source)) {
    handoffs.delete(key);
    return false;
  }

  if (handoff.successorTurnId === undefined) {
    handoff.successorTurnId = identity.turnId;
    handoffs.delete(key);
    handoffs.set(key, handoff);
  }
  if (handoff.successorTurnId === identity.turnId) return true;
  handoffs.delete(key);
  return false;
}
