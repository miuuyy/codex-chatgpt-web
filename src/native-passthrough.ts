import { readJsonRequestBody } from "./http-body";
import { BRIDGE_REASONING_PREFIX } from "./responses/reasoning-envelope";

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
export type NativeCodexEndpoint = "models" | "responses" | "responses/compact" | "alpha/search";

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

/** Terminator every Responses SSE stream ends with; nothing after it carries meaning. */
const SSE_TERMINATOR = "data: [DONE]";
/** Enough trailing bytes to recognise the terminator across a chunk boundary. */
const SSE_TAIL_WINDOW = 64;

/**
 * ChatGPT's backend routinely resets the native Codex connection instead of closing it cleanly,
 * which Bun surfaces as ECONNRESET while reading the body. Passed through untouched that reaches
 * Codex as a truncated HTTP body and the opaque "error decoding response body".
 *
 * A reset that arrives after the stream already delivered `data: [DONE]` is an unclean TCP close on
 * a turn that finished: every byte the protocol defines has been forwarded, so the stream is closed
 * normally rather than failed. A reset before that genuinely truncated the turn and is still raised,
 * because inventing a terminal event there would tell Codex a turn ended when it did not.
 */
function withUncleanCloseTolerance(
  body: ReadableStream<Uint8Array>,
  isEventStream: boolean,
  onUncleanClose?: (bytes: number) => void,
): ReadableStream<Uint8Array> {
  if (!isEventStream) return body;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let completed = false;
  let bytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        tail = (tail + decoder.decode(chunk.value, { stream: true })).slice(-SSE_TAIL_WINDOW);
        if (tail.includes(SSE_TERMINATOR)) completed = true;
        controller.enqueue(chunk.value);
      } catch (error) {
        if (!completed) {
          controller.error(error);
          return;
        }
        onUncleanClose?.(bytes);
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
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
  const upstreamRequest = new Request(`${CODEX_BACKEND}/${endpoint}${incomingUrl.search}`, {
    method,
    headers,
    ...(body ? { body } : {}),
    signal: request.signal,
  });
  const upstream = await fetchUpstream(upstreamRequest);
  const responseHeaders = endToEndHeaders(upstream.headers);
  const isEventStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  return new Response(
    upstream.body
      ? withUncleanCloseTolerance(upstream.body, isEventStream, bytes => {
        console.warn(
          `[codex-chatgpt-web] native_upstream_unclean_close endpoint=${endpoint} bytes=${bytes}`
          + " (turn had already completed; closing the client stream normally)",
        );
      })
      : upstream.body,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    },
  );
}
