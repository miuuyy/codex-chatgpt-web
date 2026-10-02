import { chatGptWebTraceId, createChatGptWebAdapter } from "./adapters/chatgpt-web";
import { closeChatGptBrowserWorkers } from "./adapters/chatgpt-web/browser-worker";
import { closeTurnBrokers, TurnBroker } from "./adapters/chatgpt-web/turn-broker";
import { timingSafeEqual } from "node:crypto";
import { chatGptTurnSessions } from "./adapters/chatgpt-web/turn-execution";
import {
  cancelAllStructuredCompactions,
  cancelStructuredCompactionNativeTurn,
  beginCancelStructuredCompactionTrace,
} from "./adapters/chatgpt-web/compaction-handoff";
import { ChatGptWebAdapterError, chatGptBrowserTabClosedError } from "./adapters/chatgpt-web/adapter-error";
import {
  CHATGPT_TURN_REVISION_CONFLICT_MESSAGE,
  extractChatGptTurnIdentity,
  extractCodexTurnIdentityFromBody,
  extractChatGptCompactionSourceRevision,
  isChatGptCompactionContinuation,
} from "./adapters/chatgpt-web/environment";
import { rememberCompactionContinuation } from "./adapters/chatgpt-web/compaction-continuation";
import { admitNativeCompactionContinuation } from "./adapters/chatgpt-web/native-compaction-admission";
import { authenticateNativeFailedTurnRetry } from "./adapters/chatgpt-web/native-turn-retry";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "./bridge";
import type { AppConfig } from "./config";
import { providerConfig } from "./config";
import { AsyncEventQueue } from "./event-queue";
import { readJsonRequestBody } from "./http-body";
import { httpStatusFromTerminalError } from "./lib/errors";
import { createHash } from "node:crypto";
import { augmentNativeModelCatalog } from "./model-catalog";
import {
  readCodexModelContextOverride,
  readCodexSubagentProtocol,
  type CodexModelContextOverride,
} from "./codex-integration";
import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";
import { forwardNativeCodexRequest, type NativeFetch, type NativeImageEndpoint } from "./native-passthrough";
import { fetchNativeCodex } from "./native-network";
import {
  buildCompactV1Output,
  COMPACT_PROMPT,
  decodeCompactionSummary,
  extractCompactUserMessages,
} from "./responses/compaction";
import { parseRequest } from "./responses/parser";
import { expandPreviousResponseInput, flushResponseState, rememberResponseState } from "./responses/state";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "./types";
import type { CodexProviderConfig } from "./types";
import type { ProviderAdapter } from "./adapters/base";
import { VERSION } from "./version";

type HttpTrackedEndpoint = "models" | "responses" | "compact" | "search" | "unspecified" | NativeImageEndpoint;

export interface NativeCodexTurnIdentity {
  threadId: string;
  turnId: string;
}

export interface HttpStreamFailureEvidence {
  httpTurnId: number;
  endpoint: HttpTrackedEndpoint;
  reader: "client" | "windows_lifecycle";
  platform: NodeJS.Platform;
  chunks: number;
  bytes: number;
  errorName: string;
  errorCode: string;
}

type HttpStreamFailureReporter = (evidence: HttpStreamFailureEvidence) => void;

function safeStreamErrorField(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : fallback;
}

function streamFailureEvidence(
  error: unknown,
  httpTurnId: number,
  endpoint: HttpTrackedEndpoint,
  reader: HttpStreamFailureEvidence["reader"],
  platform: NodeJS.Platform,
  chunks: number,
  bytes: number,
): HttpStreamFailureEvidence {
  const candidate = error !== null && typeof error === "object"
    ? error as { name?: unknown; code?: unknown }
    : {};
  return {
    httpTurnId,
    endpoint,
    reader,
    platform,
    chunks,
    bytes,
    errorName: safeStreamErrorField(candidate.name, "Error"),
    errorCode: safeStreamErrorField(candidate.code, "unknown"),
  };
}

const reportHttpStreamFailure: HttpStreamFailureReporter = evidence => {
  console.warn(`[codex-chatgpt-web] http_stream_failed ${JSON.stringify(evidence)}`);
};

function emitHttpStreamFailure(
  reporter: HttpStreamFailureReporter,
  evidence: HttpStreamFailureEvidence,
): void {
  try {
    reporter(evidence);
  } catch {
    // Diagnostics are a side channel: they must never replace the source stream error or retain
    // HTTP turn ownership after the client has already observed that failure.
  }
}

export class HttpTurnCounter {
  private readonly active = new Map<number, {
    abort: AbortController;
    done: Promise<void>;
    finish: () => void;
    identity?: NativeCodexTurnIdentity;
  }>();
  private readonly interrupted = new Map<string, unknown>();
  private nextId = 1;

