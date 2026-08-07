import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResponseJSON } from "../src/bridge";
import { ChatGptCapacityError, ChatGptCompletionTracker, chatGptImageFilePayloads, chatGptPromptFilePayloads, chatGptTurnIsComplete, ChatGptTransientLimitError } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { chatGptHtmlToMarkdown, ChatGptMarkdownStream } from "../src/adapters/chatgpt-web/markdown";
import { CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_COMPACTION_CONTEXT_FILENAME, CHATGPT_TASK_CONTEXT_FILENAME, chatGptReadOnlyContextWarning, compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions, chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { estimateChatGptWebUsage, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
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
    const compact = structuredClone(first);
    compact._compactionRequest = true;
    expect(chatGptTurnExecutionKey(compact)).not.toBe(chatGptTurnExecutionKey(first));
    expect(() => chatGptTurnExecutionKey(parsed(environmentXml))).toThrow("requires native Codex turn_id metadata");
  });

  test("a failed compaction session cannot evict an active response session", async () => {
    const response = rawWireRequest(environmentXml);
    const compaction = structuredClone(response);
    compaction._compactionRequest = true;
    const responseKey = chatGptTurnExecutionKey(response);
    const compactionKey = chatGptTurnExecutionKey(compaction);
    const sessions = new ChatGptTurnSessions();
    let responseCancelled = 0;
    let compactionCancelled = 0;

    const responseSession = sessions.getOrCreate(responseKey, () => ({
      mode: "read-only",
      browser: new Promise<string>(() => {}),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => { responseCancelled += 1; },
    }));
    const compactionSession = sessions.getOrCreate(compactionKey, () => ({
      mode: "read-only",
      browser: Promise.reject(new Error("compaction failed")),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => { compactionCancelled += 1; },
    }));

    expect(await compactionSession.browserOutcome).toMatchObject({ type: "error" });
    await Promise.resolve();
    expect(compactionCancelled).toBe(1);
    expect(responseCancelled).toBe(0);
    expect(sessions.getOrCreate(responseKey, () => {
      throw new Error("active response session must survive compaction failure");
    })).toBe(responseSession);

    sessions.clear();
    expect(responseCancelled).toBe(1);
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

  test("keeps inline images out of the context JSON and prepares native browser attachments", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const request = parsed();
    request.context.messages[0]!.content = [
      { type: "text", text: "Inspect this image" },
      { type: "image", imageUrl, detail: "high" },
    ];
    const compiled = compileChatGptWebPrompt(request, toolCapabilities, "turn_123456789012345678901234");
    expect(compiled.text).not.toContain(imageUrl);
    expect(compiled.contextAttachment.text).toContain('"attachment_ref":"codex-input-image-1"');
    expect(compiled.contextAttachment.text).toContain('"version":3');
    const files = chatGptImageFilePayloads(compiled.images);
    expect(files[0]?.name).toBe("codex-input-image-1.png");
    expect(files[0]?.mimeType).toBe("image/png");
    expect(files[0]?.buffer.length).toBeGreaterThan(0);
  });

  test("keeps a large context in the task document and uploads its referenced image", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const request = parsed();
    request.context.systemPrompt = ["d".repeat(70_000)];
    request.context.messages[0]!.content = [
      { type: "text", text: "Inspect the attached context and image" },
      { type: "image", imageUrl, detail: "high" },
    ];
    const compiled = compileChatGptWebPrompt(request, toolCapabilities, "turn_123456789012345678901234");
    const files = chatGptPromptFilePayloads(compiled);

    expect(compiled.text).not.toContain("d".repeat(70_000));
    expect(compiled.text).not.toContain("<codex_context_json>");
    expect(compiled.contextAttachment.text).toContain("d".repeat(70_000));
    expect(files.map(file => file.name)).toEqual([
      CHATGPT_TASK_CONTEXT_FILENAME,
      "codex-input-image-1.png",
    ]);
    expect(files[0]!.mimeType).toBe("text/plain");
    expect(files[1]!.mimeType).toBe("image/png");
  });

