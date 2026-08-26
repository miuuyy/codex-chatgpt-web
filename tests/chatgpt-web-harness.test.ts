import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildResponseJSON } from "../src/bridge";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptCompletionTracker, chatGptImageFilePayloads, chatGptPromptFilePayloads, chatGptTurnIsComplete } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { chatGptWebTraceId, createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { chatGptHtmlToMarkdown, ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt, withoutSupersededModelSwitchContracts } from "../src/adapters/chatgpt-web/prompt";
import { MAX_CHATGPT_WEB_TURN_RETRIES } from "../src/adapters/chatgpt-web/retry-policy";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, chatGptCompactionSourceExecutionKey, chatGptTurnExecutionKey, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { estimateChatGptWebUsage } from "../src/adapters/chatgpt-web/usage";
import { decodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig, CodexTool } from "../src/types";

const tempRoot = join(tmpdir(), `codex-chatgpt-web-harness-${process.pid}-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

const tools: CodexTool[] = [
  { name: "exec", description: "Run nested Codex tools", parameters: {}, freeform: true },
  { name: "exec_command", description: "Run command", parameters: { type: "object" } },
  { name: "write_stdin", description: "Continue command", parameters: { type: "object" } },
  { name: "apply_patch", description: "Patch files", parameters: {}, freeform: true },
  { name: "view_image", description: "View image", parameters: { type: "object" } },
  { name: "search_openai_docs", namespace: "mcp__openaiDeveloperDocs", description: "Search docs", parameters: { type: "object" } },
];

const environmentXml = `<environment_context>
  <cwd>${tempRoot}</cwd>
  <filesystem><workspace_roots><root>${tempRoot}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
const toolCapabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: true };
const browserOnlyCapabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };

function brokerTestEndpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
}

interface GatewayProgramCall {
  name: string;
  input: unknown;
}

async function executeGatewayProgram(
  program: string,
  availableToolNames: string[],
  calls: GatewayProgramCall[],
): Promise<void> {
  const nestedTools = Object.fromEntries(availableToolNames.map(name => [
    name,
    async (input: unknown) => {
      calls.push({ name, input });
      return { output: name, exit_code: 0 };
    },
  ]));
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<void>;
  const execute = new AsyncFunction("tools", "ALL_TOOLS", "text", "image", "audio", "generatedImage", program);
  const ignoreOutput = (_value: unknown): void => {};
  await execute(
    nestedTools,
    availableToolNames.map(name => ({ name, description: `${name} test tool` })),
    ignoreOutput,
    ignoreOutput,
    ignoreOutput,
    ignoreOutput,
  );
}

function parsed(developerText?: string): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      tools,
      messages: [
        ...(developerText ? [{ role: "developer" as const, content: developerText, timestamp: 1 }] : []),
        { role: "user", content: "Inspect the project", timestamp: 2 },
      ],
    },
    options: { reasoning: "high" },
  };
}

function rawWireRequest(environmentText: string): CodexParsedRequest {
  const request = parsed();
  const turnId = "turn_test_123";
  const threadId = "thread_test_123";
  request._rawBody = {
    prompt_cache_key: threadId,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: environmentText }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the project" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    ],
  };
  return request;
}

function canonicalCurrentWireRequest(environmentText: string): CodexParsedRequest {
  const request = rawWireRequest(environmentText);
  const raw = request._rawBody as {
    client_metadata: Record<string, unknown>;
    input: Array<Record<string, unknown>>;
  };
  raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
    thread_id: "thread_test_123",
    turn_id: "turn_test_123",
    request_kind: "turn",
    sandbox: "none",
  });
  raw.input.unshift({
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "Follow the repository instructions." }],
  });
  raw.input[1]!.id = "msg_environment";
  raw.input[2]!.id = "msg_instruction";
  raw.input[1]!.content = [
    { type: "input_text", text: "<recommended_plugins>none</recommended_plugins>" },
    { type: "input_text", text: environmentText },
  ];
  delete raw.input[1]!.internal_chat_message_metadata_passthrough;
  delete raw.input[2]!.internal_chat_message_metadata_passthrough;
  return request;
}

function proRequest(environmentText = environmentXml): CodexParsedRequest {
  const request = rawWireRequest(environmentText);
  request.options.reasoning = "max";
  return request;
}

function toolResult(value: Record<string, unknown>): BrokerToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

