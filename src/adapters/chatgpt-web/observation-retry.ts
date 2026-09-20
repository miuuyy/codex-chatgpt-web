import { setTimeout as delay } from "node:timers/promises";

/** Shared budget for CDP reconnects and same-tab DOM rebinds. Recovery must never Send. */
export const MAX_CHATGPT_SURFACE_REBINDS = 3;
/** Pro/Ultra thinking can outlast three CDP drops; keep the same tab without resending. */
export const MAX_CHATGPT_PRO_SURFACE_REBINDS = 6;
export const MAX_OBSERVATION_CONNECTION_RETRIES = MAX_CHATGPT_SURFACE_REBINDS;
export const MAX_CHATGPT_BROWSER_PAGE_REBINDS = MAX_CHATGPT_SURFACE_REBINDS;
export const OBSERVATION_RETRY_BASE_DELAY_MS = 500;
export const OBSERVATION_RETRY_MAX_DELAY_MS = 8_000;

const TRANSIENT_CONNECTION_CODES = /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETDOWN|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/;
const TRANSIENT_CONNECTION_NAMES = new Set([
  "TargetClosedError",
  "ProtocolError",
  "ChatGptBrowserObservationTimeoutError",
]);
const TRANSIENT_CONNECTION_MESSAGE = /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT)\b|websocket.*(?:closed|disconnect)|connection (?:closed|reset)|browser has been closed|execution context was destroyed|cannot find context with specified id|session closed|net::ERR_CONNECTION_RESET|inspector\.targetcrashed/i;

export class ChatGptBrowserObservationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ChatGPT browser DOM observation did not respond within ${timeoutMs}ms`);
    this.name = "ChatGptBrowserObservationTimeoutError";
  }
}

export interface ChatGptSurfaceRebindBudget {
  remaining: number;
  consume(): boolean;
}

export function createChatGptSurfaceRebindBudget(
  max = MAX_CHATGPT_SURFACE_REBINDS,
): ChatGptSurfaceRebindBudget {
  let remaining = max;
  return {
    get remaining() {
      return remaining;
    },
    consume() {
      if (remaining <= 0) return false;
      remaining -= 1;
      return true;
    },
  };
}

/** Full jitter in `[0, min(cap, base * 2^attempt)]` so concurrent tabs do not reconnect in lockstep. */
export function observationRetryDelayMs(attempt: number, random = Math.random): number {
  const ceiling = Math.min(OBSERVATION_RETRY_MAX_DELAY_MS, OBSERVATION_RETRY_BASE_DELAY_MS * 2 ** attempt);
  return Math.min(ceiling, Math.floor(random() * (ceiling + 1)));
}

export function isTransientObservationConnectionError(error: unknown): error is Error {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    // Explicit application policy and cancellation take precedence over nested transport errors.
    if (current.name === "AbortError" || "retryable" in current) return false;
    seen.add(current);
    current = current.cause;
  }
  for (const candidate of seen) {
    if (TRANSIENT_CONNECTION_NAMES.has(candidate.name)) return true;
    const code = "code" in candidate ? candidate.code : undefined;
    if (typeof code === "string" && TRANSIENT_CONNECTION_CODES.test(code)) return true;
    if (TRANSIENT_CONNECTION_MESSAGE.test(candidate.message)) return true;
  }
  return false;
}

/** Only wrap reads: recovery must never resubmit a prompt or replay a tool action. */
export async function retryChatGptObservation<T>(
  observe: () => Promise<T>,
  recover: (attempt: number, error: Error) => Promise<void>,
  signal?: AbortSignal,
  wait: (ms: number, signal?: AbortSignal) => Promise<void> = async (ms, signal) => {
    await delay(ms, undefined, { signal });
  },
  budget?: ChatGptSurfaceRebindBudget,
  random: () => number = Math.random,
): Promise<T> {
  const rebinds = budget ?? createChatGptSurfaceRebindBudget();
  let recoveryError: Error | undefined;
  let attempt = 0;
  for (;;) {
    signal?.throwIfAborted();
    try {
      if (recoveryError) await recover(attempt, recoveryError);
      signal?.throwIfAborted();
      const result = await observe();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (!isTransientObservationConnectionError(error) || !rebinds.consume()) throw error;
      recoveryError = error;
      attempt += 1;
      await wait(observationRetryDelayMs(attempt - 1, random), signal);
    }
  }
}
