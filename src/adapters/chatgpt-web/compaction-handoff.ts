import { parseDataUrl } from "../image";
import type {
  CodexContentPart,
  CodexParsedRequest,
  CodexToolResultMessage,
} from "../../types";
import { extractChatGptCompactionSourceRevision } from "./environment";
import type { ChatGptBrowserWorker } from "./browser-worker";
import type { CompactionTransactionHandle } from "./compaction-transaction";
import type { ChatGptWebCapabilities } from "./model";
import {
  activeCompactionToolResultInstruction,
  structuredCompactionHandoffInstruction,
  zeroRiskActiveCompactionToolResultInstruction,
} from "./native-compaction-control";
import type { BrokerToolResult, TurnBroker, TurnBrokerOwner } from "./turn-broker";
import type { ChatGptTurnSession } from "./turn-execution";

export const LATEST_USER_PROMPT_MARKER = "CODEX_LATEST_USER_PROMPT_JSON";

function brokerContent(content: string | CodexContentPart[]): unknown[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map(part => {
    if (part.type === "text") return { type: "text", text: part.text };
    const parsed = parseDataUrl(part.imageUrl);
    if (parsed) return { type: "image", data: parsed.base64, mimeType: parsed.mediaType };
    return { type: "resource_link", uri: part.imageUrl, name: "Codex tool image", mimeType: "image/*" };
  });
}

function structuredContent(text: string): unknown | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toolResult(message: CodexToolResultMessage): BrokerToolResult {
  const content = brokerContent(message.content);
  const text = typeof message.content === "string"
    ? message.content
    : message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  const structured = structuredContent(text);
  return {
    content,
    ...(structured !== undefined ? { structuredContent: structured } : {}),
    ...(message.isError ? { isError: true } : {}),
  };
}

function interruptedByActiveCompaction(): BrokerToolResult {
  return {
    content: [{ type: "text", text: activeCompactionToolResultInstruction() }],
    isError: true,
  };
}

function withZeroRiskCompactionInstruction(result: BrokerToolResult): BrokerToolResult {
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: zeroRiskActiveCompactionToolResultInstruction(true),
      },
    ],
  };
}

function interruptedByZeroRiskCompaction(): BrokerToolResult {
  return {
    content: [{
      type: "text",
      text: zeroRiskActiveCompactionToolResultInstruction(false),
    }],
    isError: true,
  };
}

function userPromptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap(part => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const value = part as { type?: unknown; text?: unknown };
    return (value.type === "input_text" || value.type === "text") && typeof value.text === "string"
      ? [value.text]
      : [];
  }).join("\n");
  return text || undefined;
}

export function canonicalizeCompactionHandoff(
  parsed: CodexParsedRequest,
  summary: string,
): string {
  const normalized = summary.trim();
  if (!normalized) throw new Error("ChatGPT returned an empty structured compaction handoff");
  const latestUserPrompt = userPromptText(extractChatGptCompactionSourceRevision(parsed).content);
  if (latestUserPrompt === undefined) {
    throw new Error("ChatGPT compaction source has no canonical latest user prompt");
  }
  const appendix = `${LATEST_USER_PROMPT_MARKER}\n${JSON.stringify(latestUserPrompt)}`;
  const markerOffset = normalized.lastIndexOf(`\n${LATEST_USER_PROMPT_MARKER}\n`);
  if (markerOffset < 0) return `${normalized}\n\n${appendix}`;
  if (normalized.slice(markerOffset + 1).trimEnd() !== appendix) {
    throw new Error("ChatGPT compaction handoff contains a conflicting latest-user marker");
  }
  return normalized;
}

