import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";
import { chatGptBrowserTabClosedError } from "./adapter-error";
import {
  extractChatGptCompactionSourceRevision,
  extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision,
} from "./environment";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";

export type ChatGptBrowserOutcome =
  | { type: "final"; answer: string }
  | { type: "error"; error: Error };

export interface ChatGptTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface TraceWaiter {
  resolve: (event: ChatGptTraceEvent) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ChatGptTraceFeed {
  private readonly queued: ChatGptTraceEvent[] = [];
  private readonly waiters = new Set<TraceWaiter>();

  push(event: ChatGptTraceEvent): void {
    const normalized = event.continuation ? event.text : event.text.trim();
    if (!normalized) return;
    const normalizedEvent = { ...event, text: normalized };
    const waiter = this.waiters.values().next().value as TraceWaiter | undefined;
    if (!waiter) {
      this.queued.push(normalizedEvent);
      return;
    }
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(normalizedEvent);
  }

  drain(): ChatGptTraceEvent[] {
    return this.queued.splice(0);
  }

  next(signal?: AbortSignal): Promise<ChatGptTraceEvent> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (signal?.aborted) return Promise.reject(new DOMException("trace wait aborted", "AbortError"));
    return new Promise<ChatGptTraceEvent>((resolveWait, rejectWait) => {
      const waiter: TraceWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("trace wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface TextWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Append-only browser Markdown feed. Waiters are notifications; `drain` owns consumption. */
export class ChatGptTextFeed {
  private readonly queued: string[] = [];
  private readonly waiters = new Set<TextWaiter>();
  private text = "";

  push(delta: string): void {
    if (!delta) return;
    this.text += delta;
    this.queued.push(delta);
    const waiter = this.waiters.values().next().value as TextWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): string[] {
    return this.queued.splice(0);
  }

  value(): string {
    return this.text;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("text wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TextWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("text wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface ChatGptTurnRuntimeBase {
  browser: Promise<string>;
  trace: ChatGptTraceFeed;
  text: ChatGptTextFeed;
  cancel: (reason?: Error) => void;
}

export type ChatGptTurnRuntime =
  | (ChatGptTurnRuntimeBase & { mode: "tools"; token: Promise<string> })
  | (ChatGptTurnRuntimeBase & { mode: "read-only" });

function executionKey(parsed: CodexParsedRequest, payload: unknown): string {
  return createHash("sha256").update(JSON.stringify({
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    payload,
  })).digest("hex");
}

function compactionInputRevision(parsed: CodexParsedRequest): unknown[] {
  const body = parsed._rawBody;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex request body");
  }
  const input = (body as { input?: unknown }).input;
  if (!Array.isArray(input)) {
    throw new Error("ChatGPT web compaction requires the complete native Codex input history");
  }
  return input;
}

export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
    revision: parsed._compactionRequest
      ? compactionInputRevision(parsed)
      : extractChatGptTurnUserRevision(parsed),
  });
}

/** Stable identity for limiting automatic retries of one native Codex turn. */
export function chatGptTurnRetryKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-turn retry budgeting");
  return createHash("sha256").update(JSON.stringify({
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
  })).digest("hex");
}

/** Locate the browser response that a native mid-turn compaction replaces. */
export function chatGptCompactionSourceExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const source = extractChatGptCompactionSourceRevision(parsed);
  return executionKey(parsed, {
    threadId: identity.threadId,
    turnId: source.turnId ?? identity.turnId,
    purpose: "response",
    revision: source.content,
  });
}

export class ChatGptTurnSession {
  readonly createdAt = Date.now();
  private lastTouchedAt = this.createdAt;
  readonly browserOutcome: Promise<ChatGptBrowserOutcome>;
  private readonly outstandingById = new Map<string, BrokerToolRequest>();
  private readonly deliveredResultIds = new Set<string>();
  private outstandingReasoning: string[] = [];
  private finalReasoning: string[] = [];
  private outstandingPrelude: AdapterEvent[] = [];
  private finalPrelude: AdapterEvent[] = [];
  private settledBrowserOutcome?: ChatGptBrowserOutcome;
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly runtime: ChatGptTurnRuntime, readonly traceId?: string) {
    this.browserOutcome = runtime.browser
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
      this.settledBrowserOutcome = outcome;
      return outcome;
    });
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.touch();
    const run = this.tail.then(task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  touch(): void {
    this.lastTouchedAt = Date.now();
  }

  lastUsedAt(): number {
    return this.lastTouchedAt;
  }

  outstanding(): BrokerToolRequest[] {
    return [...this.outstandingById.values()];
  }

  settledOutcome(): ChatGptBrowserOutcome | undefined {
    return this.settledBrowserOutcome;
  }

  isActive(): boolean {
    return this.settledBrowserOutcome === undefined;
  }

  setOutstanding(requests: BrokerToolRequest[], reasoning: string[] = [], prelude: AdapterEvent[] = []): void {
    if (this.outstandingById.size > 0) throw new Error("cannot emit a new ChatGPT tool batch while the previous batch is unresolved");
    for (const request of requests) {
      if (this.deliveredResultIds.has(request.callId) || this.outstandingById.has(request.callId)) {
        throw new Error(`duplicate ChatGPT bridge tool call id: ${request.callId}`);
      }
      this.outstandingById.set(request.callId, request);
    }
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.deliveredResultIds.add(callId);
    if (this.outstandingById.size === 0) {
      this.outstandingReasoning = [];
      this.outstandingPrelude = [];
    }
  }

  reasoningForOutstandingReplay(): string[] {
    return [...this.outstandingReasoning];
  }

  eventsForOutstandingReplay(): AdapterEvent[] {
    return [...this.outstandingPrelude];
  }

  setFinalReasoning(reasoning: string[]): void {
    this.finalReasoning = [...reasoning];
  }

  reasoningForFinalReplay(): string[] {
    return [...this.finalReasoning];
  }

  setFinalEvents(events: AdapterEvent[]): void {
    this.finalPrelude = [...events];
  }

  eventsForFinalReplay(): AdapterEvent[] {
    return [...this.finalPrelude];
  }

  cancel(reason?: Error): void {
    this.runtime.cancel(reason);
  }
}

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();
  private readonly retirements = new Map<string, Promise<void>>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
  ) {}

  getOrCreate(key: string, start: () => ChatGptTurnRuntime, traceId?: string): ChatGptTurnSession {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      existing.touch();
      return existing;
    }
    const active = [...this.entries.values()].filter(session => session.isActive()).length;
    if (active >= MAX_CHATGPT_BROWSER_TABS) {
      throw new Error(
        `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; close or finish a browser tab before starting another`,
      );
    }
    if (this.entries.size >= this.maxEntries) throw new Error(`ChatGPT web session registry is full (${this.maxEntries} entries)`);
    const session = new ChatGptTurnSession(start(), traceId);
    this.entries.set(key, session);
    return session;
  }

  async waitForRetirement(key: string): Promise<void> {
    await this.retirements.get(key);
  }

  async retireAndWait(key: string): Promise<boolean> {
    const pending = this.retirements.get(key);
    if (pending) {
      await pending;
      return true;
    }
    const session = this.entries.get(key);
    if (!session) return false;

    this.entries.delete(key);
    session.cancel();
    const retirement = session.browserOutcome.then(() => undefined);
    this.retirements.set(key, retirement);
    try {
      await retirement;
    } finally {
      if (this.retirements.get(key) === retirement) this.retirements.delete(key);
    }
    return true;
  }

  retire(key: string, session: ChatGptTurnSession): boolean {
    if (this.entries.get(key) !== session) return false;
    session.cancel();
    this.entries.delete(key);
    return true;
  }

  clear(): number {
    const cancelled = this.entries.size;
    for (const session of this.entries.values()) session.cancel();
    this.entries.clear();
    return cancelled;
  }

  async cancelTrace(traceId: string, reason = chatGptBrowserTabClosedError()): Promise<number> {
    const sessions = [...this.entries.values()]
      .filter(session => session.traceId === traceId && session.isActive());
    for (const session of sessions) session.cancel(reason);
    await Promise.all(sessions.map(session => session.browserOutcome.then(() => undefined)));
    return sessions.length;
  }

  cancelledError(traceId: string): Error | undefined {
    for (const session of this.entries.values()) {
      if (session.traceId !== traceId) continue;
      const outcome = session.settledOutcome();
      if (outcome?.type !== "error") continue;
      if ("code" in outcome.error && outcome.error.code === "client_cancelled") return outcome.error;
    }
    return undefined;
  }

  activeCount(): number {
    this.prune();
    let active = 0;
    for (const session of this.entries.values()) if (session.isActive()) active += 1;
    return active;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, session] of this.entries) {
      if (session.isActive() || session.lastUsedAt() >= cutoff) continue;
      session.cancel();
      this.entries.delete(key);
    }
  }
}

export const chatGptTurnSessions = new ChatGptTurnSessions();
