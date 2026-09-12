import { createHash } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const PUBLIC_TOOLS = new Set([
  "codex_turn_start", "codex_exec", "codex_write_stdin", "codex_apply_patch",
  "codex_view_image", "codex_tool_inventory", "codex_tool_call", "codex_turn_complete",
]);
const ARGUMENT_KEYS = new Set([
  "turn_token", "request_id", "cmd", "workdir", "yield_time_ms", "max_output_tokens", "tty",
  "session_id", "chars", "patch", "path", "detail", "query", "offset", "limit", "include_schema",
  "wire_name", "arguments", "input", "final_answer",
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function digest(value: string) {
  return { chars: value.length, sha256: createHash("sha256").update(value).digest("hex") };
}

function valueShape(value: unknown) {
  return {
    type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    ...(typeof value === "string" ? { chars: value.length } : {}),
    ...(value && typeof value === "object" ? { json_bytes: Buffer.byteLength(JSON.stringify(value)) } : {}),
  };
}

function safeWireName(value: unknown) {
  if (typeof value !== "string") return { type: typeof value };
  return /^[A-Za-z0-9_$.-]{1,200}$/.test(value) && !/(?:turn|binding|control|call)_[A-Za-z0-9_-]{16,}/.test(value)
    ? value : digest(value);
}

function inventorySummary(result: Record<string, unknown>) {
  const catalog = object(result.structuredContent);
  if (!catalog || !Array.isArray(catalog.tools)) return { available: false };
  return {
    returned: catalog.tools.length,
    total: typeof catalog.total === "number" ? catalog.total : null,
    next_offset: typeof catalog.next_offset === "number" ? catalog.next_offset : null,
    tools: catalog.tools.slice(0, 50).map(value => {
      const tool = object(value) ?? {};
      return {
        wire_name: safeWireName(tool.wire_name),
        kind: ["freeform", "tool_search", "function", "gateway"].includes(String(tool.kind)) ? tool.kind : "unknown",
        description: digest(typeof tool.description === "string" ? tool.description : ""),
        ...(tool.parameters !== undefined ? { schema: digest(JSON.stringify(tool.parameters)) } : {}),
      };
    }),
  };
}

function errorSummary(value: unknown) {
  const error = object(value) ?? {};
  const text = typeof error.message === "string" ? error.message
    : Array.isArray(error.content) ? error.content.map(item => object(item)?.text)
      .filter((part): part is string => typeof part === "string").join("\n") : "";
  // SDK messages can interpolate arbitrary argument paths/values. Only emit a fixed category;
  // retain a fingerprint, never the message or a model-authored/tool-returned error body.
  return {
    category: /^(?:MCP error -32602: )?Input validation error: Invalid arguments for tool /.test(text)
      ? "input_validation_error" : "unclassified_error",
    ...(typeof error.code === "number" ? { code: error.code } : {}),
    text: digest(text),
  };
}

/** Observe the stdio boundary before SDK input validation, without changing the MCP contract. */
export function instrumentChatGptMcpTransport(
  transport: Transport,
  write: (event: Record<string, unknown>) => void = event => console.error(`[chatgpt-web-mcp] transport=${JSON.stringify(event)}`),
): Transport {
  let sequence = 0;
  const pending = new Map<string, { started: number; sequence: number; tool: unknown; inventory: boolean }>();
  const emit = (event: Record<string, unknown>) => {
    // A diagnostics sink failure must not reject or alter a tool invocation.
    try { write({ at: new Date().toISOString(), ...event }); } catch { /* diagnostics only */ }
  };
  const requestKey = (id: string | number) => `${typeof id}:${id}`;
  const rpcId = (id: string | number) => typeof id === "number" ? id : digest(id);
  const onmessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if ("method" in message && message.method === "tools/call" && "id" in message) {
      const params = object(message.params) ?? {};
      const args = object(params.arguments);
      const tool = typeof params.name === "string" && PUBLIC_TOOLS.has(params.name) ? params.name
        : typeof params.name === "string" ? digest(params.name) : { type: typeof params.name };
      const key = requestKey(message.id);
      const duplicate = pending.has(key);
      // Bound bookkeeping if a client disappears without receiving its replies.
      if (pending.size >= 1_024) pending.delete(pending.keys().next().value!);
      const call = { started: performance.now(), sequence: ++sequence, tool, inventory: params.name === "codex_tool_inventory" };
      pending.set(key, call);
      emit({
        event: "tool_call_received", rpc_id: rpcId(message.id), call_sequence: call.sequence, tool,
        ...(duplicate ? { duplicate_pending_id: true } : {}),
        arguments: args ? Object.entries(args).map(([key, value]) => ({
          key: ARGUMENT_KEYS.has(key) ? key : digest(key), ...valueShape(value),
          ...(key === "query" && typeof value === "string" ? { sha256: digest(value).sha256 } : {}),
        })) : valueShape(params.arguments),
      });
    }
    onmessage?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message: JSONRPCMessage, options) => {
    const id = "id" in message && (typeof message.id === "string" || typeof message.id === "number") ? message.id : undefined;
    const key = id !== undefined ? requestKey(id) : undefined;
    const call = key !== undefined && !("method" in message) ? pending.get(key) : undefined;
    try {
      await send(message, options);
      if (call && id !== undefined) {
        const result = "result" in message ? object(message.result) : undefined;
        const isError = "error" in message || result?.isError === true;
        emit({
          event: "tool_call_replied", rpc_id: rpcId(id), call_sequence: call.sequence, tool: call.tool,
          elapsed_ms: Math.round(performance.now() - call.started),
          outcome: "error" in message ? "jsonrpc_error" : isError ? "tool_error" : "success",
          ...(isError ? { error: errorSummary("error" in message ? message.error : result) } : {}),
          ...(call.inventory && result && !isError ? { inventory: inventorySummary(result) } : {}),
        });
      }
    } catch (error) {
      if (call && id !== undefined) emit({
        event: "tool_call_reply_send_failed", rpc_id: rpcId(id), call_sequence: call.sequence,
        tool: call.tool, elapsed_ms: Math.round(performance.now() - call.started),
        error: errorSummary({ message: error instanceof Error ? error.message : "" }),
      });
      throw error;
    } finally {
      if (call && key !== undefined) pending.delete(key);
    }
  };
  const onclose = transport.onclose;
  transport.onclose = () => { pending.clear(); onclose?.(); };
  return transport;
}
