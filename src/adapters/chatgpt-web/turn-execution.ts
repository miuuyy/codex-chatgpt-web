import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";
import { extractChatGptTurnIdentity } from "./environment";

export type ChatGptBrowserOutcome =
  | { type: "final"; answer: string }
  | { type: "error"; error: Error };

export const CHATGPT_TURN_RECONNECT_GRACE_MS = 5_000;

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
  private queued: ChatGptTraceEvent[] = [];
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

  restore(events: ChatGptTraceEvent[]): void {
    if (events.length > 0) this.queued = [...events, ...this.queued];
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
  private queued: string[] = [];
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

  restore(deltas: string[]): void {
    if (deltas.length > 0) this.queued = [...deltas, ...this.queued];
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
  cancel: () => void;
}

export type ChatGptTurnRuntime =
  | (ChatGptTurnRuntimeBase & { mode: "tools"; token: Promise<string> })
  | (ChatGptTurnRuntimeBase & { mode: "read-only" });

export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const payload = {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
  };
  return createHash("sha256").update(JSON.stringify({
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    payload,
  })).digest("hex");
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

  constructor(readonly runtime: ChatGptTurnRuntime) {
    this.browserOutcome = runtime.browser
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
        this.settledBrowserOutcome = outcome;
        this.touch();
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

  cancel(): void {
    this.runtime.cancel();
  }
}

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();
  private readonly detachTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxSettledEntries = 256,
    private readonly reconnectGraceMs = CHATGPT_TURN_RECONNECT_GRACE_MS,
  ) {}

  getOrCreate(key: string, start: () => ChatGptTurnRuntime): ChatGptTurnSession {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      this.clearDetachTimer(key);
      if (existing.settledOutcome()?.type === "error") {
        this.remove(key, existing);
        return this.getOrCreate(key, start);
      }
      existing.touch();
      return existing;
    }
    const session = new ChatGptTurnSession(start());
    this.entries.set(key, session);
    void session.browserOutcome.then(outcome => {
      if (outcome.type === "error" && this.entries.get(key) === session) this.remove(key, session);
    });
    return session;
  }

  detach(key: string, session: ChatGptTurnSession): void {
    if (this.entries.get(key) !== session) return;
    this.clearDetachTimer(key);
    session.touch();
    const timer = setTimeout(() => {
      this.detachTimers.delete(key);
      if (this.entries.get(key) !== session) return;
      if (session.settledOutcome()?.type === "final") return;
      this.remove(key, session);
    }, this.reconnectGraceMs);
    (timer as { unref?: () => void }).unref?.();
    this.detachTimers.set(key, timer);
  }

  clear(): number {
    const cancelled = this.entries.size;
    for (const timer of this.detachTimers.values()) clearTimeout(timer);
    this.detachTimers.clear();
    for (const session of this.entries.values()) session.cancel();
    this.entries.clear();
    return cancelled;
  }

  evict(key: string): boolean {
    const session = this.entries.get(key);
    if (!session) return false;
    this.remove(key, session);
    return true;
  }

  activeCount(): number {
    this.prune();
    let active = 0;
    for (const session of this.entries.values()) if (session.isActive()) active += 1;
    return active;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    const settled: Array<[string, ChatGptTurnSession]> = [];
    for (const [key, session] of this.entries) {
      if (session.isActive()) continue;
      if (session.lastUsedAt() < cutoff) {
        this.remove(key, session);
        continue;
      }
      settled.push([key, session]);
    }
    settled.sort((left, right) => left[1].lastUsedAt() - right[1].lastUsedAt());
    for (const [key, session] of settled.slice(0, Math.max(0, settled.length - this.maxSettledEntries))) {
      this.remove(key, session);
    }
  }

  private clearDetachTimer(key: string): void {
    const timer = this.detachTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.detachTimers.delete(key);
  }

  private remove(key: string, session: ChatGptTurnSession): void {
    if (this.entries.get(key) !== session) return;
    this.clearDetachTimer(key);
    session.cancel();
    this.entries.delete(key);
  }
}

export const chatGptTurnSessions = new ChatGptTurnSessions();