function currentToolResults(
  parsed: CodexParsedRequest,
  session: ChatGptTurnSession,
): Map<string, CodexToolResultMessage> {
  const results = new Map<string, CodexToolResultMessage>();
  for (const message of parsed.context.messages) {
    if (message.role !== "toolResult" || !session.hasOutstanding(message.toolCallId)) continue;
    if (results.has(message.toolCallId)) {
      throw new Error(`Codex returned duplicate results for tool call ${message.toolCallId}`);
    }
    results.set(message.toolCallId, message);
  }
  return results;
}

export const DEFAULT_COMPACTION_HANDOFF_TIMEOUT_MS = 5 * 60_000;
export const MAX_COMPACTION_HANDOFF_TIMEOUT_MS = 50 * 60_000;

export function resolveCompactionHandoffTimeoutMs(
  proCompaction: boolean,
  configuredTimeoutMs?: number,
): number {
  const modelTimeoutMs = proCompaction
    ? MAX_COMPACTION_HANDOFF_TIMEOUT_MS
    : DEFAULT_COMPACTION_HANDOFF_TIMEOUT_MS;
  return Math.min(configuredTimeoutMs ?? modelTimeoutMs, modelTimeoutMs);
}

function boundedCompactionTimeout(timeoutMs: number): number {
  return Math.min(timeoutMs, MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("ChatGPT compaction handoff aborted", "AbortError");
}

function withCompactionAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function settleActiveCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  signal?: AbortSignal,
): Promise<{ answer: string; compactionInstructionDelivered: boolean }> {
  return source.runExclusive(async () => {
    if (signal?.aborted) {
      source.cancel(abortReason(signal));
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools") {
      throw new Error("The active ChatGPT compaction source has no MCP tool boundary");
    }
    const outstanding = source.outstanding();
    const results = currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(
        `Codex supplied ${results.size} of ${outstanding.length} required tool results for compaction`,
      );
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      broker.requestCompaction(token, interruptedByActiveCompaction());
      for (const request of outstanding) {
        const result = results.get(request.callId)!;
        await broker.completeTool(
          token,
          request.callId,
          toolResult(result),
        );
        source.runtime.externalProgress.recordToolResult();
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await withCompactionAbort(source.browserOutcome, signal);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      const compactionInstructionDelivered = broker.compactionDeliveryCount(token) > 0;
      // The one structured checkpoint message reuses this exact retained tab. It must not race the
      // helper's /turn/end handshake for the response that consumed the canonical tool results.
      // `requestCompaction` leaves those results untouched and only intercepts a later tool call, so
      // a zero delivery count proves that this is an ordinary publishable terminal response.
      await withCompactionAbort(source.physicalSettlement, signal);
      return {
        answer: browserOutcome.answer,
        compactionInstructionDelivered,
      };
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token) await broker.revoke(token);
    }
  });
}

export async function settleActiveZeroRiskCompactionSource(
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBrokerOwner,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return source.runExclusive(async () => {
    if (signal?.aborted) {
      source.cancel(abortReason(signal));
      throw abortReason(signal);
    }
    if (!source.isActive() || source.runtime.mode !== "tools" || !source.runtime.manualControl) {
      throw new Error("The active Zero Risk compaction source has no manual MCP tool boundary");
    }
    const outstanding = source.outstanding();
    const results = currentToolResults(parsed, source);
    if (results.size !== outstanding.length) {
      throw new Error(
        `Codex supplied ${results.size} of ${outstanding.length} required tool results for Zero Risk compaction`,
      );
    }
    let token: string | undefined;
    try {
      token = await source.runtime.token;
      const interruptedQueued = await broker.requestCompaction(
        token,
        interruptedByZeroRiskCompaction(),
      );
      for (const [index, request] of outstanding.entries()) {
        const result = results.get(request.callId)!;
        const canonical = toolResult(result);
        await broker.completeTool(
          token,
          request.callId,
          interruptedQueued === 0 && index === outstanding.length - 1
            ? withZeroRiskCompactionInstruction(canonical)
            : canonical,
        );
        source.runtime.externalProgress.recordToolResult();
        source.markResultDelivered(request.callId);
      }
      const browserOutcome = await withCompactionAbort(source.browserOutcome, signal);
      if (browserOutcome.type === "error") throw browserOutcome.error;
      await withCompactionAbort(source.physicalSettlement, signal);
      const instructionDelivered = outstanding.length > 0
        || await broker.compactionDeliveryCount(token) > 0;
      if (!instructionDelivered) return undefined;
      const summary = browserOutcome.answer.trim();
      if (!summary) throw new Error("The active Zero Risk response returned an empty compaction summary");
      return summary;
    } catch (error) {
      if (signal?.aborted) source.cancel(abortReason(signal));
      throw error;
    } finally {
      if (token) await broker.revoke(token);
    }
  });
}

