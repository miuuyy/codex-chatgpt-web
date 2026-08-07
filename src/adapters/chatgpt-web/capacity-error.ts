export const CHATGPT_CAPACITY_ERROR_CODE = "CHATGPT_CAPACITY" as const;

/** Model/server capacity outcome. Stable fields survive the launcher helper process boundary. */
export class ChatGptCapacityError extends Error {
  readonly code = CHATGPT_CAPACITY_ERROR_CODE;

  constructor(readonly stage: string) {
    super(`ChatGPT selected model is at capacity during ${stage}`);
    this.name = "ChatGptCapacityError";
  }
}

export function isChatGptCapacityError(error: unknown): error is ChatGptCapacityError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Partial<ChatGptCapacityError>;
  return candidate.code === CHATGPT_CAPACITY_ERROR_CODE
    && typeof candidate.stage === "string"
    && candidate.stage.trim().length > 0
    && typeof candidate.message === "string";
}