  private identityKey(identity: NativeCodexTurnIdentity): string {
    return `${identity.threadId}\u0000${identity.turnId}`;
  }

  private rememberInterrupted(identity: NativeCodexTurnIdentity, reason: unknown): void {
    const key = this.identityKey(identity);
    this.interrupted.delete(key);
    this.interrupted.set(key, reason);
    while (this.interrupted.size > 1_024) {
      const oldest = this.interrupted.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.interrupted.delete(oldest);
    }
  }

  constructor(private readonly reportStreamFailure: HttpStreamFailureReporter = reportHttpStreamFailure) {}

  count(): number {
    return this.active.size;
  }

  async cancelAll(reason: unknown = new Error("Active HTTP turns cancelled")): Promise<number> {
    const turns = [...this.active.values()];
    for (const turn of turns) {
      if (!turn.abort.signal.aborted) turn.abort.abort(reason);
    }
    await Promise.all(turns.map(turn => turn.done));
    return turns.length;
  }

  async cancelTurn(
    identity: NativeCodexTurnIdentity,
    reason: unknown = new DOMException("Codex turn interrupted", "AbortError"),
  ): Promise<number> {
    const cancellation = this.beginCancelTurn(identity, reason);
    await cancellation.settlement;
    return cancellation.cancelled;
  }

  beginCancelTurn(
    identity: NativeCodexTurnIdentity,
    reason: unknown = new DOMException("Codex turn interrupted", "AbortError"),
  ): { cancelled: number; settlement: Promise<void> } {
    this.rememberInterrupted(identity, reason);
    const turns = [...this.active.values()].filter(turn => (
      turn.identity?.threadId === identity.threadId && turn.identity.turnId === identity.turnId
    ));
    for (const turn of turns) {
      if (!turn.abort.signal.aborted) turn.abort.abort(reason);
    }
    return {
      cancelled: turns.length,
      settlement: Promise.all(turns.map(turn => turn.done)).then(() => undefined),
    };
  }

  async track(
    run: (
      signal: AbortSignal,
      bindIdentity: (identity: NativeCodexTurnIdentity) => void,
    ) => Promise<Response>,
    clientSignal?: AbortSignal,
    platform: NodeJS.Platform = process.platform,
    endpoint: HttpTrackedEndpoint = "unspecified",
  ): Promise<Response> {
    const id = this.nextId++;
    const abort = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const tracked: {
      abort: AbortController;
      done: Promise<void>;
      finish: () => void;
      identity?: NativeCodexTurnIdentity;
    } = { abort, done, finish };
    this.active.set(id, tracked);
    let released = false;
    let clientAbortListener: (() => void) | undefined;
    let streamAbortListener: (() => void) | undefined;
    const release = () => {
      if (released) return;
      released = true;
      this.active.delete(id);
      if (clientSignal && clientAbortListener) {
        clientSignal.removeEventListener("abort", clientAbortListener);
        clientAbortListener = undefined;
      }
      if (streamAbortListener) abort.signal.removeEventListener("abort", streamAbortListener);
      finish();
    };
    clientAbortListener = () => abort.abort(clientSignal?.reason);
    if (clientSignal?.aborted) abort.abort(clientSignal.reason);
    else clientSignal?.addEventListener("abort", clientAbortListener, { once: true });

    try {
      const response = await run(abort.signal, identity => {
        if (!identity.threadId.trim() || !identity.turnId.trim()) {
          throw new Error("Native Codex turn identity must contain a threadId and turnId");
        }
        if (tracked.identity
          && (tracked.identity.threadId !== identity.threadId || tracked.identity.turnId !== identity.turnId)) {
          throw new Error("An HTTP request cannot change its native Codex turn identity");
        }
        tracked.identity = identity;
        const interruptedReason = this.interrupted.get(this.identityKey(identity));
        if (interruptedReason !== undefined && !abort.signal.aborted) abort.abort(interruptedReason);
      });
      if (!response.body) {
        release();
        return response;
      }
      if (abort.signal.aborted) {
        await response.body.cancel(abort.signal.reason).catch(() => {});
        release();
        return new Response(null, { status: 499, statusText: "Client Closed Request" });
      }

      if (platform !== "win32") {
        // Bun's async-pull teardown bug is Windows-only. On Darwin/Linux, preserve the direct
        // pull chain: it keeps HTTP backpressure native and lets a client body cancellation reach
        // the original SSE reader without an eagerly drained tee branch racing the socket writer.
        const reader = response.body.getReader();
        const reportStreamFailure = this.reportStreamFailure;
        let chunks = 0;
        let bytes = 0;
        streamAbortListener = () => {
          void reader.cancel(abort.signal.reason).catch(() => {}).finally(release);
        };
        abort.signal.addEventListener("abort", streamAbortListener, { once: true });
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                release();
                controller.close();
                return;
              }
              chunks += 1;
              bytes += chunk.value.byteLength;
              controller.enqueue(chunk.value);
            } catch (error) {
              if (!abort.signal.aborted) {
                emitHttpStreamFailure(reportStreamFailure, streamFailureEvidence(
                  error,
                  id,
                  endpoint,
                  "client",
                  platform,
                  chunks,
                  bytes,
                ));
              }
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      // Windows-safe Bun#32111 shape: the client gets a native tee branch,
      // never a JS ReadableStream with async pull(). The second branch is consumed only
      // to observe completion. The request signal releases lifecycle ownership immediately
      // when the client disconnects and cancels the observer branch.
      const [clientBody, lifecycleBody] = response.body.tee();
      const reader = lifecycleBody.getReader();
      let chunks = 0;
      let bytes = 0;
      streamAbortListener = () => {
        void Promise.allSettled([
          reader.cancel(abort.signal.reason),
          clientBody.cancel(abort.signal.reason),
        ]).finally(release);
      };
      abort.signal.addEventListener("abort", streamAbortListener, { once: true });
      void (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            chunks += 1;
            bytes += chunk.value.byteLength;
            // Consume eagerly so the lifecycle branch never backpressures the client branch.
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            emitHttpStreamFailure(this.reportStreamFailure, streamFailureEvidence(
              error,
              id,
              endpoint,
              "windows_lifecycle",
              platform,
              chunks,
              bytes,
            ));
          }
          // Stream failure is delivered to the client branch; lifecycle cleanup stays best-effort.
        } finally {
          release();
        }
      })();
      return new Response(clientBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      release();
      throw error;
    }
  }
}

type ChatGptWebAdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

export interface ResponseRequestOptions {
  /** DEV and other in-process harnesses can keep continuation state in their own canonical store. */
  rememberState?: boolean;
  /** Observe the exact production adapter stream when invoking the handler in-process. */
  onAdapterEvent?: (event: AdapterEvent) => void;
  /** Bind the physical HTTP stream to the exact native Codex turn that owns it. */
  onTurnIdentity?: (identity: NativeCodexTurnIdentity) => void;
}

export function routeChatGptWebRequest(parsed: CodexParsedRequest, config: AppConfig): ChatGptWebModelRoute {
  const route = requireChatGptWebModelRoute(parsed.modelId, config, parsed.options.reasoning);
  if (route.interactionMode === "automatic" && route.modelFamily) parsed._chatgptModelFamily = route.modelFamily;
  else delete parsed._chatgptModelFamily;
  parsed.modelId = route.backendModel;
  // Zero Risk preserves a distinct backend identity. Its immutable Codex effort is only a
  // protocol/catalog value; the manual adapter must never reinterpret it as a ChatGPT selection.
  parsed.options.reasoning = route.interactionMode === "automatic"
    ? route.adapterEffort
    : route.codexEffort;
  return route;
}

interface ModelCatalogFailure {
  stage: "config" | "request" | "transport" | "upstream" | "catalog";
  code?: string;
}

function modelCatalogFailure(stage: ModelCatalogFailure["stage"], error: unknown): ModelCatalogFailure {
  if (!error || typeof error !== "object") return { stage };
  // Fetch can wrap the network error. Keep only bounded codes, never free-form
  // messages, URLs or paths from either layer in the health snapshot.
  for (const source of [error, "cause" in error ? error.cause : undefined]) {
    const code = source && typeof source === "object" && "code" in source ? source.code : undefined;
    if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) return { stage, code };
  }
  const name = "name" in error ? error.name : undefined;
  // AbortError identifies cancellation, not who initiated it. The upstream request
  // can also be cancelled by the server, so do not blame the Codex client here.
  if (name === "AbortError") return { stage, code: "ABORT_ERR" };
  if (name === "TimeoutError") return { stage, code: "ETIMEDOUT" };
  return { stage };
}

export async function modelsRequest(
  req: Request,
  config: AppConfig,
  fetchUpstream?: NativeFetch,
  contextOverride?: () => CodexModelContextOverride | undefined,
  onFailure?: (failure: ModelCatalogFailure) => void,
): Promise<Response> {
  let upstream: Response;
  let sent = false;
  try {
    upstream = await forwardNativeCodexRequest(req, "models", input => {
      sent = true;
      return (fetchUpstream ?? fetchNativeCodex)(input);
    });
  } catch (error) {
    onFailure?.(modelCatalogFailure(sent ? "transport" : "request", error));
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
  if (!upstream.ok) {
    onFailure?.({ stage: "upstream" });
    return upstream;
  }
  let catalog: Record<string, unknown>;
  try {
    catalog = augmentNativeModelCatalog(await upstream.json(), config, contextOverride?.());
  } catch (error) {
    onFailure?.(modelCatalogFailure("catalog", error));
    return formatErrorResponse(502, "invalid_response_error", error instanceof Error ? error.message : String(error));
  }
  const body = JSON.stringify(catalog);
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("etag", `W/\"${createHash("sha256").update(body).digest("base64url")}\"`);
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers });
}

