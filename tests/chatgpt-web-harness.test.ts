import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResponseJSON } from "../src/bridge";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptCompletionTracker, chatGptImageFilePayloads, chatGptPromptFilePayloads, chatGptTurnIsComplete } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { chatGptHtmlToMarkdown, ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import { CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { chatGptReadOnlyContextWarning, compileChatGptWebPrompt, withoutSupersededModelSwitchContracts } from "../src/adapters/chatgpt-web/prompt";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, chatGptCompactionSourceExecutionKey, chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
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
const toolCapabilities = { localToolsEnabled: true, proAvailable: true };
const readOnlyCapabilities = { localToolsEnabled: false, proAvailable: true };

function brokerTestEndpoint(name: string): string {
  return process.platform === "win32"
    ? defaultBrokerEndpoint(join(tmpdir(), name), "win32")
    : join(tmpdir(), `${name}.sock`);
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

describe("ChatGPT outer-native harness v3", () => {
  test("rejects an opaque MultiAgent V2 child payload before starting the browser", async () => {
    const request = parseRequest({
      model: "chatgpt-web/pro",
      stream: true,
      reasoning: { effort: "ultra" },
      input: [{
        type: "agent_message",
        author: "parent",
        recipient: "child",
        content: [{ type: "encrypted_content", encrypted_content: "opaque-native-v2-payload" }],
      }],
    });
    expect(request._opaqueMultiAgentV2Payload).toBe(true);

    const socketPath = brokerTestEndpoint(`cgw-h3-v2-reject-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-v2-reject-test",
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: false, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async () => {
      browserStarts += 1;
      return "unexpected";
    };
    try {
      await expect(createChatGptWebAdapter(provider).runTurn!(
        request,
        { headers: new Headers() },
        () => {},
      )).rejects.toThrow("require a V1-rooted task");
      expect(browserStarts).toBe(0);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

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

  test("starts a tool-capable browser turn from the current Codex metadata shape", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-canonical-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-canonical-metadata-test",
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      const prepared = await turn.prepare();
      expect(prepared.text).toContain("<codex_context_json>");
      const answer = "Canonical metadata accepted";
      turn.onTextDelta(answer);
      return answer;
    };
    try {
      const request = canonicalCurrentWireRequest(environmentXml);

      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(provider).runTurn!(request, { headers: new Headers() }, event => events.push(event));
      expect(browserStarts).toBe(1);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
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

  test("a client disconnect does not poison the turn session for the next native retry", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-abort-retry-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-abort-retry-test",
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: false, proAvailable: true },
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
      const adapter = createChatGptWebAdapter(provider);
      const disconnect = new AbortController();
      const first = adapter.runTurn!(
        rawWireRequest(environmentXml),
        { headers: new Headers(), abortSignal: disconnect.signal },
        () => {},
      );
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
      disconnect.abort();
      await expect(first).rejects.toThrow("ChatGPT web turn aborted");

      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(provider).runTurn!(rawWireRequest(environmentXml), { headers: new Headers() }, event => events.push(event));
      expect(browserStarts).toBe(2);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("an unclassified browser failure does not poison the turn session for the next native retry", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-plain-error-retry-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-plain-error-retry-test",
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: false, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      if (browserStarts === 1) throw new Error("ChatGPT browser stage timed out: browser_page");
      const answer = "Recovered after stage timeout";
      turn.onTextDelta(answer);
      return answer;
    };
    try {
      const adapter = createChatGptWebAdapter(provider);
      await expect(
        adapter.runTurn!(rawWireRequest(environmentXml), { headers: new Headers() }, () => {}),
      ).rejects.toThrow("stage timed out");

      const events: AdapterEvent[] = [];
      await createChatGptWebAdapter(provider).runTurn!(rawWireRequest(environmentXml), { headers: new Headers() }, event => events.push(event));
      expect(browserStarts).toBe(2);
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("a non-retryable ChatGPT failure stays cached so a replayed turn cannot burn another browser attempt", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-nonretryable-cache-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-nonretryable-cache-test",
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: false, proAvailable: true },
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
      const first: AdapterEvent[] = [];
      await createChatGptWebAdapter(provider).runTurn!(rawWireRequest(environmentXml), { headers: new Headers() }, event => first.push(event));
      expect(first.at(-1)).toMatchObject({ type: "error", code: "context_length_exceeded", retryable: false });

      const second: AdapterEvent[] = [];
      await createChatGptWebAdapter(provider).runTurn!(rawWireRequest(environmentXml), { headers: new Headers() }, event => second.push(event));
      expect(second.at(-1)).toMatchObject({ type: "error", code: "context_length_exceeded", retryable: false });
      expect(browserStarts).toBe(1);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
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

  test("maps one ChatGPT Web model to explicit effort modes and fails closed on invalid combinations", () => {
    expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "max", toolCapabilities)).toEqual({
      modelId: CHATGPT_WEB_MODEL_ID,
      effort: "max",
      displayLabel: "Pro",
      uiEffortIndex: 4,
      localTools: false,
    });
    expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", toolCapabilities)).toMatchObject({
      uiEffortIndex: 3,
      localTools: true,
    });
    expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "max", {
      localToolsEnabled: false,
      proAvailable: false,
    })).toThrow("Pro effort is not available");
    expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", {
      localToolsEnabled: true,
      proAvailable: false,
    })).toThrow("Extra High effort is not available");
    expect(() => resolveChatGptWebModelMode("unknown", "high", toolCapabilities)).toThrow("model is not supported");
  });

  test("builds a context-complete Pro prompt without exposing any local-tool capability", () => {
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

    const compiled = compileChatGptWebPrompt(request, readOnlyCapabilities);
    expect(compiled.text).toContain("ChatGPT Web Pro with no Codex Native bridge to the user's local computer");
    expect(compiled.text).toContain("web search, browsing, research");
    expect(compiled.text).toContain("prepared workspace evidence");
    expect(compiled.text).toContain('"system":["system-rule","repo-rule"]');
    expect(compiled.text).toContain('"attachment_ref":"codex-input-image-1"');
    expect(compiled.images).toHaveLength(1);
    expect(compiled.text).not.toContain("codex_bind_turn");
    expect(compiled.text).not.toContain("turn_token");
    expect(compiled.text).not.toContain("Use the attached Codex Native plugin");
    expect(() => compileChatGptWebPrompt(request, readOnlyCapabilities, "turn_forbidden")).toThrow("must not receive");

    expect(chatGptReadOnlyContextWarning(request, readOnlyCapabilities)).toContain("complete accumulated task context");
    expect(chatGptReadOnlyContextWarning(request, readOnlyCapabilities)).toContain("web search remain available");
    expect(chatGptReadOnlyContextWarning(request, readOnlyCapabilities)).not.toContain("tools/MCP");
    request.context.messages = [{ role: "user", content: "No preparation yet", timestamp: 3 }];
    expect(chatGptReadOnlyContextWarning(request, readOnlyCapabilities)).toContain("does not contain local tool results yet");
    request.context.messages = [{
      role: "user",
      content: `${SUMMARY_PREFIX}\n\nWorkspace files and tests were inspected before compaction.`,
      timestamp: 4,
    }];
    expect(chatGptReadOnlyContextWarning(request, readOnlyCapabilities)).toContain("compaction summary");
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
      message: "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
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

    const rewritten = new ChatGptMarkdownBuffer(markdown => markdown, 100);
    const source = [{ key: "source", html: plain, text: "Source", streamable: true }];
    expect(rewritten.observe(source, 0)).toBe("");
    expect(rewritten.observe(source, 100)).toBe("Source");
    expect(() => rewritten.observe([
      { key: "source", html: "<p>Different</p>", text: "Different", streamable: true },
    ], 200)).toThrow("completed text block");
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

  test("replaces the active browser response after Codex compacts mid-tool-loop", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-adapter-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt",
      chatgptWeb: { brokerSocketPath: socketPath, turnTimeoutMs: 30_000, localToolsEnabled: true, proAvailable: true },
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

  test("runs Pro as one context-complete read-only browser turn with native warning, tracing, and exact replay", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-pro-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-pro-test",
      contextWindow: 256_000,
      chatgptWeb: { brokerSocketPath: socketPath, turnTimeoutMs: 30_000, localToolsEnabled: false, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      expect(turn.modelId).toBe(CHATGPT_WEB_MODEL_ID);
      const prepared = await turn.prepare();
      try {
        expect(prepared.text).toContain("ChatGPT Web Pro with no Codex Native bridge to the user's local computer");
        expect(prepared.text).toContain("web search, browsing, research");
        expect(prepared.text).not.toContain("turn_token");
        expect(prepared.text).not.toContain("codex_bind_turn");
        turn.onReasoningSummary?.("Reviewed the accumulated");
        turn.onReasoningSummary?.(" task evidence", true);
        turn.onCommentary?.("The prepared context contains enough evidence to continue the analysis.");
        turn.onReasoningSummary?.("Synthesized the read-only conclusion");
        turn.onTextDelta("## Pro result");
        turn.onTextDelta("\n\nPrepared context synthesized.");
        return "## Pro result\n\nPrepared context synthesized.";
      } finally {
        prepared.release();
      }
    };

    const request = proRequest();
    request._rawBody = {
      prompt_cache_key: "thread_pro_read_only",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_pro_read_only",
          turn_id: "turn_pro_read_only",
        }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Synthesize the already prepared context" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_pro_read_only" },
      }],
    };
    request.context.messages.push({
      role: "toolResult",
      toolCallId: "call_prepared",
      toolName: "exec_command",
      content: JSON.stringify({ output: "workspace already inspected", exit_code: 0 }),
      isError: false,
      timestamp: 3,
    });
    const adapter = createChatGptWebAdapter(provider);
    const events: AdapterEvent[] = [];
    try {
      await adapter.runTurn!(request, { headers: new Headers() }, event => events.push(event));
      expect(browserStarts).toBe(1);
      expect(events.some(event => event.type === "tool_call_start")).toBe(false);
      const commentary = events.filter(
        (event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta" && event.phase === "commentary",
      );
      expect(commentary).toEqual([
        expect.objectContaining({
          text: expect.stringContaining("cannot access the local Codex computer"),
          phase: "commentary",
        }),
        {
          type: "text_delta",
          text: "The prepared context contains enough evidence to continue the analysis.",
          phase: "commentary",
        },
      ]);
      expect(events.filter(event => event.type === "thinking_delta")).toEqual([
        { type: "thinking_delta", thinking: "Reviewed the accumulated" },
        { type: "thinking_delta", thinking: " task evidence" },
        { type: "thinking_delta", thinking: "Synthesized the read-only conclusion" },
      ]);
      expect(events.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta" && event.phase === "final_answer")
        .map(event => event.text).join(""))
        .toBe("## Pro result\n\nPrepared context synthesized.");
      expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });

      const response = buildResponseJSON(events, CHATGPT_WEB_MODEL_ID) as {
        output: Array<{ type: string; phase?: string; content?: Array<{ text?: string }> }>;
      };
      const warning = response.output.find(item => item.type === "message" && item.phase === "commentary");
      expect(warning?.content?.[0]?.text).toContain("cannot access the local Codex computer");
      expect(warning?.content?.[0]?.text).toContain("web search remain available");
      expect(warning?.content?.[0]?.text).not.toContain("tools/MCP");
      expect(response.output.filter(item => item.type === "message" && item.phase === "commentary")).toHaveLength(2);
      expect(response.output.filter(item => item.type === "reasoning")).toHaveLength(2);

      const replay: AdapterEvent[] = [];
      await adapter.runTurn!(request, { headers: new Headers() }, event => replay.push(event));
      expect(browserStarts).toBe(1);
      expect(replay).toEqual(events);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("serves the complete outer-native bridge contract over MCP stdio", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-mcp-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const gatewayOnlyEnvironment = extractChatGptTurnEnvironment(parsed(environmentXml));
    gatewayOnlyEnvironment.tools = gatewayOnlyEnvironment.tools.filter(tool => (
      tool.name === "exec" || tool.name === "search_openai_docs"
    ));
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
        "codex_bind_turn",
        "codex_exec",
        "codex_tool_call",
        "codex_tool_inventory",
        "codex_view_image",
        "codex_write_stdin",
      ]);

      const bound = await call("codex_bind_turn", { turn_token: token });
      const bindingId = (bound.structuredContent as { binding_id?: string } | undefined)?.binding_id;
      expect(bindingId).toStartWith("binding_");
      expect((bound.structuredContent as { execution: string }).execution).toBe("outer_codex_native");
      expect((bound.structuredContent as { outer_tool_gateway: string }).outer_tool_gateway).toBe("exec");
      expect((bound.structuredContent as { command_tool: string }).command_tool).toBe("exec_command");

      const inventory = await call("codex_tool_inventory", { binding_id: bindingId, query: "docs" });
      const discovered = (inventory.structuredContent as { tools: Array<{ wire_name: string }> }).tools;
      expect(discovered.map(tool => tool.wire_name)).toEqual(["mcp__openaiDeveloperDocs__search_openai_docs"]);

      const execPromise = call("codex_exec", { binding_id: bindingId, cmd: "pwd", workdir: tempRoot });
      const [execRequest] = await broker.nextToolBatch(token);
      expect(execRequest).toMatchObject({ wireName: "exec", freeform: true });
      expect(execRequest?.input).toContain(`tools["exec_command"](${JSON.stringify({ cmd: "pwd", workdir: tempRoot })})`);
      broker.completeTool(token, execRequest!.callId, toolResult({ output: tempRoot, exit_code: 0 }));
      expect((await execPromise).structuredContent).toEqual({ output: tempRoot, exit_code: 0 });

      const patchText = "*** Begin Patch\n*** Add File: test.txt\n+ok\n*** End Patch";
      const patchPromise = call("codex_apply_patch", { binding_id: bindingId, patch: patchText });
      const [patchRequest] = await broker.nextToolBatch(token);
      expect(patchRequest).toMatchObject({ wireName: "exec", freeform: true });
      expect(patchRequest?.input).toContain(`tools["apply_patch"](${JSON.stringify(patchText)})`);
      broker.completeTool(token, patchRequest!.callId, toolResult({ applied: true }));
      expect((await patchPromise).isError).not.toBe(true);

      const docsPromise = call("codex_tool_call", {
        binding_id: bindingId,
        wire_name: "mcp__openaiDeveloperDocs__search_openai_docs",
        arguments: { query: "Responses API" },
      });
      const [docsRequest] = await broker.nextToolBatch(token);
      expect(docsRequest).toMatchObject({ wireName: "exec", freeform: true });
      expect(docsRequest?.input).toContain('tools["mcp__openaiDeveloperDocs__search_openai_docs"]({"query":"Responses API"})');
      broker.completeTool(token, docsRequest!.callId, toolResult({ hits: 3 }));
      expect((await docsPromise).structuredContent).toEqual({ hits: 3 });
    } finally {
      await client.close().catch(() => {});
      broker.revoke(token);
      await broker.close();
    }
  }, 30_000);

  test("serves the outer-native bridge contract over MCP stdio for a turn registered without a turn timeout", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-mcp-no-ttl-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const gatewayOnlyEnvironment = extractChatGptTurnEnvironment(parsed(environmentXml));
    gatewayOnlyEnvironment.tools = gatewayOnlyEnvironment.tools.filter(tool => (
      tool.name === "exec" || tool.name === "search_openai_docs"
    ));
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

      const bound = await call("codex_bind_turn", { turn_token: token });
      expect(bound.content).toEqual([{ type: "text", text: expect.stringContaining("binding_") }]);
      expect(bound.isError).not.toBe(true);
      const binding = bound.structuredContent as {
        binding_id: string;
        binding_status: string;
        valid_until: string;
        expires_at: string | null;
        next_action: string;
      };
      expect(binding.binding_id).toStartWith("binding_");
      expect(binding.binding_status).toBe("active");
      expect(binding.valid_until).toBe("outer_turn_end");
      expect(binding.expires_at).toBeNull();
      expect(binding.next_action).toContain("Never put turn_token in binding_id");

      const confused = await call("codex_exec", { binding_id: token, cmd: "pwd" });
      expect(confused.isError).toBe(true);
      expect(JSON.stringify(confused.content)).toContain("never pass turn_token here");

      const execPromise = call("codex_exec", { binding_id: binding.binding_id, cmd: "pwd", workdir: tempRoot });
      const [execRequest] = await Promise.race([
        broker.nextToolBatch(token),
        execPromise.then(response => {
          throw new Error(`codex_exec settled before reaching the broker: ${JSON.stringify(response.content)}`);
        }),
      ]);
      expect(execRequest).toMatchObject({ wireName: "exec", freeform: true });
      expect(execRequest?.input).toContain(`tools["exec_command"](${JSON.stringify({ cmd: "pwd", workdir: tempRoot })})`);
      broker.completeTool(token, execRequest!.callId, toolResult({ output: tempRoot, exit_code: 0 }));
      expect((await execPromise).structuredContent).toEqual({ output: tempRoot, exit_code: 0 });
    } finally {
      await client.close().catch(() => {});
      broker.revoke(token);
      await broker.close();
    }
  }, 30_000);
});
