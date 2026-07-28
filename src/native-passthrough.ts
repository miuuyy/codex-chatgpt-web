import { encodeJsonRequestBody, readJsonRequestBody } from "./http-body";

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

function endToEndHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers.append(name, value);
  }
  headers.delete("content-length");
  return headers;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripInputItemIdsWhenUnstored(value: unknown): unknown {
  if (!isObject(value) || value.store !== false || !Array.isArray(value.input)) return value;
  let changed = false;
  const input = value.input.map(item => {
    if (!isObject(item) || !Object.hasOwn(item, "id")) return item;
    changed = true;
    const next = { ...item };
    delete next.id;
    return next;
  });
  return changed ? { ...value, input } : value;
}

export async function forwardNativeCodexRequest(
  request: Request,
  endpoint: NativeCodexEndpoint,
  fetchUpstream: NativeFetch = fetch,
): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    throw new Error("Native Codex passthrough requires the incoming Bearer authorization");
  }

  const incomingUrl = new URL(request.url);
  const headers = endToEndHeaders(request.headers);
  if (endpoint === "models") headers.delete("if-none-match");
  const method = endpoint === "models" ? "GET" : "POST";
  let body: ArrayBuffer | undefined;
  if (method === "POST") {
    const inspectionRequest = endpoint === "responses" ? request.clone() : undefined;
    body = await request.arrayBuffer();
    if (inspectionRequest) {
      const parsed = await readJsonRequestBody(inspectionRequest);
      const sanitized = stripInputItemIdsWhenUnstored(parsed);
      if (sanitized !== parsed) {
        body = await encodeJsonRequestBody(
          sanitized,
          request.headers.get("content-encoding") ?? "identity",
        );
      }
    }
  }
  const upstreamRequest = new Request(`${CODEX_BACKEND}/${endpoint}${incomingUrl.search}`, {
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
