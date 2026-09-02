import { readJsonRequestBody } from "./http-body";
import {
  BRIDGE_COMPACTION_PREFIX,
  SUMMARY_PREFIX,
  decodeCompactionSummary,
} from "./responses/compaction";
import { BRIDGE_REASONING_PREFIX } from "./responses/reasoning-envelope";

const CODEX_BACKEND = "https://chatgpt.com/backend-api/codex";
const FIRST_PARTY_CODEX_ORIGINATORS = new Set([
  "codex_cli_rs",
  "codex-tui",
  "codex_vscode",
  "codex_atlas",
  "codex_chatgpt_desktop",
]);
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

export interface NativeCodexPassthroughOptions {
  plaintextMultiAgentV2Messages?: boolean;
}

type JsonObject = Record<string, unknown>;
type BridgeCompactionItem = JsonObject & { type: "compaction"; encrypted_content: string };

function firstPartyCodexOriginator(value: string): boolean {
  return FIRST_PARTY_CODEX_ORIGINATORS.has(value)
    || /^Codex [A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(value);
}

/**
 * Current Codex clients identify themselves as `<originator>/<cargo semver> (...)`. The models
 * backend requires the release-only `major.minor.patch` value even when the client is an alpha.
 * Derive it only from the documented first-party Codex prefix; an arbitrary browser or proxy
 * User-Agent is not evidence of a Codex version and leaves the original request untouched.
 */
export function codexClientVersionFromUserAgent(userAgent: string | null): string | undefined {
  if (!userAgent) return undefined;
  const separator = userAgent.indexOf("/");
  if (separator < 1) return undefined;
  const originator = userAgent.slice(0, separator);
  if (!firstPartyCodexOriginator(originator)) return undefined;
  const version = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]+)?(?:\s|$)/
    .exec(userAgent.slice(separator + 1));
  return version ? `${version[1]}.${version[2]}.${version[3]}` : undefined;
}

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

function isBridgeCompactionItem(value: unknown): value is BridgeCompactionItem {
  return isObject(value)
    && value.type === "compaction"
    && typeof value.encrypted_content === "string"
    && value.encrypted_content.startsWith(BRIDGE_COMPACTION_PREFIX);
}

/**
 * Response item ids are scoped to the backend that created them. A ChatGPT Web response is
 * generated locally, so replaying its `rs_*` id after switching back to native Codex makes the
 * official backend try to load an item it has never stored. The same boundary applies to local
 * `ocx1:` compaction checkpoints: preserve their decoded summary as a normal input message rather
 * than asking the official backend to decrypt a bridge-owned envelope. Once either artifact proves
 * that the history crossed providers, send the complete item content without provider-local ids.
 */
