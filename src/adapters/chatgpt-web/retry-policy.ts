import { ChatGptWebAdapterError } from "./adapter-error";

/** Maximum number of automatic browser-turn retries after the initial send. */
export const MAX_CHATGPT_WEB_TURN_RETRIES = 3;
export const CHATGPT_WEB_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const RETRY_BUDGET_TTL_MS = 30 * 60_000;

interface RetryBudgetEntry {
  retries: number;
  updatedAt: number;
  lastError: {
    message: string;
    status: number;
    errorType: string;
    code: string;
  };
}

interface RateLimitCooldownEntry {
  until: number;
  lastError: RetryBudgetEntry["lastError"];
}

function rateLimitCooldownError(entry: RateLimitCooldownEntry, now: number): ChatGptWebAdapterError {
  const remainingSeconds = Math.max(1, Math.ceil((entry.until - now) / 1_000));
  return new ChatGptWebAdapterError(
    `${entry.lastError.message} ChatGPT cooldown detected; browser retry suppressed. ChatGPT browser-wide cooldown is active; refusing to open another browser turn for ${remainingSeconds}s so new turns cannot extend the cooldown.`,
    {
      status: entry.lastError.status,
      errorType: entry.lastError.errorType,
      code: entry.lastError.code,
      retryable: false,
    },
  );
}

function exhaustedError(entry: RetryBudgetEntry): ChatGptWebAdapterError {
  const retryMessage = entry.lastError.code === "rate_limit_exceeded"
    ? "ChatGPT cooldown detected; browser retry suppressed so reconnects cannot extend the cooldown."
    : `Automatic browser-turn retry limit reached after ${MAX_CHATGPT_WEB_TURN_RETRIES} retries; refusing to send another message.`;
  return new ChatGptWebAdapterError(
    `${entry.lastError.message} ${retryMessage}`,
    {
      status: entry.lastError.status,
      errorType: entry.lastError.errorType,
      code: entry.lastError.code,
      retryable: false,
    },
  );
}

/**
 * Tracks only retryable ChatGPT browser failures across adapter instances. The HTTP bridge creates
 * one adapter per request, so this process-local budget must live outside createChatGptWebAdapter.
 */
export class ChatGptWebTurnRetryPolicy {
  private readonly entries = new Map<string, RetryBudgetEntry>();
  private readonly cooldowns = new Map<string, RateLimitCooldownEntry>();

  constructor(
    private readonly ttlMs = RETRY_BUDGET_TTL_MS,
    private readonly rateLimitCooldownMs = CHATGPT_WEB_RATE_LIMIT_COOLDOWN_MS,
  ) {}

  recordRetryableFailure(key: string, error: ChatGptWebAdapterError, now = Date.now()): ChatGptWebAdapterError {
    this.prune(now);
    const previous = this.entries.get(key);
    const suppressBrowserRetry = error.code === "rate_limit_exceeded" || error.status === 429;
    const entry: RetryBudgetEntry = {
      retries: suppressBrowserRetry
        ? MAX_CHATGPT_WEB_TURN_RETRIES + 1
        : (previous?.retries ?? 0) + 1,
      updatedAt: now,
      lastError: {
        message: error.message,
        status: error.status,
        errorType: error.errorType,
        code: error.code,
      },
    };
    this.entries.set(key, entry);
    return entry.retries > MAX_CHATGPT_WEB_TURN_RETRIES ? exhaustedError(entry) : error;
  }

  recordRateLimit(scope: string, key: string, error: ChatGptWebAdapterError, now = Date.now()): ChatGptWebAdapterError {
    this.recordRetryableFailure(key, error, now);
    const entry: RateLimitCooldownEntry = {
      until: now + this.rateLimitCooldownMs,
      lastError: {
        message: error.message,
        status: error.status,
        errorType: error.errorType,
        code: error.code,
      },
    };
    this.cooldowns.set(scope, entry);
    return rateLimitCooldownError(entry, now);
  }

  cooldownError(scope: string, now = Date.now()): ChatGptWebAdapterError | undefined {
    this.prune(now);
    const entry = this.cooldowns.get(scope);
    if (!entry || entry.until <= now) return undefined;
    return rateLimitCooldownError(entry, now);
  }

  exhaustedError(key: string, now = Date.now()): ChatGptWebAdapterError | undefined {
    this.prune(now);
    const entry = this.entries.get(key);
    return entry && entry.retries > MAX_CHATGPT_WEB_TURN_RETRIES ? exhaustedError(entry) : undefined;
  }

  clear(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt >= this.ttlMs) this.entries.delete(key);
    }
    for (const [scope, entry] of this.cooldowns) {
      if (entry.until <= now) this.cooldowns.delete(scope);
    }
  }
}

export const chatGptWebTurnRetryPolicy = new ChatGptWebTurnRetryPolicy();
