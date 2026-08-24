import { randomUUID, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { formatErrorResponse } from "./bridge";
import {
  availableChatGptWebModelRoutes,
  isChatGptWebModelSlug,
  requireChatGptWebModelRoute,
} from "./chatgpt-web-models";
import type { AppConfig } from "./config";
import { readJsonRequestBody } from "./http-body";

export interface ExternalResponseOptions {
  responseId: string;
}

export type ExternalResponsesDelegate = (
  request: Request,
  config: AppConfig,
  options: ExternalResponseOptions,
) => Promise<Response>;

const RESPONSE_ID = /^resp_ext_([a-f0-9]{32})_([a-f0-9]{32})_[a-f0-9]{16}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function randomHex(): string {
  return randomUUID().replaceAll("-", "");
}

function responseId(threadId: string, turnId: string): string {
  return `resp_ext_${threadId.slice("ext_thread_".length)}_${turnId.slice("ext_turn_".length)}_${randomHex().slice(0, 16)}`;
}

function previousIdentity(value: unknown): { threadId: string; turnId: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("previous_response_id must be a string");
  const match = RESPONSE_ID.exec(value);
  if (!match) throw new Error("previous_response_id was not issued by this external API");
  return { threadId: `ext_thread_${match[1]}`, turnId: `ext_turn_${match[2]}` };
}

function authorized(request: Request, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function externalRoot(): string {
  const root = process.platform === "win32" ? "C:\\codex-chatgpt-web-external" : "/codex-chatgpt-web-external";
  if (!isAbsolute(root)) throw new Error("External API read-only root must be absolute");
  return resolve(root);
}

function environmentContext(root: string): string {
  const escaped = root
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  return `<environment_context>
  <cwd>${escaped}</cwd>
  <filesystem><workspace_roots><root>${escaped}</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"></file_system></permission_profile></filesystem>
</environment_context>`;
}

function withTurnMetadata(value: unknown, turnId: string): unknown {
  const item = record(value);
  if (!item) return value;
  const message = item.type === "message" || (item.type === undefined && typeof item.role === "string");
  return {
    ...item,
    ...(message ? { type: "message", id: `msg_ext_${randomHex()}` } : {}),
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function inputItemType(value: unknown): string | undefined {
  const item = record(value);
  if (!item) return undefined;
  if (typeof item.type === "string") return item.type;
  return typeof item.role === "string" ? "message" : undefined;
}

function validateExternalInput(input: unknown): { hasUser: boolean; error?: string } {
  if (typeof input === "string") {
    return input.length > 0
      ? { hasUser: true }
      : { hasUser: false, error: "input must not be empty" };
  }
  if (!Array.isArray(input) || input.length === 0) {
    return { hasUser: false, error: "input must be a non-empty string or array" };
  }
  const allowed = new Set(["message", "reasoning", "function_call", "function_call_output"]);
  let hasUser = false;
  for (const value of input) {
    const type = inputItemType(value);
    if (!type || !allowed.has(type)) {
      return { hasUser: false, error: "External API input supports only messages, reasoning, and function call items" };
    }
    const item = record(value)!;
    if (type === "message" && item.role === "user") hasUser = true;
  }
  return { hasUser };
}

function canonicalInput(input: unknown, turnId: string, root: string): unknown[] {
  const items = typeof input === "string"
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }]
    : Array.isArray(input)
      ? input
      : [];
  const normalized = items.map(item => withTurnMetadata(item, turnId));
  let userIndex = -1;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    if (inputItemType(normalized[index]) === "message" && record(normalized[index])?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return normalized;
  let environmentIndex = userIndex;
  while (environmentIndex > 0 && record(normalized[environmentIndex - 1])?.role === "developer") {
    environmentIndex -= 1;
  }
  normalized.splice(environmentIndex, 0, withTurnMetadata({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: environmentContext(root) }],
  }, turnId));
  return normalized;
}

function validateExternalTools(value: unknown): { usesTools: boolean; error?: string } {
  if (value === undefined) return { usesTools: false };
  if (!Array.isArray(value)) return { usesTools: false, error: "tools must be an array" };
  const names = new Set<string>();
  for (const raw of value) {
    const tool = record(raw);
    if (!tool || tool.type !== "function" || typeof tool.name !== "string"
      || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)
      || (tool.description !== undefined && typeof tool.description !== "string")
      || (tool.parameters !== undefined && !record(tool.parameters))) {
      return { usesTools: false, error: "External API supports only standard function tools" };
    }
    if (names.has(tool.name)) return { usesTools: false, error: `Duplicate tool name: ${tool.name}` };
    names.add(tool.name);
  }
  return { usesTools: value.length > 0 };
}

function modelsResponse(config: AppConfig): Response {
  const created = Math.floor(Date.now() / 1_000);
  return Response.json({
    object: "list",
    data: availableChatGptWebModelRoutes(config).map(route => ({
      id: route.slug,
      object: "model",
      created,
      owned_by: "chatgpt-web",
    })),
  });
}

export async function externalApiRequest(
  request: Request,
  config: AppConfig,
  delegate: ExternalResponsesDelegate,
): Promise<Response> {
  if (!config.externalApi?.enabled) return new Response("Not found", { status: 404 });
  if (!authorized(request, config.externalApi.token)) {
    return formatErrorResponse(401, "authentication_error", "Invalid external API bearer token");
  }

  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/v1/models") return modelsResponse(config);
  if (request.method !== "POST" || url.pathname !== "/v1/responses") {
    return new Response("Not found", { status: 404 });
  }

  let raw: Record<string, unknown>;
  try {
    const body = await readJsonRequestBody(request);
    if (!record(body)) throw new Error("Request body must be a JSON object");
    raw = body as Record<string, unknown>;
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }

  if (typeof raw.model !== "string" || !isChatGptWebModelSlug(raw.model)) {
    return formatErrorResponse(400, "invalid_request_error", "External API model must use a chatgpt-web/ route");
  }
  try {
    requireChatGptWebModelRoute(raw.model, config);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  const inputValidation = validateExternalInput(raw.input);
  if (inputValidation.error) return formatErrorResponse(400, "invalid_request_error", inputValidation.error);
  const toolValidation = validateExternalTools(raw.tools);
  if (toolValidation.error) return formatErrorResponse(400, "invalid_request_error", toolValidation.error);
  if (toolValidation.usesTools && config.mode !== "full") {
    return formatErrorResponse(400, "invalid_request_error", "External function tools require a configured Full harness");
  }

  let previous: ReturnType<typeof previousIdentity>;
  try {
    previous = previousIdentity(raw.previous_response_id);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }
  const currentUserMessage = inputValidation.hasUser;
  if (!previous && !currentUserMessage) {
    return formatErrorResponse(400, "invalid_request_error", "A new external response requires user input");
  }
  const threadId = previous?.threadId ?? `ext_thread_${randomHex()}`;
  const turnId = previous && !currentUserMessage ? previous.turnId : `ext_turn_${randomHex()}`;
  const root = externalRoot();
  const metadata = {
    thread_id: threadId,
    turn_id: turnId,
    request_kind: "turn",
    sandbox: "read-only",
    workspaces: { [root]: {} },
  };
  const body = {
    ...raw,
    input: canonicalInput(raw.input, turnId, root),
    prompt_cache_key: threadId,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
  };
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.set("content-type", "application/json");
  const internal = new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: request.signal,
  });
  const scopedConfig = toolValidation.usesTools ? config : { ...config, mode: "browser-only" as const };
  return delegate(internal, scopedConfig, { responseId: responseId(threadId, turnId) });
}
