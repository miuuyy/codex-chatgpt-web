import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import {
  createChatGptWebAdapter,
  type ChatGptZeroRiskManualControl,
} from "../src/adapters/chatgpt-web/index";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { encodeCompactionSummary, SUMMARY_PREFIX } from "../src/responses/compaction";
import { LAUNCHER_BROWSER_HOST_KIND, LAUNCHER_BROWSER_IDLE_URL } from "../src/launcher-browser-host";
import { CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL } from "../src/chatgpt-web-models";
import { defaultBrokerEndpoint } from "../src/config";
import type { AdapterEvent, CodexParsedRequest, CodexProviderConfig } from "../src/types";

const testTempRoot = process.platform === "win32" ? tmpdir() : "/tmp";
const root = mkdtempSync(join(testTempRoot, "cgw-zero-risk-adapter-"));
afterAll(() => {
  chatGptTurnSessions.clear();
  rmSync(root, { recursive: true, force: true });
});

function request(turnId: string): CodexParsedRequest {
  const threadId = "thread_safe_adapter";
  const environment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
  return {
    modelId: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
    stream: true,
    options: { reasoning: "low" },
    context: {
      tools: [],
      messages: [
        { role: "developer", content: environment, timestamp: 1 },
        { role: "user", content: "Inspect the Zero Risk transport.", timestamp: 2 },
      ],
    },
    _rawBody: {
      prompt_cache_key: threadId,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: environment }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the Zero Risk transport." }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      ],
    },
  };
}

function binding(prompt: string): { request_id: string } {
  const match = prompt.match(/<codex_zero_risk_request_json>\n(\{[^\n]+\})\n<\/codex_zero_risk_request_json>/);
  if (!match) throw new Error("Zero Risk prompt did not expose its request id");
  return JSON.parse(match[1]!) as { request_id: string };
}

function provider(name: string): CodexProviderConfig {
  return {
    adapter: "chatgpt-web",
    baseUrl: `manual://${name}-${Date.now()}`,
    chatgptWeb: {
      appName: "Codex Zero Risk",
      browserInteractionMode: "manual",
      browserHost: "launcher",
      browserHostDescriptorPath: join(root, `${name}-launcher.json`),
      brokerSocketPath: defaultBrokerEndpoint(join(root, name)),
      localToolsEnabled: true,
      solAvailable: false,
      proAvailable: false,
      experimentalBiggerContext: false,
    },
  };
}

function noManualTerminal(): Promise<never> {
  return new Promise<never>(() => {});
}

