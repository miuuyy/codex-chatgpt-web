/** A Responses observer can disappear while its independently owned browser remains active. */
export class ChatGptRoundObserverDetached extends Error {
  constructor(cause: unknown) {
    super("The Codex response observer disconnected", { cause });
    this.name = "ChatGptRoundObserverDetached";
  }
}

export function emitChatGptRoundEvent<T>(emit: (event: T) => void, event: T): void {
  try {
    emit(event);
  } catch (cause) {
    // Only errors from the observer callback cross this boundary. Validation, broker and browser
    // failures outside it remain execution failures and must still revoke their capabilities.
    throw new ChatGptRoundObserverDetached(cause);
  }
}

export function isChatGptObserverAbort(error: unknown, signal?: AbortSignal): boolean {
  if (error instanceof ChatGptRoundObserverDetached) return true;
  if (!signal?.aborted || !error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}

const knownNames = new Set(["Error", "TypeError", "DOMException", "AbortError", "AggregateError", "ChatGptWebAdapterError", "ChatGptRoundObserverDetached"]);
const knownCodes = new Set([
  "client_cancelled", "codex_tool_timeout", "chatgpt_submitted_turn_failed",
  "chatgpt_submission_failed", "chatgpt_submission_ambiguous", "chatgpt_stopped_thinking",
  "chatgpt_security_check_required", "chatgpt_sign_in_required", "compaction_source_unavailable",
  "native_snapshot_not_ready", "trusted_environment_unavailable", "turn_preflight_changed",
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ERR_STREAM_DESTROYED", "ABORT_ERR",
]);

export function chatGptRoundFailureEvidence(error: unknown): { errorName: string; errorCode: string } {
  const candidate = error && typeof error === "object" ? error as { name?: unknown; code?: unknown } : {};
  return {
    errorName: typeof candidate.name === "string" && knownNames.has(candidate.name) ? candidate.name : "unknown",
    errorCode: typeof candidate.code === "string" && knownCodes.has(candidate.code)
      ? candidate.code : "unknown",
  };
}