export async function requestRetainedCompactionHandoff(
  worker: ChatGptBrowserWorker,
  parsed: CodexParsedRequest,
  source: ChatGptTurnSession,
  broker: TurnBroker,
  capabilities: ChatGptWebCapabilities,
  traceId: string,
  signal?: AbortSignal,
  timeoutMs = MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
): Promise<string> {
  const conversationKey = source.conversationKey();
  if (!conversationKey) throw new Error("The completed ChatGPT source has no retained conversation identity");
  const operationTimeoutMs = boundedCompactionTimeout(timeoutMs);
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new Error(`ChatGPT compaction handoff timed out after ${operationTimeoutMs}ms`)),
    operationTimeoutMs,
  );
  deadlineTimer.unref?.();
  const operationSignal = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  const browserAbort = new AbortController();
  const abortBrowser = () => browserAbort.abort(operationSignal.reason);
  let transaction: CompactionTransactionHandle | undefined;
  let browser: Promise<string> | undefined;
  if (operationSignal.aborted) abortBrowser();
  else operationSignal.addEventListener("abort", abortBrowser, { once: true });
  try {
    const transactionPromise = broker.beginCompactionTransaction(traceId, operationTimeoutMs);
    void transactionPromise.then(lateTransaction => {
      if (operationSignal.aborted && transaction !== lateTransaction) {
        broker.abortCompactionTransaction(lateTransaction.token);
      }
    }, () => {});
    transaction = await withCompactionAbort(transactionPromise, operationSignal);
    const instruction = structuredCompactionHandoffInstruction(transaction);
    const prepare = async () => ({ text: instruction, images: [], release: () => {} });
    browser = worker.run({
      traceId,
      modelId: parsed.modelId,
      reasoning: parsed.options.reasoning,
      // The retained connector exposes only the one-shot control token embedded above. It does
      // not receive an ordinary Codex tool environment for this checkpoint message.
      capabilities: { ...capabilities, localToolsEnabled: false },
      nativeConnector: true,
      prepare,
      prepareResume: prepare,
      conversationKey,
      requireRetainedConversation: true,
      abortSignal: browserAbort.signal,
      onTextDelta: () => {},
    });
    const browserFailure = browser.then<never>(
      () => new Promise<never>(() => {}),
      error => { throw error; },
    );
    const summary = await withCompactionAbort(
      Promise.race([
        broker.waitForCompactionHandoff(transaction.token, operationSignal),
        browserFailure,
      ]),
      operationSignal,
    );
    // The one-shot control submission is the terminal event for this purpose-built response.
    // ChatGPT may render no assistant text after a tool-only response, and therefore no Copy
    // action. End our owned turn explicitly and wait for the launcher/helper cleanup handshake.
    browserAbort.abort(new DOMException("Structured compaction handoff accepted", "AbortError"));
    await withCompactionAbort(
      browser.then(() => undefined, () => undefined),
      operationSignal,
    );
    return summary;
  } finally {
    browserAbort.abort();
    if (transaction) broker.abortCompactionTransaction(transaction.token);
    if (browser) {
      // Logical cancellation is not physical retirement. The retained-session owner tracks
      // physical settlement separately, so this helper must not turn its own deadline into an
      // unbounded wait when the worker does not acknowledge abort immediately.
      await withCompactionAbort(
        browser.then(() => undefined, () => undefined),
        operationSignal,
      ).catch(() => {});
    }
    operationSignal.removeEventListener("abort", abortBrowser);
    clearTimeout(deadlineTimer);
  }
}