for (const scenario of [
  { format: "v1", finalWins: false },
  { format: "v2", finalWins: false },
  { format: "v2", finalWins: true },
] as const) test(`Zero Risk ${scenario.format} compaction resumes with exact launcher ownership (final wins: ${scenario.finalWins})`, async () => {
  // Real adapter, broker, and launcher lifecycle. Only the Electron view/clipboard and the
  // human/model actions are simulated: a mock start/end that omits tombstones misses #318.
  const require = createRequire(import.meta.url);
  const { BrowserHost } = require("../launcher/electron/browser-host.cjs");
  const { BrowserControlServer } = require("../launcher/electron/control-server.cjs");
  const config = provider(`compaction-owner-${scenario.format}-${scenario.finalWins}`);
  const socket = config.chatgptWeb!.brokerSocketPath!;
  const broker = TurnBroker.forSocket(socket);
  const logs: string[] = [];
  const logger = { info(event: string) { logs.push(event); }, warn() {}, error() {} };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(), manualTerminalSignals: new Map(), manualCompletionSignals: new Map(),
    manualOperation: null, clipboard: { writeText() {} }, logger,
    publishState() {}, snapshot: () => ({}), showWindow() {}, show() {}, writeDescriptor() {},
    createManualTurnTab(traceId: string, helperPid: number, conversationKey: string | undefined,
      prompt: string, manualSubmitTimeoutMs: number) {
      const tab = {
        id: traceId, traceId, helperPid, conversationKey, interactionMode: "manual", status: "running",
        manualState: "awaiting-user", manualSubmitTimeoutMs, manualDeadlineAt: Date.now() + manualSubmitTimeoutMs,
        manualDeadlineTimer: null, manualWaiters: new Set(), manualTerminalWaiters: new Set(),
        prompt, promptDigest: createHash("sha256").update(prompt).digest("hex"), manualConversationReused: false,
      };
      host.turnTabs.set(tab.id, tab);
      return tab;
    },
    removeTurnTab(tab: { id: string; manualDeadlineTimer?: ReturnType<typeof setTimeout> }) {
      clearTimeout(tab.manualDeadlineTimer);
      host.turnTabs.delete(tab.id);
    },
  });
  const server = await new BrowserControlServer({
    logger, getBrowserHost: () => host, getPreferences: () => ({}),
  }).start();
  writeFileSync(config.chatgptWeb!.browserHostDescriptorPath!, JSON.stringify({
    version: 2, kind: LAUNCHER_BROWSER_HOST_KIND, profile: "development", pid: process.pid,
    endpoint: server.descriptor().endpoint, control: server.descriptor(),
    helper: { executable: process.execPath, script: import.meta.path },
    partition: "persist:codex-web-gpt-dev-chatgpt", idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB", createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const starts: string[] = [];
  const bindings = new Map<string, string>();
  let modelAction: Promise<void> | undefined;
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      host.beginManualTurn(activity.traceId, activity.helperPid, activity.prompt,
        activity.conversationKey, activity.resumePrompt, activity.compaction);
      starts.push(activity.traceId);
      bindings.set(activity.traceId, binding(activity.prompt).request_id);
    },
    async waitSent(_path, owner) {
      host.confirmManualSent(owner.traceId);
      broker.startSafeTurn(bindings.get(owner.traceId)!);
    },
    waitTerminal: noManualTerminal,
    async markStarted(_path, owner) {
      host.markManualTurnStarted(owner.traceId, owner.helperPid);
      const token = bindings.get(owner.traceId)!;
      if (starts.length > 1) {
        broker.completeSafeTurn(token, "Final answer after compaction");
        return;
      }
      modelAction = (async () => {
        const claim = await callTurnBroker<{ bindingId: string; activityId: string }>(socket, {
          method: "claim", token, contract: "safe",
        });
        const result = await callTurnBroker<BrokerToolResult>(socket, {
          method: "invoke", bindingId: claim.bindingId, wireName: "exec_command", freeform: false,
          arguments: { cmd: "pwd" },
        }, null);
        if (!scenario.finalWins) expect(JSON.stringify(result)).toContain("codex_turn_complete");
        await callTurnBroker(socket, { method: "activity_complete", token, activityId: claim.activityId });
        broker.completeSafeTurn(token, scenario.finalWins
          ? "Ordinary final answer before compaction"
          : "Checkpoint: the command finished; continue the task.");
      })();
    },
    async end(_path, activity) {
      return host.endManualTurn(activity.traceId, activity.helperPid, activity.status, activity.retain);
    },
    async cancel(_path, owner) { host.cancelManualTurn(owner.traceId, owner.helperPid); },
  };
  const adapter = createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control });
  const source = request("turn_safe_active_compaction");
  source.context.tools = [{ name: "exec_command", description: "Run a command", parameters: { type: "object" } }];
  const events: AdapterEvent[] = [];
  try {
    await adapter.runTurn!(source, { headers: new Headers() }, event => events.push(event));
    const call = events.find(event => event.type === "tool_call_start");
    if (call?.type !== "tool_call_start") throw new Error("Source did not emit its native tool call");
    const compact = structuredClone(source);
    compact.context.messages.push({
      role: "toolResult", toolCallId: call.id, toolName: "exec_command", content: root, isError: false, timestamp: 3,
    });
    (compact._rawBody as { input: unknown[] }).input.push({
      type: "function_call_output", call_id: call.id, output: root,
    });
    if (scenario.finalWins) {
      // Let the ordinary result finish before native Codex requests compaction. Its final answer
      // must survive retirement even though a fresh manual checkpoint uses another browser owner.
      await adapter.runTurn!(compact, { headers: new Headers() }, () => {});
    }
    compact._compactionRequest = true;
    const checkpoint: AdapterEvent[] = [];
    await adapter.runTurn!(compact, { headers: new Headers() }, event => checkpoint.push(event));
    await modelAction;
    expect(checkpoint.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(host.manualCompletionSignals.has(starts[0])).toBeTrue();
    expect(logs).toContain("browser.retained_conversation_released");
    const summary = checkpoint.filter(event => event.type === "text_delta").map(event => event.text).join("");
    const continuation = structuredClone(source);
    (continuation._rawBody as { input: unknown[] }).input.push(scenario.format === "v2" ? {
      type: "compaction", encrypted_content: encodeCompactionSummary(summary),
    } : {
      type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }],
    });
    const final: AdapterEvent[] = [];
    await adapter.runTurn!(continuation, { headers: new Headers() }, event => final.push(event));
    expect(starts).toHaveLength(2);
    expect(starts[1]).not.toBe(starts[0]);
    const expectedFinal = scenario.finalWins ? "Ordinary final answer before compaction" : "Final answer after compaction";
    expect(final.some(event => event.type === "text_delta" && event.text === expectedFinal)).toBeTrue();
    const replay: AdapterEvent[] = [];
    await adapter.runTurn!(continuation, { headers: new Headers() }, event => replay.push(event));
    expect(starts).toHaveLength(2); // exact reconnect replays, it must not submit again
    expect(replay.at(-1)).toMatchObject({ type: "done", endTurn: true });
    expect(() => host.beginManualTurn(starts[0], process.pid, "old prompt")).toThrow("already completed");
  } finally {
    chatGptTurnSessions.clear();
    for (const tab of host.turnTabs.values()) clearTimeout(tab.manualDeadlineTimer);
    await broker.close();
    await server.close();
  }
});

