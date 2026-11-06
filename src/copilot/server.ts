import { timingSafeEqual } from "node:crypto";
import type { ProviderAdapter } from "../adapters/base";
import { bridgeToResponsesSSE, buildResponseJSON, formatErrorResponse } from "../bridge";
import { AsyncEventQueue } from "../event-queue";
import { readJsonRequestBody } from "../http-body";
import { httpStatusFromTerminalError } from "../lib/errors";
import {
  buildCompactV1Output,
  COMPACT_PROMPT,
  decodeCompactionSummary,
  extractCompactUserMessages,
} from "../responses/compaction";
import { parseRequest } from "../responses/parser";
import { expandPreviousResponseInput, rememberResponseState } from "../responses/state";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest } from "../types";
import { createCopilotWebAdapter } from "./adapter";
import { closeCopilotBrowsers } from "./browser";
import { resolveCopilotModel, type CopilotConfig } from "./config";
import { copilotCatalog } from "./models";

export type CopilotAdapterFactory = (config: CopilotConfig) => ProviderAdapter;

export interface CopilotServerDependencies {
  adapterFactory?: CopilotAdapterFactory;
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
    if (tool.namespace) {
      toolNsMap.set(namespacedToolName(tool.namespace, tool.name), { namespace: tool.namespace, name: tool.name });
    }
    if (tool.freeform) freeformToolNames.add(tool.name);
    if (tool.toolSearch) toolSearchToolNames.add(tool.name);
  }
  return { toolNsMap, freeformToolNames, toolSearchToolNames };
}

function requireCopilotModel(config: CopilotConfig, modelId: string): void {
  resolveCopilotModel(config, modelId);
}

export async function copilotResponseRequest(
  req: Request,
  config: CopilotConfig,
  adapterFactory: CopilotAdapterFactory = createCopilotWebAdapter,
): Promise<Response> {
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
  if (typeof requestedModel !== "string" || requestedModel.length === 0) {
    return formatErrorResponse(400, "invalid_request_error", "Request requires a model");
  }
  try {
    requireCopilotModel(config, requestedModel);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }

  const requestedPreviousResponseId = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { previous_response_id?: unknown }).previous_response_id
    : undefined;
  const expanded = expandPreviousResponseInput(raw);
  let parsed: CodexParsedRequest;
  try {
    parsed = parseRequest(expanded);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  if (typeof requestedPreviousResponseId === "string" && expanded === raw) {
    return formatErrorResponse(
      409,
      "invalid_request_error",
      "Local continuation state for previous_response_id is unavailable; compact the Codex task or start a new task.",
    );
  }

  const compaction = parsed._compactionRequest === true;
  const compactionItem = compaction && parsed._compactionResponseFormat !== "message";
  if (compaction) {
    delete parsed.context.tools;
    delete parsed.options.toolChoice;
    delete parsed.options.parallelToolCalls;
    parsed.context.messages.push({ role: "user", content: COMPACT_PROMPT, timestamp: Date.now() });
  }

  const adapter = adapterFactory(config);
  const queue = new AsyncEventQueue<AdapterEvent>();
  const abort = new AbortController();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const run = async () => {
    try {
      await adapter.runTurn(parsed, { headers: req.headers, abortSignal: abort.signal }, event => queue.push(event));
    } catch (error) {
      queue.push({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      queue.close();
    }
  };
  const maps = toolBridgeMaps(parsed);
  const responseModel = parsed.modelId;
  const rememberCompletedResponse = (response: Record<string, unknown>): void => {
    if (!compaction) rememberResponseState(parsed._rawBody, response, { force: true });
  };

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

export async function copilotCompactRequest(
  req: Request,
  config: CopilotConfig,
  adapterFactory: CopilotAdapterFactory = createCopilotWebAdapter,
): Promise<Response> {
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
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    return formatErrorResponse(400, "invalid_request_error", "Compaction request requires a model");
  }
  try {
    requireCopilotModel(config, raw.model);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
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
  const response = await copilotResponseRequest(internal, config, adapterFactory);
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
    return Response.json({ error }, { status: httpStatusFromTerminalError(error) });
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

export function startCopilotServer(
  config: CopilotConfig,
  dependencies: CopilotServerDependencies = {},
): ReturnType<typeof Bun.serve> {
  const startedAt = Date.now();
  let activeTurns = 0;
  let shuttingDown = false;
  const adapterFactory = dependencies.adapterFactory ?? createCopilotWebAdapter;
  const authorized = (req: Request): boolean => {
    if (!config.controlToken) return true;
    const header = req.headers.get("authorization") ?? "";
    const expected = Buffer.from(`Bearer ${config.controlToken}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const track = async (action: () => Promise<Response>): Promise<Response> => {
    if (shuttingDown) {
      return formatErrorResponse(503, "server_error", "codex-copilot-web is shutting down");
    }
    activeTurns += 1;
    try {
      return await action();
    } finally {
      activeTurns -= 1;
    }
  };

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "GET" && req.headers.has("origin")) {
        return formatErrorResponse(
          403,
          "invalid_request_error",
          "Browser-originated requests are not accepted by the local Copilot route",
        );
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        return Response.json({
          status: "ok",
          service: "codex-copilot-web",
          pid: process.pid,
          port: config.port,
          uptime: (Date.now() - startedAt) / 1_000,
          active_turns: activeTurns,
          models: config.models.map(model => model.id),
        });
      }
      if (url.pathname.startsWith("/v1/") && !authorized(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return Response.json(copilotCatalog(config));
      }
      if (req.method === "GET" && url.pathname === "/v1/responses") {
        return new Response("Responses WebSocket transport is not enabled on this local route", {
          status: 426,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        return track(() => copilotResponseRequest(req, config, adapterFactory));
      }
      if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
        return track(() => copilotCompactRequest(req, config, adapterFactory));
      }
      if (req.method === "POST" && url.pathname === "/admin/shutdown") {
        if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
        shuttingDown = true;
        setTimeout(() => {
          void closeCopilotBrowsers().finally(() => server.stop(true));
        }, 0);
        return Response.json({ status: "ok", active_turns: activeTurns });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  return server;
}