describe("ChatGPT outer-native harness v4", () => {
  test("extracts authoritative environment, tool registry, and turn identity from the Codex wire envelope", () => {
    const request = rawWireRequest(environmentXml);
    expect(extractChatGptTurnEnvironment(request)).toEqual({
      cwd: tempRoot,
      roots: [tempRoot],
      writableRoots: [tempRoot],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools,
    });
    expect(extractChatGptTurnIdentity(request)).toEqual({
      threadId: "thread_test_123",
      turnId: "turn_test_123",
      promptCacheKey: "thread_test_123",
    });
  });

  test("accepts adjacent native turn provenance when Codex omits top-level client_metadata", () => {
    const request = rawWireRequest(environmentXml);
    delete (request._rawBody as { client_metadata?: unknown }).client_metadata;
    expect(extractChatGptTurnEnvironment(request).cwd).toBe(tempRoot);
  });

  test("accepts the canonical current-turn environment when Codex omits item turn ids and git metadata", () => {
    const request = canonicalCurrentWireRequest(environmentXml);

    expect(extractChatGptTurnEnvironment(request)).toEqual({
      cwd: tempRoot,
      roots: [tempRoot],
      writableRoots: [tempRoot],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools,
    });
    expect(() => chatGptTurnExecutionKey(request)).not.toThrow();
  });

  test("rejects canonical environment and user revision when an item conflicts with the current turn", () => {
    const request = canonicalCurrentWireRequest(environmentXml);
    const raw = request._rawBody as { input: Array<Record<string, unknown>> };
    raw.input[2]!.internal_chat_message_metadata_passthrough = { turn_id: "turn_other" };

    expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
    expect(() => chatGptTurnExecutionKey(request)).toThrow("conflicts with native Codex turn_id");
  });

  test("accepts a retained historical user revision after native compaction assigns a fresh turn id", () => {
    const request = rawWireRequest(environmentXml);
    const originalExecutionKey = chatGptTurnExecutionKey(request);
    const raw = request._rawBody as {
      client_metadata: { "x-codex-turn-metadata": string };
      input: Array<Record<string, unknown>>;
    };
    const resumedTurnId = "turn_after_compaction_456";
    raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
      thread_id: "thread_test_123",
      turn_id: resumedTurnId,
      sandbox: "none",
      workspaces: { [tempRoot]: { has_changes: true } },
    });
    raw.input[0]!.internal_chat_message_metadata_passthrough = { turn_id: resumedTurnId };
    raw.input.push({
      type: "compaction",
      id: "cmp_test_after_compaction",
      encrypted_content: "ocx1:test-summary",
    });

    expect(() => chatGptTurnExecutionKey(request)).not.toThrow();
    expect(chatGptTurnExecutionKey(request)).not.toBe(originalExecutionKey);
    expect(extractChatGptTurnEnvironment(request).cwd).toBe(tempRoot);
  });

  test("starts a tool-capable browser turn across a same-turn developer gap", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-canonical-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-canonical-metadata-test",
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: true, solAvailable: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      expect(turn.capabilities.localToolsEnabled).toBe(true);
      const prepared = await turn.prepare();
      expect(prepared.text).toContain("<codex_context_json>");
      expect(prepared.text).toMatch(/turn_token turn_[A-Za-z0-9_-]+/);
      const answer = "Canonical metadata accepted";
      turn.onTextDelta(answer);
      return answer;
    };
    try {
      const request = canonicalCurrentWireRequest(environmentXml);
      const raw = request._rawBody as { input: Array<Record<string, unknown>> };
      raw.input.splice(2, 0, {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Current Codex Desktop developer context." }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_test_123" },
      });

      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
      expect(browserStarts).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("closing a browser trace terminates the active adapter turn and blocks tab resurrection", async () => {
    const socketPath = brokerTestEndpoint(`cgw-close-trace-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: `browser://chatgpt-close-trace-${Date.now()}`,
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: true, solAvailable: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    let started!: () => void;
    const browserStarted = new Promise<void>(resolveStarted => { started = resolveStarted; });
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      await turn.prepare();
      started();
      return await new Promise<string>((_resolve, reject) => {
        const abort = () => reject(new ChatGptWebAdapterError("Browser tab was closed by the user", {
          status: 499,
          errorType: "client_closed_request",
          code: "client_cancelled",
          retryable: false,
        }));
        if (turn.abortSignal?.aborted) abort();
        else turn.abortSignal?.addEventListener("abort", abort, { once: true });
      });
    };

    const request = rawWireRequest(environmentXml);
    const traceId = chatGptWebTraceId(provider, request);
    const adapter = createChatGptWebAdapter(provider);
    const firstEvents: AdapterEvent[] = [];
    try {
      const running = adapter.runTurn!(request, { headers: new Headers() }, event => firstEvents.push(event));
      await browserStarted;
      expect(await chatGptTurnSessions.cancelTrace(traceId)).toBe(1);
      await running;
      expect(firstEvents.at(-1)).toMatchObject({ type: "error", code: "client_cancelled", retryable: false });
      expect(browserStarts).toBe(1);

      const replayEvents: AdapterEvent[] = [];
      await adapter.runTurn!(request, { headers: new Headers() }, event => replayEvents.push(event));
      expect(replayEvents.at(-1)).toMatchObject({ type: "error", code: "client_cancelled", retryable: false });
      expect(browserStarts).toBe(1);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      chatGptTurnSessions.clear();
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("does not trust an environment tag supplied as the active user message", () => {
    const request = parsed();
    request._rawBody = {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: "turn_test_123" }) },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: environmentXml }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_test_123" },
      }],
    };
    expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
  });

  test("recovers the trusted environment from a locally restored previous_response prefix", () => {
    const first = rawWireRequest(environmentXml);
    const firstInput = (first._rawBody as { input: unknown[] }).input;
    const request = parsed();
    const turnId = "turn_test_456";
    request._rawBody = {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ turn_id: turnId }) },
      input: [
        ...structuredClone(firstInput),
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "First turn complete" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue in the same repository" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    };
    request._replayPrefixLen = firstInput.length + 1;

    expect(extractChatGptTurnEnvironment(request)).toEqual({
      cwd: tempRoot,
      roots: [tempRoot],
      writableRoots: [tempRoot],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools,
    });
  });

  test("recovers the trusted environment from a native full-history Codex resume", () => {
    const first = rawWireRequest(environmentXml);
    const firstInput = (first._rawBody as { input: unknown[] }).input;
    const request = parsed();
    const turnId = "turn_test_456";
    request._rawBody = {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_test_123", turn_id: turnId }) },
      input: [
        ...structuredClone(firstInput),
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "First turn complete" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue in the same repository" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    };

    expect(extractChatGptTurnEnvironment(request)).toEqual({
      cwd: tempRoot,
      roots: [tempRoot],
      writableRoots: [tempRoot],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools,
    });
  });

  test("recovers a server-owned historical environment across a developer gap in a sparse native resume", () => {
    const first = rawWireRequest(environmentXml);
    const firstInput = (first._rawBody as { input: Array<Record<string, unknown>> }).input;
    firstInput[0]!.id = "msg_historical_environment";
    firstInput[1]!.id = "msg_historical_prompt";
    firstInput.splice(1, 0, {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Historical Codex developer context" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_test_123" },
    });

    const request = parsed();
    const turnId = "turn_test_456";
    request._rawBody = {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_test_123",
          turn_id: turnId,
          sandbox: "windows_sandbox",
          sandbox_mode: "none",
          workspaces: { [tempRoot]: { git: null } },
        }),
      },
      input: [
        ...structuredClone(firstInput),
        {
          type: "message",
          id: "msg_current_prompt",
          role: "user",
          content: [{ type: "input_text", text: "Continue in the same repository" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    };

    expect(extractChatGptTurnEnvironment(request)).toEqual({
      cwd: tempRoot,
      roots: [tempRoot],
      writableRoots: [tempRoot],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools,
    });
  });

  test("rejects a sparse historical resume when current workspace metadata does not bind its roots", () => {
    const first = rawWireRequest(environmentXml);
    const firstInput = (first._rawBody as { input: Array<Record<string, unknown>> }).input;
    firstInput[0]!.id = "msg_historical_environment";
    firstInput[1]!.id = "msg_historical_prompt";
    firstInput.splice(1, 0, {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Historical Codex developer context" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_test_123" },
    });
    const request = parsed();
    const turnId = "turn_test_456";
    request._rawBody = {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_test_123",
          turn_id: turnId,
          sandbox: "none",
          workspaces: { [resolve(tempRoot, "other")]: { git: null } },
        }),
      },
      input: [
        ...structuredClone(firstInput),
        {
          type: "message",
          id: "msg_current_prompt",
          role: "user",
          content: [{ type: "input_text", text: "Continue elsewhere" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    };

    expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
  });

  test("rejects sparse historical recovery without every provenance and sandbox binding", () => {
    const validSparseResume = (): CodexParsedRequest => {
      const first = rawWireRequest(environmentXml);
      const firstInput = (first._rawBody as { input: Array<Record<string, unknown>> }).input;
      firstInput[0]!.id = "msg_historical_environment";
      firstInput[1]!.id = "msg_historical_prompt";
      firstInput.splice(1, 0, {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Historical Codex developer context" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_test_123" },
      });
      const request = parsed();
      request._rawBody = {
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread_test_123",
            turn_id: "turn_test_456",
            sandbox: "windows_sandbox",
            sandbox_mode: "none",
            workspaces: { [tempRoot]: { git: null } },
          }),
        },
        input: [
          ...structuredClone(firstInput),
          {
            type: "message",
            id: "msg_current_prompt",
            role: "user",
            content: [{ type: "input_text", text: "Continue in the same repository" }],
            internal_chat_message_metadata_passthrough: { turn_id: "turn_test_456" },
          },
        ],
      };
      return request;
    };
    type SparseRaw = {
      client_metadata: { "x-codex-turn-metadata": string };
      input: Array<Record<string, unknown>>;
    };
    const updateMetadata = (raw: SparseRaw, update: (metadata: Record<string, unknown>) => void): void => {
      const metadata = JSON.parse(raw.client_metadata["x-codex-turn-metadata"]) as Record<string, unknown>;
      update(metadata);
      raw.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    };
    const mutations: Array<(raw: SparseRaw) => void> = [
      raw => updateMetadata(raw, metadata => { delete metadata.thread_id; }),
      raw => { delete raw.input[3]!.id; },
      raw => { delete raw.input[0]!.id; },
      raw => { delete raw.input[2]!.id; },
      raw => { delete raw.input[1]!.internal_chat_message_metadata_passthrough; },
      raw => { raw.input[1]!.internal_chat_message_metadata_passthrough = { turn_id: "turn_other" }; },
      raw => updateMetadata(raw, metadata => { metadata.sandbox_mode = "read-only"; }),
    ];

    for (const mutate of mutations) {
      const request = validSparseResume();
      mutate(request._rawBody as SparseRaw);
      expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
    }
  });

  test("rejects a historical environment pair without intervening assistant output", () => {
    const first = rawWireRequest(environmentXml);
    const firstInput = (first._rawBody as { input: unknown[] }).input;
    const request = parsed();
    const turnId = "turn_test_456";
    request._rawBody = {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_test_123", turn_id: turnId }) },
      input: [
        ...structuredClone(firstInput),
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Continue in the same repository" }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    };

    expect(() => extractChatGptTurnEnvironment(request)).toThrow("missing cwd");
  });


  test("uses stable native turn metadata for every provider round in one Codex turn", () => {
    const first = rawWireRequest(environmentXml);
    const second = rawWireRequest(environmentXml);
    second.context.messages[0]!.timestamp = Date.now();
    second.context.messages.push({
      role: "toolResult",
      toolCallId: "call_123",
      toolName: "exec_command",
      content: "done",
      isError: false,
      timestamp: Date.now(),
    });
    expect(chatGptTurnExecutionKey(first)).toBe(chatGptTurnExecutionKey(second));
    const notified = structuredClone(second);
    const subagentNotification = `<subagent_notification>\n${JSON.stringify({
      agent_path: "thread_child_123",
      status: { completed: "3.0.0" },
    })}\n</subagent_notification>`;
    notified.context.messages.push({
      role: "user",
      content: subagentNotification,
      timestamp: Date.now(),
    });
    ((notified._rawBody as { input: unknown[] }).input).push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: subagentNotification }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_test_123" },
    });
    expect(chatGptTurnExecutionKey(notified)).toBe(chatGptTurnExecutionKey(second));
    const steered = structuredClone(second);
    steered.context.messages.push({
      role: "user",
      content: "Stop and review the implementation before continuing",
      timestamp: Date.now(),
    });
    ((steered._rawBody as { input: unknown[] }).input).push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Stop and review the implementation before continuing" }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_test_123" },
    });
    expect(chatGptTurnExecutionKey(steered)).not.toBe(chatGptTurnExecutionKey(second));
    const afterCompact = rawWireRequest(environmentXml);
    afterCompact.context.messages.push({
      role: "user",
      content: `${SUMMARY_PREFIX}\nCompacted history`,
      timestamp: Date.now(),
    });
    ((afterCompact._rawBody as { input: unknown[] }).input).push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nCompacted history` }],
    });
    expect(chatGptTurnExecutionKey(afterCompact)).toBe(chatGptTurnExecutionKey(first));
    const compact = structuredClone(first);
    compact._compactionRequest = true;
    expect(chatGptTurnExecutionKey(compact)).not.toBe(chatGptTurnExecutionKey(first));
    const newCompactTurn = structuredClone(compact);
    (newCompactTurn._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_test_123",
        turn_id: "turn_compact_456",
      }),
    };
    expect(chatGptCompactionSourceExecutionKey(newCompactTurn)).toBe(chatGptTurnExecutionKey(first));
    expect(chatGptTurnExecutionKey(newCompactTurn)).not.toBe(chatGptTurnExecutionKey(first));
    const laterCompact = structuredClone(newCompactTurn);
    ((laterCompact._rawBody as { input: unknown[] }).input).push({
      type: "function_call_output",
      call_id: "call_later",
      output: "later compacted state",
    });
    expect(chatGptTurnExecutionKey(laterCompact)).not.toBe(chatGptTurnExecutionKey(newCompactTurn));
    expect(chatGptCompactionSourceExecutionKey(laterCompact)).toBe(chatGptTurnExecutionKey(first));
    expect(() => chatGptTurnExecutionKey(parsed(environmentXml))).toThrow("requires native Codex turn_id metadata");
  });

  test("coalesces provider retries onto one browser runtime and preserves outstanding calls", () => {
    const sessions = new ChatGptTurnSessions();
    let starts = 0;
    const runtime = () => {
      starts += 1;
      return {
        mode: "tools" as const,
        token: new Promise<string>(() => {}),
        browser: new Promise<string>(() => {}),
        trace: new ChatGptTraceFeed(),
        text: new ChatGptTextFeed(),
        cancel: () => {},
      };
    };
    const first = sessions.getOrCreate("same", runtime);
    const second = sessions.getOrCreate("same", runtime);
    expect(second).toBe(first);
    expect(starts).toBe(1);
    first.setOutstanding([{ callId: "call_1", wireName: "exec_command", freeform: false, arguments: { cmd: "pwd" } }]);
    expect(second.outstanding()).toEqual([{ callId: "call_1", wireName: "exec_command", freeform: false, arguments: { cmd: "pwd" } }]);
  });

  test("retires a failed session so the next native retry starts a new browser turn", async () => {
    const sessions = new ChatGptTurnSessions();
    let starts = 0;
    let cancellations = 0;
    const runtime = () => {
      starts += 1;
      return {
        mode: "read-only" as const,
        browser: Promise.reject(new Error("retryable upstream failure")),
        trace: new ChatGptTraceFeed(),
        text: new ChatGptTextFeed(),
        cancel: () => { cancellations += 1; },
      };
    };
    const failed = sessions.getOrCreate("retryable", runtime);
    await failed.browserOutcome;

    expect(sessions.retire("retryable", failed)).toBe(true);
    expect(sessions.retire("retryable", failed)).toBe(false);
    const retried = sessions.getOrCreate("retryable", runtime);

    expect(retried).not.toBe(failed);
    expect(starts).toBe(2);
    expect(cancellations).toBe(1);
    sessions.clear();
  });

  test("a client disconnect retires its browser session before the next native retry", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h4-abort-retry-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-abort-retry-test",
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: false, solAvailable: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = turn => {
      browserStarts += 1;
      if (browserStarts === 1) {
        return new Promise<string>((_resolve, reject) => {
          turn.abortSignal?.addEventListener("abort", () => {
            reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
          }, { once: true });
        });
      }
      const answer = "Recovered after disconnect";
      turn.onTextDelta(answer);
      return Promise.resolve(answer);
    };
    try {
      const disconnect = new AbortController();
      const first = createChatGptWebAdapter(provider).runTurn!(
        rawWireRequest(environmentXml),
        { headers: new Headers(), abortSignal: disconnect.signal },
        () => {},
      );
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
      disconnect.abort();
      await expect(first).rejects.toThrow("ChatGPT web turn aborted");

      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(provider).runTurn!(
        rawWireRequest(environmentXml),
        { headers: new Headers() },
        event => events.push(event),
      );
      expect(browserStarts).toBe(2);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("an unclassified browser failure retires its session before the next native retry", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h4-error-retry-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-error-retry-test",
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: false, solAvailable: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      if (browserStarts === 1) throw new Error("ChatGPT browser stage timed out: browser_page");
      const answer = "Recovered after stage failure";
      turn.onTextDelta(answer);
      return answer;
    };
    try {
      await expect(
        createChatGptWebAdapter(provider).runTurn!(
          rawWireRequest(environmentXml),
          { headers: new Headers() },
          () => {},
        ),
      ).rejects.toThrow("stage timed out");

      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(provider).runTurn!(
        rawWireRequest(environmentXml),
        { headers: new Headers() },
        event => events.push(event),
      );
      expect(browserStarts).toBe(2);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("caps automatic rate-limit browser sends at three retries for one native turn", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h4-retry-budget-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: `browser://chatgpt-retry-budget-${Date.now()}`,
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: false, solAvailable: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async () => {
      browserStarts += 1;
      throw new ChatGptWebAdapterError("ChatGPT rate limit: too many requests. Try again in a few minutes.", {
        status: 429,
        errorType: "rate_limit_error",
        code: "rate_limit_exceeded",
        retryable: true,
      });
    };
    try {
      for (let attempt = 0; attempt < MAX_CHATGPT_WEB_TURN_RETRIES + 2; attempt += 1) {
        const events: AdapterEvent[] = [];
        await createChatGptWebAdapter(provider).runTurn!(
          rawWireRequest(environmentXml),
          { headers: new Headers() },
          event => events.push(event),
        );
        const error = events.at(-1);
        expect(error).toMatchObject({ type: "error", code: "rate_limit_exceeded" });
        expect((error as Extract<AdapterEvent, { type: "error" }>).retryable)
          .toBe(attempt < MAX_CHATGPT_WEB_TURN_RETRIES);
        if (attempt === MAX_CHATGPT_WEB_TURN_RETRIES) {
          expect((error as Extract<AdapterEvent, { type: "error" }>).message)
            .toContain("Try again in a few minutes.");
        }
      }
      expect(browserStarts).toBe(MAX_CHATGPT_WEB_TURN_RETRIES + 1);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("a non-retryable browser failure remains replayable without starting another browser turn", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h4-nonretryable-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-nonretryable-test",
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: false, solAvailable: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async () => {
      browserStarts += 1;
      throw new ChatGptWebAdapterError("This task exceeds the model context window.", {
        status: 400,
        errorType: "invalid_request_error",
        code: "context_length_exceeded",
        retryable: false,
      });
    };
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const events: AdapterEvent[] = [];
        await createChatGptWebAdapter(provider).runTurn!(
          rawWireRequest(environmentXml),
          { headers: new Headers() },
          event => events.push(event),
        );
        expect(events.at(-1)).toMatchObject({
          type: "error",
          code: "context_length_exceeded",
          retryable: false,
        });
      }
      expect(browserStarts).toBe(1);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("a missing optional Luna checkpoint completes once without repeating the browser turn", async () => {
    const checkpointPath = join(tempRoot, `missing-luna-checkpoint-${Date.now()}.json`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: `browser://chatgpt-luna-missing-checkpoint-${Date.now()}`,
      chatgptWeb: {
        localToolsEnabled: false,
        solAvailable: false,
        proAvailable: false,
        lunaCheckpointStatePath: checkpointPath,
      },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      const prepared = await turn.prepare();
      try {
        expect(turn.captureLunaCheckpoint).toBeTrue();
        const answer = "Luna completed the requested task.";
        turn.onTextDelta(answer);
        return answer;
      } finally {
        prepared.release();
      }
    };

    const request = rawWireRequest(environmentXml);
    request.modelId = "gpt-5.6-luna";
    request.options.reasoning = "low";
    const adapter = createChatGptWebAdapter(provider);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const events: AdapterEvent[] = [];
        await adapter.runTurn!(request, { headers: new Headers() }, event => events.push(event));
        expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")).toEqual([{
          type: "text_delta",
          text: "Luna completed the requested task.",
          phase: "final_answer",
        }]);
        expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
        expect(events.some(event => event.type === "error")).toBeFalse();
      }
      expect(browserStarts).toBe(1);
      expect(existsSync(checkpointPath)).toBeFalse();
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    }
  });

  test("waits for one shared browser retirement before starting the compacted continuation", async () => {
    const sessions = new ChatGptTurnSessions();
    let finishBrowser!: (answer: string) => void;
    const browser = new Promise<string>(resolveBrowser => { finishBrowser = resolveBrowser; });
    let cancellations = 0;
    const original = sessions.getOrCreate("replace", () => ({
      mode: "read-only",
      browser,
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => { cancellations += 1; },
    }));

    const firstRetirement = sessions.retireAndWait("replace");
    const duplicateRetirement = sessions.retireAndWait("replace");
    let replacementStarts = 0;
    const replacement = sessions.waitForRetirement("replace").then(() => sessions.getOrCreate("replace", () => {
      replacementStarts += 1;
      return {
        mode: "read-only" as const,
        browser: Promise.resolve("continued"),
        trace: new ChatGptTraceFeed(),
        text: new ChatGptTextFeed(),
        cancel: () => {},
      };
    }));

    expect(cancellations).toBe(1);
    expect(replacementStarts).toBe(0);
    finishBrowser("stopped");
    expect(await Promise.all([firstRetirement, duplicateRetirement])).toEqual([true, true]);
    expect(await original.browserOutcome).toEqual({ type: "final", answer: "stopped" });
    expect(await replacement).not.toBe(original);
    expect(replacementStarts).toBe(1);
    sessions.clear();
  });

  test("keeps inline images out of the context JSON and prepares native browser attachments", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";
    const request = parsed();
    request.context.messages[0]!.content = [
      { type: "text", text: "Inspect this image" },
      { type: "image", imageUrl, detail: "high" },
    ];
    const compiled = compileChatGptWebPrompt(request, toolCapabilities, "turn_123456789012345678901234");
    expect(compiled.text).not.toContain(imageUrl);
    expect(compiled.text).toContain('"attachment_ref":"codex-input-image-1"');
    expect(compiled.text).toContain('"version":3');
    expect(compiled.text).toContain("use the attached Codex Native tools directly according to their declared descriptions and schemas");
    expect(compiled.text).toContain("Use actual Codex Native results as evidence");
    expect(compiled.text.match(/turn_123456789012345678901234/g)).toHaveLength(1);
    expect(compiled.text).not.toContain("codex_bind_turn");
    expect(compiled.text).not.toContain("binding_id");
    const files = chatGptImageFilePayloads(compiled.images);
    expect(files[0]?.name).toBe("codex-input-image-1.png");
    expect(files[0]?.mimeType).toBe("image/png");
    expect(files[0]?.buffer.length).toBeGreaterThan(0);
  });

  test("keeps only the newest complete Codex model-switch contract", () => {
    const history = [
      { role: "developer" as const, content: "<model_switch>old contract</model_switch>", timestamp: 1 },
      { role: "developer" as const, content: "<skills_instructions>old catalog</skills_instructions>", timestamp: 2 },
      { role: "user" as const, content: "historical user message", timestamp: 3 },
      { role: "assistant" as const, content: [{ type: "text" as const, text: "historical answer" }], model: "gpt-5.6-sol", timestamp: 4 },
      { role: "developer" as const, content: "unrelated developer instruction", timestamp: 5 },
      { role: "developer" as const, content: "<model_switch>current contract</model_switch>", timestamp: 6 },
      { role: "developer" as const, content: "<skills_instructions>current catalog</skills_instructions>", timestamp: 7 },
      { role: "user" as const, content: "current request", timestamp: 8 },
    ];

    const normalized = withoutSupersededModelSwitchContracts(history);
    const serialized = JSON.stringify(normalized);
    expect(serialized).not.toContain("old contract");
    expect(serialized).not.toContain("old catalog");
    expect(serialized).toContain("historical user message");
    expect(serialized).toContain("historical answer");
    expect(serialized).toContain("unrelated developer instruction");
    expect(serialized).toContain("current contract");
    expect(serialized).toContain("current catalog");
    expect(serialized).toContain("current request");
  });

  test("keeps a large context inline and uploads only its referenced images", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";
    const request = parsed();
    request.context.systemPrompt = ["d".repeat(70_000)];
    request.context.messages[0]!.content = [
      { type: "text", text: "Inspect the attached context and image" },
      { type: "image", imageUrl, detail: "high" },
    ];
    const compiled = compileChatGptWebPrompt(request, toolCapabilities, "turn_123456789012345678901234");
    const files = chatGptPromptFilePayloads(compiled);

    expect(compiled.text).toContain("d".repeat(70_000));
    expect(compiled.text).toContain("<codex_context_json>");
    expect(files.map(file => file.name)).toEqual(["codex-input-image-1.png"]);
    expect(files[0]!.mimeType).toBe("image/png");
  });

  test("keeps browser-only Pro context complete without creating a local-tool capability", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==";
    const request = proRequest();
    request.context.systemPrompt = ["system-rule", "repo-rule"];
    request.context.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Synthesize the prepared evidence" },
          { type: "image", imageUrl, detail: "high" },
        ],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call_prior",
        toolName: "exec_command",
        content: JSON.stringify({ output: "prepared workspace evidence", exit_code: 0 }),
        isError: false,
        timestamp: 2,
      },
    ];

    const compiled = compileChatGptWebPrompt(request, browserOnlyCapabilities);
    expect(compiled.text).toContain("ChatGPT Web Pro with no Codex Native bridge to the user's local computer");
    expect(compiled.text).toContain("web search, browsing, research");
    expect(compiled.text).toContain("prepared workspace evidence");
    expect(compiled.text).toContain('"system":["system-rule","repo-rule"]');
    expect(compiled.text).toContain('"attachment_ref":"codex-input-image-1"');
    expect(compiled.images).toHaveLength(1);
    expect(compiled.text).not.toContain("codex_bind_turn");
    expect(compiled.text).not.toContain("turn_token");
    expect(compiled.text).not.toContain("Use the attached Codex Native plugin");
    expect(() => compileChatGptWebPrompt(request, browserOnlyCapabilities, "turn_forbidden")).toThrow("must not receive");

    expect(chatGptReadOnlyContextWarning(request, browserOnlyCapabilities)).toContain("complete accumulated task context");
    expect(chatGptReadOnlyContextWarning(request, browserOnlyCapabilities)).toContain("web search remain available");
    expect(chatGptReadOnlyContextWarning(request, browserOnlyCapabilities)).not.toContain("tools/MCP");
    request.context.messages = [{ role: "user", content: "No preparation yet", timestamp: 3 }];
    expect(chatGptReadOnlyContextWarning(request, browserOnlyCapabilities)).toContain("does not contain local tool results yet");
    request.context.messages = [{
      role: "user",
      content: `${SUMMARY_PREFIX}\n\nWorkspace files and tests were inspected before compaction.`,
      timestamp: 4,
    }];
    expect(chatGptReadOnlyContextWarning(request, browserOnlyCapabilities)).toContain("compaction summary");
    expect(chatGptReadOnlyContextWarning(parsed(), toolCapabilities)).toBeUndefined();
    expect(() => compileChatGptWebPrompt(parsed(), toolCapabilities)).toThrow("requires a broker turn token");
  });

  test("reports conservative nonzero usage for browser text and image context", () => {
    const textRequest = parsed();
    const textUsage = estimateChatGptWebUsage(textRequest, { answer: "done" }, toolCapabilities);
    expect(textUsage).toMatchObject({ estimated: true });
    expect(textUsage.inputTokens).toBeGreaterThan(8_000);
    expect(textUsage.outputTokens).toBeGreaterThan(0);
    expect(textUsage.totalTokens).toBe(textUsage.inputTokens + textUsage.outputTokens);

    const imageRequest = parsed();
    imageRequest.context.messages[0]!.content = [
      { type: "text", text: "Inspect this image" },
      { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAE0lEQVR4nGP4z8DwHwwZGP6DAQBJyAn3FGMynQAAAABJRU5ErkJggg==", detail: "high" },
    ];
    const imageUsage = estimateChatGptWebUsage(imageRequest, { answer: "done" }, toolCapabilities);
    expect(imageUsage.inputTokens).toBeGreaterThanOrEqual(textUsage.inputTokens + 3_500);
  });

  test("keeps the ChatGPT rate-limit dialog distinct from model capacity and UI failures", () => {
    const rateLimit = buildResponseJSON([{
      type: "error",
      message: "ChatGPT rate limit: too many requests. Try again in a few minutes.",
      status: 429,
      errorType: "rate_limit_error",
      code: "rate_limit_exceeded",
      retryable: true,
    }], CHATGPT_WEB_MODEL_ID) as {
      status: string;
      retryable: boolean;
      error: { type: string; code: string };
    };
    expect(rateLimit).toMatchObject({
      status: "failed",
      retryable: true,
      error: { type: "rate_limit_error", code: "rate_limit_exceeded" },
    });

    const missingEffort = buildResponseJSON([{
      type: "error",
      message: "ChatGPT effort menu did not expose item index 1; item count: 0",
      status: 502,
      errorType: "server_error",
      code: "upstream_server_error",
      retryable: false,
    }], CHATGPT_WEB_MODEL_ID) as {
      status: string;
      retryable: boolean;
      error: { type: string; code: string };
    };
    expect(missingEffort).toMatchObject({
      status: "failed",
      retryable: false,
      error: { type: "server_error", code: "upstream_server_error" },
    });
    expect(missingEffort.error.code).not.toBe("server_is_overloaded");

    const contextWindow = buildResponseJSON([{
      type: "error",
      message: "This task exceeds the 225,000-token context window. Switch models, run /compact, then retry.",
      status: 400,
      errorType: "invalid_request_error",
      code: "context_length_exceeded",
      retryable: false,
    }], CHATGPT_WEB_MODEL_ID) as {
      status: string;
      retryable: boolean;
      error: { type: string; code: string; message: string };
    };
    expect(contextWindow).toMatchObject({
      status: "failed",
      retryable: false,
      error: {
        type: "invalid_request_error",
        code: "context_length_exceeded",
      },
    });
    expect(contextWindow.error.message).toContain("/compact");
  });

  test("returns one native compaction item with preserved estimated usage", () => {
    const request = parsed();
    const summary = "Completed the tool loop; continue with the deployment check.";
    const usage = estimateChatGptWebUsage(request, { answer: summary }, toolCapabilities);
    const response = buildResponseJSON([
      { type: "text_delta", text: "Completed the tool loop; ", phase: "final_answer" },
      { type: "text_delta", text: "continue with the deployment check.", phase: "final_answer" },
      { type: "done", stopReason: "stop", endTurn: true, usage },
    ], "gpt-5.6-sol", { compaction: true }) as {
      output: Array<{ type: string; encrypted_content?: string }>;
      usage: { input_tokens: number; output_tokens: number; total_tokens: number };
    };

    expect(response.output).toHaveLength(1);
    expect(response.output[0]?.type).toBe("compaction");
    expect(decodeCompactionSummary(response.output[0]?.encrypted_content ?? "")).toBe(summary);
    expect(response.usage.input_tokens).toBe(usage.inputTokens);
    expect(response.usage.output_tokens).toBe(usage.outputTokens);
    expect(response.usage.total_tokens).toBe(usage.totalTokens!);
  });

  test("accepts completion only from the response-scoped final answer action", () => {
    const state = {
      responsePresent: true,
      running: false,
      currentText: "new answer",
      completionActionVisible: true,
    };
    expect(chatGptTurnIsComplete(state)).toBe(true);
    expect(chatGptTurnIsComplete({ ...state, responsePresent: false })).toBe(false);
    expect(chatGptTurnIsComplete({ ...state, completionActionVisible: false })).toBe(false);
  });

  test("requires completed-turn evidence to remain unchanged before accepting it", () => {
    const state = {
      responsePresent: true,
      running: false,
      currentText: "final answer",
      completionActionVisible: true,
    };
    const tracker = new ChatGptCompletionTracker(2_000);
    expect(tracker.update(state, 1_000)).toBe(false);
    expect(tracker.update(state, 2_999)).toBe(false);
    expect(tracker.update(state, 3_000)).toBe(true);
    expect(tracker.update({ ...state, currentText: "final answer updated" }, 3_100)).toBe(false);
    expect(tracker.update({ ...state, currentHtml: "<p>final answer</p>" }, 4_000)).toBe(false);
    expect(tracker.update({ ...state, currentHtml: "<p>final answer</p><p>hydrated</p>" }, 6_000)).toBe(false);
    expect(tracker.update({ ...state, currentHtml: "<p>final answer</p><p>hydrated</p>" }, 8_000)).toBe(true);
    expect(tracker.update({ ...state, running: true }, 8_100)).toBe(false);
  });

  test("preserves GFM formatting while streaming only completed stable DOM blocks", () => {
    const heading = '<h2 data-start="0" data-end="15">Format Probe</h2>';
    const bold = '<p data-start="16" data-end="24"><strong>bold</strong></p>';
    const alpha = '<ul><li><p>alpha</p></li></ul>';
    const beta = '<ul><li><p>beta</p></li></ul>';
    const list = '<ul><li><p>alpha</p></li><li><p>beta</p></li></ul>';
    const html = `${heading}${bold}${list}`;
    expect(chatGptHtmlToMarkdown(html)).toBe("## Format Probe\n\n**bold**\n\n- alpha\n- beta");

    const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 100);
    const first = [
      { key: "heading", html: heading, text: "Format Probe", streamable: true },
      { key: "bold", html: bold, text: "bold", streamable: false },
    ];
    expect(buffer.observe(first, 0)).toBe("");
    expect(buffer.observe(first, 100)).toBe("## Format Probe");

    const expanded = [
      { key: "heading", html: heading, text: "Format Probe", streamable: true },
      { key: "bold", html: bold, text: "bold", streamable: true },
      { key: "alpha", html: alpha, text: "alpha", group: "list", streamable: true },
      { key: "beta", html: beta, text: "beta", group: "list", streamable: false },
    ];
    expect(buffer.observe(expanded, 150)).toBe("");
    expect(buffer.observe(expanded, 250)).toBe("\n\n**bold**\n\n- alpha");
    expect(buffer.finish()).toEqual({
      delta: "\n- beta",
      markdown: "## Format Probe\n\n**bold**\n\n- alpha\n- beta",
    });
  });

  test("buffers citation hydration, tolerates later markup-only rewrites, and rejects text rewrites", () => {
    const plain = "<p>Source</p>";
    const linked = '<p><a href="https://example.com">Source</a></p>';
    const hydrated = new ChatGptMarkdownBuffer(markdown => markdown, 100);
    expect(hydrated.observe([
      { key: "source", html: plain, text: "Source", streamable: true },
    ], 0)).toBe("");
    expect(hydrated.observe([
      { key: "source", html: linked, text: "Source", streamable: true },
    ], 50)).toBe("");
    expect(hydrated.observe([
      { key: "source", html: linked, text: "Source", streamable: true },
    ], 150)).toBe("[Source](https://example.com)");
    expect(hydrated.observe([
      { key: "source", html: `${linked}<button>Copy</button>`, text: "Source", streamable: true },
    ], 200)).toBe("");

    const rewritten = new ChatGptMarkdownBuffer(markdown => markdown, 100, 500);
    const source = [{ key: "source", html: plain, text: "Source", streamable: true }];
    expect(rewritten.observe(source, 0)).toBe("");
    expect(rewritten.observe(source, 100)).toBe("Source");
    const different = [
      { key: "source", html: "<p>Different</p>", text: "Different", streamable: true },
    ];
    expect(rewritten.observe(different, 200)).toBe("");
    expect(rewritten.currentSnapshotIsConsistent()).toBe(false);
    expect(() => rewritten.finish()).toThrow("completed text block");
    expect(() => rewritten.observe(different, 700)).toThrow("completed text block");
  });

  test("recovers from a transient React frame that omits already-streamed Markdown blocks", () => {
    const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 100, 500);
    const first = { key: "first", html: "<p>First</p>", text: "First", streamable: true };
    const second = { key: "second", html: "<p>Second</p>", text: "Second", streamable: false };
    expect(buffer.observe([first], 0)).toBe("");
    expect(buffer.observe([first], 100)).toBe("First");
    expect(buffer.observe([], 150)).toBe("");
    expect(buffer.currentSnapshotIsConsistent()).toBe(false);
    expect(buffer.observe([first, second], 200)).toBe("");
    expect(buffer.currentSnapshotIsConsistent()).toBe(true);
    expect(buffer.finish()).toEqual({ markdown: "First\n\nSecond", delta: "\n\nSecond" });
  });

  test("drops decorative HTML images without removing textual links", () => {
    const markdown = chatGptHtmlToMarkdown([
      '<p>Source card: <a href="https://github.com/example/repo"><img alt="GitHub" src="data:image/png;base64,AAAA"></a></p>',
      '<p><a href="https://github.com/example/repo">Open repository</a></p>',
    ].join(""));
    expect(markdown).not.toContain("![");
    expect(markdown).not.toContain("data:image");
    expect(markdown).toContain("[Open repository](https://github.com/example/repo)");
  });

  test("replays the complete outer Codex context, including prior reasoning and tool evidence", () => {
    const request = parsed();
    request.context.systemPrompt = ["system-rule", "repo-rule"];
    request.context.messages = [
      { role: "developer", content: "developer-rule", timestamp: 1 },
      { role: "user", content: "first request", timestamp: 2 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspected files" },
          { type: "toolCall", id: "call_prior", name: "exec_command", arguments: { cmd: "pwd" } },
        ],
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "call_prior",
        toolName: "exec_command",
        content: JSON.stringify({ output: tempRoot, exit_code: 0 }),
        isError: false,
        timestamp: 4,
      },
      { role: "user", content: "continue", timestamp: 5 },
    ];
    const compiled = compileChatGptWebPrompt(request, toolCapabilities, "turn_123456789012345678901234");
    const encoded = compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)?.[1];
    const envelope = JSON.parse(encoded!) as { version: number; system: string[]; messages: Array<Record<string, unknown>> };
    expect(envelope.version).toBe(3);
    expect(envelope.system).toEqual(["system-rule", "repo-rule"]);
    expect(envelope.messages.map(message => message.role)).toEqual(["developer", "user", "assistant", "tool_result", "user"]);
    expect(envelope.messages[2]?.content).toEqual([
      { type: "thinking_summary", text: "Inspected files" },
      { type: "tool_call", id: "call_prior", name: "exec_command", arguments: { cmd: "pwd" } },
    ]);
    expect(envelope.messages[3]).toMatchObject({
      tool_call_id: "call_prior",
      tool_name: "exec_command",
      content: JSON.stringify({ output: tempRoot, exit_code: 0 }),
    });
  });

  test("rejects remote image fetches instead of creating an implicit browser-side fallback", () => {
    expect(() => chatGptImageFilePayloads([{
      ref: "codex-input-image-1",
      imageUrl: "https://example.com/image.png",
    }])).toThrow("inline base64 data URL");
  });

  test("holds an MCP invocation until the outer Codex result arrives", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const environment = extractChatGptTurnEnvironment(parsed(environmentXml));
    const token = await broker.register(environment, 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000);
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({ wireName: "exec_command", freeform: false, arguments: { cmd: "pwd" } });
    expect(() => broker.completeTool(token, "unknown", toolResult({ output: "no" }))).toThrow("not pending");
    broker.completeTool(token, request!.callId, toolResult({ output: tempRoot }));
    expect(await invocation).toEqual(toolResult({ output: tempRoot }));
    await broker.close();
  });

  test("makes capability claim retries idempotent until the turn is revoked", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-claim-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(extractChatGptTurnEnvironment(parsed(environmentXml)), 10_000);
    const first = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const retry = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    expect(retry.bindingId).toBe(first.bindingId);
    await broker.close();
  });

  test("batches parallel ChatGPT MCP calls into one native Responses round", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-parallel-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(extractChatGptTurnEnvironment(parsed(environmentXml)), 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invoke = (cmd: string) => callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd },
    }, 10_000);
    const first = invoke("pwd");
    const second = invoke("git status --short");
    const batch = await broker.nextToolBatch(token);
    expect(batch.map(request => request.arguments?.cmd).sort()).toEqual(["git status --short", "pwd"]);
    for (const request of batch) broker.completeTool(token, request.callId, toolResult({ output: request.arguments?.cmd }));
    await Promise.all([first, second]);
    await broker.close();
  });

  test("revoking a turn rejects pending invocations and invalidates its binding", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-revoke-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(extractChatGptTurnEnvironment(parsed(environmentXml)), 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "sleep 30" },
    }, 10_000);
    await broker.nextToolBatch(token);
    broker.revoke(token);
    await expect(invocation).rejects.toThrow("revoked");
    await expect(callTurnBroker(socketPath, { method: "resolve", bindingId: claimed.bindingId }))
      .rejects.toThrow("has already finished");
    await broker.close();
  });

  test("recalculates usage from tool results added during the active browser turn", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-usage-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-usage-test",
      chatgptWeb: { brokerSocketPath: socketPath, turnTimeoutMs: 30_000, localToolsEnabled: true, solAvailable: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      const prepared = await turn.prepare();
      try {
        const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
        if (!token) throw new Error("turn token missing from compiled prompt");
        const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
        const nativeResult = await callTurnBroker<BrokerToolResult>(socketPath, {
          method: "invoke",
          bindingId: claimed.bindingId,
          wireName: "exec_command",
          freeform: false,
          arguments: { cmd: "collect-large-evidence", workdir: tempRoot },
        }, 30_000);
        const output = (nativeResult.structuredContent as { output: string }).output;
        turn.onTextDelta("Evidence bytes: ");
        turn.onTextDelta(String(output.length));
        return `Evidence bytes: ${output.length}`;
      } finally {
        prepared.release();
      }
    };

    const adapter = createChatGptWebAdapter(provider);
    const initial = rawWireRequest(environmentXml);
    const firstEvents: AdapterEvent[] = [];
    try {
      await adapter.runTurn!(initial, { headers: new Headers() }, event => firstEvents.push(event));
      const call = firstEvents.find(
        (event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start",
      );
      expect(call?.name).toBe("exec_command");
      const firstDone = firstEvents.at(-1) as Extract<AdapterEvent, { type: "done" }>;
      expect(firstDone.usage!.inputTokens).toBeLessThan(95_000);

      const largeOutput = "abcdefghij0123456789 ".repeat(30_000);
      const continuation = structuredClone(initial);
      const toolCall = {
        role: "assistant" as const,
        content: [{
          type: "toolCall" as const,
          id: call!.id,
          name: "exec_command",
          arguments: { cmd: "collect-large-evidence", workdir: tempRoot },
        }],
        timestamp: 3,
      };
      const result = {
        role: "toolResult" as const,
        toolCallId: call!.id,
        toolName: "exec_command",
        content: JSON.stringify({ output: largeOutput, exit_code: 0 }),
        isError: false,
        timestamp: 4,
      };
      continuation.context.messages.push(toolCall, result);
      ((continuation._rawBody as { input: unknown[] }).input).push(
        {
          type: "function_call",
          call_id: call!.id,
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "collect-large-evidence", workdir: tempRoot }),
        },
        {
          type: "function_call_output",
          call_id: call!.id,
          output: result.content,
        },
      );

      const finalEvents: AdapterEvent[] = [];
      await adapter.runTurn!(continuation, { headers: new Headers() }, event => finalEvents.push(event));
      const finalDone = finalEvents.at(-1) as Extract<AdapterEvent, { type: "done" }>;
      expect(browserStarts).toBe(1);
      expect(finalDone).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(finalDone.usage!.inputTokens).toBeGreaterThan(95_000);
      expect(finalDone.usage!.inputTokens).toBeGreaterThan(firstDone.usage!.inputTokens + 50_000);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("replaces the active browser response after Codex compacts mid-tool-loop", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-adapter-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt",
      chatgptWeb: { brokerSocketPath: socketPath, turnTimeoutMs: 30_000, localToolsEnabled: true, solAvailable: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    let originalTurnToken = "";
    let continuationTurnToken = "";
    let originalBrowserStopped = false;
    let originalBrowserReceivedToolResult = false;
    let compactionPrompt = "";
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      const prepared = await turn.prepare();
      try {
        if (prepared.text.includes("history-compaction checkpoint")) {
          expect(turn.compaction).toBe(true);
          compactionPrompt = prepared.text;
          const compactSummary = "The project was inspected and the pending command completed.";
          turn.onTextDelta(compactSummary);
          return compactSummary;
        }
        const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
        if (!token) throw new Error("turn token missing from compiled prompt");
        const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
        if (prepared.text.includes("The project was inspected and the pending command completed.")) {
          continuationTurnToken = token;
          turn.onReasoningSummary?.("Resumed from the compacted Codex history");
          const nativeResult = await callTurnBroker<BrokerToolResult>(socketPath, {
            method: "invoke",
            bindingId: claimed.bindingId,
            wireName: "exec_command",
            freeform: false,
            arguments: { cmd: "git status --short", workdir: tempRoot },
          }, 30_000);
          turn.onReasoningSummary?.("Verified the continued task");
          const answer = `## Browser final\n\nStatus: ${(nativeResult.structuredContent as { output: string }).output}`;
          turn.onTextDelta("## Browser final");
          turn.onTextDelta(`\n\nStatus: ${(nativeResult.structuredContent as { output: string }).output}`);
          return answer;
        }

        originalTurnToken = token;
        turn.onReasoningSummary?.("Mapped the repository surface");
        turn.onReasoningSummary?.("Inspected the working directory");
        try {
          const nativeResult = await callTurnBroker<BrokerToolResult>(socketPath, {
            method: "invoke",
            bindingId: claimed.bindingId,
            wireName: "exec_command",
            freeform: false,
            arguments: { cmd: "pwd", workdir: tempRoot },
          }, 30_000);
          originalBrowserReceivedToolResult = true;
          return `stale browser continued with ${(nativeResult.structuredContent as { output: string }).output}`;
        } catch (error) {
          originalBrowserStopped = turn.abortSignal?.aborted === true
            && error instanceof Error
            && error.message.includes("revoked");
          throw error;
        }
      } finally {
        prepared.release();
      }
    };

    const adapter = createChatGptWebAdapter(provider);
    const firstRequest = rawWireRequest(environmentXml);
    const firstEvents: AdapterEvent[] = [];
    const secondEvents: AdapterEvent[] = [];
    try {
      await adapter.runTurn!(firstRequest, { headers: new Headers() }, event => firstEvents.push(event));
      const callStart = firstEvents.find((event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start");
      expect(callStart?.name).toBe("exec_command");
      expect(firstEvents.filter(event => event.type === "assistant_boundary")).toHaveLength(2);
      expect(firstEvents.filter(event => event.type === "thinking_delta")).toEqual([
        { type: "thinking_delta", thinking: "Mapped the repository surface" },
        { type: "thinking_delta", thinking: "Inspected the working directory" },
      ]);
      const firstDone = firstEvents.at(-1) as Extract<AdapterEvent, { type: "done" }>;
      expect(firstDone).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
      expect(firstDone.usage?.estimated).toBe(true);
      expect(Number.isFinite(firstDone.usage?.inputTokens)).toBe(true);
      expect(Number.isFinite(firstDone.usage?.outputTokens)).toBe(true);
      const firstResponse = buildResponseJSON(firstEvents, "gpt-5.6-sol") as { output: Array<Record<string, unknown>>; usage: { total_tokens: number } };
      expect(firstResponse.usage.total_tokens).toBeGreaterThan(0);
      expect(firstResponse.output.map(item => item.type)).toEqual(["reasoning", "reasoning", "function_call"]);
      expect(firstResponse.output[2]).toMatchObject({
        type: "function_call",
        call_id: callStart!.id,
        name: "exec_command",
        status: "completed",
      });

      const compactRequest = rawWireRequest(environmentXml);
      compactRequest._compactionRequest = true;
      const toolCall = {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: callStart!.id, name: "exec_command", arguments: { cmd: "pwd", workdir: tempRoot } }],
        timestamp: 3,
      };
      const result = {
        role: "toolResult" as const,
        toolCallId: callStart!.id,
        toolName: "exec_command",
        content: JSON.stringify({ output: tempRoot, exit_code: 0 }),
        isError: false,
        timestamp: 4,
      };
      compactRequest.context.messages.push(toolCall, result);
      ((compactRequest._rawBody as { input: unknown[] }).input).push(
        {
          type: "function_call",
          call_id: callStart!.id,
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "pwd", workdir: tempRoot }),
        },
        {
          type: "function_call_output",
          call_id: callStart!.id,
          output: result.content,
        },
      );
      const compactEvents: AdapterEvent[] = [];
      await adapter.runTurn!(compactRequest, { headers: new Headers() }, event => compactEvents.push(event));
      expect(compactEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(originalBrowserStopped).toBe(true);
      expect(originalBrowserReceivedToolResult).toBe(false);
      expect(compactionPrompt).toContain(`"tool_call_id":"${callStart!.id}"`);
      expect(compactionPrompt).toContain('"role":"tool_result"');

      const secondRequest = rawWireRequest(environmentXml);
      secondRequest.context.messages.push({
        role: "user",
        content: `${SUMMARY_PREFIX}\nThe project was inspected and the pending command completed.`,
        timestamp: 5,
      });
      ((secondRequest._rawBody as { input: unknown[] }).input).push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nThe project was inspected and the pending command completed.` }],
      });
      await adapter.runTurn!(secondRequest, { headers: new Headers() }, event => secondEvents.push(event));
      expect(browserStarts).toBe(3);
      expect(continuationTurnToken).not.toBe(originalTurnToken);
      expect(secondEvents.find(event => event.type === "thinking_delta")).toEqual({
        type: "thinking_delta",
        thinking: "Resumed from the compacted Codex history",
      });
      const continuedCall = secondEvents.find(
        (event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start",
      );
      expect(continuedCall?.name).toBe("exec_command");
      expect(secondEvents.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });

      const finalRequest = structuredClone(secondRequest);
      const continuedToolCall = {
        role: "assistant" as const,
        content: [{
          type: "toolCall" as const,
          id: continuedCall!.id,
          name: "exec_command",
          arguments: { cmd: "git status --short", workdir: tempRoot },
        }],
        timestamp: 6,
      };
      const continuedResult = {
        role: "toolResult" as const,
        toolCallId: continuedCall!.id,
        toolName: "exec_command",
        content: JSON.stringify({ output: "clean", exit_code: 0 }),
        isError: false,
        timestamp: 7,
      };
      finalRequest.context.messages.push(continuedToolCall, continuedResult);
      ((finalRequest._rawBody as { input: unknown[] }).input).push(
        {
          type: "function_call",
          call_id: continuedCall!.id,
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "git status --short", workdir: tempRoot }),
        },
        {
          type: "function_call_output",
          call_id: continuedCall!.id,
          output: continuedResult.content,
        },
      );
      const finalEvents: AdapterEvent[] = [];
      await adapter.runTurn!(finalRequest, { headers: new Headers() }, event => finalEvents.push(event));
      expect(browserStarts).toBe(3);
      expect(finalEvents.find(event => event.type === "thinking_delta")).toEqual({
        type: "thinking_delta",
        thinking: "Verified the continued task",
      });
      expect(finalEvents.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
        .map(event => event.text).join(""))
        .toBe("## Browser final\n\nStatus: clean");
      const finalDone = finalEvents.at(-1) as Extract<AdapterEvent, { type: "done" }>;
      expect(finalDone).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(finalDone.usage?.estimated).toBe(true);
      expect(Number.isFinite(finalDone.usage?.inputTokens)).toBe(true);
      expect(Number.isFinite(finalDone.usage?.outputTokens)).toBe(true);
      expect(finalDone.usage!.inputTokens).toBeGreaterThan(firstDone.usage!.inputTokens);

      const replayEvents: AdapterEvent[] = [];
      await adapter.runTurn!(finalRequest, { headers: new Headers() }, event => replayEvents.push(event));
      expect(browserStarts).toBe(3);
      expect(replayEvents).toEqual(finalEvents);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("runs Pro through the same turn-bound MCP tool loop as other Full-mode efforts", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-pro-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-pro-test",
      contextWindow: 256_000,
      chatgptWeb: { brokerSocketPath: socketPath, turnTimeoutMs: 30_000, localToolsEnabled: true, solAvailable: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      expect(turn.modelId).toBe(CHATGPT_WEB_MODEL_ID);
      expect(turn.reasoning).toBe("max");
      expect(turn.capabilities.localToolsEnabled).toBe(true);
      const prepared = await turn.prepare();
      try {
        expect(prepared.text).toContain("For local work required by the task, use the attached Codex Native tools directly");
        expect(prepared.text).not.toContain("with no Codex Native bridge");
        const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
        if (!token) throw new Error("turn token missing from compiled Pro prompt");
        const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
        turn.onReasoningSummary?.("Pro requested live workspace evidence");
        const nativeResult = await callTurnBroker<BrokerToolResult>(socketPath, {
          method: "invoke",
          bindingId: claimed.bindingId,
          wireName: "exec_command",
          freeform: false,
          arguments: { cmd: "pwd", workdir: tempRoot },
        }, 30_000);
        const output = (nativeResult.structuredContent as { output: string }).output;
        turn.onReasoningSummary?.("Pro received the native tool result");
        turn.onTextDelta("## Pro result");
        turn.onTextDelta(`\n\nWorkspace: ${output}`);
        return `## Pro result\n\nWorkspace: ${output}`;
      } finally {
        prepared.release();
      }
    };

    const request = proRequest();
    const adapter = createChatGptWebAdapter(provider);
    const firstEvents: AdapterEvent[] = [];
    try {
      await adapter.runTurn!(request, { headers: new Headers() }, event => firstEvents.push(event));
      expect(browserStarts).toBe(1);
      const call = firstEvents.find(
        (event): event is Extract<AdapterEvent, { type: "tool_call_start" }> => event.type === "tool_call_start",
      );
      expect(call?.name).toBe("exec_command");
      expect(firstEvents.some(event => event.type === "text_delta"
        && event.text.includes("cannot access the local Codex computer"))).toBe(false);
      expect(firstEvents.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });

      const continuation = structuredClone(request);
      const toolCall = {
        role: "assistant" as const,
        content: [{
          type: "toolCall" as const,
          id: call!.id,
          name: "exec_command",
          arguments: { cmd: "pwd", workdir: tempRoot },
        }],
        timestamp: 3,
      };
      const result = {
        role: "toolResult" as const,
        toolCallId: call!.id,
        toolName: "exec_command",
        content: JSON.stringify({ output: tempRoot, exit_code: 0 }),
        isError: false,
        timestamp: 4,
      };
      continuation.context.messages.push(toolCall, result);
      ((continuation._rawBody as { input: unknown[] }).input).push(
        {
          type: "function_call",
          call_id: call!.id,
          name: "exec_command",
          arguments: JSON.stringify({ cmd: "pwd", workdir: tempRoot }),
        },
        {
          type: "function_call_output",
          call_id: call!.id,
          output: result.content,
        },
      );

      const finalEvents: AdapterEvent[] = [];
      await adapter.runTurn!(continuation, { headers: new Headers() }, event => finalEvents.push(event));
      expect(browserStarts).toBe(1);
      expect(finalEvents.find(event => event.type === "thinking_delta")).toEqual({
        type: "thinking_delta",
        thinking: "Pro received the native tool result",
      });
      expect(finalEvents.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
        .map(event => event.text).join(""))
        .toBe(`## Pro result\n\nWorkspace: ${tempRoot}`);
      expect(finalEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });

      const replay: AdapterEvent[] = [];
      await adapter.runTurn!(continuation, { headers: new Headers() }, event => replay.push(event));
      expect(browserStarts).toBe(1);
      expect(replay).toEqual(finalEvents);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("serves the complete outer-native bridge contract over MCP stdio", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-mcp-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const gatewayOnlyEnvironment = extractChatGptTurnEnvironment(parsed(environmentXml));
    gatewayOnlyEnvironment.tools = [
      { name: "exec", description: "Run nested Codex tools, including exec_command", parameters: {}, freeform: true },
      { name: "wait", description: "Wait for an exec cell", parameters: { type: "object" } },
      { name: "request_user_input", description: "Request user input", parameters: { type: "object" } },
      {
        name: "wait_agent",
        namespace: "multi_agent_v1",
        description: "Wait for agents to reach a final status.",
        parameters: {
          type: "object",
          properties: {
            targets: { type: "array", items: { type: "string" } },
            timeout_ms: { type: "number", minimum: 10_000, maximum: 3_600_000 },
          },
          required: ["targets"],
          additionalProperties: false,
        },
      },
    ];
    const token = await broker.register(gatewayOnlyEnvironment, 60_000);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "codex-chatgpt-web-harness-test", version: "1.0.0" });
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        "codex_apply_patch",
        "codex_exec",
        "codex_tool_call",
        "codex_tool_inventory",
        "codex_view_image",
        "codex_write_stdin",
      ]);
      const publicConnectorAbi = listed.tools.map(tool => ({
        name: tool.name,
        title: tool.title ?? null,
        description: tool.description ?? null,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? null,
        annotations: tool.annotations ?? null,
      }));
      // ChatGPT caches the complete tools/list contract under a connector identity.
      // An intentional hash change therefore requires an explicit connector refresh or identity migration.
      expect(createHash("sha256").update(canonicalJson(publicConnectorAbi)).digest("hex"))
        .toBe("5cb59b378c7d1939e260a2b4a60f58e22da31208fe09c2cc17a2cf31eb5ff3ad");
      for (const tool of listed.tools) {
        const properties = tool.inputSchema.properties as Record<string, unknown>;
        expect(properties.turn_token).toEqual({ type: "string", minLength: 20, maxLength: 256 });
        expect(properties).not.toHaveProperty("binding_id");
        expect(tool.outputSchema).toBeUndefined();
      }
      expect(listed.tools.find(tool => tool.name === "codex_exec")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(listed.tools.find(tool => tool.name === "codex_write_stdin")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });
      expect(listed.tools.find(tool => tool.name === "codex_apply_patch")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
      expect(listed.tools.find(tool => tool.name === "codex_view_image")?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(listed.tools.find(tool => tool.name === "codex_tool_inventory")?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(listed.tools.find(tool => tool.name === "codex_tool_call")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      });

      const firstExec = call("codex_exec", {
        turn_token: token,
        cmd: "pwd",
        workdir: tempRoot,
        yield_time_ms: 2_000,
        max_output_tokens: 1_234,
        tty: true,
      });
      const secondExec = call("codex_exec", { turn_token: token, cmd: "git status --short", workdir: tempRoot });
      const execRequests = await broker.nextToolBatch(token);
      expect(execRequests).toHaveLength(2);
      expect(execRequests.every(request => request.wireName === "exec" && request.freeform)).toBe(true);
      expect(execRequests.some(request => request.input?.includes(JSON.stringify({
        cmd: "pwd",
        workdir: tempRoot,
        yield_time_ms: 2_000,
        max_output_tokens: 1_234,
        tty: true,
      })))).toBe(true);
      expect(execRequests.some(request => request.input?.includes(JSON.stringify({ cmd: "git status --short", workdir: tempRoot })))).toBe(true);
      for (const request of execRequests) {
        expect(request.input).toContain("ALL_TOOLS");
        expect(request.input).toContain('"exec_command"');
        expect(request.input).toContain('"shell_command"');
        const output = request.input?.includes('git status --short') ? "clean" : tempRoot;
        broker.completeTool(token, request.callId, toolResult({ output, exit_code: 0 }));
      }
      const pwdRequest = execRequests.find(request => request.input?.includes('"cmd":"pwd"'));
      expect(pwdRequest?.input).toBeString();
      const execGatewayCalls: GatewayProgramCall[] = [];
      await executeGatewayProgram(pwdRequest!.input!, ["exec_command"], execGatewayCalls);
      expect(execGatewayCalls).toEqual([{
        name: "exec_command",
        input: {
          cmd: "pwd",
          workdir: tempRoot,
          yield_time_ms: 2_000,
          max_output_tokens: 1_234,
          tty: true,
        },
      }]);
      const shellGatewayCalls: GatewayProgramCall[] = [];
      await executeGatewayProgram(pwdRequest!.input!, ["shell_command"], shellGatewayCalls);
      expect(shellGatewayCalls).toEqual([{
        name: "shell_command",
        input: { command: "pwd", workdir: tempRoot, timeout_ms: 2_000 },
      }]);
      for (const ambiguousInventory of [[], ["exec_command", "shell_command"]]) {
        const rejectedCalls: GatewayProgramCall[] = [];
        await expect(executeGatewayProgram(pwdRequest!.input!, ambiguousInventory, rejectedCalls))
          .rejects.toThrow("Expected exactly one native command tool");
        expect(rejectedCalls).toEqual([]);
      }
      expect((await firstExec).structuredContent).toEqual({ output: tempRoot, exit_code: 0 });
      expect((await secondExec).structuredContent).toEqual({ output: "clean", exit_code: 0 });

      const waitPromise = call("codex_tool_call", {
        turn_token: token,
        wire_name: "wait",
        arguments: { cell_id: "cell_test", yield_time_ms: 10_000 },
      });
      const [waitRequest] = await broker.nextToolBatch(token);
      expect(waitRequest).toMatchObject({
        wireName: "wait",
        freeform: false,
        arguments: { cell_id: "cell_test", yield_time_ms: 10_000 },
      });
      expect(waitRequest?.input).toBeUndefined();
      broker.completeTool(token, waitRequest!.callId, toolResult({ output: "completed" }));
      expect((await waitPromise).structuredContent).toEqual({ output: "completed" });

      const agentInventory = await call("codex_tool_inventory", {
        turn_token: token,
        query: "wait_agent",
        include_schema: true,
      });
      expect(agentInventory.structuredContent).toMatchObject({
        total: 1,
        tools: [{
          wire_name: "multi_agent_v1__wait_agent",
          description: expect.stringContaining("exactly 10 seconds"),
          parameters: {
            properties: {
              timeout_ms: { const: 10_000, minimum: 10_000, maximum: 10_000 },
            },
            required: ["targets", "timeout_ms"],
          },
        }],
      });

      const rejectedLongWait = await call("codex_tool_call", {
        turn_token: token,
        wire_name: "multi_agent_v1__wait_agent",
        arguments: { targets: ["agent_test"], timeout_ms: 3_600_000 },
      });
      expect(rejectedLongWait.isError).toBe(true);
      expect(JSON.stringify(rejectedLongWait.content)).toContain("requires timeout_ms=10000");

      const agentWait = call("codex_tool_call", {
        turn_token: token,
        wire_name: "multi_agent_v1__wait_agent",
        arguments: { targets: ["agent_test"], timeout_ms: 10_000 },
      });
      const [agentWaitRequest] = await broker.nextToolBatch(token);
      expect(agentWaitRequest).toMatchObject({
        wireName: "multi_agent_v1__wait_agent",
        arguments: { targets: ["agent_test"], timeout_ms: 10_000 },
      });
      broker.completeTool(token, agentWaitRequest!.callId, toolResult({ statuses: {} }));
      expect((await agentWait).structuredContent).toEqual({ statuses: {} });
    } finally {
      await client.close().catch(() => {});
      broker.revoke(token);
      await broker.close();
    }
  }, 30_000);

  test("routes every dedicated direct-token bridge to its exact top-level Codex tool", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h4-mcp-direct-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const directEnvironment = extractChatGptTurnEnvironment(parsed(environmentXml));
    directEnvironment.tools = [
      { name: "exec_command", description: "Run a command", parameters: { type: "object" } },
      { name: "write_stdin", description: "Continue a command", parameters: { type: "object" } },
      { name: "apply_patch", description: "Apply a patch", parameters: {}, freeform: true },
      { name: "view_image", description: "View an image", parameters: { type: "object" } },
    ];
    const token = await broker.register(directEnvironment, 60_000);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "codex-chatgpt-web-direct-tools-test", version: "1.0.0" });
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    try {
      await client.connect(transport);

      const inventory = await call("codex_tool_inventory", {
        turn_token: token,
        query: "exec_command",
        include_schema: false,
      });
      expect(inventory.structuredContent).toMatchObject({
        total: 1,
        tools: [{ wire_name: "exec_command", kind: "function" }],
      });
      expect(JSON.stringify(inventory)).not.toContain("binding_");

      const exec = call("codex_exec", {
        turn_token: token,
        cmd: "pwd",
        workdir: tempRoot,
        yield_time_ms: 2_000,
        max_output_tokens: 4_000,
        tty: false,
      });
      const [execRequest] = await broker.nextToolBatch(token);
      expect(execRequest).toEqual(expect.objectContaining({
        wireName: "exec_command",
        freeform: false,
        arguments: {
          cmd: "pwd",
          workdir: tempRoot,
          yield_time_ms: 2_000,
          max_output_tokens: 4_000,
          tty: false,
        },
      }));
      expect(execRequest?.input).toBeUndefined();
      broker.completeTool(token, execRequest!.callId, toolResult({ output: tempRoot, exit_code: 0, session_id: 42 }));
      expect((await exec).structuredContent).toMatchObject({ session_id: 42 });

      const write = call("codex_write_stdin", {
        turn_token: token,
        session_id: 42,
        chars: "y\n",
        yield_time_ms: 5_000,
        max_output_tokens: 2_000,
      });
      const [writeRequest] = await broker.nextToolBatch(token);
      expect(writeRequest).toEqual(expect.objectContaining({
        wireName: "write_stdin",
        freeform: false,
        arguments: {
          session_id: 42,
          chars: "y\n",
          yield_time_ms: 5_000,
          max_output_tokens: 2_000,
        },
      }));
      broker.completeTool(token, writeRequest!.callId, toolResult({ output: "continued" }));
      expect((await write).structuredContent).toEqual({ output: "continued" });

      const patch = "*** Begin Patch\n*** Add File: direct-token.txt\n+ok\n*** End Patch";
      const apply = call("codex_apply_patch", { turn_token: token, patch });
      const [applyRequest] = await broker.nextToolBatch(token);
      expect(applyRequest).toMatchObject({ wireName: "apply_patch", freeform: true, input: patch });
      expect(applyRequest?.arguments).toBeUndefined();
      broker.completeTool(token, applyRequest!.callId, toolResult({ output: "Done!" }));
      expect((await apply).structuredContent).toEqual({ output: "Done!" });

      const view = call("codex_view_image", {
        turn_token: token,
        path: "/private/tmp/direct-token.png",
        detail: "original",
      });
      const [viewRequest] = await broker.nextToolBatch(token);
      expect(viewRequest).toEqual(expect.objectContaining({
        wireName: "view_image",
        freeform: false,
        arguments: { path: "/private/tmp/direct-token.png", detail: "original" },
      }));
      broker.completeTool(token, viewRequest!.callId, toolResult({ output: "image-ready" }));
      expect((await view).structuredContent).toEqual({ output: "image-ready" });
    } finally {
      await client.close().catch(() => {});
      broker.revoke(token);
      await broker.close();
    }
  }, 30_000);

  test("keeps simultaneous direct-token MCP actions isolated by outer Codex turn", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h4-mcp-isolation-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const firstEnvironment = extractChatGptTurnEnvironment(parsed(environmentXml));
    firstEnvironment.cwd = "/workspace/first";
    firstEnvironment.roots = [firstEnvironment.cwd];
    firstEnvironment.writableRoots = [firstEnvironment.cwd];
    firstEnvironment.tools = [
      { name: "exec_command", description: "Run a Codex command", parameters: { type: "object" } },
    ];
    const secondEnvironment = extractChatGptTurnEnvironment(parsed(environmentXml));
    secondEnvironment.cwd = "/workspace/second";
    secondEnvironment.roots = [secondEnvironment.cwd];
    secondEnvironment.writableRoots = [secondEnvironment.cwd];
    secondEnvironment.tools = [
      { name: "shell_command", description: "Run a legacy Codex command", parameters: { type: "object" } },
    ];
    const firstToken = await broker.register(firstEnvironment, 60_000, "first-turn");
    const secondToken = await broker.register(secondEnvironment, 60_000, "second-turn");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "codex-chatgpt-web-turn-isolation-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const firstCall = client.callTool({
        name: "codex_exec",
        arguments: { turn_token: firstToken, cmd: "pwd", workdir: firstEnvironment.cwd, yield_time_ms: 1_000 },
      });
      const secondCall = client.callTool({
        name: "codex_exec",
        arguments: { turn_token: secondToken, cmd: "pwd", workdir: secondEnvironment.cwd, yield_time_ms: 2_000 },
      });
      const [[firstRequest], [secondRequest]] = await Promise.all([
        broker.nextToolBatch(firstToken),
        broker.nextToolBatch(secondToken),
      ]);

      expect(firstRequest).toMatchObject({
        wireName: "exec_command",
        arguments: { cmd: "pwd", workdir: "/workspace/first", yield_time_ms: 1_000 },
      });
      expect(secondRequest).toMatchObject({
        wireName: "shell_command",
        arguments: { command: "pwd", workdir: "/workspace/second", timeout_ms: 2_000 },
      });
      expect(JSON.stringify(firstRequest)).not.toContain(firstToken);
      expect(JSON.stringify(firstRequest)).not.toContain(secondToken);
      expect(JSON.stringify(secondRequest)).not.toContain(firstToken);
      expect(JSON.stringify(secondRequest)).not.toContain(secondToken);

      broker.completeTool(firstToken, firstRequest!.callId, toolResult({ output: "first" }));
      broker.completeTool(secondToken, secondRequest!.callId, toolResult({ output: "second" }));
      expect((await firstCall).structuredContent).toEqual({ output: "first" });
      expect((await secondCall).structuredContent).toEqual({ output: "second" });
    } finally {
      await client.close().catch(() => {});
      broker.revoke(firstToken);
      broker.revoke(secondToken);
      await broker.close();
    }
  }, 30_000);

  test("serves the outer-native bridge contract over MCP stdio for a turn registered without a turn timeout", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-mcp-no-ttl-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const gatewayOnlyEnvironment = extractChatGptTurnEnvironment(parsed(environmentXml));
    gatewayOnlyEnvironment.tools = [
      { name: "exec", description: "Run nested Codex tools, including exec_command", parameters: {}, freeform: true },
      { name: "wait", description: "Wait for an exec cell", parameters: { type: "object" } },
      { name: "request_user_input", description: "Request user input", parameters: { type: "object" } },
    ];
    const token = await broker.register(gatewayOnlyEnvironment);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "codex-chatgpt-web-harness-test", version: "1.0.0" });
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    try {
      await client.connect(transport);

      const invalid = await call("codex_tool_inventory", {
        turn_token: "turn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid.content)).toContain("turn token is invalid, expired, or revoked");

      const execPromise = call("codex_exec", { turn_token: token, cmd: "pwd", workdir: tempRoot });
      const [execRequest] = await Promise.race([
        broker.nextToolBatch(token),
        execPromise.then(response => {
          throw new Error(`codex_exec settled before reaching the broker: ${JSON.stringify(response.content)}`);
        }),
      ]);
      expect(execRequest).toMatchObject({ wireName: "exec", freeform: true });
      expect(execRequest?.input).toContain("ALL_TOOLS");
      expect(execRequest?.input).toContain('"exec_command"');
      expect(execRequest?.input).toContain('"shell_command"');
      expect(execRequest?.input).toContain(JSON.stringify({ cmd: "pwd", workdir: tempRoot }));
      broker.completeTool(token, execRequest!.callId, toolResult({ output: tempRoot, exit_code: 0 }));
      expect((await execPromise).structuredContent).toEqual({ output: tempRoot, exit_code: 0 });
    } finally {
      await client.close().catch(() => {});
      broker.revoke(token);
      await broker.close();
    }
  }, 30_000);
});