test("Zero Risk adapter never starts the automatic browser worker and completes only through Zero Risk MCP", async () => {
  const config = provider("complete");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  const worker = ChatGptBrowserWorker.forProvider(config);
  const originalRun = worker.run.bind(worker);
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async () => {
    throw new Error("automatic browser worker must not run in Zero Risk mode");
  };
  let exactBinding: ReturnType<typeof binding> | undefined;
  let manualCompaction: true | undefined;
  const calls: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      calls.push("start");
      manualCompaction = activity.compaction;
      exactBinding = binding(activity.prompt);
    },
    async waitSent() {
      calls.push("sent");
      broker.startSafeTurn(exactBinding!.request_id);
    },
    waitTerminal: noManualTerminal,
    async markStarted() {
      calls.push("started");
      broker.completeSafeTurn(exactBinding!.request_id, "Zero Risk final answer");
    },
    async end(_path, activity) { calls.push(`end:${activity.status}:${activity.retain === true}`); },
    async cancel() { calls.push("cancel"); },
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      request("turn_safe_complete"),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(calls).toEqual(["start", "sent", "started", "end:completed:true"]);
    expect(manualCompaction).toBeUndefined();
    expect(events.some(event => event.type === "text_delta"
      && event.phase === "commentary"
      && event.text.startsWith("> **Action required in Zero Risk**")
      && event.text.includes("select the `Codex Zero Risk` plugin")
      && event.text.includes("confirm it was sent in the launcher"))).toBeTrue();
    expect(events.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
      event.type === "text_delta" && event.phase === "final_answer"
    )).map(event => event.text).join(""))
      .toBe("Zero Risk final answer");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("a lost launcher completion acknowledgement cannot replace an authoritative Zero Risk answer", async () => {
  const config = provider("completion-ack-lost");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  let exactBinding: ReturnType<typeof binding> | undefined;
  const endStatuses: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) { exactBinding = binding(activity.prompt); },
    async waitSent() { broker.startSafeTurn(exactBinding!.request_id); },
    waitTerminal: noManualTerminal,
    async markStarted() {
      broker.completeSafeTurn(exactBinding!.request_id, "Answer completed before the acknowledgement was lost");
    },
    async end(_path, activity) {
      endStatuses.push(activity.status);
      throw new Error("local completion acknowledgement was lost");
    },
    async cancel() {},
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      request("turn_safe_completion_ack_lost"),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(endStatuses).toEqual(["completed"]);
    expect(events.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
      event.type === "text_delta" && event.phase === "final_answer"
    )).map(event => event.text).join(""))
      .toBe("Answer completed before the acknowledgement was lost");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("Zero Risk keeps image handoff manual and says so in the paste instruction", async () => {
  const config = provider("image-boundary");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  const input = request("turn_safe_image_boundary");
  input.context.messages[1] = {
    role: "user",
    content: [
      { type: "text", text: "Inspect this image." },
      { type: "image", imageUrl: "data:image/png;base64,AAAA" },
    ],
    timestamp: 2,
  };
  let exactBinding: ReturnType<typeof binding> | undefined;
  let manualPrompt = "";
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      manualPrompt = activity.prompt;
      exactBinding = binding(activity.prompt);
    },
    async waitSent() { broker.startSafeTurn(exactBinding!.request_id); },
    waitTerminal: noManualTerminal,
    async markStarted() { broker.completeSafeTurn(exactBinding!.request_id, "Manual image handoff completed"); },
    async end() {},
    async cancel() {},
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      input,
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(manualPrompt).not.toContain('"type":"image_attachment"');
    expect(manualPrompt).toContain("Images from the replayed Codex context are intentionally omitted");
    expect(events.some(event => event.type === "text_delta"
      && event.phase === "commentary"
      && event.text.includes("Images from the Codex context are intentionally omitted"))).toBeTrue();
    expect(events.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
      event.type === "text_delta" && event.phase === "final_answer"
    )).map(event => event.text).join(""))
      .toBe("Manual image handoff completed");
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("a stopped Responses observer revokes its Zero Risk binding and releases the manual turn", async () => {
  const config = provider("stopped-observer");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  let exactBinding: ReturnType<typeof binding> | undefined;
  let signalVisible!: () => void;
  const visible = new Promise<void>(resolve => { signalVisible = resolve; });
  const ended: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      exactBinding = binding(activity.prompt);
      signalVisible();
    },
    async waitSent(_path, _owner, options) {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new DOMException("manual wait aborted", "AbortError"));
        options?.abortSignal?.addEventListener("abort", abort, { once: true });
        if (options?.abortSignal?.aborted) abort();
      });
    },
    waitTerminal: noManualTerminal,
    async markStarted() {},
    async end(_path, activity) { ended.push(activity.status); },
    async cancel() {},
  };
  const adapter = createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control });
  const input = request("turn_safe_stopped");
  const disconnect = new AbortController();
  try {
    const first = adapter.runTurn!(
      input,
      { headers: new Headers(), abortSignal: disconnect.signal },
      () => {},
    );
    await visible;
    disconnect.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    for (let attempt = 0; ended.length === 0 && attempt < 50; attempt += 1) await Bun.sleep(5);
    expect(ended).toEqual(["aborted"]);
    expect(() => broker.startSafeTurn(exactBinding!.request_id))
      .toThrow("invalid, expired, or revoked");
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("a Zero Risk launcher failure remains failed when its own capability cleanup retires the broker", async () => {
  const config = provider("failed-cleanup");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  let exactBinding: ReturnType<typeof binding> | undefined;
  const ended: string[] = [];
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) { exactBinding = binding(activity.prompt); },
    async waitSent() { throw new Error("synthetic launcher observation failure"); },
    waitTerminal: noManualTerminal,
    async markStarted() {},
    async end(_path, activity) { ended.push(activity.status); },
    async cancel() {},
  };
  try {
    await expect(createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      request("turn_safe_failed_cleanup"),
      { headers: new Headers() },
      () => {},
    )).rejects.toThrow("synthetic launcher observation failure");
    expect(ended).toEqual(["failed"]);
    expect(() => broker.startSafeTurn(exactBinding!.request_id))
      .toThrow("invalid, expired, or revoked");
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("Zero Risk offers only the new Codex suffix when the launcher reuses its retained ChatGPT chat", async () => {
  const config = provider("incremental-resume");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  const input = request("turn_safe_incremental");
  input.context.messages.push(
    { role: "assistant", content: [{ type: "text", text: "Earlier answer already visible in ChatGPT." }], timestamp: 3 },
    { role: "user", content: "Continue with only this new request.", timestamp: 4 },
  );
  const rawInput = (input._rawBody as { input: Array<Record<string, unknown>> }).input;
  const historicalTurnId = "turn_safe_incremental_previous";
  for (const item of rawInput) {
    item.internal_chat_message_metadata_passthrough = { turn_id: historicalTurnId };
  }
  rawInput.push(
    {
      type: "message",
      id: "msg_safe_incremental_previous_answer",
      role: "assistant",
      content: [{ type: "output_text", text: "Earlier answer already visible in ChatGPT." }],
    },
    {
      type: "message",
      id: "msg_safe_incremental_current_prompt",
      role: "user",
      content: [{ type: "input_text", text: "Continue with only this new request." }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_safe_incremental" },
    },
  );
  let exactBinding: ReturnType<typeof binding> | undefined;
  let fullPrompt = "";
  let resumePrompt = "";
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      fullPrompt = activity.prompt;
      resumePrompt = activity.resumePrompt ?? "";
      exactBinding = binding(resumePrompt);
    },
    async waitSent() {
      broker.startSafeTurn(exactBinding!.request_id);
    },
    waitTerminal: noManualTerminal,
    async markStarted() {
      broker.completeSafeTurn(exactBinding!.request_id, "Incremental answer");
    },
    async end() {},
    async cancel() {},
  };
  try {
    await createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      input,
      { headers: new Headers() },
      () => {},
    );
    expect(fullPrompt).toContain("Earlier answer already visible in ChatGPT.");
    expect(fullPrompt).toContain("Continue with only this new request.");
    expect(resumePrompt).not.toContain("Earlier answer already visible in ChatGPT.");
    expect(resumePrompt).toContain("Continue with only this new request.");
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("Zero Risk compaction uses a fresh manual checkpoint without leaking guide text into the summary", async () => {
  const config = provider("compaction");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  let exactBinding: ReturnType<typeof binding> | undefined;
  let manualCompaction: true | undefined;
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) {
      manualCompaction = activity.compaction;
      exactBinding = binding(activity.prompt);
    },
    async waitSent() {
      broker.startSafeTurn(exactBinding!.request_id);
    },
    waitTerminal: noManualTerminal,
    async markStarted() {
      broker.completeSafeTurn(
        exactBinding!.request_id,
        "Zero Risk checkpoint summary",
      );
    },
    async end() {},
    async cancel() {},
  };
  const input = request("turn_safe_compaction");
  input._compactionRequest = true;
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      input,
      { headers: new Headers() },
      event => events.push(event),
    );
    const deltas = events.filter((event): event is Extract<AdapterEvent, { type: "text_delta" }> => (
      event.type === "text_delta"
    ));
    expect(manualCompaction).toBeTrue();
    expect(deltas.every(event => event.phase === "final_answer")).toBeTrue();
    expect(deltas.map(event => event.text).join(""))
      .toContain("Zero Risk checkpoint summary\n\nCODEX_LATEST_USER_PROMPT_JSON");
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});