test("normal and compaction turns share the task-document transport", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const request = parsed();
    request._compactionRequest = true;
    request.context.systemPrompt = ["d".repeat(70_000)];
    request.context.messages[0]!.content = [
      { type: "text", text: "Inspect the attached context and image" },
      { type: "image", imageUrl, detail: "high" },
    ];
    const compiled = compileChatGptWebPrompt(request, readOnlyCapabilities);
    const files = chatGptPromptFilePayloads(compiled);

expect(compiled.text).not.toContain("d".repeat(70_000));
    expect(compiled.contextAttachment.text).toContain("d".repeat(70_000));
    expect(compiled.contextAttachment.text).toContain("<codex_context_json>");
    expect(files.map(file => file.name)).toEqual([
      CHATGPT_COMPACTION_CONTEXT_FILENAME,
      "codex-input-image-1.png",
    ]);
    expect(files[0]!.mimeType).toBe("application/zip");
    expect(files[1]!.mimeType).toBe("image/png");

    const normalRequest = structuredClone(request);
    delete normalRequest._compactionRequest;
    const normal = compileChatGptWebPrompt(
      normalRequest,
      toolCapabilities,
      "turn_123456789012345678901234",
    );
    expect(chatGptPromptFilePayloads(normal).map(file => file.name)).toEqual([
      CHATGPT_TASK_CONTEXT_FILENAME,
      "codex-input-image-1.png",
    ]);
    expect(chatGptPromptFilePayloads(normal)[0]!.mimeType).toBe("text/plain");
    const compactionEstimate = estimateCompiledChatGptWebInputTokens(compiled, request.modelId);
    const normalEstimate = estimateCompiledChatGptWebInputTokens(normal, request.modelId);
    expect(Math.abs(compactionEstimate - normalEstimate)).toBeLessThan(1_000);
  });