export async function nativeSearchRequest(
  req: Request,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  try {
    return await forwardNativeCodexRequest(req, "alpha/search", fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

async function nativeImagesRequest(
  req: Request,
  endpoint: NativeImageEndpoint,
  fetchUpstream?: NativeFetch,
): Promise<Response> {
  const authorization = req.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    return formatErrorResponse(401, "authentication_error", "Native image requests require incoming Codex Bearer authorization");
  }
  try {
    return await forwardNativeCodexRequest(req, endpoint, fetchUpstream);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}

function toolBridgeMaps(parsed: CodexParsedRequest): {
  toolNsMap: Map<string, { namespace: string; name: string }>;
  freeformToolNames: Set<string>;
  toolSearchToolNames: Set<string>;
} {
  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeformToolNames = new Set<string>();
  const toolSearchToolNames = new Set<string>();
  for (const tool of parsed.context.tools ?? []) {
    if (tool.namespace) toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

export async function responseRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
  options: ResponseRequestOptions = {},
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Request body must be valid JSON",
    );
  }
  const requestedModel = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { model?: unknown }).model
    : undefined;
  try {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof requestedModel === "string" && !isChatGptWebModelSlug(requestedModel)) {
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  const requestedPreviousResponseId = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { previous_response_id?: unknown }).previous_response_id
    : undefined;
  const expanded = expandPreviousResponseInput(raw);
  let parsed: CodexParsedRequest;
  let route: ChatGptWebModelRoute;
  try {
    parsed = parseRequest(expanded);
    route = routeChatGptWebRequest(parsed, config);
    const identity = extractChatGptTurnIdentity(parsed);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (parsed._opaqueMultiAgentV2Payload) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "ChatGPT Web cannot read this encrypted cross-backend subagent payload. "
        + "Start a new Compatibility V1 task, or delegate from a Web model whose collaboration call uses the plaintext-delivery marker.",
    );
  }
  if (typeof requestedPreviousResponseId === "string" && expanded === raw) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Local continuation state for previous_response_id is unavailable; refusing to run ChatGPT Web with partial Codex context. Compact the Codex task or start a new task before retrying.",
    );
  }

  const compaction = parsed._compactionRequest === true;
  const compactionItem = compaction && parsed._compactionResponseFormat !== "message";
  const rememberCompletedResponse = (response: Record<string, unknown>): void => {
    if (!compaction) {
      if (options.rememberState !== false) rememberResponseState(parsed._rawBody, response, { force: true });
      return;
    }
    if (response.status !== "completed") return;
    const identity = extractChatGptTurnIdentity(parsed);
    if (!identity.threadId || !identity.turnId || !Array.isArray(response.output)) return;
    const items = response.output.filter(item => item?.type === (compactionItem ? "compaction" : "message"));
    if (items.length !== 1 || (compactionItem && response.output.length !== 1)) return;
    const item = items[0];
    const summary = compactionItem
      ? (typeof item?.encrypted_content === "string" ? decodeCompactionSummary(item.encrypted_content) : null)
      : (item?.role === "assistant" && Array.isArray(item.content)
        ? item.content.filter((part: { type?: string; text?: unknown }) => part.type === "output_text" && typeof part.text === "string")
          .map((part: { text: string }) => part.text).join("")
        : null);
    if (!summary) return;
    const source = extractChatGptCompactionSourceRevision(parsed);
    const body = parsed._rawBody as { input?: unknown[] };
    // v1 installs the bounded user-message output, whereas v2 retains the original source.
    // Authenticate both exact producer-defined representations, never arbitrary rewrites.
    const v1Source = extractChatGptCompactionSourceRevision({
      ...parsed,
      _rawBody: { ...body, input: buildCompactV1Output(extractCompactUserMessages(body.input), summary) },
    });
    rememberCompactionContinuation(parsed, identity, [source, v1Source], summary);
  };
  // Native checkpoint + current turn_context are the durable control plane. Reconstruct their
  // exact authority before transcript-derived trace/revision validation can reject a reconnect.
  if (!compaction && !isChatGptCompactionContinuation(parsed)) admitNativeCompactionContinuation(parsed);
  if (compaction && route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  if (compaction) {
    // History compaction is a dedicated summarization turn. It must never bind the active Codex
    // tool bridge or continue an in-flight MCP round; the returned summary becomes the next turn's
    // replacement history through the Responses compaction contract.
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  const provider = providerConfig(config);
  let traceId: string | undefined;
  try {
    traceId = chatGptWebTraceId(provider, parsed);
  } catch (error) {
    // A cancelled browser session can only exist after the adapter accepted canonical native
    // turn identity and user-revision metadata. Requests without that identity have no matching
    // trace tombstone; preserve the adapter's existing strict validation/error path below.
    const message = error instanceof Error ? error.message : String(error);
    if (message === CHATGPT_TURN_REVISION_CONFLICT_MESSAGE) {
      if (!authenticateNativeFailedTurnRetry(parsed)) return formatErrorResponse(400, "invalid_request_error", message);
      traceId = chatGptWebTraceId(provider, parsed);
    } else if (!message.includes("requires native Codex turn_id metadata")
      && !message.includes("requires a current-turn user message")) throw error;
  }
  const cancelledError = traceId ? chatGptTurnSessions.cancelledError(traceId) : undefined;
  if (cancelledError) {
    // Codex retries unknown streamed response.failed codes. A replay after the user explicitly
    // closed the only browser document is instead a terminal client state: repeating that exact
    // request is invalid and must not recreate the DOM. Codex maps HTTP 400 to its non-retryable
    // InvalidRequest category while the body preserves the real client_cancelled classification.
    return new Response(JSON.stringify({
      error: {
        type: "client_closed_request",
        code: "client_cancelled",
        message: cancelledError.message,
      },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const adapter = adapterFactory(provider);
  try {
    await adapter.prepareTurn?.(parsed, { headers: req.headers, abortSignal: req.signal });
  } catch (error) {
    // An invalid control envelope is a terminal admission failure, not a broken SSE connection
    // that native Codex retries five times. No browser or tool execution has been admitted yet.
    return Response.json({ error: {
      type: error instanceof ChatGptWebAdapterError ? error.errorType : "invalid_request_error",
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof ChatGptWebAdapterError ? error.code : "turn_preflight_failed",
    } }, { status: error instanceof ChatGptWebAdapterError ? error.status : 400 });
  }
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const run = async () => {
    try {
      await adapter.runTurn!(parsed, { headers: req.headers, abortSignal: abort.signal }, event => {
        options.onAdapterEvent?.(event);
        queue.push(event);
      });
    } catch (error) {
      const event: AdapterEvent = { type: "error", message: error instanceof Error ? error.message : String(error) };
      options.onAdapterEvent?.(event);
      queue.push(event);
    } finally {
      queue.close();
    }
  };
  const maps = toolBridgeMaps(parsed);
  const responseModel = route.slug;

  if (parsed.stream) {
    void run();
    const stream = bridgeToResponsesSSE(
      queue,
      responseModel,
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
      () => abort.abort(),
      2_000,
      {
        hideThinkingSummary: parsed.options.hideThinkingSummary,
        ...(provider.chatgptWeb?.stallTimeoutSec !== undefined
          ? { stallTimeoutSec: provider.chatgptWeb.stallTimeoutSec }
          : {}),
        ...(compactionItem ? { compaction: true } : {}),
        onCompletedResponse: rememberCompletedResponse,
      },
    );
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  await run();
  const events = await queue.collect();
  const json = buildResponseJSON(events, responseModel, {
    hideThinkingSummary: parsed.options.hideThinkingSummary,
    toolNsMap: maps.toolNsMap,
    freeformToolNames: maps.freeformToolNames,
    toolSearchToolNames: maps.toolSearchToolNames,
    ...(compactionItem ? { compaction: true } : {}),
  });
  rememberCompletedResponse(json);
  return Response.json(json);
}

export async function compactRequest(
  req: Request,
  config: AppConfig,
  adapterFactory: ChatGptWebAdapterFactory = createChatGptWebAdapter,
  options: Pick<ResponseRequestOptions, "onTurnIdentity"> = {},
): Promise<Response> {
  const nativeRequest = req.clone();
  let raw: Record<string, unknown>;
  try {
    const parsed = await readJsonRequestBody(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      error instanceof Error ? error.message : "Compaction request body must be a JSON object",
    );
  }
  const headerTurnMetadata = req.headers.get("x-codex-turn-metadata");
  if (headerTurnMetadata) {
    const existingMetadata = raw.client_metadata;
    const clientMetadata = existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
      ? existingMetadata as Record<string, unknown>
      : {};
    raw = {
      ...raw,
      client_metadata: {
        ...clientMetadata,
        // `/responses/compact` carries native turn authority in this canonical Codex header,
        // unlike ordinary `/responses` payloads where the same value also appears in the body.
        "x-codex-turn-metadata": headerTurnMetadata,
      },
    };
  }
  try {
    const identity = extractCodexTurnIdentityFromBody(raw);
    if (identity.threadId && identity.turnId) {
      options.onTurnIdentity?.({ threadId: identity.threadId, turnId: identity.turnId });
    }
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof raw.model !== "string" || !raw.model) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
  }
  if (!isChatGptWebModelSlug(raw.model)) {
    try {
      return await forwardNativeCodexRequest(nativeRequest, "responses/compact", undefined, raw);
    } catch (error) {
      return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
    }
  }
  let route: ChatGptWebModelRoute;
  try {
    route = requireChatGptWebModelRoute(raw.model, config);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "ChatGPT Web Luna uses a rolling checkpoint on every completed browser turn; separate Codex compaction is disabled for this route.",
    );
  }
  const input = Array.isArray(raw.input) ? raw.input : [];
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  const internal = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...raw, stream: false, input: [...input, { type: "compaction_trigger" }] }),
    signal: req.signal,
  });
  const response = await responseRequest(internal, config, adapterFactory, options);
  if (!response.ok) return response;
  let body: {
    output?: unknown[];
    status?: unknown;
    error?: { message?: unknown; type?: unknown; code?: unknown } | null;
  };
  try {
    body = await response.json() as typeof body;
  } catch {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn returned invalid JSON");
  }
  if (body.error) {
    const error = {
      message: typeof body.error.message === "string" ? body.error.message : "Compaction turn failed",
      type: typeof body.error.type === "string" ? body.error.type : "upstream_error",
      code: typeof body.error.code === "string" ? body.error.code : null,
    };
    return Response.json(
      { error },
      { status: httpStatusFromTerminalError(error) },
    );
  }
  if (body.status !== "completed") {
    return formatErrorResponse(502, "upstream_error", `Compaction turn failed (status: ${String(body.status ?? "unknown")})`);
  }
  const items = (body.output ?? []).filter(
    (item): item is { type: "compaction"; encrypted_content?: string } =>
      Boolean(item && typeof item === "object" && (item as { type?: string }).type === "compaction"),
  );
  if (items.length !== 1) {
    return formatErrorResponse(502, "invalid_response_error", `Compaction turn produced ${items.length} compaction items; expected one`);
  }
  const summary = typeof items[0]!.encrypted_content === "string"
    ? decodeCompactionSummary(items[0]!.encrypted_content)
    : null;
  if (!summary?.trim()) {
    return formatErrorResponse(502, "invalid_response_error", "Compaction turn produced an empty summary");
  }
  return Response.json({ output: buildCompactV1Output(extractCompactUserMessages(input), summary) });
}