test("closing the Zero Risk Launcher tab revokes the bound turn instead of waiting forever", async () => {
  const config = provider("cancelled-tab");
  const broker = TurnBroker.forSocket(config.chatgptWeb!.brokerSocketPath!);
  let exactBinding: ReturnType<typeof binding> | undefined;
  let releaseTerminal!: () => void;
  const terminal = new Promise<void>(resolve => { releaseTerminal = resolve; });
  const control: ChatGptZeroRiskManualControl = {
    async start(_path, activity) { exactBinding = binding(activity.prompt); },
    async waitSent() {
      broker.startSafeTurn(exactBinding!.request_id);
    },
    async waitTerminal() {
      await terminal;
      return { status: "cancelled" };
    },
    async markStarted() { releaseTerminal(); },
    async end() {},
    async cancel() {},
  };
  const events: AdapterEvent[] = [];
  try {
    await createChatGptWebAdapter(config, { broker, zeroRiskManualControl: control }).runTurn!(
      request("turn_safe_cancelled_tab"),
      { headers: new Headers() },
      event => events.push(event),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "manual_turn_cancelled",
      retryable: false,
    });
    expect(() => broker.startSafeTurn(exactBinding!.request_id))
      .toThrow("invalid, expired, or revoked");
  } finally {
    chatGptTurnSessions.clear();
    await broker.close();
  }
});
