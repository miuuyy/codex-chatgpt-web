import { createHash } from "node:crypto";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import type { ChatGptTurnEnvironment } from "./environment";
import { callTurnBroker, type BrokerToolResult } from "./turn-broker";

interface ClaimedTurn {
  bindingId: string;
  environment: ChatGptTurnEnvironment & { expiresAt: number };
}

interface ResolvedTurn {
  environment: ChatGptTurnEnvironment & { expiresAt: number };
}

const bindingSchema = z.string().min(20).max(256).describe("Opaque binding_id returned by codex_bind_turn.");
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});
const obviousTextExtensions = new Set([
  ".c", ".cc", ".conf", ".cpp", ".css", ".csv", ".env", ".go", ".h", ".hpp",
  ".html", ".ini", ".java", ".js", ".json", ".jsx", ".log", ".md", ".mjs",
  ".php", ".py", ".rb", ".rs", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx",
  ".tsv", ".txt", ".xml", ".yaml", ".yml", ".zsh",
]);

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function requestScopeSummary(extra: {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
}): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: String(extra.requestId),
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function rejectUnsupportedUltraSpawn(
  environment: ChatGptTurnEnvironment,
  tool: CodexTool,
): void {
  if (environment.ultraWorkerModel && /(?:^|__)spawn_agent$/.test(wireName(tool))) {
    throw new Error(
      "Direct collaboration spawn_agent is incompatible with the ChatGPT Web bridge; "
      + "use the reserved Ultra worker envelope through codex_exec",
    );
  }
}

function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

const workerResultFilter = String.raw`
const [eventsPath, stderrPath, rawStatus] = process.argv.slice(1);
const status = Number(rawStatus);
const lines = (await Bun.file(eventsPath).text()).split(/\r?\n/);
let workerTaskId;
let finalReport;
const errors = [];
for (const line of lines) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event?.type === "thread.started" && typeof event.thread_id === "string") {
    workerTaskId = event.thread_id;
  }
  if (event?.type === "item.completed"
      && event.item?.type === "agent_message"
      && typeof event.item.text === "string") {
    finalReport = event.item.text;
  }
  if (event?.type === "error") {
    errors.push(typeof event.message === "string" ? event.message : JSON.stringify(event));
  }
}
const maxReportChars = 60_000;
const reportTruncated = typeof finalReport === "string" && finalReport.length > maxReportChars;
if (reportTruncated) finalReport = finalReport.slice(0, maxReportChars);
const stderr = status === 0 ? "" : (await Bun.file(stderrPath).text()).trim().slice(-4_000);
const { unlink } = await import("node:fs/promises");
await Promise.allSettled([unlink(eventsPath), unlink(stderrPath)]);
console.log(JSON.stringify({
  worker_task_id: workerTaskId ?? null,
  exit_code: status,
  final_report: finalReport ?? null,
  final_report_truncated: reportTruncated,
  errors: errors.slice(-3),
  ...(stderr ? { stderr_tail: stderr } : {}),
}));
if (status === 0 && (!workerTaskId || !finalReport)) process.exitCode = 91;
`.trim();

export const ULTRA_WORKER_COMMAND_PREFIX = "[[CODEX_ULTRA_WORKER]]\n";

export function ultraWorkerCommand(
  model: string,
  task: string,
  workerCodexHome = process.env.CODEX_CHATGPT_WEB_WORKER_CODEX_HOME?.trim(),
): string {
  if (workerCodexHome && !isAbsolute(workerCodexHome)) {
    throw new Error("CODEX_CHATGPT_WEB_WORKER_CODEX_HOME must be an absolute path");
  }
  const appCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const workerEnvironment = workerCodexHome
    ? `CODEX_HOME=${shellQuote(workerCodexHome)} `
    : "";
  return [
    "set -u",
    'codex_bin=""',
    'if [ -n "${CODEX_CHATGPT_WEB_CODEX_BIN:-}" ] && [ -x "$CODEX_CHATGPT_WEB_CODEX_BIN" ]; then codex_bin="$CODEX_CHATGPT_WEB_CODEX_BIN"; '
      + `elif [ -x ${shellQuote(appCodex)} ]; then codex_bin=${shellQuote(appCodex)}; `
      + 'else codex_bin="$(command -v codex 2>/dev/null || true)"; fi',
    'if [ -z "$codex_bin" ]; then printf "native Codex executable not found\\n" >&2; exit 127; fi',
    'events_file="$(mktemp -t codex-ultra-worker-events.XXXXXX)"',
    'stderr_file="$(mktemp -t codex-ultra-worker-stderr.XXXXXX)"',
    `${workerEnvironment}"$codex_bin" -s read-only -c model_reasoning_effort=low exec --json`
      + ` -m ${shellQuote(model)} ${shellQuote(task)} >"$events_file" 2>"$stderr_file"`,
    "worker_status=$?",
    `${shellQuote(process.execPath)} -e ${shellQuote(workerResultFilter)} "$events_file" "$stderr_file" "$worker_status"`,
    "filter_status=$?",
    'if [ "$worker_status" -ne 0 ]; then exit "$worker_status"; fi',
    'exit "$filter_status"',
  ].join("\n");
}

function exactTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  return environment.tools.find(tool => !tool.namespace && tool.name === name);
}

function namedTool(environment: ChatGptTurnEnvironment, requestedWireName: string): CodexTool {
  const tool = environment.tools.find(candidate => wireName(candidate) === requestedWireName);
  if (!tool) throw new Error(`Codex tool is not available in this turn: ${requestedWireName}`);
  return tool;
}

function invocationTimeout(environment: ChatGptTurnEnvironment & { expiresAt: number }): number {
  return Math.max(1, environment.expiresAt - Date.now());
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: value._meta as Record<string, unknown> }
      : {}),
  };
}

function textFileMcpResult(value: ReturnType<typeof asMcpResult>) {
  const structured = value.structuredContent as Record<string, unknown> | undefined;
  let output = typeof structured?.output === "string" ? structured.output : undefined;
  const content = value.content as unknown as Array<{ type?: unknown; text?: unknown }>;
  if (output === undefined) {
    for (const part of content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      const candidates = [part.text];
      const outputMarker = part.text.lastIndexOf("\nOutput:\n");
      if (outputMarker >= 0) candidates.unshift(part.text.slice(outputMarker + "\nOutput:\n".length));
      for (const candidate of candidates) {
        try {
          const parsed = JSON.parse(candidate) as Record<string, unknown>;
          if (typeof parsed.output === "string") {
            output = parsed.output;
            break;
          }
        } catch {
          // The next content block can contain the structured command output.
        }
      }
      if (output !== undefined) break;
    }
  }
  if (output === undefined) return value;
  return {
    content: [{ type: "text" as const, text: output }],
    structuredContent: { text: output },
    ...(value.isError ? { isError: true } : {}),
  };
}

function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
}