export function startServer(
  config: AppConfig,
  dependencies: { fetchUpstream?: NativeFetch; adapterFactory?: ChatGptWebAdapterFactory } = {},
): ReturnType<typeof Bun.serve> {
  if (config.purpose === "dev-harness") {
    throw new Error("DEV harness configuration cannot start a Responses listener");
  }
  const startedAt = Date.now();
  const turnBroker = config.mode === "full" ? TurnBroker.forSocket(config.brokerSocketPath) : undefined;
  if (config.mode === "full") {
    void turnBroker!.listen().catch(error => {
      console.error(
        `[chatgpt-web] turn broker endpoint is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
  let draining = false;
  let shutdownPromise: Promise<void> | undefined;
  let successfulModelCatalogRequests = 0;
  let lastSuccessfulModelCatalogRequestAt: string | null = null;
  let modelCatalogRequests = 0;
  let lastModelCatalogResult: {
    request: number; at: string; status: number; failure?: ModelCatalogFailure;
  } | null = null;
  const httpTurns = new HttpTurnCounter();
  const activity = () => ({
    active_http_turns: httpTurns.count(),
    active_browser_turns: chatGptTurnSessions.activeCount() + (turnBroker?.externalOwnerActiveCount() ?? 0),
  });
  const controlAuthorized = (req: Request): boolean => {
    const header = req.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${config.controlToken}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          service: "codex-chatgpt-web",
          version: VERSION,
          mode: config.mode,
          pid: process.pid,
          port: config.port,
          uptime: (Date.now() - startedAt) / 1_000,
          accepting_turns: !draining,
          successful_model_catalog_requests: successfulModelCatalogRequests,
          last_successful_model_catalog_request_at: lastSuccessfulModelCatalogRequestAt,
          model_catalog_requests: modelCatalogRequests,
          last_model_catalog_result: lastModelCatalogResult,
          ...activity(),
        });
      }
      if (req.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        draining = url.pathname === "/admin/drain";
        turnBroker?.setExternalOwnersAccepted(!draining);
        return Response.json({ status: "ok", accepting_turns: !draining, ...activity() });
      }
      if (req.method === "POST" && url.pathname === "/admin/cancel-turn") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        let traceId: string;
        let leaseFailure: "browser_surface_bootstrap_timeout" | "helper_heartbeat_expired" | undefined;
        try {
          const body = await req.json() as { traceId?: unknown; reason?: unknown };
          traceId = typeof body?.traceId === "string" ? body.traceId : "";
          if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) throw new Error("traceId is invalid");
          if (body.reason !== undefined) {
            if (body.reason !== "browser_surface_bootstrap_timeout" && body.reason !== "helper_heartbeat_expired") {
              throw new Error("Browser turn cancellation reason is invalid");
            }
            leaseFailure = body.reason;
          }
        } catch (error) {
          return Response.json(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
        const reason = leaseFailure
          ? new ChatGptWebAdapterError(
            leaseFailure === "browser_surface_bootstrap_timeout"
              ? "The ChatGPT browser turn did not finish browser setup before its lease expired. The turn was stopped."
              : "The ChatGPT browser helper stopped reporting progress and its lease expired. The turn was stopped.",
            { status: 504, errorType: "server_error", code: leaseFailure, retryable: false },
          )
          : chatGptBrowserTabClosedError();
        // Revoke the owner first. This prevents a compaction callback that observes its retained
        // source being cancelled below from starting a fresh fallback during operator shutdown.
        const compactionCancellation = beginCancelStructuredCompactionTrace(traceId, reason);
        const browserCancellation = chatGptTurnSessions.beginCancelTrace(traceId, reason);
        const cancelledBrokerTurns = turnBroker?.revokeTrace(traceId, reason) ?? 0;
        const settlement = Promise.all([browserCancellation.settlement, compactionCancellation.settlement]);
        // Explicit tab close acknowledges revoked authority, then destroys its document. Waiting
        // for that document's helper first can deadlock the UI behind a stalled browser operation.
        // Lease cleanup still requires physical settlement before declaring the runtime idle.
        if (leaseFailure) await settlement;
        else void settlement.catch(error => console.error(`[chatgpt-web] cancelled turn cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
        return Response.json({
          status: "ok",
          trace_id: traceId,
          cancelled_browser_turns: browserCancellation.cancelled,
          cancelled_broker_turns: cancelledBrokerTurns,
          cancelled_compaction_runs: compactionCancellation.cancelled,
          ...activity(),
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/interrupt-turn") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        let identity: NativeCodexTurnIdentity;
        try {
          const body = await req.json() as { threadId?: unknown; turnId?: unknown };
          const threadId = typeof body?.threadId === "string" ? body.threadId.trim() : "";
          const turnId = typeof body?.turnId === "string" ? body.turnId.trim() : "";
          if (!/^[A-Za-z0-9_-]{6,128}$/.test(threadId) || !/^[A-Za-z0-9_-]{6,128}$/.test(turnId)) {
            throw new Error("native Codex threadId or turnId is invalid");
          }
          identity = { threadId, turnId };
        } catch (error) {
          return Response.json(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
        const reason = new DOMException("Codex turn interrupted", "AbortError");
        const browserCancellation = chatGptTurnSessions.cancelNativeTurn(
          identity.threadId,
          identity.turnId,
          reason,
        );
        const compactionCancellation = cancelStructuredCompactionNativeTurn(
          identity.threadId,
          identity.turnId,
          reason,
        );
        const httpCancellation = httpTurns.beginCancelTurn(identity, reason);
        const settlement = Promise.allSettled([
          browserCancellation.settlement,
          compactionCancellation.settlement,
          httpCancellation.settlement,
        ]);
        void settlement.then(results => {
          for (const result of results) {
            if (result.status === "rejected") {
              console.error(
                `[chatgpt-web] interrupted turn cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
              );
            }
          }
        });
        return Response.json({
          status: "ok",
          cancelled_http_turns: httpCancellation.cancelled,
          cancelled_browser_turns: browserCancellation.cancelled,
          cancelled_compaction_runs: compactionCancellation.cancelled,
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/cancel-turns") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        const reason = new Error("Active turn cancelled by launcher");
        // Abort shared compaction owners before clearing their retained source sessions. The
        // owner signal is the only cancellation boundary for a fresh fallback not in the session
        // registry.
        const compactionCancellation = cancelAllStructuredCompactions(reason);
        const cancelledBrowserTurns = chatGptTurnSessions.clear() + (turnBroker?.revokeExternalOwners() ?? 0);
        const [cancelledHttpTurns, cancelledCompactionRuns] = await Promise.all([
          httpTurns.cancelAll(reason),
          compactionCancellation,
        ]);
        return Response.json({
          status: "ok",
          cancelled_http_turns: cancelledHttpTurns,
          cancelled_browser_turns: cancelledBrowserTurns,
          cancelled_compaction_runs: cancelledCompactionRuns,
          ...activity(),
        });
      }
      if (req.method === "POST" && url.pathname === "/admin/shutdown") {
        if (!controlAuthorized(req)) return new Response("Unauthorized", { status: 401 });
        const current = activity();
        if (!draining || current.active_http_turns > 0 || current.active_browser_turns > 0) {
          return Response.json(
            {
              status: "refused",
              accepting_turns: !draining,
              ...current,
            },
            { status: 409 },
          );
        }
        setTimeout(shutdown, 0);
        return Response.json({ status: "ok", accepting_turns: false, ...current });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        if (draining) {
          return formatErrorResponse(
            503,
            "server_error",
            "codex-chatgpt-web is draining for a requested service operation",
          );
        }
        return httpTurns.track(async signal => {
          const request = ++modelCatalogRequests;
          const started = Date.now();
          const recordResult = (response: Response, failure?: ModelCatalogFailure): Response => {
            const result = { request, at: new Date().toISOString(), status: response.status, ...(failure ? { failure } : {}) };
            // An older, slower request must not replace a newer completed result.
            if (!lastModelCatalogResult || request > lastModelCatalogResult.request) lastModelCatalogResult = result;
            if (!response.ok) {
              try {
                console.warn(`[codex-chatgpt-web] model_catalog_failed ${JSON.stringify({ ...result, elapsedMs: Date.now() - started })}`);
              } catch { /* Logging must not replace the catalog result. */ }
            }
            return response;
          };
          let catalogConfig: AppConfig;
          try {
            catalogConfig = {
              ...config,
              subagentProtocol: readCodexSubagentProtocol(config.subagentProtocol),
            };
          } catch (error) {
            return recordResult(formatErrorResponse(
              500,
              "server_error",
              `Could not resolve the installed subagent protocol: ${error instanceof Error ? error.message : String(error)}`,
            ), modelCatalogFailure("config", error));
          }
          let failure: ModelCatalogFailure | undefined;
          const response = await modelsRequest(
            new Request(req, { signal }),
            catalogConfig,
            dependencies.fetchUpstream,
            readCodexModelContextOverride,
            value => { failure = value; },
          );
          if (response.ok) {
            successfulModelCatalogRequests += 1;
            lastSuccessfulModelCatalogRequestAt = new Date().toISOString();
          }
          return recordResult(response, failure);
        }, req.signal, process.platform, "models");
      }
      if (req.method === "GET" && url.pathname === "/v1/responses") {
        return new Response("Responses WebSocket transport is not enabled on this local route", {
          status: 426,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(
          (signal, bindIdentity) => responseRequest(
            new Request(req, { signal }),
            config,
            dependencies.adapterFactory,
            { onTurnIdentity: bindIdentity },
          ),
          req.signal,
          process.platform,
          "responses",
        );
      }
      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(
          (signal, bindIdentity) => compactRequest(
            new Request(req, { signal }),
            config,
            dependencies.adapterFactory,
            { onTurnIdentity: bindIdentity },
          ),
          req.signal,
          process.platform,
          "compact",
        );
      }
      if (req.method === "POST" && url.pathname === "/v1/alpha/search") {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        return httpTurns.track(
          signal => nativeSearchRequest(new Request(req, { signal }), dependencies.fetchUpstream),
          req.signal,
          process.platform,
          "search",
        );
      }
      if (req.method === "POST"
        && (url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits")) {
        if (draining) return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
        const endpoint: NativeImageEndpoint = url.pathname === "/v1/images/generations"
          ? "images/generations"
          : "images/edits";
        return httpTurns.track(
          signal => nativeImagesRequest(new Request(req, { signal }), endpoint, dependencies.fetchUpstream),
          req.signal,
          process.platform,
          endpoint,
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });
  function shutdown(): void {
    if (shutdownPromise) return;
    draining = true;
    chatGptTurnSessions.clear();
    flushResponseState();
    shutdownPromise = (async () => {
      const results = await Promise.allSettled([
        closeChatGptBrowserWorkers(),
        closeTurnBrokers(),
      ]);
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map(result => result.reason);
      if (failures.length > 0) {
        process.exitCode = 1;
        for (const failure of failures) {
          console.error(`[codex-chatgpt-web] shutdown cleanup failed: ${failure instanceof Error ? failure.message : String(failure)}`);
        }
      }
      await server.stop(true);
    })().catch(error => {
      process.exitCode = 1;
      console.error(`[codex-chatgpt-web] server shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
