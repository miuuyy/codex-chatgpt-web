export type ChatGptServiceErrorCode = "input_too_large" | "message_length_exceeds_limit";
export type ChatGptServiceErrorReason = "last_user_message";

/** Safe to export: service-owned enum values only, never the service's free-text error. */
export interface ChatGptServiceError {
  error_code: ChatGptServiceErrorCode;
  error_reason?: ChatGptServiceErrorReason;
}

export type ChatGptSizeRejection =
  | { error_code: "input_too_large"; error_reason: "last_user_message" }
  | { error_code: "message_length_exceeds_limit" };

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Parse only the top-level SSE service fields or the known HTTP 413 JSON detail shape. */
export function parseChatGptServiceError(value: unknown): ChatGptServiceError | undefined {
  const event = object(value);
  if (!event) return;
  const code = event.error_code !== undefined ? event.error_code : object(event.detail)?.code;
  if (code !== "input_too_large" && code !== "message_length_exceeds_limit") return;
  // The HTTP detail shape establishes only the specific, known message-length error.
  if (event.error_code === undefined && code !== "message_length_exceeds_limit") return;
  return { error_code: code,
    ...(event.error_reason === "last_user_message" ? { error_reason: event.error_reason } : {}) };
}

/** Unknown errors and model text are not proof that an owned submission was rejected. */
export function parseChatGptSizeRejection(value: unknown): ChatGptSizeRejection | undefined {
  const serviceError = parseChatGptServiceError(value);
  if (serviceError?.error_code === "message_length_exceeds_limit") {
    return { error_code: "message_length_exceeds_limit" };
  }
  if (serviceError?.error_code === "input_too_large" && serviceError.error_reason === "last_user_message") {
    const event = object(value)!;
    if (typeof event.error === "string" && event.error.trim().length > 0) {
      return { error_code: "input_too_large", error_reason: "last_user_message" };
    }
  }
}