interface CachedCompactionRun {
  createdAt: number;
  ownerKey: string;
  traceIds: ReadonlySet<string>;
  abort: AbortController;
  active: boolean;
  promise: Promise<string>;
}

export interface StructuredCompactionOwner {
  ownerKey: string;
  /** Every externally addressable browser trace owned by this structured compaction. */
  traceIds: readonly string[];
}

const structuredCompactionRuns = new Map<string, CachedCompactionRun>();
const structuredCompactionOwners = new Map<string, Promise<void>>();
const STRUCTURED_COMPACTION_RUN_TTL_MS = 30 * 60_000;

function pruneStructuredCompactionRuns(): void {
  const cutoff = Date.now() - STRUCTURED_COMPACTION_RUN_TTL_MS;
  for (const [candidate, run] of structuredCompactionRuns) {
    if (run.createdAt < cutoff) structuredCompactionRuns.delete(candidate);
  }
}

/** Return the canonical result of an exact compact request, even after its source was retired. */
export function existingStructuredCompactionRun(key: string): Promise<string> | undefined {
  pruneStructuredCompactionRuns();
  return structuredCompactionRuns.get(key)?.promise;
}

export function runStructuredCompactionOnce(
  key: string,
  owner: StructuredCompactionOwner,
  start: (operatorSignal: AbortSignal) => Promise<string>,
): Promise<string> {
  pruneStructuredCompactionRuns();
  const existing = structuredCompactionRuns.get(key);
  if (existing) return existing.promise;
  const abort = new AbortController();
  const previousOwner = structuredCompactionOwners.get(owner.ownerKey);
  const promise = Promise.resolve().then(async () => {
    if (previousOwner) await withCompactionAbort(previousOwner, abort.signal);
    if (abort.signal.aborted) throw abortReason(abort.signal);
    return start(abort.signal);
  });
  const run: CachedCompactionRun = {
    createdAt: Date.now(),
    ownerKey: owner.ownerKey,
    traceIds: new Set(owner.traceIds),
    abort,
    active: true,
    promise,
  };
  structuredCompactionRuns.set(key, run);
  const ownerSettlement = promise.then(() => undefined, () => undefined);
  structuredCompactionOwners.set(owner.ownerKey, ownerSettlement);
  void ownerSettlement.then(() => {
    run.active = false;
    if (structuredCompactionOwners.get(owner.ownerKey) === ownerSettlement) {
      structuredCompactionOwners.delete(owner.ownerKey);
    }
  });
  void promise.catch(() => {
    if (structuredCompactionRuns.get(key)?.promise === promise) {
      structuredCompactionRuns.delete(key);
    }
  });
  return promise;
}

async function cancelStructuredCompactionRuns(
  matches: (run: CachedCompactionRun) => boolean,
  reason: Error,
): Promise<number> {
  const runs = [...structuredCompactionRuns.values()].filter(run => run.active && matches(run));
  for (const run of runs) {
    if (!run.abort.signal.aborted) run.abort.abort(reason);
  }
  await Promise.allSettled(runs.map(run => run.promise));
  return runs.length;
}

/** Cancel a user-requested compaction without treating an HTTP observer disconnect as terminal. */
export function cancelStructuredCompactionTrace(traceId: string, reason: Error): Promise<number> {
  return cancelStructuredCompactionRuns(run => run.traceIds.has(traceId), reason);
}

/** Cancel every active compaction owner and wait for its browser/helper cleanup. */
export function cancelAllStructuredCompactions(reason: Error): Promise<number> {
  return cancelStructuredCompactionRuns(() => true, reason);
}
