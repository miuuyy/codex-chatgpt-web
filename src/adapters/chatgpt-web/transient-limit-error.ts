export const CHATGPT_TRANSIENT_LIMIT_ERROR_CODE = "CHATGPT_TRANSIENT_LIMIT" as const;

/**
 * Server-enforced ChatGPT transient request-limit outcome. The stable code and fields survive the
 * launcher helper process boundary, where JavaScript class identity does not.
 */
export class ChatGptTransientLimitError extends Error {
  readonly code = CHATGPT_TRANSIENT_LIMIT_ERROR_CODE;

  constructor(
    readonly stage: string,
    readonly dismissals: number,
  ) {
    super(
      `ChatGPT transient request-limit dialog persisted during ${stage}`
      + ` after ${dismissals} dismissal(s); refusing a fourth activation`,
    );
    this.name = "ChatGptTransientLimitError";
  }
}

export function isChatGptTransientLimitError(error: unknown): error is ChatGptTransientLimitError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Partial<ChatGptTransientLimitError>;
  return candidate.code === CHATGPT_TRANSIENT_LIMIT_ERROR_CODE
    && typeof candidate.stage === "string"
    && candidate.stage.trim().length > 0
    && Number.isSafeInteger(candidate.dismissals)
    && (candidate.dismissals ?? -1) >= 0
    && typeof candidate.message === "string";
}
