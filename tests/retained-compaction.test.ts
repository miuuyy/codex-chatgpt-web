import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptRetainedConversationUnavailableError } from "../src/adapters/chatgpt-web/adapter-error";
import {
  MAX_COMPACTION_HANDOFF_TIMEOUT_MS,
  requestRetainedCompactionHandoff,
  settleActiveCompactionSource,
} from "../src/adapters/chatgpt-web/compaction-handoff";
import { CompactionTransactionStore } from "../src/adapters/chatgpt-web/compaction-transaction";
import {
  chatGptConversationKey,
  retainedConversationResumeRequest,
} from "../src/adapters/chatgpt-web/conversation-key";
import {
  chatGptWebExecutionNamespace,
  createChatGptWebAdapter,
} from "../src/adapters/chatgpt-web/index";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  ChatGptTurnSession,
  ChatGptTurnSessions,
  chatGptCompactionSourceExecutionKey,
  chatGptTurnExecutionKey,
  chatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import {
  callTurnBroker,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import {
  CODEX_ACTIVE_COMPACTION_REQUEST_MARKER,
  structuredCompactionHandoffInstruction,
} from "../src/adapters/chatgpt-web/native-compaction-control";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "Original task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Work completed" }], timestamp: 2 },
        { role: "user", content: "Continue with the next step", timestamp: 3 },
      ],
    },
    options: { reasoning: "high" },
    _compactionRequest: compaction,
    _rawBody: {
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue with the next step" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_source" },
      }],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_retained_compaction",
          turn_id: compaction ? "turn_compact" : "turn_source",
        }),
      },
    },
  };
}

function controlBinding(instruction: string): { token: string; handoffId: string } {
  const token = instruction.match(/turn_token (control_[a-f0-9]{32})/)?.[1];
  const handoffId = instruction.match(/handoff_id (handoff_[a-f0-9]{32})/)?.[1];
  if (!token || !handoffId) throw new Error(`Missing compaction control binding: ${instruction}`);
  return { token, handoffId };
}

