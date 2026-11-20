export interface ChatGptWebAdapterErrorOptions {
  status: number;
  errorType: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
  /** Only an observed rejection of this browser submission may set this flag. */
  inputRejected?: boolean;
  rejectedMessageSize?: { chars: number; tokens: number };
}

export class ChatGptWebAdapterError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly inputRejected: boolean;
  rejectedMessageSize?: { chars: number; tokens: number };

  constructor(message: string, options: ChatGptWebAdapterErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatGptWebAdapterError";
    this.status = options.status;
    this.errorType = options.errorType;
    this.code = options.code;
    this.retryable = options.retryable;
    this.inputRejected = options.inputRejected === true;
    this.rejectedMessageSize = options.rejectedMessageSize;
  }
}

export function chatGptToolTimeoutError(tool: string, timeoutMs: number): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `Codex tool ${tool} did not return a result within ${timeoutMs / 1_000} seconds. `
    + "The turn was stopped. Check whether the command is still running or waiting for approval before retrying.",
    { status: 504, errorType: "server_error", code: "codex_tool_timeout", retryable: false },
  );
}

export function chatGptResponseIncompleteError(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 502, errorType: "server_error", code: "chatgpt_response_incomplete", retryable: false,
  });
}

export function chatGptToolApprovalRequiredError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT is waiting for plugin permission. Open the plugin's settings in ChatGPT, "
    + 'then Permissions → Allow all actions, and retry this turn.',
    { status: 403, errorType: "permission_error", code: "chatgpt_tool_approval_required", retryable: false },
  );
}

// Only the compaction owner may signal this after the broker accepts its one-shot handoff.
// It cancels browser observation, while the accepted summary remains the native result.
export class ChatGptCompactionHandoffAccepted extends DOMException {
  constructor() {
    super("Structured compaction handoff accepted", "AbortError");
  }
}

export function chatGptBrowserTabClosedError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    {
      status: 499,
      errorType: "client_closed_request",
      code: "client_cancelled",
      retryable: false,
    },
  );
}

export function chatGptTurnSupersededError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "A newer Codex instruction superseded this ChatGPT response.",
    { status: 499, errorType: "client_closed_request", code: "client_cancelled", retryable: false },
  );
}

export function chatGptStoppedThinkingError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT displayed 'Stopped thinking' and could not continue this response. "
    + "A ChatGPT Web usage limit may have been reached. Check the ChatGPT tab for the exact reason before retrying.",
    {
      status: 502,
      errorType: "server_error",
      code: "chatgpt_stopped_thinking",
      retryable: false,
    },
  );
}

export function chatGptRetainedConversationUnavailableError(): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "The retained ChatGPT conversation is no longer available.",
    {
      status: 409,
      errorType: "invalid_request_error",
      code: "compaction_source_unavailable",
      retryable: false,
    },
  );
}