export function scrubBridgeArtifactsForNative(value: unknown): { value: unknown; changed: boolean } {
  if (!isObject(value)
    || !Array.isArray(value.input)
    || !value.input.some(item => isBridgeReasoningItem(item) || isBridgeCompactionItem(item))) {
    return { value, changed: false };
  }

  const input = value.input.flatMap(item => {
    if (!isObject(item)) return [item];
    const clean = { ...item };
    delete clean.id;
    if (isBridgeCompactionItem(clean)) {
      const summary = decodeCompactionSummary(clean.encrypted_content);
      if (summary === null) throw new Error("Invalid ChatGPT Web compaction checkpoint");
      return [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n\n${summary}` }],
      }];
    }
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

const MULTI_AGENT_V2_MESSAGE_TOOLS = new Set([
  "spawn_agent",
  "send_message",
  "followup_task",
]);

interface PlaintextMultiAgentV2Surface {
  namespaces: Set<string>;
  unnamespaced: boolean;
}

function emptyPlaintextMultiAgentV2Surface(): PlaintextMultiAgentV2Surface {
  return { namespaces: new Set(), unnamespaced: false };
}

function isMultiAgentV2Namespace(tool: JsonObject): tool is JsonObject & { name: string; tools: unknown[] } {
  if (tool.type !== "namespace" || typeof tool.name !== "string" || !Array.isArray(tool.tools)) {
    return false;
  }
  if (tool.name === "collaboration") return true;
  const names = new Set(tool.tools.flatMap(inner => isObject(inner)
    && inner.type === "function"
    && typeof inner.name === "string"
    ? [inner.name]
    : []));
  return [...MULTI_AGENT_V2_MESSAGE_TOOLS].every(name => names.has(name));
}

function plaintextMultiAgentV2MessageTool(tool: unknown): { tool: unknown; changed: boolean } {
  if (!isObject(tool)
    || tool.type !== "function"
    || typeof tool.name !== "string"
    || !MULTI_AGENT_V2_MESSAGE_TOOLS.has(tool.name)
    || !isObject(tool.parameters)
    || !isObject(tool.parameters.properties)
    || !isObject(tool.parameters.properties.message)
    || tool.parameters.properties.message.encrypted !== true) return { tool, changed: false };
  const message = { ...tool.parameters.properties.message };
  delete message.encrypted;
  return {
    tool: {
      ...tool,
      parameters: {
        ...tool.parameters,
        properties: {
          ...tool.parameters.properties,
          message,
        },
      },
    },
    changed: true,
  };
}

function plaintextMultiAgentV2ToolSchemas(
  tools: unknown[],
  surface: PlaintextMultiAgentV2Surface,
): { tools: unknown[]; changed: boolean } {
  let changed = false;
  const topLevelNames = new Set(tools.flatMap(tool => isObject(tool)
    && tool.type === "function"
    && typeof tool.name === "string"
    ? [tool.name]
    : []));
  const unnamespaced = [...MULTI_AGENT_V2_MESSAGE_TOOLS]
    .every(name => topLevelNames.has(name));
  if (unnamespaced) surface.unnamespaced = true;
  const rewritten = tools.map(tool => {
    if (unnamespaced && isObject(tool) && tool.type === "function") {
      const result = plaintextMultiAgentV2MessageTool(tool);
      if (result.changed) changed = true;
      return result.tool;
    }
    if (!isObject(tool) || !isMultiAgentV2Namespace(tool)) return tool;
    surface.namespaces.add(tool.name);
    let namespaceChanged = false;
    const innerTools = tool.tools.map(inner => {
      const result = plaintextMultiAgentV2MessageTool(inner);
      if (!result.changed) return inner;
      changed = true;
      namespaceChanged = true;
      return result.tool;
    });
    return namespaceChanged ? { ...tool, tools: innerTools } : tool;
  });
  return { tools: changed ? rewritten : tools, changed };
}

function plaintextMultiAgentV2MessageSchemas(value: unknown): {
  value: unknown;
  changed: boolean;
  surface: PlaintextMultiAgentV2Surface;
} {
  const surface = emptyPlaintextMultiAgentV2Surface();
  if (!isObject(value)) return { value, changed: false, surface };
  const topLevel = Array.isArray(value.tools)
    ? plaintextMultiAgentV2ToolSchemas(value.tools, surface)
    : { tools: value.tools, changed: false };
  let inputChanged = false;
  const input = Array.isArray(value.input) ? value.input.map(item => {
    if (!isObject(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
    const rewritten = plaintextMultiAgentV2ToolSchemas(item.tools, surface);
    if (!rewritten.changed) return item;
    inputChanged = true;
    return { ...item, tools: rewritten.tools };
  }) : value.input;
  if (!topLevel.changed && !inputChanged) return { value, changed: false, surface };
  return {
    value: {
      ...value,
      ...(topLevel.changed ? { tools: topLevel.tools } : {}),
      ...(inputChanged ? { input } : {}),
    },
    changed: true,
    surface,
  };
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
  let lineBuffer = "";
  let completed = false;
  let bytes = 0;
  const inspectLines = (text: string): void => {
    lineBuffer += text;
    let newline = lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newline + 1);
      if (line === SSE_TERMINATOR) completed = true;
      newline = lineBuffer.indexOf("\n");
    }
  };
  const inspectTrailingLine = (): void => {
    // A reset can arrive before the final line separator. Treat only an exact unterminated
    // terminator line as complete; text embedded in a JSON data payload must not qualify.
    if (lineBuffer.replace(/\r$/, "") === SSE_TERMINATOR) completed = true;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          inspectLines(decoder.decode());
          inspectTrailingLine();
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        inspectLines(decoder.decode(chunk.value, { stream: true }));
        controller.enqueue(chunk.value);
      } catch (error) {
        inspectTrailingLine();
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

function markPlaintextMultiAgentV2Calls(
  value: unknown,
  surface: PlaintextMultiAgentV2Surface,
): boolean {
  if (Array.isArray(value)) {
    return value.reduce(
      (changed, item) => markPlaintextMultiAgentV2Calls(item, surface) || changed,
      false,
    );
  }
  if (!isObject(value)) return false;
  let changed = false;
  const surfaceMatches = typeof value.namespace === "string"
    ? surface.namespaces.has(value.namespace)
    : value.namespace === undefined && surface.unnamespaced;
  if (value.type === "function_call"
    && surfaceMatches
    && typeof value.name === "string"
    && MULTI_AGENT_V2_MESSAGE_TOOLS.has(value.name)
    && value.encrypted_function_args === undefined) {
    value.encrypted_function_args = [];
    changed = true;
  }
  for (const child of Object.values(value)) {
    if (markPlaintextMultiAgentV2Calls(child, surface)) changed = true;
  }
  return changed;
}

function withPlaintextMultiAgentV2Markers(
  body: ReadableStream<Uint8Array>,
  surface: PlaintextMultiAgentV2Surface,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  const rewriteLine = (line: string): string => {
    const suffix = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    const content = suffix ? line.slice(0, -suffix.length) : line;
    if (!content.startsWith("data:")) return line;
    const data = content.slice(5).trimStart();
    if (!data || data === "[DONE]") return line;
    try {
      const event = JSON.parse(data) as unknown;
      return markPlaintextMultiAgentV2Calls(event, surface)
        ? `data: ${JSON.stringify(event)}${suffix}`
        : line;
    } catch {
      return line;
    }
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        controller.enqueue(encoder.encode(rewriteLine(buffered.slice(0, newline + 1))));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    },
    flush(controller) {
      buffered += decoder.decode();
      if (buffered) controller.enqueue(encoder.encode(rewriteLine(buffered)));
    },
  }));
}

export async function forwardNativeCodexRequest(
  request: Request,
  endpoint: NativeCodexEndpoint,
  fetchUpstream: NativeFetch = fetch,
  decodedBody?: unknown,
  options: NativeCodexPassthroughOptions = {},
): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ") || authorization.length <= "Bearer ".length) {
    throw new Error("Native Codex passthrough requires the incoming Bearer authorization");
  }

  const incomingUrl = new URL(request.url);
  if (endpoint === "models" && !incomingUrl.searchParams.has("client_version")) {
    const clientVersion = codexClientVersionFromUserAgent(request.headers.get("user-agent"));
    if (clientVersion) incomingUrl.searchParams.set("client_version", clientVersion);
  }
  const headers = endToEndHeaders(request.headers);
  if (endpoint === "models") headers.delete("if-none-match");
  const method = endpoint === "models" ? "GET" : "POST";
  let body: BodyInit | undefined;
  let plaintextSurface = emptyPlaintextMultiAgentV2Surface();
  if (method === "POST") {
    const parseRequest = decodedBody === undefined ? request.clone() : undefined;
    const originalBody = await request.arrayBuffer();
    const scrubbed = scrubBridgeArtifactsForNative(
      decodedBody === undefined ? await readJsonRequestBody(parseRequest!) : decodedBody,
    );
    const prepared = options.plaintextMultiAgentV2Messages
      ? plaintextMultiAgentV2MessageSchemas(scrubbed.value)
      : {
        value: scrubbed.value,
        changed: false,
        surface: emptyPlaintextMultiAgentV2Surface(),
      };
    plaintextSurface = prepared.surface;
    if (scrubbed.changed || prepared.changed) {
      headers.delete("content-encoding");
      body = JSON.stringify(prepared.value);
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
  const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
  const isEventStream = contentType.includes("text/event-stream");
  const rewritePlaintextCalls = plaintextSurface.unnamespaced
    || plaintextSurface.namespaces.size > 0;
  if (rewritePlaintextCalls && upstream.body && contentType.includes("application/json")) {
    const original = await upstream.text();
    let rewritten = original;
    try {
      const json = JSON.parse(original) as unknown;
      if (markPlaintextMultiAgentV2Calls(json, plaintextSurface)) {
        rewritten = JSON.stringify(json);
      }
    } catch {
      // Preserve a malformed upstream body so the native Codex client reports the protocol error.
    }
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    return new Response(rewritten, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }
  if (rewritePlaintextCalls && upstream.body && isEventStream) {
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
  }
  const upstreamBody = upstream.body
    ? withUncleanCloseTolerance(upstream.body, isEventStream, bytes => {
      console.warn(
        `[codex-chatgpt-web] native_upstream_unclean_close endpoint=${endpoint} bytes=${bytes}`
        + " (turn had already completed; closing the client stream normally)",
      );
    })
    : upstream.body;
  return new Response(
    rewritePlaintextCalls && upstreamBody && isEventStream
      ? withPlaintextMultiAgentV2Markers(upstreamBody, plaintextSurface)
      : upstreamBody,
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    },
  );
}
