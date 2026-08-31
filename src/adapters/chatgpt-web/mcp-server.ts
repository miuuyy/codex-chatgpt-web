import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";
import { VERSION } from "../../version";

const MAX_BUFFERED_OUTPUT_CHARS = 4_000_000;
const COMPLETED_SESSION_TTL_MS = 10 * 60_000;

interface CommandSession {
  child: ChildProcessWithoutNullStreams;
  output: string;
  cursor: number;
  startedAt: number;
  done: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const commandSessions = new Map<number, CommandSession>();
let nextSessionId = 1;

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function commandShell(command: string): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  const configured = process.env.SHELL;
  const executable = configured && isAbsolute(configured) ? configured : "/bin/sh";
  return { executable, args: ["-lc", command] };
}

function appendOutput(session: CommandSession, chunk: Buffer | string): void {
  session.output += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  if (session.output.length > MAX_BUFFERED_OUTPUT_CHARS) {
    const removed = session.output.length - MAX_BUFFERED_OUTPUT_CHARS;
    session.output = session.output.slice(removed);
    session.cursor = Math.max(0, session.cursor - removed);
  }
}

function createCommandSession(command: string, workdir?: string): { id: number; session: CommandSession } {
  const cwd = resolve(workdir || homedir());
  if (!statSync(cwd).isDirectory()) throw new Error(`Command workdir is not a directory: ${cwd}`);
  const shell = commandShell(command);
  const child = spawn(shell.executable, shell.args, {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const id = nextSessionId++;
  const session: CommandSession = {
    child,
    output: "",
    cursor: 0,
    startedAt: Date.now(),
    done: false,
    exitCode: null,
    signal: null,
  };
  commandSessions.set(id, session);
  child.stdout.on("data", chunk => appendOutput(session, chunk));
  child.stderr.on("data", chunk => appendOutput(session, chunk));
  child.once("error", error => {
    session.error = error;
    session.done = true;
  });
  child.once("exit", (code, signal) => {
    session.done = true;
    session.exitCode = code;
    session.signal = signal;
    session.cleanupTimer = setTimeout(() => commandSessions.delete(id), COMPLETED_SESSION_TTL_MS);
    session.cleanupTimer.unref?.();
  });
  return { id, session };
}

async function waitForSession(session: CommandSession, milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (session.done || milliseconds <= 0) return;
  await new Promise<void>((resolveWait, rejectWait) => {
    const timer = setTimeout(finish, milliseconds);
    const onExit = () => finish();
    const onAbort = () => {
      cleanup();
      rejectWait(new DOMException("MCP command wait aborted", "AbortError"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      session.child.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
    };
    function finish() {
      cleanup();
      resolveWait();
    }
    session.child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function takeOutput(session: CommandSession, maxOutputTokens?: number): {
  output: string;
  original_token_count: number;
} {
  const unread = session.output.slice(session.cursor);
  session.cursor = session.output.length;
  const originalTokenCount = Math.ceil(unread.length / 4);
  const limit = Math.min(MAX_BUFFERED_OUTPUT_CHARS, Math.max(1, maxOutputTokens ?? 10_000) * 4);
  const output = unread.length > limit
    ? `…[truncated ${unread.length - limit} chars]\n${unread.slice(-limit)}`
    : unread;
  return { output, original_token_count: originalTokenCount };
}

function sessionResult(id: number, session: CommandSession, maxOutputTokens?: number) {
  const output = takeOutput(session, maxOutputTokens);
  if (session.error) {
    commandSessions.delete(id);
    throw session.error;
  }
  if (!session.done) {
    return result({
      ...output,
      session_id: id,
      wall_time_seconds: (Date.now() - session.startedAt) / 1_000,
    });
  }
  if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
  commandSessions.delete(id);
  return result({
    ...output,
    exit_code: session.exitCode,
    signal: session.signal,
    wall_time_seconds: (Date.now() - session.startedAt) / 1_000,
  }, session.exitCode !== 0);
}

const imageMimeTypes: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function createChatGptMcpServer(_options: { brokerSocketPath?: string } = {}): McpServer {
  const server = new McpServer({ name: "codex-native", version: VERSION });

  server.registerTool(
    "codex_exec",
    {
      title: "Run a local command",
      description: "Run a shell command directly on the authenticated local machine. A long-running command returns a session_id.",
      inputSchema: {
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        yield_time_ms: z.number().int().min(250).max(30_000).default(10_000),
        max_output_tokens: z.number().int().min(1).max(1_000_000).default(10_000),
        tty: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ cmd, workdir, yield_time_ms, max_output_tokens, tty }, extra) => {
      if (tty) throw new Error("Authenticated web MCP command sessions do not provide a PTY");
      const { id, session } = createCommandSession(cmd, workdir);
      await waitForSession(session, yield_time_ms, extra.signal);
      return sessionResult(id, session, max_output_tokens);
    },
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a local command session",
      description: "Write to, interrupt, or poll a session_id returned by codex_exec.",
      inputSchema: {
        session_id: z.number().int().positive(),
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).default(5_000),
        max_output_tokens: z.number().int().min(1).max(1_000_000).default(10_000),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ session_id, chars, yield_time_ms, max_output_tokens }, extra) => {
      const session = commandSessions.get(session_id);
      if (!session) throw new Error(`Command session is not available: ${session_id}`);
      if (chars === "\u0003") session.child.kill("SIGINT");
      else if (chars !== undefined && !session.child.stdin.destroyed) session.child.stdin.write(chars);
      await waitForSession(session, yield_time_ms, extra.signal);
      return sessionResult(session_id, session, max_output_tokens);
    },
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View a local image",
      description: "Read a local PNG, JPEG, GIF, or WebP image from the authenticated machine.",
      inputSchema: { path: z.string().min(1).max(16_384) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ path }) => {
      const absolute = resolve(path);
      const mimeType = imageMimeTypes[extname(absolute).toLowerCase()];
      if (!mimeType) throw new Error(`Unsupported local image type: ${extname(absolute) || "none"}`);
      const bytes = readFileSync(absolute);
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Local image exceeds the 20 MiB MCP limit");
      return { content: [{ type: "image" as const, data: bytes.toString("base64"), mimeType }] };
    },
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "List local MCP tools",
      description: "List the tools provided directly by this authenticated local MCP server.",
      inputSchema: { query: z.string().max(500).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const tools = [
        { name: "codex_exec", description: "Run a local shell command" },
        { name: "codex_write_stdin", description: "Continue a local command session" },
        { name: "codex_view_image", description: "Read a local image" },
        { name: "codex_tool_inventory", description: "List this authenticated MCP tool surface" },
      ];
      const needle = query?.trim().toLowerCase();
      return result({
        tools: needle
          ? tools.filter(tool => `${tool.name}\n${tool.description}`.toLowerCase().includes(needle))
          : tools,
      });
    },
  );

  return server;
}

export async function runChatGptMcpServer(options: { brokerSocketPath?: string } = {}): Promise<void> {
  await createChatGptMcpServer(options).connect(new StdioServerTransport());
}

export async function handleChatGptMcpHttpRequest(
  request: Request,
  options: { brokerSocketPath?: string; allowedHost: string },
): Promise<Response> {
  const server = createChatGptMcpServer(options);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: [options.allowedHost],
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}
