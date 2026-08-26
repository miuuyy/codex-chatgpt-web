import { ChatGptWebAdapterError } from "./adapter-error";
import type { ChatGptTurnSession } from "./turn-execution";

function terminalError(error: unknown, phase: "send_activated" | "accepted"): ChatGptWebAdapterError {
  const ambiguous = phase === "send_activated";
  return new ChatGptWebAdapterError(
    ambiguous
      ? `ChatGPT Send was activated, but acceptance could not be proven; the prompt will not be resent: ${error instanceof Error ? error.message : String(error)}`
      : `ChatGPT failed after accepting the Web prompt; the prompt will not be resent: ${error instanceof Error ? error.message : String(error)}`,
    {
      status: 502,
      errorType: "server_error",
      code: ambiguous ? "chatgpt_submission_ambiguous" : "chatgpt_submitted_turn_failed",
      retryable: false,
    },
  );
}

export function submittedBrowserFailure(
  session: ChatGptTurnSession,
  error: unknown,
): ChatGptWebAdapterError | undefined {
  const phase = session.runtime.submission?.phase;
  if (!phase || phase === "prepared") return undefined;
  const terminal = terminalError(error, phase);
  session.setTerminalError(terminal);
  return terminal;
}