test("every turn uploads one context file and reserves the tenth slot", () => {
    const request = parsed();
    request._compactionRequest = true;
    const compiled = compileChatGptWebPrompt(request, readOnlyCapabilities);
    expect(compiled.text).not.toContain("<codex_context_json>");
    expect(chatGptPromptFilePayloads(compiled).map(file => file.name)).toEqual([
      CHATGPT_COMPACTION_CONTEXT_FILENAME,
    ]);

    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    expect(chatGptPromptFilePayloads({
      ...compiled,
      images: Array.from({ length: 9 }, (_unused, index) => ({
        ref: `codex-input-image-${index + 1}`,
        imageUrl,
      })),
}).map(file => file.name)).toEqual(
      [
        CHATGPT_COMPACTION_CONTEXT_FILENAME,
        ...Array.from({ length: 9 }, (_unused, index) => `codex-input-image-${index + 1}.png`),
      ],
    );
    expect(() => chatGptPromptFilePayloads({
      ...compiled,
      images: Array.from({ length: 10 }, (_unused, index) => ({
        ref: `codex-input-image-${index + 1}`,
        imageUrl,
      })),
    })).toThrow("at most 9 input images");
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
    expect(() => resolveChatGptWebModelMode("unknown", "high", toolCapabilities)).toThrow("model is not supported");
  });

  test("builds a context-complete Pro prompt without exposing any local-tool capability", () => {
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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
    expect(compiled.contextAttachment.text).toContain("prepared workspace evidence");
    expect(compiled.contextAttachment.text).toContain('"system":["system-rule","repo-rule"]');
    expect(compiled.contextAttachment.text).toContain('"attachment_ref":"codex-input-image-1"');
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
      { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", detail: "high" },
    ];
    const imageUsage = estimateChatGptWebUsage(imageRequest, { answer: "done" }, toolCapabilities);
    expect(imageUsage.inputTokens).toBeGreaterThanOrEqual(textUsage.inputTokens + 3_500);
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

  test("preserves GFM formatting and streams only a stable rendered prefix", () => {
    const heading = '<h2 data-start="0" data-end="15">Format Probe</h2>';
    const bold = '<p data-start="16" data-end="24"><strong>bold</strong></p>';
    const list = '<ul><li><p>alpha</p></li><li><p>beta</p></li></ul>';
    const html = `${heading}${bold}${list}`;
    expect(chatGptHtmlToMarkdown(html)).toBe("## Format Probe\n\n**bold**\n\n- alpha\n- beta");

    const stream = new ChatGptMarkdownStream();
    expect(stream.observeStableHtml(heading)).toBe("");
    expect(stream.observeStableHtml(heading)).toBe("## Format Probe");
    const final = stream.finish(html);
    expect(final.delta).toBe("\n\n**bold**\n\n- alpha\n- beta");
    expect(final.markdown).toBe("## Format Probe\n\n**bold**\n\n- alpha\n- beta");
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
    const encoded = compiled.contextAttachment.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)?.[1];
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
    const token = await broker.register(environment);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, null);
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
    const token = await broker.register(extractChatGptTurnEnvironment(parsed(environmentXml)));
    const first = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const retry = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    expect(retry.bindingId).toBe(first.bindingId);
    await broker.close();
  });

  test("batches parallel ChatGPT MCP calls into one native Responses round", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-parallel-${process.pid}-${Date.now()}`);
    const broker = TurnBroker.forSocket(socketPath);
    const token = await broker.register(extractChatGptTurnEnvironment(parsed(environmentXml)));
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
    const token = await broker.register(extractChatGptTurnEnvironment(parsed(environmentXml)));
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "sleep 30" },
    }, null);
    await broker.nextToolBatch(token);
    broker.revoke(token);
    await expect(invocation).rejects.toThrow("revoked");
    await expect(callTurnBroker(socketPath, { method: "resolve", bindingId: claimed.bindingId }))
      .rejects.toThrow("has already finished");
    await broker.close();
  });

  test("keeps one browser response alive across the native outer Codex tool loop", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-adapter-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt",
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: true, proAvailable: true },
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
        turn.onReasoningSummary?.("Mapped the repository surface");
        turn.onReasoningSummary?.("Inspected the working directory");
        const nativeResult = await callTurnBroker<BrokerToolResult>(socketPath, {
          method: "invoke",
          bindingId: claimed.bindingId,
          wireName: "exec_command",
          freeform: false,
          arguments: { cmd: "pwd", workdir: tempRoot },
        }, 30_000);
        turn.onReasoningSummary?.("Verified the command result");
        const answer = `## Browser final\n\nWorking directory: ${(nativeResult.structuredContent as { output: string }).output}`;
        turn.onTextDelta("## Browser final");
        turn.onTextDelta(`\n\nWorking directory: ${(nativeResult.structuredContent as { output: string }).output}`);
        return answer;
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

      const secondRequest = rawWireRequest(environmentXml);
      secondRequest.context.messages.push(
        {
          role: "assistant",
          content: [{ type: "toolCall", id: callStart!.id, name: "exec_command", arguments: { cmd: "pwd", workdir: tempRoot } }],
          timestamp: 3,
        },
        {
          role: "toolResult",
          toolCallId: callStart!.id,
          toolName: "exec_command",
          content: JSON.stringify({ output: tempRoot, exit_code: 0 }),
          isError: false,
          timestamp: 4,
        },
      );
      await adapter.runTurn!(secondRequest, { headers: new Headers() }, event => secondEvents.push(event));
      expect(browserStarts).toBe(1);
      expect(secondEvents.find(event => event.type === "thinking_delta")).toEqual({
        type: "thinking_delta",
        thinking: "Verified the command result",
      });
      expect(secondEvents.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
        .map(event => event.text).join(""))
        .toBe(`## Browser final\n\nWorking directory: ${tempRoot}`);
      const secondDone = secondEvents.at(-1) as Extract<AdapterEvent, { type: "done" }>;
      expect(secondDone).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
      expect(secondDone.usage?.estimated).toBe(true);
      expect(Number.isFinite(secondDone.usage?.inputTokens)).toBe(true);
      expect(Number.isFinite(secondDone.usage?.outputTokens)).toBe(true);
      expect(secondDone.usage!.inputTokens).toBeGreaterThan(firstDone.usage!.inputTokens);

      const replayEvents: AdapterEvent[] = [];
      await adapter.runTurn!(secondRequest, { headers: new Headers() }, event => replayEvents.push(event));
      expect(browserStarts).toBe(1);
      expect(replayEvents).toEqual(secondEvents);
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("request disconnect detaches and same-turn reconnect keeps the browser runtime and broker token", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-reconnect-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-reconnect-test",
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: true, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    let token = "";
    let bindingId = "";
    let browserAbortSignal: AbortSignal | undefined;
    let resolvePrepared!: () => void;
    const preparedReady = new Promise<void>(resolve => { resolvePrepared = resolve; });
    let releaseBrowser!: () => void;
    const browserGate = new Promise<void>(resolve => { releaseBrowser = resolve; });
    const commentaryPrefix = "Reconnect prefix observed";
    const commentarySuffix = " and browser turn resumed";
    const prefix = "## Reconnected\n\nBrowser turn ";
    const suffix = "survived the request disconnect.";
    const answer = `${prefix}${suffix}`;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      browserAbortSignal = turn.abortSignal;
      const prepared = await turn.prepare();
      token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1] ?? "";
      if (!token) throw new Error("turn token missing from compiled prompt");
      bindingId = (await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token })).bindingId;
      turn.onCommentary?.(commentaryPrefix);
      turn.onTextDelta(prefix);
      resolvePrepared();
      await browserGate;
      turn.onCommentary?.(commentarySuffix, true);
      turn.onTextDelta(suffix);
      return answer;
    };

    const adapter = createChatGptWebAdapter(provider);
    const request = rawWireRequest(environmentXml);
    const firstAbort = new AbortController();
    const firstEvents: AdapterEvent[] = [];
    const secondEvents: AdapterEvent[] = [];
    let resolveFirstPrefix!: () => void;
    const firstPrefixReady = new Promise<void>(resolve => { resolveFirstPrefix = resolve; });
    try {
      const firstRun = adapter.runTurn!(
        request,
        { headers: new Headers(), abortSignal: firstAbort.signal },
        event => {
          firstEvents.push(event);
          if (event.type === "text_delta" && event.phase === "final_answer") resolveFirstPrefix();
        },
      );
      await preparedReady;
      await firstPrefixReady;
      expect(firstEvents.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
        event.type === "text_delta" && event.phase === "final_answer"
      )).map(event => event.text).join("")).toBe(prefix);
      firstAbort.abort();
      await expect(firstRun).rejects.toThrow("ChatGPT web turn aborted");

      expect(browserAbortSignal?.aborted).toBe(false);
      const reclaimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
      expect(reclaimed.bindingId).toBe(bindingId);

      const secondRun = adapter.runTurn!(request, { headers: new Headers() }, event => secondEvents.push(event));
      releaseBrowser();
      await secondRun;

      expect(browserStarts).toBe(1);
      expect(secondEvents.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
        event.type === "text_delta" && event.phase === "commentary"
      )).map(event => event.text).join("")).toBe(`${commentaryPrefix}${commentarySuffix}`);
      expect(secondEvents.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
        event.type === "text_delta" && event.phase === "final_answer"
      ))
        .map(event => event.text).join(""))
        .toBe(answer);
      expect(secondEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    } finally {
      releaseBrowser();
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("automatic compaction reconnects to the same browser turn and returns one complete compaction item", async () => {
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-auto-compaction-reconnect-test",
      chatgptWeb: { localToolsEnabled: false, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    let browserAbortSignal: AbortSignal | undefined;
    let releaseBrowser!: () => void;
    const browserGate = new Promise<void>(resolve => { releaseBrowser = resolve; });
    const prefix = "## Compact summary\n\nAutomatic compaction ";
    const suffix = "survived the request reconnect.";
    const answer = `${prefix}${suffix}`;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      browserAbortSignal = turn.abortSignal;
      const prepared = await turn.prepare();
      try {
        turn.onTextDelta(prefix);
        await browserGate;
        turn.onTextDelta(suffix);
        return answer;
      } finally {
        prepared.release();
      }
    };

    const adapter = createChatGptWebAdapter(provider);
    const request = rawWireRequest(environmentXml);
    request._compactionRequest = true;
    const firstAbort = new AbortController();
    const firstEvents: AdapterEvent[] = [];
    const secondEvents: AdapterEvent[] = [];
    let resolveFirstPrefix!: () => void;
    const firstPrefixReady = new Promise<void>(resolve => { resolveFirstPrefix = resolve; });
    try {
      const firstRun = adapter.runTurn!(
        request,
        { headers: new Headers(), abortSignal: firstAbort.signal },
        event => {
          firstEvents.push(event);
          if (event.type === "text_delta" && event.phase === "final_answer") resolveFirstPrefix();
        },
      );
      await firstPrefixReady;
      firstAbort.abort();
      await expect(firstRun).rejects.toThrow("ChatGPT web turn aborted");

      expect(browserAbortSignal?.aborted).toBe(false);
      const secondRun = adapter.runTurn!(request, { headers: new Headers() }, event => secondEvents.push(event));
      releaseBrowser();
      await secondRun;

      expect(browserStarts).toBe(1);
      expect(secondEvents.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
        event.type === "text_delta" && event.phase === "final_answer"
      )).map(event => event.text).join("")).toBe(answer);

      const response = buildResponseJSON(secondEvents, "gpt-5.6-sol", { compaction: true }) as {
        output: Array<{ type: string; encrypted_content?: string }>;
      };
      expect(response.output).toHaveLength(1);
      expect(response.output[0]?.type).toBe("compaction");
      expect(decodeCompactionSummary(response.output[0]?.encrypted_content ?? "")).toBe(answer);
    } finally {
      releaseBrowser();
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    }
  });

  test("runs Pro as one context-complete read-only browser turn with native warning, tracing, and exact replay", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-pro-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-pro-test",
      contextWindow: 256_000,
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: false, proAvailable: true },
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

  test("classifies a persistent transient-limit dialog as retryable 429 and evicts the session", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-transient-429-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-transient-429-test",
      contextWindow: 256_000,
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: false, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      const prepared = await turn.prepare();
      try {
        if (browserStarts === 1) {
          turn.onReasoningSummary?.("Mapped the repository surface");
          throw new ChatGptTransientLimitError("send", 3);
        }
        turn.onReasoningSummary?.("Retried after the transient limit cleared");
        const answer = "## Browser final\n\nPrepared context synthesized.";
        turn.onTextDelta("## Browser final");
        turn.onTextDelta("\n\nPrepared context synthesized.");
        return answer;
      } finally {
        prepared.release();
      }
    };

    const adapter = createChatGptWebAdapter(provider);
    const request = rawWireRequest(environmentXml);
    const firstEvents: AdapterEvent[] = [];
    const secondEvents: AdapterEvent[] = [];
    try {
      await adapter.runTurn!(request, { headers: new Headers() }, event => firstEvents.push(event));
      expect(browserStarts).toBe(1);
      const errorEvent = firstEvents.find(event => event.type === "error");
      expect(errorEvent).toEqual({
        type: "error",
        message: "ChatGPT transient request-limit dialog persisted during send after 3 dismissal(s); refusing a fourth activation",
        status: 429,
        errorType: "rate_limit_error",
        code: "rate_limit_exceeded",
        retryable: true,
      });
      expect(firstEvents.at(-1)?.type).toBe("error");

      await adapter.runTurn(request, { headers: new Headers() }, event => secondEvents.push(event));
      expect(browserStarts).toBe(2);
      expect(secondEvents.some(event => event.type === "error")).toBe(false);
      const secondDone = secondEvents.at(-1) as Extract<AdapterEvent, { type: "done" }>;
      expect(secondDone).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    } finally {
      (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
      await TurnBroker.forSocket(socketPath).close();
    }
  });

  test("classifies genuine model capacity as retryable 503 and evicts the session", async () => {
    const socketPath = brokerTestEndpoint(`cgw-h3-capacity-503-${process.pid}-${Date.now()}`);
    const provider: CodexProviderConfig = {
      adapter: "chatgpt-web",
      baseUrl: "browser://chatgpt-capacity-503-test",
      contextWindow: 256_000,
      chatgptWeb: { brokerSocketPath: socketPath, localToolsEnabled: false, proAvailable: true },
    };
    const worker = ChatGptBrowserWorker.forProvider(provider);
    const originalRun = worker.run.bind(worker);
    let browserStarts = 0;
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
      browserStarts += 1;
      const prepared = await turn.prepare();
      try {
        if (browserStarts === 1) throw new ChatGptCapacityError("response collection");
        const answer = "## Browser final\n\nCapacity retry succeeded.";
        turn.onTextDelta(answer);
        return answer;
      } finally {
        prepared.release();
      }
    };

    const adapter = createChatGptWebAdapter(provider);
    const request = rawWireRequest(environmentXml);
    const firstEvents: AdapterEvent[] = [];
    const secondEvents: AdapterEvent[] = [];
    try {
      await adapter.runTurn!(request, { headers: new Headers() }, event => firstEvents.push(event));
      expect(browserStarts).toBe(1);
      expect(firstEvents.find(event => event.type === "error")).toEqual({
        type: "error",
        message: "ChatGPT selected model is at capacity during response collection",
        status: 503,
        errorType: "server_error",
        code: "server_is_overloaded",
        retryable: true,
      });

      await adapter.runTurn!(request, { headers: new Headers() }, event => secondEvents.push(event));
      expect(browserStarts).toBe(2);
      expect(secondEvents.some(event => event.type === "error")).toBe(false);
      expect(secondEvents.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
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
    const directEnvironment = extractChatGptTurnEnvironment(parsed(environmentXml));
    const directWithoutContinuationEnvironment = extractChatGptTurnEnvironment(parsed(environmentXml));
    directWithoutContinuationEnvironment.tools = directWithoutContinuationEnvironment.tools.filter(tool => tool.name !== "write_stdin");
    const shellEnvironment = extractChatGptTurnEnvironment(parsed(environmentXml));
    shellEnvironment.tools = [
      { name: "exec", description: "Run nested Codex tools", parameters: {}, freeform: true },
      { name: "shell_command", description: "Run shell command", parameters: { type: "object" } },
      { name: "write_stdin", description: "Continue command", parameters: { type: "object" } },
    ];
    const token = await broker.register(gatewayOnlyEnvironment);
    const directToken = await broker.register(directEnvironment);
    const directWithoutContinuationToken = await broker.register(directWithoutContinuationEnvironment);
    const shellToken = await broker.register(shellEnvironment);
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
      const listedExec = listed.tools.find(tool => tool.name === "codex_exec") as {
        annotations?: Record<string, unknown>;
      } | undefined;
      expect(listedExec?.annotations?.readOnlyHint).toBeUndefined();
      expect(listedExec?.annotations?.destructiveHint).toBeUndefined();

      const bound = await call("codex_bind_turn", { turn_token: token });
      const bindingId = (bound.structuredContent as { binding_id?: string } | undefined)?.binding_id;
      expect(bindingId).toStartWith("binding_");
      expect((bound.structuredContent as { execution: string }).execution).toBe("outer_codex_native");
      expect((bound.structuredContent as { outer_tool_gateway: string }).outer_tool_gateway).toBe("exec");
      expect((bound.structuredContent as { command_tool: string | null }).command_tool).toBeNull();
      expect((bound.structuredContent as { resumable_sessions: boolean }).resumable_sessions).toBe(false);
      expect((bound.structuredContent as { continuation_tool: string | null }).continuation_tool).toBeNull();
      expect((bound.structuredContent as { capabilities: string[] }).capabilities).not.toContain("resumable_exec_sessions");

      const inventory = await call("codex_tool_inventory", { binding_id: bindingId, query: "docs" });
      const discovered = (inventory.structuredContent as { tools: Array<{ wire_name: string }> }).tools;
      expect(discovered.map(tool => tool.wire_name)).toEqual(["mcp__openaiDeveloperDocs__search_openai_docs"]);

      const execPromise = call("codex_exec", {
        binding_id: bindingId,
        cmd: "pwd",
        workdir: tempRoot,
        yield_time_ms: 1_000,
        max_output_tokens: 40_000,
      });
      const [execRequest] = await broker.nextToolBatch(token);
      expect(execRequest).toMatchObject({ wireName: "exec", freeform: true });
      const pragma = execRequest?.input?.split("\n", 1)[0]?.replace("// @exec: ", "");
      expect(JSON.parse(pragma!)).toEqual({
        ["yield" + "_time_ms"]: 25_000,
        max_output_tokens: 40_000,
      });
      expect(execRequest?.input).toContain('["shell_command", "exec_command"]');
      expect(execRequest?.input).toContain('typeof tools[name] === "function"');
      expect(execRequest?.input).toContain('command: commandInput.cmd');
      expect(execRequest?.input).toContain('timeout_ms: 20000');
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const generated = new AsyncFunction(
        "tools",
        "text",
        "image",
        "audio",
        "generatedImage",
        execRequest!.input!,
      );
      let shellArguments: unknown;
      const shellOutput: unknown[] = [];
      await generated(
        {
          shell_command: async (args: unknown) => {
            shellArguments = args;
            return { type: "text", text: "shell-ok" };
          },
        },
        (value: unknown) => shellOutput.push(value),
        () => {},
        () => {},
        () => {},
      );
      expect(shellArguments).toEqual({ command: "pwd", workdir: tempRoot, timeout_ms: 20_000 });
      expect(shellOutput).toEqual(["shell-ok"]);
      let execArguments: unknown;
      await generated(
        {
          exec_command: async (args: unknown) => {
            execArguments = args;
            return "exec-ok";
          },
        },
        () => {},
        () => {},
        () => {},
        () => {},
      );
      expect(execArguments).toEqual({
        cmd: "pwd",
        workdir: tempRoot,
        max_output_tokens: 40_000,
      });
      await expect(generated(
        { shell_command: async () => ({ session_id: 7 }) },
        () => {},
        () => {},
        () => {},
        () => {},
      )).rejects.toThrow("cannot return a resumable session");
      const generatedWithImmediateTimer = new AsyncFunction(
        "tools",
        "text",
        "image",
        "audio",
        "generatedImage",
        "setTimeout",
        "clearTimeout",
        execRequest!.input!,
      );
      await expect(generatedWithImmediateTimer(
        { shell_command: async () => new Promise(() => {}) },
        () => {},
        () => {},
        () => {},
        () => {},
        (callback: () => void) => {
          queueMicrotask(callback);
          return 1;
        },
        () => {},
      )).rejects.toThrow("Gateway-only command execution timed out after 20000ms");
      await expect(generated(
        {},
        () => {},
        () => {},
        () => {},
        () => {},
      )).rejects.toThrow("No compatible callable command tool");
      broker.completeTool(token, execRequest!.callId, toolResult({ output: tempRoot, exit_code: 0 }));
      expect((await execPromise).structuredContent).toEqual({ output: tempRoot, exit_code: 0 });

      const ttyResult = await call("codex_exec", {
        binding_id: bindingId,
        cmd: "interactive",
        workdir: tempRoot,
        tty: true,
      });
      expect(ttyResult.isError).toBe(true);
      expect(ttyResult.content).toContainEqual({
        type: "text",
        text: "Gateway-only command execution does not support tty or resumable sessions",
      });
      const writeResult = await call("codex_write_stdin", {
        binding_id: bindingId,
        session_id: 1,
      });
      expect(writeResult.isError).toBe(true);
      expect(writeResult.content).toContainEqual({
        type: "text",
        text: "This Codex turn does not support resumable command sessions because write_stdin is unavailable",
      });

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
      expect(docsRequest).toMatchObject({
        wireName: "mcp__openaiDeveloperDocs__search_openai_docs",
        freeform: false,
        arguments: { query: "Responses API" },
      });
      broker.completeTool(token, docsRequest!.callId, toolResult({ hits: 3 }));
      expect((await docsPromise).structuredContent).toEqual({ hits: 3 });

      const directBound = await call("codex_bind_turn", { turn_token: directToken });
      const directBindingId = (directBound.structuredContent as { binding_id: string }).binding_id;
      expect((directBound.structuredContent as { command_tool: string }).command_tool).toBe("exec_command");
      expect((directBound.structuredContent as { outer_tool_gateway: string }).outer_tool_gateway).toBe("exec");
      expect((directBound.structuredContent as { resumable_sessions: boolean }).resumable_sessions).toBe(true);
      expect((directBound.structuredContent as { continuation_tool: string }).continuation_tool).toBe("write_stdin");
      expect((directBound.structuredContent as { capabilities: string[] }).capabilities).toContain("resumable_exec_sessions");

      const directExecPromise = call("codex_exec", {
        binding_id: directBindingId,
        cmd: "pwd",
        workdir: tempRoot,
        yield_time_ms: 1_000,
      });
      const [directExecRequest] = await broker.nextToolBatch(directToken);
      expect(directExecRequest).toMatchObject({
        wireName: "exec_command",
        freeform: false,
        arguments: { cmd: "pwd", workdir: tempRoot, yield_time_ms: 1_000 },
      });
      broker.completeTool(directToken, directExecRequest!.callId, toolResult({ output: tempRoot, exit_code: 0 }));
      await directExecPromise;

      const directWritePromise = call("codex_write_stdin", {
        binding_id: directBindingId,
        session_id: 42,
        chars: "x",
        yield_time_ms: 1_000,
      });
      const [directWriteRequest] = await broker.nextToolBatch(directToken);
      expect(directWriteRequest).toMatchObject({
        wireName: "write_stdin",
        freeform: false,
        arguments: { session_id: 42, chars: "x", yield_time_ms: 1_000 },
      });
      broker.completeTool(directToken, directWriteRequest!.callId, toolResult({ output: "continued" }));
      await directWritePromise;

      const directWithoutContinuationBound = await call("codex_bind_turn", { turn_token: directWithoutContinuationToken });
      const directWithoutContinuationBindingId = (directWithoutContinuationBound.structuredContent as { binding_id: string }).binding_id;
      expect((directWithoutContinuationBound.structuredContent as { command_tool: string | null }).command_tool).toBeNull();
      expect((directWithoutContinuationBound.structuredContent as { outer_tool_gateway: string }).outer_tool_gateway).toBe("exec");
      expect((directWithoutContinuationBound.structuredContent as { resumable_sessions: boolean }).resumable_sessions).toBe(false);
      expect((directWithoutContinuationBound.structuredContent as { capabilities: string[] }).capabilities).not.toContain("resumable_exec_sessions");
      const directWithoutContinuationExec = call("codex_exec", {
        binding_id: directWithoutContinuationBindingId,
        cmd: "pwd",
        workdir: tempRoot,
        yield_time_ms: 250,
      });
      const [directWithoutContinuationRequest] = await broker.nextToolBatch(directWithoutContinuationToken);
      expect(directWithoutContinuationRequest).toMatchObject({ wireName: "exec", freeform: true });
      expect(directWithoutContinuationRequest?.input).toContain('["shell_command", "exec_command"]');
      broker.completeTool(directWithoutContinuationToken, directWithoutContinuationRequest!.callId, toolResult({ output: tempRoot, exit_code: 0 }));
      await directWithoutContinuationExec;

      const directPatchPromise = call("codex_apply_patch", { binding_id: directBindingId, patch: patchText });
      const [directPatchRequest] = await broker.nextToolBatch(directToken);
      expect(directPatchRequest).toMatchObject({ wireName: "apply_patch", freeform: true, input: patchText });
      broker.completeTool(directToken, directPatchRequest!.callId, toolResult({ applied: true }));
      await directPatchPromise;

      const directImagePromise = call("codex_view_image", {
        binding_id: directBindingId,
        path: `${tempRoot}/image.png`,
        detail: "high",
      });
      const [directImageRequest] = await broker.nextToolBatch(directToken);
      expect(directImageRequest).toMatchObject({
        wireName: "view_image",
        freeform: false,
        arguments: { path: `${tempRoot}/image.png`, detail: "high" },
      });
      broker.completeTool(directToken, directImageRequest!.callId, toolResult({ viewed: true }));
      await directImagePromise;

      const shellBound = await call("codex_bind_turn", { turn_token: shellToken });
      const shellBindingId = (shellBound.structuredContent as { binding_id: string }).binding_id;
      expect((shellBound.structuredContent as { command_tool: string }).command_tool).toBe("shell_command");
      expect((shellBound.structuredContent as { outer_tool_gateway: string }).outer_tool_gateway).toBe("exec");
      expect((shellBound.structuredContent as { resumable_sessions: boolean }).resumable_sessions).toBe(false);
      expect((shellBound.structuredContent as { continuation_tool: string }).continuation_tool).toBe("write_stdin");
      expect((shellBound.structuredContent as { capabilities: string[] }).capabilities).not.toContain("resumable_exec_sessions");
      const shellExecPromise = call("codex_exec", {
        binding_id: shellBindingId,
        cmd: "pwd",
        workdir: tempRoot,
      });
      const [shellExecRequest] = await broker.nextToolBatch(shellToken);
      expect(shellExecRequest).toMatchObject({
        wireName: "shell_command",
        freeform: false,
        arguments: { command: "pwd", workdir: tempRoot },
      });
      broker.completeTool(shellToken, shellExecRequest!.callId, toolResult({ output: tempRoot, exit_code: 0 }));
      await shellExecPromise;
    } finally {
      await client.close().catch(() => {});
      broker.revoke(token);
      broker.revoke(directToken);
      broker.revoke(directWithoutContinuationToken);
      broker.revoke(shellToken);
      await broker.close();
    }
  }, 30_000);
});
