import { readJsonRequestBody } from "./http-body";
import { BRIDGE_REASONING_PREFIX } from "./responses/reasoning-envelope";
import { resolveOpenCodexUpstream, type OpenCodexUpstream } from "./opencodex";
import type { AppConfig } from "./config";

const CODEX_BACKEND = "https://chatgpt.com/backend-api/codex";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export type NativeFetch = (request: Request) => Promise<Response>;
export type NativeCodexEndpoint = "models" | "responses" | "responses/compact";

/** Runtime state for the resolved opencodex upstream. */
let activeOpenCodexUpstream: OpenCodexUpstream | null = null;
let openCodexConfigRef: AppConfig["opencodex"] | undefined;

/** Update the opencodex config reference (called from server startup and setup). */
export function setOpenCodexConfig(config: AppConfig["opencodex"]): void {
  openCodexConfigRef = config;
}

/** Whether opencodex auto-detection is enabled (defaults to true). */
function openCodexAutoDetectEnabled(): boolean {
  // Only active when explicitly enabled in config. Default is off — the user must
  // register opencodex as a provider in config.json for routing to activate.
  return openCodexConfigRef?.autoDetect === true;
}

/**
 * Resolve the effective upstream for native passthrough. When opencodex is running and
 * auto-detect is enabled (or an explicit URL is configured), requests route through it.
 * Otherwise, the direct ChatGPT backend is used.
 */
async function resolveNativeUpstream(): Promise<{ url: string; viaOpenCodex: boolean }> {
  if (!openCodexAutoDetectEnabled() && !openCodexConfigRef?.url) {
    return { url: CODEX_BACKEND, viaOpenCodex: false };
  }
  const upstream = await resolveOpenCodexUpstream(openCodexConfigRef?.url);
  if (upstream) {
    activeOpenCodexUpstream = upstream;
    return { url: `${upstream.baseUrl}/v1`, viaOpenCodex: true };
  }
  return { url: CODEX_BACKEND, viaOpenCodex: false };
}

/** Returns the currently active opencodex upstream, if any. */
export function getActiveOpenCodexUpstream(): OpenCodexUpstream | null {
  return activeOpenCodexUpstream;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBridgeReasoningItem(value: unknown): value is JsonObject {
  if (!isObject(value) || value.type !== "reasoning") return false;
  const encrypted = value.encrypted_content;
  if (typeof encrypted === "string" && encrypted.startsWith(BRIDGE_REASONING_PREFIX)) return true;
  return typeof value.id === "string"
    && /^rs_[0-9a-f]{32}$/i.test(value.id)
    && (encrypted === undefined || encrypted === null)
    && (Array.isArray(value.summary) || Array.isArray(value.content));
}

/**
 * Response item ids are scoped to the backend that created them. A ChatGPT Web response is
 * generated locally, so replaying its `rs_*` id after switching back to native Codex makes the
 * official backend try to load an item it has never stored. Once a Web reasoning item proves that
 * the history crossed providers, send the complete item content without any provider-local ids.
 */
export function scrubBridgeArtifactsForNative(value: unknown): { value: unknown; changed: boolean } {
  if (!isObject(value) || !Array.isArray(value.input) || !value.input.some(isBridgeReasoningItem)) {
    return { value, changed: false };
  }

  const input = value.input.flatMap(item => {
    if (!isObject(item)) return [item];
    const clean = { ...item };
    delete clean.id;
    if (clean.type !== "reasoning") return [clean];

    if (typeof clean.encrypted_content === "string"
      && clean.encrypted_content.startsWith(BRIDGE_REASONING_PREFIX)) {
      delete clean.encrypted_content;
    } else if (clean.encrypted_content === null) {
      delete clean.encrypted_content;
    }

    const hasSummary = Array.isArray(clean.summary) && clean.summary.length > 0;
    const hasContent = Array.isArray(clean.content) && clean.content.length > 0;
    const hasNativeEncryptedContent = typeof clean.encrypted_content === "string";
    return hasSummary || hasContent || hasNativeEncryptedContent ? [clean] : [];
  });
  const clean: JsonObject = { ...value, input };
  delete clean.previous_response_id;
  return { value: clean, changed: true };
}

function endToEndHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  headers.delete("content-length");
  return headers;
}

export async function forwardNativeCodexRequest(
  request: Request,
  endpoint: NativeCodexEndpoint,
  fetchUpstream: NativeFetch = fetch,
  decodedBody?: unknown,
): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    throw new Error("Native Codex passthrough requires the incoming Bearer authorization");
  }

  const { url: upstreamBase } = await resolveNativeUpstream();
  const incomingUrl = new URL(request.url);
  const headers = endToEndHeaders(request.headers);
  if (endpoint === "models") headers.delete("if-none-match");
  const method = endpoint === "models" ? "GET" : "POST";
  let body: BodyInit | undefined;
  if (method === "POST") {
    const parseRequest = decodedBody === undefined ? request.clone() : undefined;
    const originalBody = await request.arrayBuffer();
    const scrubbed = scrubBridgeArtifactsForNative(
      decodedBody === undefined ? await readJsonRequestBody(parseRequest!) : decodedBody,
    );
    if (scrubbed.changed) {
      headers.delete("content-encoding");
      body = JSON.stringify(scrubbed.value);
    } else {
      body = originalBody;
    }
  }
  const upstreamRequest = new Request(`${upstreamBase}/${endpoint}${incomingUrl.search}`, {
    method,
    headers,
    ...(body ? { body } : {}),
    signal: request.signal,
  });
  const upstream = await fetchUpstream(upstreamRequest);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: endToEndHeaders(upstream.headers),
  });
}
