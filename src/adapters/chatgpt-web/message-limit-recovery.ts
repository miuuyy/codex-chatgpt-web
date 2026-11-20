import { readFileSync, statSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { BrowserTurn } from "./browser-worker";

export interface ChatGptMessageLimits {
  chars: number;
  tokens: number;
  /** A staged/retained rejection does not establish a maximum for one fresh message. */
  probeInline?: true;
}
type LearnedLimit = { limits: ChatGptMessageLimits; expiresAt: number; retryOnly: boolean };
const TTL_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 128;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_RECOVERIES = 3;

function validLimits(limits: ChatGptMessageLimits): boolean {
  return Number.isSafeInteger(limits.chars) && limits.chars >= 4_096
    && Number.isSafeInteger(limits.tokens) && limits.tokens >= 2_048;
}

/** One bounded cache per runtime profile. Only transport limits and expiry are persisted. */
export class ChatGptMessageLimitStore {
  private static readonly profiles = new Map<string, ChatGptMessageLimitStore>();

  static forProfile(path?: string): ChatGptMessageLimitStore {
    if (!path) return new ChatGptMessageLimitStore();
    const cached = this.profiles.get(path);
    if (cached) return cached;
    const store = new ChatGptMessageLimitStore(path);
    this.profiles.set(path, store);
    return store;
  }

  private readonly learned = new Map<string, LearnedLimit>();

  constructor(private readonly path?: string, private readonly now: () => number = Date.now) {
    if (!path) return;
    try {
      if (statSync(path).size > MAX_STATE_BYTES) return;
      const state = JSON.parse(readFileSync(path, "utf8"));
      if (![1, 2].includes(state?.version) || !Array.isArray(state.entries) || state.entries.length > MAX_ENTRIES) return;
      for (const entry of state.entries) {
        if (typeof entry?.key !== "string" || entry.key.length > 256 || !entry.limits
          || !validLimits(entry.limits) || !Number.isSafeInteger(entry.expiresAt)
          || entry.expiresAt <= this.now() || entry.expiresAt > this.now() + TTL_MS
          || (state.version === 2 && entry.retryOnly !== undefined && typeof entry.retryOnly !== "boolean")) continue;
        const { chars, tokens } = entry.limits;
        this.learned.set(entry.key, { limits: { chars, tokens }, expiresAt: entry.expiresAt,
          retryOnly: state.version === 1 || entry.retryOnly === true });
      }
    } catch { /* A missing or damaged cache is safe to relearn. */ }
  }

  get(key: string): ChatGptMessageLimits | undefined {
    const entry = this.learned.get(key);
    if (entry && entry.expiresAt > this.now()) return { ...entry.limits, ...(entry.retryOnly ? { probeInline: true as const } : {}) };
    this.learned.delete(key);
    return undefined;
  }

  learn(key: string, rejected: ChatGptMessageLimits, retryOnly = false): ChatGptMessageLimits | undefined {
    if (!validLimits(rejected)) return undefined;
    const stored = this.get(key);
    // Fresh-message evidence supersedes old guesses made from a partially staged context.
    const previous = stored?.probeInline ? undefined : stored;
    const limits = {
      chars: Math.floor(Math.min(previous?.chars ?? Infinity, rejected.chars) * 0.65),
      tokens: Math.floor(Math.min(previous?.tokens ?? Infinity, rejected.tokens) * 0.65),
    };
    if (!validLimits(limits)) return undefined;
    // A later context rejection cannot permanently narrow an established message limit.
    if (retryOnly && previous) return limits;
    const now = this.now();
    for (const [entryKey, entry] of this.learned) if (entry.expiresAt <= now) this.learned.delete(entryKey);
    this.learned.delete(key);
    if (this.learned.size >= MAX_ENTRIES) this.learned.delete(this.learned.keys().next().value!);
    this.learned.set(key, { limits, expiresAt: now + TTL_MS, retryOnly });
    this.persist();
    return { ...limits, ...(retryOnly ? { probeInline: true as const } : {}) };
  }

  forget(key: string): void {
    if (this.learned.delete(key)) this.persist();
  }

  private persist(): void {
    if (this.path) {
      try {
        const entries = [...this.learned].map(([key, entry]) => ({ key, ...entry }));
        atomicWriteFile(this.path, JSON.stringify({ version: 2, entries }), { durable: true });
      } catch { console.warn("[chatgpt-web] could not persist learned message limits"); }
    }
  }
}

/** A server-rejected submission can be rebuilt only before any answer or tool work escapes. */
export async function runWithMessageLimitRecovery(
  turn: BrowserTurn,
  run: (turn: BrowserTurn) => Promise<string>,
  key: string | (() => string | undefined),
  recompile: (limits: ChatGptMessageLimits) => void,
  store: ChatGptMessageLimitStore,
): Promise<string> {
  let outputObserved = false;
  let current = turn;
  // Unknown accounts may recover this operation, but never reuse or persist another account's limits.
  const transientStore = new ChatGptMessageLimitStore();
  const scope = () => {
    const resolved = typeof key === "function" ? key() : key;
    return { key: resolved ?? "unidentified", store: resolved ? store : transientStore };
  };
  const observe = (text: string) => { if (text.trim()) outputObserved = true; };
  for (let attempt = 0; ; attempt++) {
    const attemptTurn = current;
    let prepared = false, multipart = false, reused = false;
    const prepare = (fn: BrowserTurn["prepare"], resume = false): BrowserTurn["prepare"] => async transactionId => {
      const prompt = await fn(transactionId);
      prepared = true; multipart = prompt.multipart !== undefined; reused ||= resume;
      return prompt;
    };
    try {
      const result = await run({
        ...attemptTurn,
        prepare: prepare(attemptTurn.prepare),
        ...(attemptTurn.prepareResume ? { prepareResume: prepare(attemptTurn.prepareResume, true) } : {}),
        onPreparedSelected: async (...args) => { reused ||= args[0]; await attemptTurn.onPreparedSelected?.(...args); },
        onTextDelta: text => { observe(text); turn.onTextDelta(text); },
        onCommentary: (text, continuation) => { observe(text); turn.onCommentary?.(text, continuation); },
        onReasoningSummary: (text, continuation) => turn.onReasoningSummary?.(text, continuation),
      });
      const scoped = scope();
      if (prepared && !multipart && !reused && scoped.store.get(scoped.key)?.probeInline) scoped.store.forget(scoped.key);
      return result;
    } catch (error) {
      const progress = turn.externalProgress?.snapshot();
      if (!(error instanceof ChatGptWebAdapterError) || !error.inputRejected || !error.rejectedMessageSize
        || attempt >= MAX_RECOVERIES || outputObserved || turn.abortSignal?.aborted
        || (progress && (progress.lastToolBatchRevision > 0 || progress.activeToolCalls > 0))) throw error;
      const scoped = scope();
      const limits = scoped.store.learn(scoped.key, error.rejectedMessageSize, prepared && (multipart || reused));
      if (!limits) throw error;
      recompile(limits);
      console.info(`[chatgpt-web] message_limit_recovery ${JSON.stringify({ attempt: attempt + 1, ...limits })}`);
      // The failed worker has released its physical lease. Rebuild complete canonical history in
      // the next physical transaction; an abbreviated retained-chat suffix is insufficient here.
      current = { ...turn, traceId: `${turn.traceId}_size${attempt + 1}`,
        prepareResume: undefined, retainConversation: false, requireRetainedConversation: false,
        conversationKey: undefined };
    }
  }
}