function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
): string {
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return [
    `const result = await tools[${JSON.stringify(gatewayNestedToolName(nestedToolName))}](${JSON.stringify(nestedInput)});`,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

export async function runChatGptMcpServer(options: { brokerSocketPath: string }): Promise<void> {
  const server = new McpServer({ name: "codex-native", version: "3.0.0" });

  const environment = async (bindingId: string): Promise<ChatGptTurnEnvironment & { expiresAt: number }> => {
    const resolved = await callTurnBroker<ResolvedTurn>(options.brokerSocketPath, { method: "resolve", bindingId });
    if (resolved.environment.expiresAt <= Date.now()) throw new Error("Codex turn binding expired");
    return resolved.environment;
  };

  const invoke = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
  ) => {
    const response = await callTurnBroker<BrokerToolResult>(options.brokerSocketPath, {
      method: "invoke",
      bindingId,
      wireName: wireName(tool),
      freeform: tool.freeform === true,
      ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
    }, invocationTimeout(bound));
    return asMcpResult(response);
  };

  const invokeNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
  ) => {
    const gateway = execGateway(bound);
    if (tool.toolSearch || tool.loadedFromToolSearch) {
      return invoke(bindingId, bound, tool, payload);
    }
    return gateway && gateway !== tool
      ? invoke(bindingId, bound, gateway, { input: execGatewayProgram(wireName(tool), tool.freeform === true, payload) })
      : invoke(bindingId, bound, tool, payload);
  };

  const invokeNestedNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This Codex turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    return invoke(bindingId, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload),
    });
  };

  server.registerTool(
    "codex_bind_turn",
    {
      title: "Bind this response to its Codex turn",
      description: "Idempotently claim the capability for the current outer Codex turn before calling its native tools.",
      inputSchema: { turn_token: z.string().min(20).max(256) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ turn_token }, extra) => {
      console.error(`[chatgpt-web-mcp] codex_bind_turn scope=${requestScopeSummary(extra)}`);
      const claimed = await callTurnBroker<ClaimedTurn>(options.brokerSocketPath, { method: "claim", token: turn_token });
      const commandTool = exactTool(claimed.environment, "exec_command") ?? exactTool(claimed.environment, "shell_command");
      const gateway = execGateway(claimed.environment);
      return result({
        binding_id: claimed.bindingId,
        harness_version: 3,
        execution: "outer_codex_native",
        cwd: claimed.environment.cwd,
        roots: claimed.environment.roots,
        writable_roots: claimed.environment.writableRoots,
        sandbox: claimed.environment.sandboxPolicy.type,
        expires_at: new Date(claimed.environment.expiresAt).toISOString(),
        tool_count: claimed.environment.tools.length,
        command_tool: commandTool ? wireName(commandTool) : gateway ? "exec_command" : null,
        outer_tool_gateway: gateway ? wireName(gateway) : null,
        ultra_worker_model: claimed.environment.ultraWorkerModel ?? null,
        capabilities: [
          "native_tool_loop",
          "session_history",
          "exec",
          "apply_patch",
          "images",
          "tool_registry",
          ...(claimed.environment.ultraWorkerModel ? ["ultra_process_workers"] : []),
        ],
      });
    },
  );

  server.registerTool(
    "codex_exec",
    {
      title: "Run a native Codex command",
      description: "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id.",
      inputSchema: {
        binding_id: bindingSchema,
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ binding_id, cmd, workdir, yield_time_ms, max_output_tokens, tty }, extra) => {
      console.error(`[chatgpt-web-mcp] codex_exec scope=${requestScopeSummary(extra)}`);
      const bound = await environment(binding_id);
      const workerTask = cmd.startsWith(ULTRA_WORKER_COMMAND_PREFIX)
        ? cmd.slice(ULTRA_WORKER_COMMAND_PREFIX.length).trim()
        : undefined;
      if (workerTask !== undefined && !workerTask) {
        throw new Error("The reserved Ultra worker envelope requires a non-empty task");
      }
      if (workerTask !== undefined && !bound.ultraWorkerModel) {
        throw new Error("The reserved Ultra worker envelope is available only for ChatGPT Web Ultra");
      }
      const effectiveCommand = workerTask === undefined
        ? cmd
        : ultraWorkerCommand(bound.ultraWorkerModel!, workerTask);
      const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
      const commandName = tool?.name ?? "exec_command";
      const args = commandName === "exec_command"
        ? {
            cmd: effectiveCommand,
            ...(workdir ? { workdir } : {}),
            ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
            ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
            ...(tty !== undefined ? { tty } : {}),
          }
        : {
            command: effectiveCommand,
            ...(workdir ? { workdir } : {}),
            ...(yield_time_ms !== undefined ? { timeout_ms: yield_time_ms } : {}),
          };
      return tool
        ? invokeNative(binding_id, bound, tool, { arguments: args })
        : invokeNestedNative(binding_id, bound, commandName, false, { arguments: args });
    },
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a native Codex command session",
      description: "Write characters to, or poll, a session_id returned by codex_exec.",
      inputSchema: {
        binding_id: bindingSchema,
        session_id: z.number().int().nonnegative(),
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ binding_id, session_id, chars, yield_time_ms, max_output_tokens }) => {
      const bound = await environment(binding_id);
      const tool = exactTool(bound, "write_stdin");
      const payload = { arguments: {
        session_id,
        ...(chars !== undefined ? { chars } : {}),
        ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
        ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
      } };
      return tool
        ? invokeNative(binding_id, bound, tool, payload)
        : invokeNestedNative(binding_id, bound, "write_stdin", false, payload);
    },
  );

  server.registerTool(
    "codex_apply_patch",
    {
      title: "Apply a native Codex patch",
      description: "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task.",
      inputSchema: { binding_id: bindingSchema, patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ binding_id, patch }) => {
      const bound = await environment(binding_id);
      const tool = exactTool(bound, "apply_patch");
      if (!tool) return invokeNestedNative(binding_id, bound, "apply_patch", true, { input: patch });
      return tool.freeform
        ? invokeNative(binding_id, bound, tool, { input: patch })
        : invokeNative(binding_id, bound, tool, { arguments: { input: patch } });
    },
  );

  server.registerTool(
    "codex_read_text_file",
    {
      title: "Read a text file through native Codex",
      description: "Read a text, source, config, log, JSON, or other non-image file through the outer Codex read-only sandbox. Use codex_view_image only for actual images.",
      inputSchema: {
        binding_id: bindingSchema,
        path: z.string().min(1).max(16_384),
        max_bytes: z.number().int().min(1).max(5_000_000).default(1_000_000),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ binding_id, path, max_bytes }) => {
      const bound = await environment(binding_id);
      if (!isAbsolute(path) || path.includes("\0")) {
        return result({ error: "Text file path must be an absolute local path." }, true);
      }
      const normalizedPath = resolve(path);
      if (!bound.roots.some(root => containsPath(root, normalizedPath))) {
        return result({ error: "Text file path is outside the active Codex workspace roots." }, true);
      }
      const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
      const commandName = tool?.name ?? "exec_command";
      const cmd = `/usr/bin/head -c ${max_bytes} -- ${shellQuote(normalizedPath)}`;
      const args = commandName === "exec_command"
        ? { cmd, workdir: bound.cwd, max_output_tokens: 1_000_000 }
        : { command: cmd, workdir: bound.cwd };
      const response = tool
        ? await invokeNative(binding_id, bound, tool, { arguments: args })
        : await invokeNestedNative(binding_id, bound, commandName, false, { arguments: args });
      return textFileMcpResult(response);
    },
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View an image through native Codex",
      description: "Inspect an actual image file through native Codex. Never use this for text, source, config, log, JSON, or other non-image files; use codex_read_text_file for those.",
      inputSchema: {
        binding_id: bindingSchema,
        path: z.string().min(1).max(16_384),
        detail: z.enum(["high", "original"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ binding_id, path, detail }) => {
      if (obviousTextExtensions.has(extname(path).toLowerCase())) {
        return result({
          error: "The requested path is a text or source file, not an image.",
          suggested_tool: "codex_read_text_file",
          guidance: "Use codex_read_text_file for text and source files.",
        }, true);
      }
      const bound = await environment(binding_id);
      const tool = exactTool(bound, "view_image");
      const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
      return tool
        ? invokeNative(binding_id, bound, tool, payload)
        : invokeNestedNative(binding_id, bound, "view_image", false, payload);
    },
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "Discover tools from the current Codex harness",
      description: "Search the exact tool registry supplied to the current outer Codex turn, including configured MCP/app tools.",
      inputSchema: {
        binding_id: bindingSchema,
        query: z.string().max(500).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        include_schema: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ binding_id, query, offset, limit, include_schema }) => {
      const bound = await environment(binding_id);
      const needle = query?.trim().toLowerCase();
      const matches = bound.tools.filter(tool => !needle || [
        wireName(tool),
        tool.name,
        tool.namespace ?? "",
        tool.description,
      ].join("\n").toLowerCase().includes(needle));
      const page = matches.slice(offset, offset + limit).map(tool => ({
        wire_name: wireName(tool),
        name: tool.name,
        namespace: tool.namespace ?? null,
        description: tool.description,
        kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
        ...(include_schema ? { parameters: tool.parameters } : {}),
      }));
      return result({
        tools: page,
        total: matches.length,
        next_offset: offset + page.length < matches.length ? offset + page.length : null,
      });
    },
  );

  server.registerTool(
    "codex_tool_call",
    {
      title: "Call any tool from the current Codex harness",
      description: "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle.",
      inputSchema: {
        binding_id: bindingSchema,
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
        input: z.string().max(5_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ binding_id, wire_name, arguments: args, input }) => {
      const bound = await environment(binding_id);
      const tool = namedTool(bound, wire_name);
      if (tool.freeform) {
        if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
        if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
        return invokeNative(binding_id, bound, tool, { input });
      }
      if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
      rejectUnsupportedUltraSpawn(bound, tool);
      return invokeNative(binding_id, bound, tool, {
        arguments: args ?? {},
      });
    },
  );

  await server.connect(new StdioServerTransport());
}