test("one browser conversation spans native turns and rotates only at compaction", () => {
  const before = request(false);
  before.context.systemPrompt = ["stable system contract"];
  const sameTurn = structuredClone(before);
  (sameTurn._rawBody as { input: unknown[] }).input.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Same native turn revision" }],
  });
  const nextTurn = structuredClone(before);
  (nextTurn._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_retained_compaction",
      turn_id: "turn_next",
    }),
  };
  const afterCompact = structuredClone(before);
  (afterCompact._rawBody as { input: unknown[] }).input.unshift({
    type: "compaction",
    encrypted_content: "ocx1:checkpoint",
  });

  expect(chatGptConversationKey(sameTurn, "provider")).toBe(chatGptConversationKey(before, "provider"));
  expect(chatGptConversationKey(nextTurn, "provider")).toBe(chatGptConversationKey(before, "provider"));
  expect(chatGptConversationKey(afterCompact, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const otherModel = structuredClone(before);
  otherModel.modelId = "chatgpt-web/pro";
  expect(chatGptConversationKey(otherModel, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const otherEffort = structuredClone(before);
  otherEffort.options.reasoning = "medium";
  expect(chatGptConversationKey(otherEffort, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const otherThread = structuredClone(before);
  (otherThread._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_other",
      turn_id: "turn_source",
    }),
  };
  expect(chatGptConversationKey(otherThread, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const changedSystem = structuredClone(before);
  changedSystem.context.systemPrompt = ["updated system contract"];
  expect(chatGptConversationKey(changedSystem, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
  const resume = retainedConversationResumeRequest(before);
  expect(resume?.context.systemPrompt).toBeUndefined();
  expect(resume?.context.messages).toEqual([
    { role: "user", content: "Continue with the next step", timestamp: 3 },
  ]);

  const v1Compact = structuredClone(before);
  (v1Compact._rawBody as { input: unknown[] }).input.unshift({
    role: "user",
    content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\ncheckpoint` }],
  });
  expect(chatGptConversationKey(v1Compact, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
});

test("compaction capability is one-shot and structurally bound to its handoff id", async () => {
  const store = new CompactionTransactionStore();
  const transaction = store.begin("trace_compaction", 1_000);
  expect(() => store.submit(transaction.token, "handoff_wrong", "checkpoint")).toThrow("does not match");
  store.submit(transaction.token, transaction.handoffId, "  exact checkpoint  ");
  await expect(store.wait(transaction.token)).resolves.toBe("exact checkpoint");
  expect(() => store.submit(transaction.token, transaction.handoffId, "again")).toThrow("invalid, expired, or consumed");
  store.close();
});

test("retained compaction provides one exact same-agent control binding", () => {
  const prompt = structuredCompactionHandoffInstruction({
    token: "control_11111111111111111111111111111111",
    handoffId: "handoff_22222222222222222222222222222222",
  });
  expect(prompt).toContain("Automatic Codex context compaction has started.");
  expect(prompt).toContain("Stop ordinary task work");
  expect(prompt).toContain("turn_token control_11111111111111111111111111111111");
  expect(prompt).toContain("wire_name codex.control.compaction_handoff");
  expect(prompt).toContain('"handoff_id":"handoff_22222222222222222222222222222222"');
  expect(prompt).toContain("do not use it with codex_exec, codex_tool_inventory, or any outer Codex tool");
  expect(prompt).toContain("submitted=true");
});

test("a compaction control token cannot claim the ordinary Codex tool environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-compaction-capability-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const transaction = await broker.beginCompactionTransaction("trace_capability", 1_000);
    await expect(callTurnBroker(broker.socketPath, {
      method: "claim",
      token: transaction.token,
    })).rejects.toThrow("turn token is invalid");
    await callTurnBroker(broker.socketPath, {
      method: "submit_compaction_handoff",
      token: transaction.token,
      handoffId: transaction.handoffId,
      summary: "Bound checkpoint",
    });
    await expect(broker.waitForCompactionHandoff(transaction.token)).resolves.toBe("Bound checkpoint");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("active compaction delivers the current result and converts every later MCP call into the checkpoint request", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-active-compaction-gate-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    // The assertion exercises compaction routing, not expiry. Leave enough lease headroom for
    // Windows named-pipe scheduling under the full parallel test suite.
    }, 30_000, "trace_active_compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const current = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "pwd" },
    });
    const [request] = await broker.nextToolBatch(token);
    broker.requestCompaction(token, {
      content: [{ type: "text", text: "compact now" }],
      isError: true,
    });
    broker.completeTool(token, request!.callId, {
      content: [{ type: "text", text: "current result" }],
    });
    await expect(current).resolves.toMatchObject({
      content: [{ type: "text", text: "current result" }],
    });
    await expect(callTurnBroker(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "git status --short" },
    })).resolves.toMatchObject({
      content: [{ type: "text", text: "compact now" }],
      isError: true,
    });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("active compaction drains an MCP call already queued without an outer Codex waiter", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-queued-before-compaction-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    }, 10_000, "trace_prequeued_compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const invocation = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "must-not-run" },
    });
    await Bun.sleep(25);
    const interrupted = broker.requestCompaction(token, {
      content: [{ type: "text", text: "compact instead" }],
      isError: true,
    });
    expect(interrupted).toBe(1);
    await expect(invocation).resolves.toMatchObject({
      content: [{ type: "text", text: "compact instead" }],
      isError: true,
    });
    expect(broker.compactionDeliveryCount(token)).toBe(1);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a completed retained agent returns an exact checkpoint and its browser is physically retired", async () => {
  expect(MAX_COMPACTION_HANDOFF_TIMEOUT_MS).toBe(5 * 60_000);
  const sourceRequest = request(false);
  const conversationKey = chatGptConversationKey(sourceRequest, "provider")!;
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey,
    cancel() {},
  });
  let captured: BrowserTurn | undefined;
  let browserRetired = false;
  let transactionAborted = false;
  let transactionTtl = 0;
  const broker = {
    beginCompactionTransaction: async (_traceId: string, ttlMs: number) => {
      transactionTtl = ttlMs;
      return {
      token: "control_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
      };
    },
    waitForCompactionHandoff: async () => "Retained agent checkpoint",
    abortCompactionTransaction: () => { transactionAborted = true; },
  } as unknown as TurnBroker;
  const worker = {
    run: async (turn: BrowserTurn): Promise<string> => {
      captured = turn;
      const prepared = await turn.prepareResume!();
      expect(prepared.text).toContain("wire_name codex.control.compaction_handoff");
      prepared.release();
      browserRetired = true;
      return "Checkpoint submitted through MCP";
    },
  };

  await expect(requestRetainedCompactionHandoff(
    worker as never,
    request(true),
    source,
    broker,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    "trace_handoff",
    undefined,
    60 * 60_000,
  )).resolves.toBe("Retained agent checkpoint");
  expect(captured?.conversationKey).toBe(conversationKey);
  expect(captured?.requireRetainedConversation).toBeTrue();
  expect(captured?.nativeConnector).toBeTrue();
  expect(captured?.capabilities.localToolsEnabled).toBeFalse();
  expect(browserRetired).toBeTrue();
  expect(transactionAborted).toBeTrue();
  expect(transactionTtl).toBe(MAX_COMPACTION_HANDOFF_TIMEOUT_MS);
});

test("completed retained compaction never treats ordinary assistant text as a handoff", async () => {
  const sourceRequest = request(false);
  const source = new ChatGptTurnSession({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey: chatGptConversationKey(sourceRequest, "provider")!,
    cancel() {},
  });
  const broker = {
    beginCompactionTransaction: async () => ({
      token: "control_11111111111111111111111111111111",
      handoffId: "handoff_22222222222222222222222222222222",
    }),
    waitForCompactionHandoff: async () => { throw new Error("structured handoff missing"); },
    abortCompactionTransaction() {},
  } as unknown as TurnBroker;
  const worker = {
    run: async () => '{"checkpoint":"must never be parsed"}',
  };

  await expect(requestRetainedCompactionHandoff(
    worker as never,
    request(true),
    source,
    broker,
    { localToolsEnabled: true, solAvailable: true, proAvailable: true },
    "trace_no_text_fallback",
  )).rejects.toThrow("structured handoff missing");
});

test("active compaction turns the final canonical tool result into the same-response checkpoint request", async () => {
  const completed: Array<{ callId: string; result: BrokerToolResult }> = [];
  const compactionTokens: string[] = [];
  const broker = {
    requestCompaction: (token: string) => { compactionTokens.push(token); return 0; },
    compactionDeliveryCount: () => 0,
    completeTool: async (_token: string, callId: string, result: BrokerToolResult) => {
      completed.push({ callId, result });
    },
    revoke() {},
  } as unknown as TurnBroker;
  const source = new ChatGptTurnSession({
    mode: "tools",
    token: Promise.resolve("turn_active"),
    externalProgress: { recordToolResult() {} } as never,
    browser: Promise.resolve("  Active-turn checkpoint  "),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  });
  source.setOutstanding([
    { callId: "call_one", wireName: "exec_command", freeform: false },
    { callId: "call_two", wireName: "exec_command", freeform: false },
  ]);
  const parsed = request(true);
  parsed.context.messages.push(
    { role: "toolResult", toolCallId: "call_one", toolName: "exec_command", content: "one", isError: false, timestamp: 4 },
    { role: "toolResult", toolCallId: "call_two", toolName: "exec_command", content: "two", isError: false, timestamp: 5 },
  );

  await expect(settleActiveCompactionSource(
    parsed,
    source,
    broker,
  )).resolves.toBe("Active-turn checkpoint");
  expect(compactionTokens).toEqual(["turn_active"]);
  expect(completed.map(entry => entry.callId)).toEqual(["call_one", "call_two"]);
  expect(JSON.stringify(completed[0])).not.toContain(CODEX_ACTIVE_COMPACTION_REQUEST_MARKER);
  expect(JSON.stringify(completed[1])).toContain(CODEX_ACTIVE_COMPACTION_REQUEST_MARKER);
  expect(JSON.stringify(completed[1])).toContain("You are performing a CONTEXT CHECKPOINT COMPACTION");
  expect(JSON.stringify(completed[1])).toContain("final response is the compaction result");
});

test("active compaction interrupts a queued MCP call that Codex never started waiting for", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-compaction-queued-call-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(root));
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [{
        name: "exec_command",
        description: "Run one command",
        parameters: { type: "object" },
      }],
    }, 10_000, "trace_queued_compaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(broker.socketPath, {
      method: "claim",
      token,
    });
    const queuedInvocation = callTurnBroker<BrokerToolResult>(broker.socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "must-not-run" },
    });
    const browser = queuedInvocation.then(result => {
      expect(result.isError).toBeTrue();
      expect(JSON.stringify(result.content)).toContain(CODEX_ACTIVE_COMPACTION_REQUEST_MARKER);
      expect(JSON.stringify(result.content)).toContain("The tool was not executed");
      return "Queued-call checkpoint";
    });
    const source = new ChatGptTurnSession({
      mode: "tools",
      token: Promise.resolve(token),
      externalProgress: { recordToolResult() {} } as never,
      browser,
      physicalSettlement: browser.then(() => undefined),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel() {},
    });

    await expect(settleActiveCompactionSource(
      request(true),
      source,
      broker,
    )).resolves.toBe("Queued-call checkpoint");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a later native message waits for the current response and its physical settlement without preempting it", async () => {
  const sessions = new ChatGptTurnSessions();
  let finishClient!: (answer: string) => void;
  let settlePhysical!: () => void;
  const clientOutcome = new Promise<string>(resolve => { finishClient = resolve; });
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  let cancellations = 0;
  sessions.getOrCreate("old", () => ({
    mode: "read-only",
    browser: clientOutcome,
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancellations += 1; },
  }), "old_trace", "same_owner");
  let starts = 0;
  const replacement = sessions.getOrCreateAfterOwnerRetirement("new", "same_owner", () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: Promise.resolve("new"),
      physicalSettlement: Promise.resolve(),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel() {},
    };
  });

  await Bun.sleep(0);
  expect(starts).toBe(0);
  expect(cancellations).toBe(0);
  finishClient("old complete");
  await Bun.sleep(0);
  expect(starts).toBe(0);
  settlePhysical();
  await replacement;
  expect(starts).toBe(1);
  expect(cancellations).toBe(0);
  sessions.clear();
});

test("a later native message still waits when logical completion happened before ownership lookup", async () => {
  const sessions = new ChatGptTurnSessions();
  let settlePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  const completed = sessions.getOrCreate("old-completed", () => ({
    mode: "read-only",
    browser: Promise.resolve("logical result"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel() {},
  }), "old_trace", "same_owner_after_result");
  await completed.browserOutcome;

  let starts = 0;
  const replacement = sessions.getOrCreateAfterOwnerRetirement(
    "new-after-result",
    "same_owner_after_result",
    () => {
      starts += 1;
      return {
        mode: "read-only" as const,
        browser: Promise.resolve("new"),
        physicalSettlement: Promise.resolve(),
        trace: new ChatGptTraceFeed(),
        text: new ChatGptTextFeed(),
        cancel() {},
      };
    },
  );
  await Bun.sleep(0);
  expect(starts).toBe(0);
  settlePhysical();
  await replacement;
  expect(starts).toBe(1);
  sessions.clear();
});

test("retained conversation release waits for physical settlement", async () => {
  const sessions = new ChatGptTurnSessions();
  let settlePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { settlePhysical = resolve; });
  let releases = 0;
  sessions.getOrCreate("retained", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    conversationKey: "a".repeat(64),
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  const retirement = sessions.retireConversationAndWait("a".repeat(64));
  await Bun.sleep(0);
  expect(releases).toBe(0);
  settlePhysical();
  expect(await retirement).toBe(1);
  expect(releases).toBe(1);
});

test("adapter compact returns only the same-agent MCP handoff and retires the old epoch", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-adapter-retained-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://retained-compact-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      appName: "Codex Native DEV",
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
    },
  };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  const conversationKey = chatGptConversationKey(sourceRequest, namespace)!;
  let releases = 0;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey,
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepareResume!();
    const binding = controlBinding(prepared.text);
    expect(turn.nativeConnector).toBeTrue();
    expect(turn.capabilities.localToolsEnabled).toBeFalse();
    prepared.release();
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "submit_compaction_handoff",
      token: binding.token,
      handoffId: binding.handoffId,
      summary: "Adapter retained checkpoint",
    });
    return "Checkpoint submitted through MCP";
  };
  const compact = structuredClone(sourceRequest);
  compact._compactionRequest = true;
  const compactSourceMessage = (compact._rawBody as { input: Array<{
    content: Array<{ type: string; text: string }>;
  }> }).input[0]!;
  compactSourceMessage.content = [{
    type: "input_text",
    text: "Provider-normalized current task revision",
  }];
  (compact._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_retained_compaction",
      turn_id: "turn_compact",
    }),
  };
  expect(chatGptConversationKey(compact, namespace)).toBe(conversationKey);
  expect(`${namespace}:${chatGptCompactionSourceExecutionKey(compact)}`).not.toBe(sourceKey);
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    const text = events
      .filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => event.type === "text_delta")
      .map(event => event.text)
      .join("");
    expect(text).toContain("Adapter retained checkpoint");
    expect(text).toContain("CODEX_LATEST_USER_PROMPT_JSON");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
    expect(chatGptTurnSessions.find(sourceKey)).toBeUndefined();
    expect(releases).toBe(1);
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a compact HTTP observer can reconnect without sending a second retained-chat message", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-compact-reconnect-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://compact-reconnect-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      appName: "Codex Native DEV",
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
    },
  };
  const broker = TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  const conversationKey = chatGptConversationKey(sourceRequest, namespace)!;
  let releases = 0;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey,
    releaseRetainedConversation: async () => { releases += 1; },
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  let browserMessages = 0;
  let messageStarted!: () => void;
  const started = new Promise<void>(resolve => { messageStarted = resolve; });
  let finishMessage!: () => void;
  const finish = new Promise<void>(resolve => { finishMessage = resolve; });
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserMessages += 1;
    const prepared = await turn.prepareResume!();
    const binding = controlBinding(prepared.text);
    prepared.release();
    messageStarted();
    await finish;
    await callTurnBroker(provider.chatgptWeb!.brokerSocketPath!, {
      method: "submit_compaction_handoff",
      token: binding.token,
      handoffId: binding.handoffId,
      summary: "Reconnect-safe checkpoint",
    });
    return "Checkpoint submitted through MCP";
  };
  const compact = structuredClone(sourceRequest);
  compact._compactionRequest = true;
  (compact._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "thread_retained_compaction",
      turn_id: "turn_compact_reconnect",
    }),
  };
  const adapter = createChatGptWebAdapter(provider);
  const disconnect = new AbortController();
  try {
    const first = adapter.runTurn!(
      compact,
      { headers: new Headers(), abortSignal: disconnect.signal },
      () => {},
    );
    await started;
    disconnect.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });

    const events: AdapterEvent[] = [];
    const reconnect = adapter.runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    finishMessage();
    await reconnect;
    expect(browserMessages).toBe(1);
    expect(releases).toBe(1);
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Reconnect-safe checkpoint"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("structured compact rebuilds canonical context when its retained source is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-missing-retained-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://missing-retained-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    expect(turn.requireRetainedConversation).toBeUndefined();
    expect(turn.conversationKey).toBeUndefined();
    expect(turn.compaction).toBeTrue();
    const prepared = await turn.prepare();
    expect(prepared.text).toContain("Original task");
    expect(prepared.text).toContain("Continue with the next step");
    prepared.release();
    return "Fallback checkpoint from canonical Codex context";
  };
  const compact = request(true);
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      compact,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserStarts).toBe(1);
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Fallback checkpoint from canonical Codex context"))).toBeTrue();
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("CODEX_LATEST_USER_PROMPT_JSON"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("structured compact rebuilds canonical context when its retained browser disappeared", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-stale-retained-compact-"));
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://stale-retained-${Date.now()}`,
    chatgptWeb: {
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, "launcher.json"),
      brokerSocketPath: defaultBrokerEndpoint(root),
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const sourceRequest = request(false);
  const namespace = chatGptWebExecutionNamespace(provider);
  const sourceKey = `${namespace}:${chatGptTurnExecutionKey(sourceRequest)}`;
  chatGptTurnSessions.getOrCreate(sourceKey, () => ({
    mode: "read-only",
    browser: Promise.resolve("source complete"),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    usageInput: sourceRequest,
    conversationKey: chatGptConversationKey(sourceRequest, namespace)!,
    cancel() {},
  }));
  await chatGptTurnSessions.find(sourceKey)!.browserOutcome;

  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    if (turn.requireRetainedConversation) throw chatGptRetainedConversationUnavailableError();
    const prepared = await turn.prepare();
    expect(prepared.text).toContain("Original task");
    prepared.release();
    return "Fallback checkpoint after retained browser loss";
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request(true),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(browserStarts).toBe(2);
    expect(events.some(event => event.type === "text_delta"
      && event.text.includes("Fallback checkpoint after retained browser loss"))).toBeTrue();
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await TurnBroker.forSocket(provider.chatgptWeb!.brokerSocketPath!).close();
    rmSync(root, { recursive: true, force: true });
  }
});
