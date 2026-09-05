import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS, CHATGPT_COMPLETION_SETTLE_MS, CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS, CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS, ChatGptCompletionTracker, chatGptExternalProgressSuppressesDomHealth, CHATGPT_RESPONSE_DOM_GRACE_MS, MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS, CHATGPT_COMPOSER_DOCUMENT_END_KEY, CHATGPT_COMPOSER_SELECT_ALL_KEY, CHATGPT_STOPPED_THINKING_GRACE_MS, ChatGptBrowserObservationTimeoutError, ChatGptBrowserWorker, ChatGptPromptAttachmentIntegrityError, ChatGptStoppedThinkingTracker, ChatGptTurnDomHealthTracker, ChatGptVisibleTraceTracker, MAX_CHATGPT_BROWSER_PAGE_REBINDS, MAX_CHATGPT_BROWSER_TABS, MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS, assertChatGptWebInputWithinLimits, assertChatGptWebMultipartInputWithinLimits, browserDiagnosticCheckpoint, chatGptConnectorAttachmentMode, chatGptEffortSelectionRequired, chatGptNewTurnIdentity, chatGptReboundTurnIdentity, chatGptSubmissionEvidence, connectAfterClosingBrowserConnection, dismissChatGptTemporaryChatOnboarding, isChatGptTraceControl, redactChatGptUiDiagnostic, resolveBrowserConfig, resolveChatGptToolConfirmation, resolveChatGptWebMultipartStagingMode, sanitizeChatGptBrowserDiagnosticState, setChatGptThinkMode, stripChatGptTraceControlSuffix, throwIfChatGptRateLimitDialog, throwIfChatGptSessionFailureAlert, throwIfChatGptTerminalErrorAlert, withChatGptBrowserObservationTimeout, CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS, browserStageTimeouts, ChatGptSuspensionClock, remainingStageBudgetMs } from "../src/adapters/chatgpt-web/browser-worker";
import { ensureChatGptPersonalizedConnectorAccess } from "../src/adapters/chatgpt-web/browser-worker";
import { chatGptStoppedThinkingError } from "../src/adapters/chatgpt-web/adapter-error";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { CHATGPT_CONNECTOR_NAME, DEV_CHATGPT_CONNECTOR_NAME, defaultChromeExecutable, legacyChatGptConnectorMigrationMessage } from "../src/config";
import { parseChatGptEffortSliderState } from "../src/chatgpt-session";
import { ChatGptExternalTurnProgress, chatGptExternalToolCallsAreInFlight } from "../src/adapters/chatgpt-web/turn-progress";
import type { CodexProviderConfig } from "../src/types";

function personalizedTemporaryChatRole(
  _role: string,
  options: { name: string | RegExp },
) {
  const locator = {
    filter: (_filter: { visible: boolean }) => ({
      count: async () => options.name === "Personalized" ? 1 : 0,
    }),
  };
  return locator;
}

test("conversation turn identity survives ChatGPT DOM virtualization", () => {
  expect(chatGptNewTurnIdentity(
    ["conversation-turn-1", "conversation-turn-2", "conversation-turn-3"],
    ["conversation-turn-2", "conversation-turn-3", "conversation-turn-4"],
  )).toBe("conversation-turn-4");
  expect(chatGptNewTurnIdentity(
    ["conversation-turn-1"],
    ["conversation-turn-1"],
  )).toBeUndefined();
  expect(() => chatGptNewTurnIdentity(
    ["conversation-turn-1"],
    ["conversation-turn-1", "conversation-turn-2", "conversation-turn-3"],
  )).toThrow("2 new conversation turns");
});

test("assistant tracking rebinds only one proven replacement after React detaches its node", () => {
  expect(chatGptReboundTurnIdentity(
    ["conversation-turn-1"],
    "conversation-turn-2",
    ["conversation-turn-1", "conversation-turn-2"],
  )).toBe("conversation-turn-2");
  expect(chatGptReboundTurnIdentity(
    ["conversation-turn-1"],
    "conversation-turn-2",
    ["conversation-turn-1", "conversation-turn-3"],
  )).toBe("conversation-turn-3");
  expect(() => chatGptReboundTurnIdentity(
    ["conversation-turn-1"],
    "conversation-turn-2",
    ["conversation-turn-1", "conversation-turn-3", "conversation-turn-4"],
  )).toThrow("2 new conversation turns");
});

test("a retained MCP conversation reuses its proven connector binding", () => {
  expect(chatGptConnectorAttachmentMode(true, false)).toBe("mention");
  expect(chatGptConnectorAttachmentMode(true, true)).toBe("retained");
  expect(chatGptConnectorAttachmentMode(false, false)).toBe("none");
});

test("a retained conversation preserves its proven effort unless multipart staging needs another one", () => {
  expect(chatGptEffortSelectionRequired(false, "medium", "medium")).toBeTrue();
  expect(chatGptEffortSelectionRequired(true, "medium", "medium")).toBeFalse();
  expect(chatGptEffortSelectionRequired(true, "medium", "light")).toBeTrue();
});

test("browser turns run concurrently up to the five-tab limit", async () => {
  expect(MAX_CHATGPT_BROWSER_TABS).toBe(5);
  const releases = new Map<string, () => void>();
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    config: { browserHost: "managed-chrome" },
    activeRuns: new Map(),
    runExclusive: (turn: { traceId: string }) => new Promise<string>(resolve => {
      releases.set(turn.traceId, () => resolve(turn.traceId));
    }),
  }) as ChatGptBrowserWorker;
  const browserTurn = (traceId: string) => ({
    traceId,
    modelId: "chatgpt-web/high",
    capabilities: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
    prepare: async () => ({ text: traceId, images: [], release() {} }),
    onTextDelta() {},
  });

  const active = Array.from({ length: 5 }, (_unused, index) => worker.run(browserTurn(`trace_${index + 1}`)));
  await Promise.resolve();
  expect(releases.size).toBe(5);
  await expect(worker.run(browserTurn("trace_6"))).rejects.toThrow("at most 5 simultaneous browser turns");

  releases.get("trace_1")?.();
  await active[0];
  const sixth = worker.run(browserTurn("trace_6"));
  await Promise.resolve();
  expect(releases.has("trace_6")).toBeTrue();
  for (const traceId of ["trace_2", "trace_3", "trace_4", "trace_5", "trace_6"]) {
    releases.get(traceId)?.();
  }
  await Promise.all([...active.slice(1), sixth]);
});

test("browser turns have no absolute deadline unless one is explicitly configured", () => {
  const provider = { adapter: "chatgpt-web" as const, baseUrl: "browser://chatgpt" };
  expect(resolveBrowserConfig(provider).turnTimeoutMs).toBeUndefined();
  expect(resolveBrowserConfig({
    ...provider,
    chatgptWeb: { turnTimeoutMs: 123_000 },
  }).turnTimeoutMs).toBe(123_000);
  expect(() => resolveBrowserConfig({
    ...provider,
    chatgptWeb: { turnTimeoutMs: 0 },
  })).toThrow("turnTimeoutMs must be a positive finite number");
});

test("managed Chrome defaults follow the host platform", () => {
  expect(defaultChromeExecutable("darwin")).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  expect(defaultChromeExecutable("linux")).toBe("/usr/bin/google-chrome");
  expect(defaultChromeExecutable("win32", "D:\\Program Files")).toBe(
    "D:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  );
  const provider = { adapter: "chatgpt-web" as const, baseUrl: "browser://chatgpt" };
  expect(resolveBrowserConfig(provider).chromeExecutablePath).toBe(defaultChromeExecutable());
  expect(resolveBrowserConfig(provider).appName).toBe(CHATGPT_CONNECTOR_NAME);
});

test("browser configuration rejects the retired connector identity before opening a turn", () => {
  expect(() => resolveBrowserConfig({
    adapter: "chatgpt-web",
    baseUrl: "browser://chatgpt",
    chatgptWeb: { appName: "Codex Native" },
  })).toThrow(/requires a newly created connector named "Codex Native2".*do not rename or refresh/s);
});

test("connector verification reports a legacy-only ChatGPT menu as a migration error", async () => {
  const connectorMentionFailure = (ChatGptBrowserWorker.prototype as unknown as {
    connectorMentionFailure(menuRows: unknown, triggerAttempts: number): Promise<string>;
  }).connectorMentionFailure;
  const message = await connectorMentionFailure.call({
    config: { appName: CHATGPT_CONNECTOR_NAME },
    connectorMentionRowTitles: async () => ["Codex Native", "Another connector"],
  }, {}, 4);

  expect(message).toContain('Legacy ChatGPT connector "Codex Native" was found');
  expect(message).toContain('newly created connector named "Codex Native2"');
  expect(message).toContain('do not rename or refresh "Codex Native"');
  expect(message).not.toContain("Another connector");

  const mixedMessage = await connectorMentionFailure.call({
    config: { appName: CHATGPT_CONNECTOR_NAME },
    connectorMentionRowTitles: async () => ["Codex Native", "Codex Native2", "Private chat title"],
  }, {}, 4);
  expect(mixedMessage).not.toContain("Legacy ChatGPT connector");
  expect(mixedMessage).toContain('no row named "Codex Native2"');
  expect(mixedMessage).not.toContain("Private chat title");
});

test("browser stage timeout aborts late page acquisition", async () => {
  let acquisitionAborted = false;
  const runStage = (ChatGptBrowserWorker.prototype as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
    ): Promise<T>;
  }).runStage;

  const result = runStage.call(
    {},
    "trace_timeout",
    "browser_page",
    10,
    async (signal) => await new Promise<string>((resolve) => {
      signal.addEventListener("abort", () => {
        acquisitionAborted = true;
        resolve("late page");
      }, { once: true });
    }),
  );

  await expect(result).rejects.toThrow("ChatGPT browser stage timed out: browser_page");
  expect(acquisitionAborted).toBeTrue();
});

test("a mutating stage timeout waits for abort cleanup before returning", async () => {
  let cleanupComplete = false;
  let stageSettled = false;
  let releaseCleanup!: () => void;
  let markAbortSeen!: () => void;
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  const abortSeen = new Promise<void>(resolve => { markAbortSeen = resolve; });
  const runStage = (ChatGptBrowserWorker.prototype as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
      clock: { suspendedMs(): number },
      awaitAbortedActionSettlement: boolean,
    ): Promise<T>;
  }).runStage;

  const stage = runStage.call(
    {},
    "trace_cleanup",
    "prompt_attachment",
    10,
    async (signal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      markAbortSeen();
      await cleanupGate;
      cleanupComplete = true;
      throw new DOMException("stage aborted", "AbortError");
    },
    { suspendedMs: () => 0 },
    true,
  ).finally(() => { stageSettled = true; });
  const outcome = stage.then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );

  await abortSeen;
  expect(stageSettled).toBeFalse();
  expect(cleanupComplete).toBeFalse();
  releaseCleanup();
  const { error } = await outcome;
  expect(error).toMatchObject({ message: "ChatGPT browser stage timed out: prompt_attachment" });
  expect(stageSettled).toBeTrue();
  expect(cleanupComplete).toBeTrue();
});

test("a mutating stage timeout preserves a failed cleanup integrity error", async () => {
  let menuOpen = false;
  const personalized = { filter: () => personalized, count: async () => 0 };
  const unpersonalized = {
    filter: () => unpersonalized,
    count: async () => 1,
    click: async () => { menuOpen = true; },
    getAttribute: async () => "stage-timeout-menu",
  };
  const menu = {
    waitFor: async ({ signal }: { signal?: AbortSignal }) => {
      await new Promise<never>((_resolve, reject) => signal?.addEventListener(
        "abort",
        () => reject(new DOMException("menu wait aborted", "AbortError")),
        { once: true },
      ));
    },
  };
  const page = {
    getByRole: (_role: string, options: { name: string }) => (
      options.name === "Personalized" ? personalized : unpersonalized
    ),
    locator: (selector: string) => selector === "body"
      ? { press: async () => { throw new Error("menu cleanup failed"); } }
      : menu,
  } as any;
  const runStage = (ChatGptBrowserWorker.prototype as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
      clock: { suspendedMs(): number },
      awaitAbortedActionSettlement: boolean,
    ): Promise<T>;
  }).runStage;

  await expect(runStage.call(
    {},
    "trace_cleanup_failure",
    "prompt_attachment",
    10,
    signal => ensureChatGptPersonalizedConnectorAccess(page, undefined, undefined, signal),
    { suspendedMs: () => 0 },
    true,
  )).rejects.toMatchObject({
    name: "ChatGptPersistentBrowserStateError",
    message: "ChatGPT labeled personalization change failed and its opened menu could not be closed",
  });
  expect(menuOpen).toBeTrue();
});

test("compaction retry submission evidence cannot make prompt-stage settlement unbounded", async () => {
  let evaluateStarted = false;
  const page = {
    evaluate: async () => {
      evaluateStarted = true;
      return await new Promise<never>(() => {});
    },
  } as any;
  const baseline = {
    domCache: {},
    initialUserTurnIdentities: [],
    initialResponseTurnIdentities: [],
    initialUserTurnCount: 0,
    initialResponseTurnCount: 0,
  } as any;
  const prototype = ChatGptBrowserWorker.prototype as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
      clock: { suspendedMs(): number },
      awaitAbortedActionSettlement: boolean,
    ): Promise<T>;
    attachPromptWithCompactionRetry(
      page: unknown,
      prompt: string,
      localTools: boolean,
      compaction: boolean,
      baseline: unknown,
      capture: undefined,
      signal: AbortSignal,
    ): Promise<void>;
    currentSubmissionEvidence(page: unknown, baseline: unknown, signal?: AbortSignal): Promise<unknown>;
    submissionDomState(page: unknown, cache?: unknown, signal?: AbortSignal): Promise<unknown>;
  };
  const fixture = {
    attachPrompt: async () => {
      throw new ChatGptPromptAttachmentIntegrityError("force compaction attachment retry");
    },
    currentSubmissionEvidence: prototype.currentSubmissionEvidence,
    submissionDomState: prototype.submissionDomState,
  };

  const result = prototype.runStage.call(
    {},
    "trace_compaction_retry_timeout",
    "prompt_attachment",
    10,
    signal => prototype.attachPromptWithCompactionRetry.call(
      fixture,
      page,
      "prompt",
      false,
      true,
      baseline,
      undefined,
      signal,
    ),
    { suspendedMs: () => 0 },
    true,
  );
  await expect(result).rejects.toThrow("ChatGPT browser stage timed out: prompt_attachment");
  expect(evaluateStarted).toBeTrue();
});

test("launcher page acquisition proves a nonzero operational viewport before DOM interaction", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const connect = workerSource.indexOf("const connection = await connectLauncherBrowserHost(");
  const viewport = workerSource.indexOf("await waitForOperationalChatGptViewport(connection.page, abortSignal);", connect);
  const acquired = workerSource.indexOf('await diagnostics.capture(page, "browser-page-acquired")', viewport);

  expect(connect).toBeGreaterThan(-1);
  expect(viewport).toBeGreaterThan(connect);
  expect(acquired).toBeGreaterThan(viewport);
  expect(workerSource).toContain("innerWidth >= width && innerHeight >= height");
});

test("launcher effort selection refreshes the hidden viewport after navigation and before both effort pickers", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const refreshHelper = workerSource.indexOf("private async refreshLauncherViewport(");
  const refreshRequest = workerSource.indexOf("refreshViewport: true", refreshHelper);
  const firstStage = workerSource.indexOf('"effort_selection", browserStageTimeouts.effortSelection');
  const firstRefresh = workerSource.indexOf("await this.refreshLauncherViewport(turn.traceId);", firstStage);
  const firstViewport = workerSource.indexOf("await waitForOperationalChatGptViewport(page, signal);", firstRefresh);
  const firstPicker = workerSource.indexOf("return this.selectModelAndEffort(", firstViewport);
  const finalStage = workerSource.indexOf('"final_part_effort_selection",', firstPicker);
  const finalRefresh = workerSource.indexOf("await this.refreshLauncherViewport(turn.traceId);", finalStage);
  const finalViewport = workerSource.indexOf("await waitForOperationalChatGptViewport(page, signal);", finalRefresh);
  const finalPicker = workerSource.indexOf("return this.selectModelAndEffort(", finalViewport);

  expect(refreshHelper).toBeGreaterThan(-1);
  expect(refreshRequest).toBeGreaterThan(refreshHelper);
  expect(firstStage).toBeGreaterThan(-1);
  expect(firstRefresh).toBeGreaterThan(firstStage);
  expect(firstViewport).toBeGreaterThan(firstRefresh);
  expect(firstPicker).toBeGreaterThan(firstViewport);
  expect(finalStage).toBeGreaterThan(firstPicker);
  expect(finalRefresh).toBeGreaterThan(finalStage);
  expect(finalViewport).toBeGreaterThan(finalRefresh);
  expect(finalPicker).toBeGreaterThan(finalViewport);
});

test("Luna turns without a retained conversation never send connector identity alone", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const runExclusive = workerSource.slice(workerSource.indexOf("  private async runExclusive("));
  const connectorIdentity = runExclusive.indexOf("connectorIdentity: this.config.appName");
  expect(connectorIdentity).toBeGreaterThan(-1);
  expect(runExclusive.slice(connectorIdentity - 260, connectorIdentity)).toContain("turn.conversationKey");
  expect(runExclusive.slice(connectorIdentity - 260, connectorIdentity)).toContain("turn.nativeConnector");
});

test("a stalled DOM observation fails within its probe budget", async () => {
  expect(CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS).toBe(5_000);
  expect(MAX_CHATGPT_BROWSER_PAGE_REBINDS).toBe(2);
  await expect(withChatGptBrowserObservationTimeout(
    new Promise<never>(() => {}),
    5,
  )).rejects.toBeInstanceOf(ChatGptBrowserObservationTimeoutError);

});

test("an accepted Full-mode send survives one stalled DOM probe and a later MCP batch without resending", async () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://issue-285-${Date.now()}-${Math.random()}`,
    chatgptWeb: {
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      storageStatePath: `/tmp/issue-285-${Date.now()}-${Math.random()}.json`,
    },
  };
  type Baseline = {
    responseTurns: { last(): unknown };
    initialUserTurnCount: number;
    initialResponseTurnCount: number;
    initialUserTurnIdentities: string[];
    initialResponseTurnIdentities: string[];
    domCache: Record<string, unknown>;
  };
  type Recovery = { page: Page; baseline: Baseline };
  const worker = ChatGptBrowserWorker.forProvider(provider) as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
    ): Promise<T>;
    activeComposer(page: Page): Promise<unknown>;
    submissionDomState(page: Page, cache: Record<string, unknown>): Promise<{
      userTurnCount: number;
      assistantTurnCount: number;
      visibleStopButtonCount: number;
      userIdentities: string[];
      responseIdentities: string[];
    }>;
    responseDomSnapshot(locator: unknown): Promise<{ visibleText: string }>;
    sendAttachedPrompt(
      page: Page,
      baseline: Baseline,
      capture?: (checkpoint: string) => Promise<void>,
      signal?: AbortSignal,
      progress?: ChatGptExternalTurnProgress,
      lifecycle?: { onSendActivated(): Promise<void>; onSubmitted(): void },
      tracker?: ChatGptCompletionTracker,
      recover?: (
        attempt: number,
        cause: ChatGptBrowserObservationTimeoutError,
        baseline: Baseline,
      ) => Promise<Recovery>,
    ): Promise<string>;
  };

  const hiddenLocator = {
    filter() { return this; },
    last() { return this; },
    getByText() { return this; },
    isVisible: async () => false,
  };
  const assistantLocator = { id: "assistant-turn" };
  const page = {
    isClosed: () => false,
    locator: (selector: string) => selector.startsWith("[data-testid=")
      ? assistantLocator
      : hiddenLocator,
  } as unknown as Page;
  let sendPresses = 0;
  const sendButton = {
    waitFor: async () => {},
    isEnabled: async () => true,
    press: async () => { sendPresses += 1; },
  };
  const composer = {
    locator: () => ({ getByTestId: () => sendButton }),
  };
  worker.activeComposer = async () => composer;

  let domObservations = 0;
  worker.submissionDomState = async () => {
    domObservations += 1;
    if (domObservations === 1) throw new ChatGptBrowserObservationTimeoutError(5_000);
    return {
      userTurnCount: 1,
      assistantTurnCount: 1,
      visibleStopButtonCount: 1,
      userIdentities: ["conversation-turn-user"],
      responseIdentities: ["conversation-turn-assistant"],
    };
  };
  worker.responseDomSnapshot = async () => ({ visibleText: "tool preface" });

  const baseline: Baseline = {
    responseTurns: { last: () => hiddenLocator },
    initialUserTurnCount: 0,
    initialResponseTurnCount: 0,
    initialUserTurnIdentities: [],
    initialResponseTurnIdentities: [],
    domCache: {},
  };
  const reboundBaseline: Baseline = { ...baseline, domCache: {} };
  const progress = new ChatGptExternalTurnProgress();
  const completionTracker = new ChatGptCompletionTracker();
  const lifecycle: string[] = [];
  let recoveries = 0;
  let toolBatchRevision = 0;
  const evidence = await worker.runStage(
    "issue-285",
    "send",
    1_000,
    stageSignal => worker.sendAttachedPrompt(
      page,
      baseline,
      undefined,
      stageSignal,
      progress,
      {
        onSendActivated: async () => { lifecycle.push("activated"); },
        onSubmitted: () => { lifecycle.push("submitted"); },
      },
      completionTracker,
      async (attempt, cause, observedBaseline) => {
        recoveries += 1;
        expect(attempt).toBe(1);
        expect(cause).toBeInstanceOf(ChatGptBrowserObservationTimeoutError);
        expect(observedBaseline).toBe(baseline);
        toolBatchRevision = progress.recordToolBatch(1);
        return { page, baseline: reboundBaseline };
      },
    ),
  );

  expect(evidence).toBe("mcp_tool_call");
  expect(sendPresses).toBe(1);
  expect(domObservations).toBe(2);
  expect(recoveries).toBe(1);
  expect(lifecycle).toEqual(["activated", "submitted"]);
  const acknowledgementDeadline = new AbortController();
  const timer = setTimeout(() => acknowledgementDeadline.abort(), 100);
  try {
    await expect(progress.waitForToolBatchObservation(
      toolBatchRevision,
      acknowledgementDeadline.signal,
    )).resolves.toBeUndefined();
  } finally {
    clearTimeout(timer);
  }
});

test("Bigger Context send activation keeps the outer stage budget instead of restoring a nested 20-second timeout", async () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://multipart-send-budget-${Date.now()}-${Math.random()}`,
    chatgptWeb: {
      localToolsEnabled: true,
      solAvailable: true,
      proAvailable: true,
      storageStatePath: `/tmp/multipart-send-budget-${Date.now()}-${Math.random()}.json`,
    },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider) as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
    ): Promise<T>;
    activeComposer(page: Page): Promise<unknown>;
    waitForSubmissionAcceptedWithRecovery(): Promise<string>;
    sendAttachedPrompt(
      page: Page,
      baseline: unknown,
      capture?: (checkpoint: string) => Promise<void>,
      signal?: AbortSignal,
    ): Promise<string>;
  };
  const hiddenLocator = {
    filter() { return this; },
    last() { return this; },
    isVisible: async () => false,
  };
  const page = {
    isClosed: () => false,
    locator: () => hiddenLocator,
  } as unknown as Page;
  let pressOptions: { noWaitAfter?: boolean; signal?: AbortSignal; timeout?: number } | undefined;
  const sendButton = {
    waitFor: async () => {},
    isEnabled: async () => true,
    press: async (
      _key: string,
      options?: { noWaitAfter?: boolean; signal?: AbortSignal; timeout?: number },
    ) => {
      pressOptions = options;
      if (options?.timeout !== 0) throw new Error("nested locator timeout replaced the outer stage budget");
    },
  };
  worker.activeComposer = async () => ({
    locator: () => ({ getByTestId: () => sendButton }),
  });
  worker.waitForSubmissionAcceptedWithRecovery = async () => "user_turn";

  await expect(worker.runStage(
    "multipart-send-budget",
    "send",
    1_000,
    stageSignal => worker.sendAttachedPrompt(page, {}, undefined, stageSignal),
  )).resolves.toBe("user_turn");
  expect(pressOptions).toMatchObject({ noWaitAfter: true, timeout: 0 });
  expect(pressOptions?.signal).toBeInstanceOf(AbortSignal);
});

test("submission observation recovery resumes with rebound locators and is strictly bounded", async () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://submission-recovery-${Date.now()}-${Math.random()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
  };
  type Evidence = "user_turn" | "assistant_turn" | "generation_running" | "mcp_tool_call";
  type Recovery = { page: Page; baseline: unknown };
  const worker = ChatGptBrowserWorker.forProvider(provider) as unknown as {
    waitForSubmissionAcceptedWithRecovery(
      page: Page,
      baseline: unknown,
      abortSignal?: AbortSignal,
      externalProgress?: unknown,
      initialToolBatchRevision?: number,
      completionTracker?: unknown,
      recoverObservation?: (
        attempt: number,
        cause: ChatGptBrowserObservationTimeoutError,
        baseline: unknown,
        abortSignal?: AbortSignal,
      ) => Promise<Recovery>,
    ): Promise<Evidence>;
    waitForSubmissionAccepted(page: Page, baseline: unknown): Promise<Evidence>;
  };

  const firstPage = { name: "first" } as unknown as Page;
  const reboundPage = { name: "rebound" } as unknown as Page;
  const firstBaseline = { name: "first" };
  const reboundBaseline = { name: "rebound" };
  const observations: Array<{ page: Page; baseline: unknown }> = [];
  worker.waitForSubmissionAccepted = async (page, baseline) => {
    observations.push({ page, baseline });
    if (observations.length === 1) throw new ChatGptBrowserObservationTimeoutError(5_000);
    return "assistant_turn";
  };
  const recoveries: Array<{ attempt: number; baseline: unknown }> = [];
  const evidence = await worker.waitForSubmissionAcceptedWithRecovery(
    firstPage,
    firstBaseline,
    undefined,
    undefined,
    0,
    undefined,
    async (attempt, _cause, baseline) => {
      recoveries.push({ attempt, baseline });
      return { page: reboundPage, baseline: reboundBaseline };
    },
  );
  expect(evidence).toBe("assistant_turn");
  expect(observations).toEqual([
    { page: firstPage, baseline: firstBaseline },
    { page: reboundPage, baseline: reboundBaseline },
  ]);
  expect(recoveries).toEqual([{ attempt: 1, baseline: firstBaseline }]);

  let boundedRecoveries = 0;
  worker.waitForSubmissionAccepted = async () => {
    throw new ChatGptBrowserObservationTimeoutError(5_000);
  };
  await expect(worker.waitForSubmissionAcceptedWithRecovery(
    firstPage,
    firstBaseline,
    undefined,
    undefined,
    0,
    undefined,
    async () => {
      boundedRecoveries += 1;
      return { page: reboundPage, baseline: reboundBaseline };
    },
  )).rejects.toThrow("submission DOM remained unresponsive after 2 same-page rebinds");
  expect(boundedRecoveries).toBe(2);
});

test("an accepted turn rebinds the missing assistant observation and acknowledges a tool batch that arrives during recovery", async () => {
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://assistant-recovery-${Date.now()}-${Math.random()}`,
    chatgptWeb: { localToolsEnabled: true, solAvailable: true, proAvailable: true },
  };
  type Baseline = {
    initialResponseTurnIdentities: string[];
    domCache: Record<string, unknown>;
  };
  type Recovery = { page: Page; baseline: Baseline };
  const worker = ChatGptBrowserWorker.forProvider(provider) as unknown as {
    waitForNewAssistantTurn(
      page: Page,
      baseline: Baseline,
      deadline: number | undefined,
      signal?: AbortSignal,
      externalProgress?: ChatGptExternalTurnProgress,
      graceMs?: number,
      completionTracker?: ChatGptCompletionTracker,
      recoverObservation?: (
        attempt: number,
        cause: ChatGptBrowserObservationTimeoutError,
        baseline: Baseline,
        signal?: AbortSignal,
      ) => Promise<Recovery>,
    ): Promise<{ identity: string; locator: unknown }>;
    submissionDomState(page: Page, cache: Record<string, unknown>): Promise<{
      userIdentities: string[];
      responseIdentities: string[];
    }>;
    responseDomSnapshot(): Promise<{ visibleText: string }>;
  };

  const hiddenLocator = {
    filter() { return this; },
    last() { return this; },
    isVisible: async () => false,
  };
  const assistantLocator = { id: "assistant-turn" };
  const makePage = (name: string) => ({
    name,
    isClosed: () => false,
    locator: (selector: string) => selector.startsWith("[data-testid=")
      ? assistantLocator
      : hiddenLocator,
  }) as unknown as Page;
  const firstPage = makePage("first");
  const reboundPage = makePage("rebound");
  const firstBaseline: Baseline = { initialResponseTurnIdentities: [], domCache: {} };
  const reboundBaseline: Baseline = { initialResponseTurnIdentities: [], domCache: {} };
  const progress = new ChatGptExternalTurnProgress();
  const completionTracker = new ChatGptCompletionTracker();
  const observedPages: Page[] = [];
  worker.submissionDomState = async (page) => {
    observedPages.push(page);
    if (page === firstPage) throw new ChatGptBrowserObservationTimeoutError(5_000);
    return {
      userIdentities: ["conversation-turn-user"],
      responseIdentities: ["conversation-turn-assistant"],
    };
  };
  worker.responseDomSnapshot = async () => ({ visibleText: "tool preface" });

  let toolBatchRevision = 0;
  const binding = await worker.waitForNewAssistantTurn(
    firstPage,
    firstBaseline,
    undefined,
    undefined,
    progress,
    60_000,
    completionTracker,
    async (attempt, cause, baseline) => {
      expect(attempt).toBe(1);
      expect(cause).toBeInstanceOf(ChatGptBrowserObservationTimeoutError);
      expect(baseline).toBe(firstBaseline);
      toolBatchRevision = progress.recordToolBatch(1);
      return { page: reboundPage, baseline: reboundBaseline };
    },
  );

  expect(binding.identity).toBe("conversation-turn-assistant");
  expect(binding.locator).toBe(assistantLocator);
  expect(observedPages).toEqual([firstPage, reboundPage]);
  const acknowledgementDeadline = new AbortController();
  const timer = setTimeout(() => acknowledgementDeadline.abort(), 100);
  try {
    await expect(progress.waitForToolBatchObservation(
      toolBatchRevision,
      acknowledgementDeadline.signal,
    )).resolves.toBeUndefined();
  } finally {
    clearTimeout(timer);
  }
});

test("a failed stale-browser disconnect prevents the replacement connection", async () => {
  let replacementAttempts = 0;
  const disconnectFailure = new Error("stale CDP transport did not close");

  await expect(connectAfterClosingBrowserConnection(
    { close: async () => { throw disconnectFailure; } },
    async () => {
      replacementAttempts += 1;
      return "replacement";
    },
  )).rejects.toBe(disconnectFailure);

  expect(replacementAttempts).toBe(0);
});

test("closing the launcher page is an immediate terminal turn error", async () => {
  const responseDomSnapshot = (ChatGptBrowserWorker.prototype as unknown as {
    responseDomSnapshot(responseTurn: unknown): Promise<unknown>;
  }).responseDomSnapshot;
  const responseTurn = {
    evaluate: async () => { throw new Error("Target page has been closed"); },
    page: () => ({ isClosed: () => true }),
  };

  const error = await responseDomSnapshot.call({}, responseTurn).catch(cause => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    status: 499,
    errorType: "client_closed_request",
    code: "client_cancelled",
    retryable: false,
  });
  expect((error as Error).message).toContain("turn was cancelled");
});

test("active composer resolution waits for exactly one visible editor", async () => {
  const composer = { id: "active" };
  const counts = [2, 1];
  const visibleComposers = {
    count: async () => counts.shift() ?? 1,
    first: () => composer,
  };
  const page = {
    locator: () => ({
      filter: (options: { visible: boolean }) => {
        expect(options).toEqual({ visible: true });
        return visibleComposers;
      },
    }),
  };
  const activeComposer = (ChatGptBrowserWorker.prototype as unknown as {
    activeComposer(page: unknown, timeoutMs?: number): Promise<unknown>;
  }).activeComposer;

  expect(await activeComposer.call({}, page, 500)).toBe(composer);
});

test("prompt verification accepts Lexical NBSP preservation without weakening other mismatches", async () => {
  // Lexical may preserve indentation as alternating NBSP and ASCII spaces while keeping the same
  // UTF-16 length; that representation is equivalent only for whitespace runs.
  const expected = `prefix C\\n${" ".repeat(24)}suffix`;
  const observed = `prefix C\\n${"\u00A0 ".repeat(12)}suffix`;

  expect(observed.length).toBe(expected.length);
  expect(observed).not.toBe(expected);

  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    attachedPromptText: async () => observed,
  }) as ChatGptBrowserWorker;

  const promptTextEquivalent = (ChatGptBrowserWorker.prototype as unknown as {
    promptTextEquivalent(expected: string, observed: string): boolean;
  }).promptTextEquivalent;

  expect(promptTextEquivalent.call(worker, expected, observed)).toBeTrue();

  // The allowance is intentionally directional and restricted to repeated ASCII-space runs.
  expect(promptTextEquivalent.call(worker, "a  b", "a\u00A0 b")).toBeTrue();
  expect(promptTextEquivalent.call(worker, "a b", "a\u00A0b")).toBeFalse();
  expect(promptTextEquivalent.call(worker, "a\u00A0b", "a b")).toBeFalse();

  // Other whitespace and same-length text mutations must remain fail closed.
  expect(promptTextEquivalent.call(worker, "a b", "a\tb")).toBeFalse();
  expect(promptTextEquivalent.call(worker, "a\nb", "a b")).toBeFalse();
  expect(promptTextEquivalent.call(worker, "abc", "abd")).toBeFalse();
  expect(promptTextEquivalent.call(worker, "abc", "ab")).toBeFalse();

  const assertPromptAttached = (ChatGptBrowserWorker.prototype as unknown as {
    assertPromptAttached(
      page: Page,
      prompt: string,
      abortSignal?: AbortSignal,
    ): Promise<void>;
  }).assertPromptAttached;

  await expect(
    assertPromptAttached.call(worker, {} as Page, expected),
  ).resolves.toBeUndefined();
});

test("large Markdown-rich context uses one plain-text editing command before exact verification", async () => {
  const prompt = [
    "Act as the model backend for the Codex task encoded below.",
    "```ts",
    `const payload = ${JSON.stringify("x".repeat(220_000))};`,
    "```",
    "Inspect `document.docx` exactly.",
  ].join("\n");
  const calls: Array<[string, unknown?]> = [];
  let asserted = "";
  const composer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
    evaluate: async (fn: unknown, value: string, options: unknown) => {
      calls.push(["evaluate", value]);
      calls.push(["evaluateOptions", options]);
      expect(typeof fn).toBe("function");
      return true;
    },
  };
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: unknown, prompt: string, localTools: boolean): Promise<void>;
  }).attachPrompt;
  const insertPromptText = (ChatGptBrowserWorker.prototype as unknown as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  }).insertPromptText;

  await attachPrompt.call({
    activeComposer: async () => composer,
    insertPromptText,
    assertPromptAttached: async (_page: unknown, value: string) => { asserted = value; },
  }, {}, prompt, false);

  expect(calls[0]).toEqual(["fill", ""]);
  expect(calls.filter(call => call[0] === "evaluate")).toEqual([["evaluate", prompt]]);
  expect(calls.filter(call => call[0] === "evaluateOptions")).toEqual([
    ["evaluateOptions", { timeout: 20_000 }],
  ]);
  expect(asserted).toBe(prompt);
});

test("plain-text editing command fails closed when the focused composer rejects it", async () => {
  const insertPromptText = (ChatGptBrowserWorker.prototype as unknown as {
    insertPromptText(page: unknown, text: string, abortSignal?: AbortSignal): Promise<void>;
  }).insertPromptText;
  const composer = {
    focus: async () => {},
    evaluate: async () => false,
  };

  await expect(insertPromptText.call({
    activeComposer: async () => composer,
  }, {}, "literal `markdown`"))
    .rejects.toThrow("rejected the plain-text editing command");
});

test("compaction prompt attachment retries once only before submission evidence", async () => {
  const attachWithRetry = (ChatGptBrowserWorker.prototype as unknown as {
    attachPromptWithCompactionRetry(
      page: unknown,
      prompt: string,
      localTools: boolean,
      compaction: boolean,
      baseline: unknown,
      captureDiagnostic?: (checkpoint: string) => Promise<void>,
    ): Promise<void>;
  }).attachPromptWithCompactionRetry;
  const baseline = {
    userTurns: {},
    responseTurns: {},
    initialUserTurnCount: 0,
    initialResponseTurnCount: 0,
  };
  let attempts = 0;
  let resets = 0;
  const checkpoints: string[] = [];

  await attachWithRetry.call({
    attachPrompt: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ChatGptPromptAttachmentIntegrityError(
          "ChatGPT composer did not preserve the complete prompt (expectedChars=16000, actualChars=0, commonPrefixChars=0)",
        );
      }
    },
    currentSubmissionEvidence: async () => undefined,
    resetCompactionComposerForRetry: async () => { resets += 1; },
  }, {}, "compact prompt", false, true, baseline, async checkpoint => { checkpoints.push(checkpoint); });

  expect(attempts).toBe(2);
  expect(resets).toBe(1);
  expect(checkpoints).toEqual(["prompt-attachment-integrity-retry"]);

  let duplicateAttempts = 0;
  await expect(attachWithRetry.call({
    attachPrompt: async () => {
      duplicateAttempts += 1;
      throw new ChatGptPromptAttachmentIntegrityError("composer cleared");
    },
    currentSubmissionEvidence: async () => "user_turn",
    resetCompactionComposerForRetry: async () => { throw new Error("must not reset"); },
  }, {}, "compact prompt", false, true, baseline)).rejects.toThrow(
    "ChatGPT changed while the compaction prompt was being prepared",
  );
  expect(duplicateAttempts).toBe(1);

  let normalAttempts = 0;
  await expect(attachWithRetry.call({
    attachPrompt: async () => {
      normalAttempts += 1;
      throw new ChatGptPromptAttachmentIntegrityError("composer cleared");
    },
  }, {}, "normal prompt", false, false, baseline)).rejects.toThrow("composer cleared");
  expect(normalAttempts).toBe(1);
});

test("prompt insertion stops before touching the composer when its stage is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let resolvedComposer = false;
  const insertPromptText = (ChatGptBrowserWorker.prototype as unknown as {
    insertPromptText(page: unknown, text: string, abortSignal?: AbortSignal): Promise<void>;
  }).insertPromptText;

  await expect(insertPromptText.call({
    activeComposer: async () => {
      resolvedComposer = true;
      throw new Error("must not resolve composer");
    },
  }, {}, "large prompt", controller.signal))
    .rejects.toThrow("aborted");
  expect(resolvedComposer).toBeFalse();
});

test("connector selection re-resolves the active composer after ChatGPT replaces it", async () => {
  const calls: Array<[string, string?]> = [];
  let connectorSelected = false;
  const appResult = {
    waitFor: async () => { calls.push(["waitForResult"]); },
    count: async () => 1,
    getAttribute: async (name: string) => name === "data-highlighted" ? "" : null,
  };
  const selectedConnector = {
    waitFor: async () => {
      expect(connectorSelected).toBeTrue();
      calls.push(["waitForSelectedConnector"]);
    },
    count: async () => 1,
  };
  const selectedComposer = {
    locator: (selector: string) => {
      expect(selector).toBe('[data-id^="plugin:"][data-keyword]');
      return {
        filter: (options: { hasText: string; visible: boolean }) => {
          expect(options).toEqual({ hasText: "Codex Native2", visible: true });
          return selectedConnector;
        },
      };
    },
  };
  const initialComposer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
    pressSequentially: async (value: string, options: { delay: number; signal?: AbortSignal; timeout: number }) => {
      expect(options).toEqual({ delay: 25, signal: undefined, timeout: 10_000 });
      calls.push(["pressSequentially", value]);
    },
    press: async (key: string) => {
      expect(key).toBe("Enter");
      connectorSelected = true;
      calls.push(["press"]);
    },
  };
  const page = {
    getByRole: personalizedTemporaryChatRole,
    getByText: (text: string, options: { exact: boolean }) => {
      expect(text).toBe("Codex Native2");
      expect(options).toEqual({ exact: true });
      return { exactConnectorLabel: true };
    },
    locator: (selector: string) => {
      if (selector.includes("__menu-item")) {
        return {
          evaluateAll: async () => [],
          filter: (options: { has: unknown }) => {
            expect(options).toEqual({ has: { exactConnectorLabel: true } });
            return appResult;
          },
        };
      }
      throw new Error(`Unexpected locator: ${selector}`);
    },
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  let activeComposerCalls = 0;
  const resolved = await selectConnector.call({
    config: { appName: "Codex Native2" },
    connectorIsSelected: async () => connectorSelected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return connectorSelected ? selectedComposer : initialComposer;
    },
  }, page);

  expect(resolved).toBe(selectedComposer);
  expect(activeComposerCalls).toBe(3);
  expect(calls).toEqual([
    ["fill", ""],
    ["fill", ""],
    ["focus"],
    ["pressSequentially", "@codex"],
    ["waitForResult"],
    ["press"],
    ["waitForSelectedConnector"],
  ]);
});

test("connector selection moves highlight to the exact hidden-viewport row before Enter", async () => {
  const keys: string[] = [];
  let arrowCount = 0;
  let selected = false;
  const selectedConnector = { waitFor: async () => {} };
  const appResult = {
    waitFor: async () => {},
    count: async () => 1,
    getAttribute: async () => arrowCount >= 2 ? "" : null,
  };
  const menuRows = {
    evaluateAll: async () => [],
    filter: (options: { visible?: boolean }) => options.visible
      ? { count: async () => 3 }
      : appResult,
  };
  const initialComposer = {
    fill: async () => {},
    focus: async () => {},
    pressSequentially: async () => {},
    press: async (key: string) => {
      keys.push(key);
      if (key === "ArrowDown") arrowCount += 1;
      if (key === "Enter") selected = true;
    },
  };
  const selectedComposer = { selected: true };
  const page = {
    getByRole: personalizedTemporaryChatRole,
    getByText: () => ({ exactConnectorLabel: true }),
    locator: () => menuRows,
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  await expect(selectConnector.call({
    config: { appName: "Codex Native2 DEV" },
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => selected ? selectedComposer : initialComposer,
  }, page)).resolves.toBe(selectedComposer);
  expect(keys).toEqual(["ArrowDown", "ArrowDown", "Enter"]);
});

test("repeated connector verification reuses its selected pill before clearing the composer", async () => {
  let fillCalls = 0;
  const selectedComposer = {
    fill: async () => { fillCalls += 1; },
  };
  const page = {
    getByRole: personalizedTemporaryChatRole,
    getByText: () => ({ exactConnectorLabel: true }),
    locator: () => ({ filter: () => ({}) }),
  };
  const checkpoints: string[] = [];
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown, capture?: (checkpoint: string) => Promise<void>): Promise<unknown>;
  }).selectConnector;

  await expect(selectConnector.call({
    config: { appName: "Codex Native2 DEV" },
    activeComposer: async () => selectedComposer,
    connectorIsSelected: async () => true,
  }, page, async checkpoint => { checkpoints.push(checkpoint); })).resolves.toBe(selectedComposer);

  expect(fillCalls).toBe(0);
  expect(checkpoints).toEqual(["personalization-already-enabled", "connector-already-selected"]);
});

test("connector selection retriggers the complete mention after a fresh-page hydration miss", async () => {
  const calls: string[] = [];
  let menuAttempt = 0;
  let selected = false;
  const timeout = new Error("menu not hydrated");
  timeout.name = "TimeoutError";
  const selectedConnector = {
    waitFor: async () => {
      expect(selected).toBeTrue();
      calls.push("selected");
    },
    count: async () => 1,
  };
  const appResult = {
    waitFor: async () => {
      menuAttempt += 1;
      calls.push(`menu:${menuAttempt}`);
      if (menuAttempt === 1) throw timeout;
    },
    count: async () => 1,
    getAttribute: async (name: string) => name === "data-highlighted" ? "" : null,
  };
  const selectedComposer = {
    locator: () => ({ filter: () => selectedConnector }),
  };
  const initialComposer = {
    fill: async () => { calls.push("clear"); },
    focus: async (_options?: { signal?: AbortSignal }) => { calls.push("focus"); },
    pressSequentially: async (value: string) => {
      expect(value).toBe("@codex");
      calls.push("type");
    },
    press: async (key: string) => {
      expect(key).toBe("Enter");
      selected = true;
      calls.push("activate");
    },
  };
  const page = {
    getByRole: personalizedTemporaryChatRole,
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => selector.includes("__menu-item")
      ? { filter: () => appResult, evaluateAll: async () => [] }
      : (() => { throw new Error(`Unexpected locator: ${selector}`); })(),
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  let activeComposerCalls = 0;
  await selectConnector.call({
    config: { appName: "Codex Native2" },
    connectorIsSelected: async () => selected,
    connectorMentionRowTitles: async () => [],
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return selected ? selectedComposer : initialComposer;
    },
  }, page);

  expect(calls).toEqual([
    "clear",
    "clear", "focus", "type", "menu:1",
    "clear", "focus", "type", "menu:2",
    "activate", "selected",
  ]);
});

test("connector verification preserves the host-refreshed catalog evidence", async () => {
  const calls: string[] = [];
  const diagnosticsRoot = mkdtempSync(join(tmpdir(), "cgw-catalog-verification-"));
  const catalogFresh = false;
  let selected = false;
  let now = Date.now();
  const realDateNow = Date.now;
  const timeout = new Error("stale catalog");
  timeout.name = "TimeoutError";
  const selectedConnector = {
    waitFor: async () => { calls.push("selected"); },
  };
  const appResult = {
    waitFor: async () => {
      calls.push(`menu:${catalogFresh ? "fresh" : "stale"}`);
      if (!catalogFresh) {
        now += 2_501;
        throw timeout;
      }
    },
    count: async () => catalogFresh ? 1 : 0,
    getAttribute: async (name: string) => name === "data-highlighted" ? "" : null,
  };
  const visibleRows = {
    allInnerTexts: async () => catalogFresh ? ["Codex Native2"] : ["Another connector"],
  };
  const menuRows = {
    filter: (options: { has?: unknown; visible?: boolean }) => options.visible ? visibleRows : appResult,
  };
  const initialComposer = {
    fill: async () => { calls.push("clear"); },
    focus: async () => { calls.push("focus"); },
    pressSequentially: async () => { calls.push("type"); },
  };
  const selectedComposer = { selected: true };
  const page = {
    getByRole: personalizedTemporaryChatRole,
    reload: async () => { calls.push("reload"); },
    getByText: () => ({ exactConnectorLabel: true }),
    locator: () => menuRows,
    evaluate: async () => ({
      url: "https://chatgpt.com/?temporary-chat=true",
      title: "ChatGPT",
      viewport: { width: 800, height: 600 },
      surfaceId: null,
      bodyTextChars: 0,
      composer: { visibleCount: 1, textChars: [0], selectedConnectors: [] },
      effortControls: [],
      effortItems: [],
      menus: [],
      connectorRows: [],
      overlays: [],
      turns: { user: 0, assistant: [] },
    }),
    keyboard: {
      press: async (key: string) => {
        expect(key).toBe("Enter");
        selected = true;
        calls.push("activate");
      },
    },
  };
  const prototype = ChatGptBrowserWorker.prototype as unknown as {
    clearChatGptComposerState(page: unknown): Promise<void>;
    connectorMentionFailure(menuRows: unknown, triggerAttempts: number): Promise<string>;
    connectorMentionRowTitles(menuRows: unknown): Promise<string[]>;
    selectConnector(page: unknown, capture?: unknown, refresh?: boolean): Promise<unknown>;
    verifyConnectorExclusive(): Promise<string>;
  };
  let prepared = 0;
  const fixture = {
    config: { appName: "Codex Native2", browserDiagnosticsPath: diagnosticsRoot },
    ensurePage: async () => page,
    prepareTemporaryChatSurface: async () => {
      prepared += 1;
      calls.push(`prepare:${prepared}`);
    },
    activeComposer: async () => selected ? selectedComposer : initialComposer,
    connectorIsSelected: async () => selected,
    connectorMentionFailure: prototype.connectorMentionFailure,
    connectorMentionRowTitles: prototype.connectorMentionRowTitles,
    clearChatGptComposerState: async () => { await initialComposer.fill(); },
    selectedConnectorControl: () => selectedConnector,
    selectConnector: prototype.selectConnector,
  };

  Date.now = () => now;
  try {
    await expect(prototype.verifyConnectorExclusive.call(fixture)).rejects.toThrow(
      'connector menu opened but exposed no row named "Codex Native2"',
    );
    expect(prepared).toBe(1);
    expect(calls.filter(call => call === "reload")).toEqual([]);
    expect(calls.filter(call => call === "menu:stale")).toHaveLength(MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS);
    expect(calls).not.toContain("menu:fresh");
  } finally {
    Date.now = realDateNow;
    rmSync(diagnosticsRoot, { recursive: true, force: true });
  }
});

for (const captureScreenshots of [false, true]) test(`connector failure persists safe checkpoints with opt-in screenshots (${captureScreenshots})`, async () => {
  const diagnosticsRoot = mkdtempSync(join(tmpdir(), "cgw-connector-verification-"));
  const previousCapture = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS;
  if (captureScreenshots) process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS = "1";
  else delete process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS;
  let screenshots = 0;
  const page = {
    screenshot: async () => { screenshots += 1; return Buffer.from("diagnostic screenshot fixture"); },
    evaluate: async () => ({
      url: "https://chatgpt.com/c/private-conversation",
      title: "private task title",
      viewport: { width: 800, height: 600 },
      surfaceId: null,
      bodyTextChars: 0,
      composer: { visibleCount: 1, textChars: [6], selectedConnectors: [] },
      effortControls: [],
      effortItems: [],
      menus: [],
      connectorRows: [],
      overlays: [],
      turns: { user: 0, assistant: [] },
    }),
  };
  const failure = new Error("connector proof failed");
  const verifyConnectorExclusive = (ChatGptBrowserWorker.prototype as unknown as {
    verifyConnectorExclusive(traceId: string): Promise<string>;
  }).verifyConnectorExclusive;

  try {
    await expect(verifyConnectorExclusive.call({
      config: { appName: "Codex Native2", browserDiagnosticsPath: diagnosticsRoot },
      ensurePage: async () => page,
      prepareTemporaryChatSurface: async (_page: unknown, capture: (checkpoint: string) => Promise<void>) => {
        await capture("composer-ready");
      },
      selectConnector: async (_page: unknown, capture: (checkpoint: string) => Promise<void>) => {
        await capture("connector-mention-triggered");
        throw failure;
      },
    }, "verify_contract_trace")).rejects.toBe(failure);

    const [traceDirectory] = readdirSync(diagnosticsRoot);
    expect(traceDirectory).toStartWith("verify_contract_trace-");
    const files = readdirSync(join(diagnosticsRoot, traceDirectory!));
    expect(screenshots).toBe(captureScreenshots ? 4 : 0);
    expect(files.filter(name => name.endsWith(".png"))).toHaveLength(screenshots);
    const checkpoints = files
      .filter(name => name.endsWith(".json"))
      .sort()
      .map(name => JSON.parse(readFileSync(join(diagnosticsRoot, traceDirectory!, name), "utf8")));
    expect(checkpoints.map(checkpoint => checkpoint.checkpoint)).toEqual([
      "connector-verification-started",
      "composer-ready",
      "connector-mention-triggered",
      "connector-verification-failed",
    ]);
    expect(checkpoints.at(-1)).toMatchObject({
      traceId: "verify_contract_trace",
      error: "connector proof failed",
      state: { composer: { visibleCount: 1, textChars: [6] } },
    });
    expect(JSON.stringify(checkpoints)).not.toContain("private");
  } finally {
    if (previousCapture === undefined) delete process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS;
    else process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS = previousCapture;
    rmSync(diagnosticsRoot, { recursive: true, force: true });
  }
});

test("successful connector verification clears the proven selection before releasing the page", async () => {
  const diagnosticsRoot = mkdtempSync(join(tmpdir(), "cgw-connector-verification-success-"));
  const calls: string[] = [];
  const page = {
    evaluate: async () => ({
      location: { origin: "https://chatgpt.com", pathSegments: 0, temporaryChat: true },
      surfaceBound: true,
      composer: { visibleCount: 1, textChars: [0], selectedConnectorCount: 0 },
    }),
  };
  const verifyConnectorExclusive = (ChatGptBrowserWorker.prototype as unknown as {
    verifyConnectorExclusive(traceId: string): Promise<string>;
  }).verifyConnectorExclusive;

  try {
    const result = await verifyConnectorExclusive.call({
      config: { appName: "Codex Native2 DEV", browserDiagnosticsPath: diagnosticsRoot },
      ensurePage: async () => page,
      prepareTemporaryChatSurface: async (_page: unknown, capture: (checkpoint: string) => Promise<void>) => {
        calls.push("prepare");
        await capture("composer-ready");
      },
      selectConnector: async (_page: unknown, capture: (checkpoint: string) => Promise<void>) => {
        calls.push("select");
        await capture("connector-selected");
      },
      clearChatGptComposerState: async () => { calls.push("clear"); },
    }, "verify_success_contract");

    expect(result).toBe("Codex Native2 DEV");
    expect(calls).toEqual(["prepare", "select", "clear"]);
    const [traceDirectory] = readdirSync(diagnosticsRoot);
    const checkpoints = readdirSync(join(diagnosticsRoot, traceDirectory!))
      .filter(name => name.endsWith(".json"))
      .sort()
      .map(name => JSON.parse(readFileSync(join(diagnosticsRoot, traceDirectory!, name), "utf8")))
      .map(checkpoint => checkpoint.checkpoint);
    expect(checkpoints).toEqual([
      "connector-verification-started",
      "composer-ready",
      "connector-selected",
      "connector-verification-cleared",
      "connector-verification-succeeded",
    ]);
  } finally {
    rmSync(diagnosticsRoot, { recursive: true, force: true });
  }
});

test("production connector diagnostics distinguish an existing DEV connector", async () => {
  const connectorMentionFailure = (ChatGptBrowserWorker.prototype as unknown as {
    connectorMentionFailure(menuRows: unknown, attempts: number): Promise<string>;
  }).connectorMentionFailure;
  const message = await connectorMentionFailure.call({
    config: { appName: CHATGPT_CONNECTOR_NAME },
    connectorMentionRowTitles: async () => [DEV_CHATGPT_CONNECTOR_NAME],
  }, {}, 1);

  expect(message).toContain(`isolated DEV connector ${JSON.stringify(DEV_CHATGPT_CONNECTOR_NAME)}`);
  expect(message).toContain(`separate connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)}`);
});

test("connector catalog refresh stays fail-closed for absent, legacy, and exact menu evidence", async () => {
  const prototype = ChatGptBrowserWorker.prototype as unknown as {
    clearChatGptComposerState(page: unknown): Promise<void>;
    selectConnector(page: unknown, capture?: unknown, refresh?: boolean): Promise<unknown>;
  };
  const selectConnector = prototype.selectConnector;
  const timeout = new Error("menu timeout");
  timeout.name = "TimeoutError";
  const realDateNow = Date.now;
  const run = async (visibleRows: string[]) => {
    let now = realDateNow();
    const page = {
      getByRole: personalizedTemporaryChatRole,
      getByText: () => ({ exactConnectorLabel: true }),
      locator: () => ({
        filter: (options: { has?: unknown; visible?: boolean }) => options.visible
          ? { allInnerTexts: async () => visibleRows }
          : {
              waitFor: async () => {
                now += 20_001;
                throw timeout;
              },
            },
      }),
    };
    Date.now = () => now;
    try {
      return await selectConnector.call({
        config: { appName: CHATGPT_CONNECTOR_NAME },
        activeComposer: async () => ({
          fill: async () => {},
          focus: async () => {},
          pressSequentially: async () => {},
        }),
        connectorIsSelected: async () => false,
        clearChatGptComposerState: async () => {},
        connectorMentionRowTitles: async () => visibleRows,
        connectorMentionFailure: async (_rows: unknown, attempts: number) => (
          visibleRows.length === 0
            ? `menu absent after ${attempts}`
            : visibleRows.includes("Codex Native")
              ? legacyChatGptConnectorMigrationMessage("Codex Native")
              : `exact row was not visible after ${attempts}`
        ),
      }, page, undefined, true);
    } finally {
      Date.now = realDateNow;
    }
  };

  const missingMenuError = await run([]).catch(error => error);
  if (!(missingMenuError instanceof Error)) {
    throw new Error("Expected connector selection to fail with an Error");
  }
  expect(missingMenuError).toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 424,
    errorType: "connector_error",
    code: "connector_not_found",
    retryable: false,
  });
  expect(missingMenuError.message).toContain(`after ${MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS}`);
  await expect(run(["Codex Native"])).rejects.toThrow("Legacy ChatGPT connector");
  await expect(run([CHATGPT_CONNECTOR_NAME])).rejects.toThrow("exact row was not visible");
});

test("tool-capable prompts use the shared Playwright connector selection before inserting context", async () => {
  const controller = new AbortController();
  const calls: Array<[string, string?]> = [];
  let selected = false;
  const selectedConnector = {
    waitFor: async (options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBeDefined();
      expect(selected).toBeTrue();
      calls.push(["selectedConnector"]);
    },
    count: async () => 1,
  };
  const appResult = {
    waitFor: async (options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBeDefined();
      calls.push(["connectorMenu"]);
    },
    count: async () => 1,
    getAttribute: async (name: string) => name === "data-highlighted" ? "" : null,
  };
  const selectedComposer = {
    focus: async (options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBeDefined();
      calls.push(["selectedFocus"]);
    },
    press: async (value: string, options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBeDefined();
      calls.push(["press", value]);
    },
    locator: () => ({ filter: () => selectedConnector }),
    evaluate: async (_fn: unknown, value: string) => {
      calls.push(["plainText", value]);
      return true;
    },
  };
  const initialComposer = {
    fill: async (value: string, options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBeDefined();
      calls.push(["fill", value]);
    },
    focus: async (options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBeDefined();
      calls.push(["focus"]);
    },
    pressSequentially: async (value: string, options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBeDefined();
      calls.push(["type", value]);
    },
    press: async (value: string, options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBeDefined();
      expect(value).toBe("Enter");
      selected = true;
      calls.push(["selectConnector"]);
    },
  };
  const page = {
    getByRole: personalizedTemporaryChatRole,
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => selector.includes("__menu-item")
      ? { filter: () => appResult, evaluateAll: async () => [] }
      : (() => { throw new Error(`Unexpected locator: ${selector}`); })(),
  };
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(
      page: unknown,
      prompt: string,
      localTools: boolean,
      captureDiagnostic?: unknown,
      abortSignal?: AbortSignal,
    ): Promise<void>;
  }).attachPrompt;
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;
  const insertPromptText = (ChatGptBrowserWorker.prototype as unknown as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  }).insertPromptText;

  let activeComposerCalls = 0;
  await attachPrompt.call({
    config: { appName: "Codex Native2" },
    selectConnector,
    insertPromptText,
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return selected ? selectedComposer : initialComposer;
    },
    assertPromptAttached: async () => { calls.push(["assertPrompt"]); },
  }, page, "context", true, undefined, controller.signal);

  expect(calls).toEqual([
    ["fill", ""],
    ["fill", ""],
    ["focus"],
    ["type", "@codex"],
    ["connectorMenu"],
    ["selectConnector"],
    ["selectedConnector"],
    ["selectedFocus"],
    ["press", CHATGPT_COMPOSER_DOCUMENT_END_KEY],
    ["selectedFocus"],
    ["plainText", " context"],
    ["assertPrompt"],
  ]);
});

test("an aborted connector proof clears its mention before the preflight releases the browser page", async () => {
  const controller = new AbortController();
  const fillSignals: AbortSignal[] = [];
  const calls: string[] = [];
  const absent = {
    filter: () => absent,
    count: async () => 0,
  };
  const appResult = {
    waitFor: async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal).toBeDefined();
      calls.push("proof-wait");
      controller.abort();
      throw new DOMException("proof aborted", "AbortError");
    },
  };
  const menuRows = {
    filter: () => appResult,
  };
  const composer = {
    fill: async (_value: string, { signal }: { signal?: AbortSignal }) => {
      expect(signal).toBeDefined();
      fillSignals.push(signal!);
      calls.push(controller.signal.aborted ? "cleanup-fill" : "probe-fill");
    },
    focus: async () => { calls.push("focus"); },
    press: async (key: string, { signal }: { signal?: AbortSignal }) => {
      expect(signal?.aborted).toBeFalse();
      calls.push(key === CHATGPT_COMPOSER_SELECT_ALL_KEY ? "cleanup-select-all" : "cleanup-backspace");
    },
    pressSequentially: async () => { calls.push("type"); },
    evaluate: async () => { calls.push("cleanup-read"); return ""; },
  };
  const page = {
    getByRole: () => absent,
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => {
      if (selector === "body") return {
        press: async (_key: string, { signal }: { signal?: AbortSignal }) => {
          expect(signal?.aborted).toBeFalse();
          calls.push("escape");
        },
      };
      expect(selector).toContain("__menu-item");
      return menuRows;
    },
  };
  const prototype = ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown, capture?: unknown, refresh?: boolean, budget?: unknown, signal?: AbortSignal): Promise<unknown>;
    clearChatGptComposerState(page: unknown): Promise<void>;
  };

  const selection = prototype.selectConnector.call({
    config: { appName: "Codex Native2" },
    activeComposer: async (_page: unknown, _timeout: number, signal?: AbortSignal) => {
      expect(signal).toBeDefined();
      return composer;
    },
    connectorIsSelected: async () => false,
    clearChatGptComposerState: prototype.clearChatGptComposerState,
  }, page, undefined, false, { triggerAttempts: 0 }, controller.signal);

  await expect(selection).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toEqual([
    "probe-fill", "focus", "type", "proof-wait", "escape", "focus",
    "cleanup-select-all", "cleanup-backspace", "cleanup-read",
  ]);
  expect(fillSignals).toHaveLength(1);
  expect(fillSignals[0]?.aborted).toBeTrue();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(calls).toEqual([
    "probe-fill", "focus", "type", "proof-wait", "escape", "focus",
    "cleanup-select-all", "cleanup-backspace", "cleanup-read",
  ]);
});

test("an aborted real connector selection clears the typed mention before returning", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  let composerText = "";
  const appResult = {
    waitFor: async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal).toBeDefined();
      calls.push("selection-wait");
      controller.abort();
      throw new DOMException("selection aborted", "AbortError");
    },
  };
  const menuRows = { filter: () => appResult };
  const composer = {
    fill: async (value: string, { signal }: { signal?: AbortSignal }) => {
      expect(signal).toBeDefined();
      composerText = value;
      calls.push(controller.signal.aborted ? "cleanup-fill" : "fill");
    },
    focus: async () => { calls.push("focus"); },
    press: async (key: string) => {
      calls.push(key === CHATGPT_COMPOSER_SELECT_ALL_KEY ? "cleanup-select-all" : "cleanup-backspace");
      if (key === "Backspace") composerText = "";
    },
    pressSequentially: async (value: string) => {
      composerText += value;
      calls.push("type");
    },
    evaluate: async () => { calls.push("cleanup-read"); return composerText.trim(); },
  };
  const page = {
    getByRole: personalizedTemporaryChatRole,
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => {
      if (selector === "body") return {
        press: async () => { calls.push("escape"); },
      };
      expect(selector).toContain("__menu-item");
      return menuRows;
    },
  };
  const prototype = ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown, capture?: unknown, refresh?: boolean, budget?: unknown, signal?: AbortSignal): Promise<unknown>;
    clearChatGptComposerState(page: unknown): Promise<void>;
  };

  const selection = prototype.selectConnector.call({
    config: { appName: "Codex Native2" },
    activeComposer: async () => composer,
    connectorIsSelected: async () => false,
    clearChatGptComposerState: prototype.clearChatGptComposerState,
  }, page, undefined, false, { triggerAttempts: 0 }, controller.signal);

  await expect(selection).rejects.toMatchObject({ name: "AbortError" });
  expect(composerText).toBe("");
  expect(calls).toEqual([
    "fill", "fill", "focus", "type", "selection-wait", "escape", "focus",
    "cleanup-select-all", "cleanup-backspace", "cleanup-read",
  ]);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(composerText).toBe("");
});

test("connector cleanup uses native editor deletion when contenteditable fill would retain the mention", async () => {
  let composerText = "@codex";
  let selectedAll = false;
  let fillCalls = 0;
  const pressed: string[] = [];
  const composer = {
    fill: async () => { fillCalls += 1; },
    focus: async () => {},
    press: async (key: string) => {
      pressed.push(key);
      if (key === CHATGPT_COMPOSER_SELECT_ALL_KEY) selectedAll = true;
      if (key === "Backspace" && selectedAll) composerText = "";
    },
    evaluate: async () => composerText,
  };
  const clearChatGptComposerState = (ChatGptBrowserWorker.prototype as unknown as {
    clearChatGptComposerState(page: unknown): Promise<void>;
  }).clearChatGptComposerState;

  await clearChatGptComposerState.call({
    activeComposer: async () => composer,
    connectorIsSelected: async () => false,
  }, {
    locator: (selector: string) => {
      expect(selector).toBe("body");
      return { press: async (key: string) => { expect(key).toBe("Escape"); } };
    },
  });

  expect(fillCalls).toBe(0);
  expect(pressed).toEqual([CHATGPT_COMPOSER_SELECT_ALL_KEY, "Backspace"]);
  expect(composerText).toBe("");
});

test("an abort after connector activation removes the selected pill before returning", async () => {
  const controller = new AbortController();
  let composerText = "";
  let connectorSelected = false;
  const appResult = {
    waitFor: async () => {},
    count: async () => 1,
    getAttribute: async () => "",
  };
  const menuRows = { filter: () => appResult };
  const composer = {
    fill: async (value: string) => {
      composerText = value;
      if (controller.signal.aborted) connectorSelected = false;
    },
    focus: async () => {},
    pressSequentially: async (value: string) => { composerText += value; },
    press: async (key: string) => {
      if (key === "Enter") {
        connectorSelected = true;
        composerText = CHATGPT_CONNECTOR_NAME;
      } else if (key === "Backspace") {
        connectorSelected = false;
        composerText = "";
      } else {
        expect(key).toBe(CHATGPT_COMPOSER_SELECT_ALL_KEY);
      }
    },
    evaluate: async () => composerText.trim(),
  };
  const page = {
    getByRole: personalizedTemporaryChatRole,
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => selector === "body"
      ? { press: async () => {} }
      : menuRows,
  };
  const prototype = ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown, capture?: unknown, refresh?: boolean, budget?: unknown, signal?: AbortSignal): Promise<unknown>;
    clearChatGptComposerState(page: unknown): Promise<void>;
  };

  const selection = prototype.selectConnector.call({
    config: { appName: CHATGPT_CONNECTOR_NAME },
    activeComposer: async () => composer,
    connectorIsSelected: async () => connectorSelected,
    clearChatGptComposerState: prototype.clearChatGptComposerState,
  }, page, async (checkpoint: string) => {
    if (checkpoint === "connector-choice-activated") controller.abort();
  }, false, { triggerAttempts: 0 }, controller.signal);

  await expect(selection).rejects.toMatchObject({ name: "AbortError" });
  expect(connectorSelected).toBeFalse();
  expect(composerText).toBe("");
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(connectorSelected).toBeFalse();
});

test("an abort while inserting a connector prompt clears the selected pill and partial text before returning", async () => {
  const controller = new AbortController();
  let connectorSelected = true;
  let composerText = CHATGPT_CONNECTOR_NAME;
  let cleanupFinished = false;
  const selectedComposer = {
    focus: async () => {},
    press: async (key: string) => { expect(key).toBe(CHATGPT_COMPOSER_DOCUMENT_END_KEY); },
  };
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(
      page: unknown,
      prompt: string,
      localTools: boolean,
      captureDiagnostic?: unknown,
      abortSignal?: AbortSignal,
    ): Promise<void>;
  }).attachPrompt;

  const attachment = attachPrompt.call({
    selectConnector: async () => selectedComposer,
    insertPromptText: async (_page: unknown, text: string) => {
      composerText += text;
      controller.abort();
      throw new DOMException("prompt insertion aborted", "AbortError");
    },
    assertPromptAttached: async () => { throw new Error("attachment assertion must not run"); },
    clearChatGptComposerState: async () => {
      await Bun.sleep(10);
      composerText = "";
      connectorSelected = false;
      cleanupFinished = true;
    },
  }, {}, "context", true, undefined, controller.signal);

  await expect(attachment).rejects.toMatchObject({ name: "AbortError" });
  expect(cleanupFinished).toBeTrue();
  expect(composerText).toBe("");
  expect(connectorSelected).toBeFalse();
});

test("retained tool turns insert into the connector-bound composer without selecting it again", async () => {
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(
      page: unknown,
      prompt: string,
      localTools: boolean,
      captureDiagnostic?: (checkpoint: string) => Promise<void>,
      abortSignal?: AbortSignal,
      catalogRefreshAvailable?: boolean,
      connectorAttemptBudget?: unknown,
      reuseConnector?: boolean,
    ): Promise<void>;
  }).attachPrompt;

  const calls: string[] = [];
  const composer = {
    fill: async (value: string) => { expect(value).toBe(""); calls.push("fill"); },
    focus: async () => { calls.push("focus"); },
  };
  await attachPrompt.call({
    activeComposer: async () => composer,
    selectConnector: async () => { throw new Error("retained connector must not be selected again"); },
    insertPromptText: async (_page: unknown, text: string) => { expect(text).toBe("retained context"); calls.push("insert"); },
    assertPromptAttached: async () => { calls.push("assert"); },
  }, {}, "retained context", true, undefined, undefined, false, undefined, true);
  expect(calls).toEqual(["fill", "focus", "insert", "assert"]);
});

test("image attachment readiness uses exact file tiles and not localized remove-button text", async () => {
  const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const calls: Array<[string, string?]> = [];
  const send = {
    isEnabled: async () => {
      calls.push(["sendEnabled"]);
      return true;
    },
  };
  const composerForm = {
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      expect(role).toBe("group");
      expect(options).toEqual({ name: "codex-input-image-1.png", exact: true });
      return {
        waitFor: async (state: { state: string; timeout: number }) => {
          expect(state).toEqual({ state: "visible", timeout: 60_000 });
          calls.push(["fileTile", options.name]);
        },
      };
    },
    getByTestId: (testId: string) => {
      expect(testId).toBe("send-button");
      return send;
    },
  };
  const composer = {
    locator: (selector: string) => {
      expect(selector).toBe("xpath=ancestor::form[1]");
      return composerForm;
    },
  };
  const input = {
    waitFor: async (state: { state: string; timeout: number }) => {
      expect(state).toEqual({ state: "attached", timeout: 20_000 });
      calls.push(["inputReady"]);
    },
    setInputFiles: async (files: Array<{ name: string }>) => {
      calls.push(["setFiles", files.map(file => file.name).join(",")]);
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === 'input[data-testid="upload-photos-input"]') return input;
      if (selector === '[role="alert"]') {
        return { allInnerTexts: async () => [] };
      }
      return { last: () => composer };
    },
  };
  const attachFiles = (ChatGptBrowserWorker.prototype as unknown as {
    attachFiles(page: unknown, prompt: unknown): Promise<void>;
  }).attachFiles;

  await attachFiles.call({ activeComposer: async () => composer }, page, {
    images: [{ ref: "codex-input-image-1", imageUrl }],
  });

  expect(calls).toEqual([
    ["inputReady"],
    ["setFiles", "codex-input-image-1.png"],
    ["fileTile", "codex-input-image-1.png"],
    ["sendEnabled"],
  ]);
});

test("effort slider ARIA state fails closed on malformed and unsupported ranges", () => {
  expect(parseChatGptEffortSliderState("0", "4", "3")).toEqual({ min: 0, max: 4, value: 3 });
  for (const attributes of [
    [null, "4", "3"],
    ["", "4", "3"],
    ["0", "4", null],
    ["0", "4", "9"],
    ["0", "5", "3"],
    ["9007199254740992", "9007199254740993", "9007199254740992"],
  ] as const) {
    expect(parseChatGptEffortSliderState(attributes[0], attributes[1], attributes[2])).toBeUndefined();
  }
});

test("Luna-only browser turns verify selector absence instead of opening an effort menu", async () => {
  const checkpoints: string[] = [];
  const hiddenDialog = {
    filter() { return this; },
    last() { return this; },
    isVisible: async () => false,
  };
  const visibleControls = { count: async () => 0 };
  const composerForm = {
    locator: () => ({ filter: () => visibleControls }),
    getByRole: () => ({ filter: () => ({ count: async () => 0 }) }),
  };
  const composer = { locator: () => composerForm };
  const selectModelAndEffort = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(
      page: unknown,
      modelId: string,
      reasoning: string,
      capabilities: { localToolsEnabled: boolean; solAvailable: boolean; proAvailable: boolean },
      captureDiagnostic: (checkpoint: string) => Promise<void>,
    ): Promise<{ displayLabel: string; uiEffortIndex: number | null }>;
  }).selectModelAndEffort;

  const mode = await selectModelAndEffort.call({
    activeComposer: async () => composer,
  }, {
    locator: () => hiddenDialog,
  }, "gpt-5.6-luna", "low", {
    localToolsEnabled: true,
    solAvailable: false,
    proAvailable: false,
  }, async checkpoint => { checkpoints.push(checkpoint); });

  expect(mode).toMatchObject({ displayLabel: "Luna", uiEffortIndex: null });
  expect(checkpoints).toEqual(["luna-default-confirmed"]);
});

test("Think mode follows the exact pressed state and normal Luna clears it", async () => {
  let pressed = false;
  let clicks = 0;
  const control = {
    getAttribute: async () => pressed ? "true" : "false",
    click: async () => { clicks += 1; pressed = !pressed; },
  };
  const controls = {
    count: async () => 1,
    first: () => control,
  };
  const composerForm = {
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      expect([role, options]).toEqual(["button", { name: "Think", exact: true }]);
      return { filter: () => controls };
    },
  };
  const checkpoints: string[] = [];

  await setChatGptThinkMode(composerForm as never, true, async checkpoint => { checkpoints.push(checkpoint); });
  expect(pressed).toBeTrue();
  expect(clicks).toBe(1);
  await setChatGptThinkMode(composerForm as never, true);
  expect(clicks).toBe(1);
  await setChatGptThinkMode(composerForm as never, false, async checkpoint => { checkpoints.push(checkpoint); });
  expect(pressed).toBeFalse();
  expect(clicks).toBe(2);
  expect(checkpoints).toEqual(["think-enabled", "think-disabled"]);
});

test("Think mode fails closed when the Luna composer does not expose the control", async () => {
  const composerForm = {
    getByRole: () => ({ filter: () => ({ count: async () => 0 }) }),
  };
  await expect(setChatGptThinkMode(composerForm as never, true))
    .rejects.toThrow("Think control is not available");
});

test("the one-time Temporary Chat onboarding is accepted with an exact Playwright click", async () => {
  const calls: unknown[] = [];
  const continueButton = {
    last: () => continueButton,
    isVisible: async () => true,
    click: async (options: unknown) => { calls.push(["click", options]); },
  };
  const dialog = {
    filter: (options: unknown) => {
      calls.push(["filter", options]);
      return dialog;
    },
    last: () => dialog,
    isVisible: async () => true,
    getByRole: (role: string, options: unknown) => {
      calls.push(["role", role, options]);
      return continueButton;
    },
    waitFor: async (options: unknown) => { calls.push(["waitFor", options]); },
  };
  const page = {
    locator: (selector: string) => {
      calls.push(["locator", selector]);
      return dialog;
    },
  } as unknown as Page;

  expect(await dismissChatGptTemporaryChatOnboarding(page)).toBeTrue();
  expect(calls).toContainEqual(["role", "button", { name: "Continue", exact: true }]);
  expect(calls).toContainEqual(["click", { force: true }]);
  expect(calls).toContainEqual(["waitFor", { state: "hidden", timeout: 10_000 }]);
});

test("an unrelated Continue dialog is never auto-accepted", async () => {
  let lookedForButton = false;
  const dialog = {
    filter: () => dialog,
    last: () => dialog,
    isVisible: async () => false,
    getByRole: () => {
      lookedForButton = true;
      throw new Error("must not inspect an unrelated dialog action");
    },
  };
  const page = { locator: () => dialog } as unknown as Page;

  expect(await dismissChatGptTemporaryChatOnboarding(page)).toBeFalse();
  expect(lookedForButton).toBeFalse();
});

function dialogPage(text: string, buttonText = "Got it"): { page: Page; pressed: string[] } {
  const pressed: string[] = [];
  const createDialog = () => {
    let matches = true;
    let buttonMatches = true;
    const button = {
      last: () => button,
      isVisible: async () => matches && buttonMatches,
      press: async (key: string) => { pressed.push(key); },
    };
    const dialog = {
      filter: ({ hasText }: { hasText: string | RegExp }) => {
        matches &&= typeof hasText === "string" ? text.includes(hasText) : hasText.test(text);
        return dialog;
      },
      last: () => dialog,
      isVisible: async () => matches,
      getByRole: (_role: string, options?: { name?: string | RegExp }) => {
        const name = options?.name;
        buttonMatches = name === undefined
          || (typeof name === "string" ? buttonText === name : name.test(buttonText));
        return button;
      },
    };
    return dialog;
  };
  return {
    page: {
      locator: () => createDialog(),
      getByText: (hasText: string | RegExp) => createDialog().filter({ hasText }),
    } as unknown as Page,
    pressed,
  };
}

test("the known ChatGPT rate-limit dialog is acknowledged and returns a structured 429", async () => {
  const fixture = dialogPage("Too many requests. You're making requests too quickly.");

  await expect(throwIfChatGptRateLimitDialog(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
    message: "ChatGPT rate limit: too many requests. Try again in a few minutes.",
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});

test("submission acceptance reports a rate-limit dialog that appears after Enter", async () => {
  const fixture = dialogPage("Too many requests. You're making requests too quickly.");
  const waitForSubmissionAccepted = (ChatGptBrowserWorker.prototype as unknown as {
    waitForSubmissionAccepted(page: Page, baseline: unknown): Promise<unknown>;
  }).waitForSubmissionAccepted;

  await expect(waitForSubmissionAccepted.call(
    {},
    fixture.page,
    {},
  )).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});

test("the Traditional Chinese ChatGPT rate-limit dialog is acknowledged and returns a structured 429", async () => {
  const fixture = dialogPage("太多要求。你提出要求的頻率過於頻繁。", "知道了");

  await expect(throwIfChatGptRateLimitDialog(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});

test("the Simplified Chinese ChatGPT rate-limit dialog is acknowledged and returns a structured 429", async () => {
  const fixture = dialogPage("太多请求。你提出请求的频率过于频繁。", "知道了");

  await expect(throwIfChatGptRateLimitDialog(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});

test("the Japanese ChatGPT rate-limit dialog is acknowledged and returns a structured 429", async () => {
  const fixture = dialogPage(
    "リクエストが多すぎます リクエストの頻度が高すぎます。お客様のデータを保護するため、会話へのアクセスを一時的に制限しています。 数分待ってから、もう一度お試しください。",
    "了解",
  );

  await expect(throwIfChatGptRateLimitDialog(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 429,
    errorType: "rate_limit_error",
    code: "rate_limit_exceeded",
    retryable: true,
  });
  expect(fixture.pressed).toEqual(["Enter"]);
});

test("unrelated ChatGPT dialogs are left untouched", async () => {
  const fixture = dialogPage("Confirm another action");

  await throwIfChatGptRateLimitDialog(fixture.page);
  expect(fixture.pressed).toEqual([]);
});

test("the known terminal ChatGPT error alert returns a structured retryable failure", async () => {
  const fixture = dialogPage(
    "Something went wrong. If this issue persists please contact us through our help center at help.openai.com.",
  );

  await expect(throwIfChatGptTerminalErrorAlert(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 502,
    errorType: "server_error",
    code: "upstream_server_error",
    retryable: true,
  });
  expect(fixture.pressed).toEqual([]);
});

test("a failed subscription fetch is retryable and does not falsely invalidate ChatGPT login", async () => {
  const fixture = dialogPage(
    "Failed to load subscription: Something went wrong. If this issue persists please contact us through our help center at help.openai.com.",
  );

  await expect(throwIfChatGptSessionFailureAlert(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 503,
    errorType: "server_error",
    code: "chatgpt_subscription_unavailable",
    retryable: true,
  });
});

test.each([
  "Your session has expired. Please log in again to continue using the app. Log in",
  "你的工作階段已過期 請重新登入以繼續使用應用程式。 登入",
  "您的会话已过期 请重新登录以继续使用该应用。 登录",
])("an expired ChatGPT session returns a non-retryable authentication failure: %s", async alertText => {
  const fixture = dialogPage(alertText);

  await expect(throwIfChatGptSessionFailureAlert(fixture.page)).rejects.toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 401,
    errorType: "authentication_error",
    code: "chatgpt_session_expired",
    retryable: false,
  });
});

test("effort selection stops as soon as ChatGPT reports an expired session", async () => {
  const neverVisible = new Promise<void>(() => {});
  const effortControl = {
    last() { return this; },
    waitFor: async () => await neverVisible,
  };
  const composerForm = { locator: () => effortControl };
  const composer = { locator: () => composerForm };
  const sessionAlert = {
    filter() { return this; },
    last() { return this; },
    waitFor: async () => {},
    isVisible: async () => true,
  };
  const hiddenDialog = {
    filter() { return this; },
    last() { return this; },
    waitFor: async () => await neverVisible,
    isVisible: async () => false,
  };
  const selectModelAndEffort = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(
      page: unknown,
      modelId: string,
      reasoning: string,
      capabilities: { localToolsEnabled: boolean; solAvailable: boolean; proAvailable: boolean },
    ): Promise<unknown>;
  }).selectModelAndEffort;

  const selection = selectModelAndEffort.call({
    activeComposer: async () => composer,
  }, {
    locator: (selector: string) => selector.includes('[role="alert"]') ? sessionAlert : hiddenDialog,
  }, "gpt-5.6-sol", "high", {
    localToolsEnabled: true,
    solAvailable: true,
    proAvailable: true,
  });
  const result = await Promise.race([
    selection.catch(error => error),
    new Promise(resolve => setTimeout(() => resolve("still waiting"), 100)),
  ]);

  expect(result).toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 401,
    code: "chatgpt_session_expired",
    retryable: false,
  });
});

test("effort menu waiting stops when ChatGPT reports an expired session", async () => {
  const neverVisible = new Promise<void>(() => {});
  const effortControl = {
    last() { return this; },
    waitFor: async () => {},
    getAttribute: async () => "true",
  };
  const composerForm = { locator: () => effortControl };
  const composer = { locator: () => composerForm };
  const effortChoice = { waitFor: async () => await neverVisible };
  const effortChoices = { nth: () => effortChoice, count: async () => 3 };
  const effortMenu = {
    last() { return this; },
    isVisible: async () => true,
    locator: () => effortChoices,
  };
  const effortSlider = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    waitFor: async () => await neverVisible,
  };
  const sessionAlert = {
    filter() { return this; },
    last() { return this; },
    waitFor: async () => {},
    isVisible: async () => true,
  };
  const hiddenDialog = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    waitFor: async () => await neverVisible,
    isVisible: async () => false,
  };
  const selectModelAndEffort = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(
      page: unknown,
      modelId: string,
      reasoning: string,
      capabilities: { localToolsEnabled: boolean; solAvailable: boolean; proAvailable: boolean },
    ): Promise<unknown>;
  }).selectModelAndEffort;

  const selection = selectModelAndEffort.call({
    activeComposer: async () => composer,
  }, {
    locator: (selector: string) => {
      if (selector.includes('[role="alert"]')) return sessionAlert;
      if (selector.includes('[role="menu"]') || selector.includes("composer-intelligence-picker-content")) return effortMenu;
      if (selector.includes("data-model-reasoning-effort-slider")) return effortSlider;
      if (selector.includes('[role="dialog"]')) return hiddenDialog;
      return effortMenu;
    },
  }, "gpt-5.6-sol", "high", {
    localToolsEnabled: true,
    solAvailable: true,
    proAvailable: true,
  });
  const result = await Promise.race([
    selection.catch(error => error),
    new Promise(resolve => setTimeout(() => resolve("still waiting"), 400)),
  ]);

  expect(result).toMatchObject({
    name: "ChatGptWebAdapterError",
    status: 401,
    code: "chatgpt_session_expired",
    retryable: false,
  });
});

test("terminal model errors are scoped to the new assistant turn instead of global page alerts", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain("throwIfChatGptTerminalErrorAlert(responseTurn.locator)");
  expect(workerSource).not.toContain("throwIfChatGptTerminalErrorAlert(page)");
});

test("submission acceptance stops when its stage is aborted", async () => {
  const waitForSubmissionAccepted = (ChatGptBrowserWorker.prototype as unknown as {
    waitForSubmissionAccepted(
      page: Page,
      baseline: unknown,
      signal: AbortSignal,
    ): Promise<unknown>;
  }).waitForSubmissionAccepted;
  const controller = new AbortController();
  controller.abort();

  await expect(waitForSubmissionAccepted.call(
    {},
    {} as Page,
    {},
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
});

test("proven current-turn MCP activity is conclusive submission evidence", async () => {
  const waitForSubmissionAccepted = (ChatGptBrowserWorker.prototype as unknown as {
    waitForSubmissionAccepted(
      page: Page,
      baseline: unknown,
      signal?: AbortSignal,
      externalProgress?: ChatGptExternalTurnProgress,
      initialToolBatchRevision?: number,
    ): Promise<unknown>;
  }).waitForSubmissionAccepted;
  const progress = new ChatGptExternalTurnProgress();
  progress.recordToolBatch(1);

  await expect(waitForSubmissionAccepted.call(
    {},
    {} as Page,
    {},
    undefined,
    progress,
    0,
  )).resolves.toBe("mcp_tool_call");

});

test("unrelated ChatGPT alerts are not terminal", async () => {
  const fixture = dialogPage("Your file was uploaded successfully");

  await throwIfChatGptTerminalErrorAlert(fixture.page);
  expect(fixture.pressed).toEqual([]);
});

function toolConfirmationPage(options: {
  disappearAfterReads?: number;
  surface?: "dialog" | "card";
  allowLabel?: "Allow once" | "Allow";
} = {}): {
  page: Page;
  pressed: string[];
} {
  let reads = 0;
  let visible = true;
  const pressed: string[] = [];
  const availableButtons = [options.allowLabel ?? "Allow once", "Deny"] as const;
  const button = (name: string | RegExp) => {
    const actualName = availableButtons.find(candidate => (
      typeof name === "string" ? candidate === name : name.test(candidate)
    ));
    return {
      last: () => button(name),
      waitFor: async () => {
        if (!actualName) throw new Error(`Approval button not found: ${String(name)}`);
      },
      press: async (key: string) => {
        if (!actualName) throw new Error(`Approval button not found: ${String(name)}`);
        pressed.push(`${actualName}:${key}`);
        visible = false;
      },
    };
  };
  const dialog = {
    filter: ({ hasText }: { hasText: string }) => {
      expect(hasText).toBe("Allow ChatGPT to use Codex Native?");
      return dialog;
    },
    last: () => dialog,
    isVisible: async () => {
      reads += 1;
      if (options.disappearAfterReads !== undefined && reads >= options.disappearAfterReads) visible = false;
      return visible;
    },
    getByRole: (_role: string, input: { name: string | RegExp }) => button(input.name),
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("hidden");
      expect(visible).toBeFalse();
    },
  };
  const surfaceSelector = options.surface === "card"
    ? '[data-testid="tool-approval-card"]'
    : '[role="dialog"]';
  const hiddenDialog = {
    filter: () => hiddenDialog,
    last: () => hiddenDialog,
    isVisible: async () => false,
  };
  return {
    page: {
      locator: (selector: string) => selector.includes(surfaceSelector)
        ? dialog
        : hiddenDialog,
    } as unknown as Page,
    pressed,
  };
}

test("manual ChatGPT connector approval pauses and resumes the same browser turn", async () => {
  const fixture = toolConfirmationPage({ disappearAfterReads: 3 });

  expect(await resolveChatGptToolConfirmation(fixture.page, "Codex Native", false, undefined, 100)).toBeTrue();
  expect(fixture.pressed).toEqual([]);
});

test("an unanswered ChatGPT connector approval is denied instead of aborting the turn", async () => {
  const fixture = toolConfirmationPage();

  expect(await resolveChatGptToolConfirmation(fixture.page, "Codex Native", false, undefined, 2)).toBeTrue();
  expect(fixture.pressed).toEqual(["Deny:Enter"]);
});

test("explicit connector auto-approval still selects Allow once", async () => {
  const fixture = toolConfirmationPage();

  expect(await resolveChatGptToolConfirmation(fixture.page, "Codex Native", true)).toBeTrue();
  expect(fixture.pressed).toEqual(["Allow once:Enter"]);
});

test("connector auto-approval accepts the current shortened Allow action", async () => {
  const fixture = toolConfirmationPage({ allowLabel: "Allow" });

  expect(await resolveChatGptToolConfirmation(fixture.page, "Codex Native", true)).toBeTrue();
  expect(fixture.pressed).toEqual(["Allow:Enter"]);
});

test("auto-approval recognizes the observed non-dialog approval card", async () => {
  const fixture = toolConfirmationPage({ surface: "card" });

  expect(await resolveChatGptToolConfirmation(fixture.page, "Codex Native", true)).toBeTrue();
  expect(fixture.pressed).toEqual(["Allow once:Enter"]);
});

test("browser preflight separates model context from one-message transport limits", () => {
  const plus = { localToolsEnabled: false, solAvailable: true, proAvailable: false };
  const pro = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
  const luna = { localToolsEnabled: false, solAvailable: false, proAvailable: false };

  try {
    assertChatGptWebInputWithinLimits(90_000, 81_808, "gpt-5.6-sol", "medium", plus);
    throw new Error("expected context-window preflight to fail");
  } catch (error) {
    expect(error).toMatchObject({
      name: "ChatGptWebAdapterError",
      status: 400,
      errorType: "invalid_request_error",
      code: "context_length_exceeded",
      retryable: false,
    });
    expect(String(error)).toContain("/compact");
  }

  expect(() => assertChatGptWebInputWithinLimits(40_999, 32_807, "gpt-5.6-sol", "low", plus)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(41_000, 32_808, "gpt-5.6-sol", "low", plus)).toThrow(
    "41,000-token context window",
  );
  expect(() => assertChatGptWebInputWithinLimits(89_999, 81_807, "gpt-5.6-sol", "medium", plus)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(89_999, 81_807, "gpt-5.6-sol", "high", plus)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(90_000, 81_808, "gpt-5.6-sol", "high", plus)).toThrow(
    "90,000-token context window",
  );
  expect(() => assertChatGptWebInputWithinLimits(100_000, 100_000, "gpt-5.6-sol", "xhigh", pro)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(100_000, 100_000, "gpt-5.6-sol", "max", pro)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(28_000, 19_808, "gpt-5.6-luna", "low", luna)).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(28_001, 19_809, "gpt-5.6-luna", "low", luna)).toThrow(
    "ChatGPT Free browser transport budget",
  );

  expect(() => assertChatGptWebInputWithinLimits(
    1,
    1,
    "gpt-5.6-sol",
    "low",
    plus,
    211_256,
  )).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(
    1,
    1,
    "gpt-5.6-sol",
    "low",
    plus,
    211_257,
  )).toThrow("211,256-character ChatGPT composer boundary");
  for (const effort of ["medium", "high"] as const) {
    expect(() => assertChatGptWebInputWithinLimits(
      1,
      1,
      "gpt-5.6-sol",
      effort,
      plus,
      1_048_572,
    )).not.toThrow();
    expect(() => assertChatGptWebInputWithinLimits(
      1,
      1,
      "gpt-5.6-sol",
      effort,
      plus,
      1_048_573,
    )).toThrow("1,048,572-character ChatGPT composer boundary");
  }

  expect(() => assertChatGptWebInputWithinLimits(
    111_192,
    103_000,
    "gpt-5.6-sol",
    "medium",
    pro,
    515_000,
  )).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(
    111_193,
    103_001,
    "gpt-5.6-sol",
    "medium",
    pro,
    515_001,
  )).toThrow("103,000-token ChatGPT browser message boundary");
  expect(() => assertChatGptWebInputWithinLimits(
    112_192,
    104_000,
    "gpt-5.6-sol",
    "max",
    pro,
    520_000,
  )).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(
    112_193,
    104_001,
    "gpt-5.6-sol",
    "max",
    pro,
    520_001,
  )).toThrow("104,000-token ChatGPT browser message boundary");
});

test("Bigger Context preflight expands only the total context ceiling and keeps each message boundary", () => {
  const plus = {
    localToolsEnabled: false,
    solAvailable: true,
    proAvailable: false,
    experimentalBiggerContext: true,
  };
  const pro = {
    localToolsEnabled: false,
    solAvailable: true,
    proAvailable: true,
    experimentalBiggerContext: true,
  };
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    333_578,
    95_000,
    "gpt-5.6-sol",
    "high",
    pro,
    900_000,
    3,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    333_579,
    95_000,
    "gpt-5.6-sol",
    "high",
    pro,
    900_000,
    3,
  )).toThrow("three-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    222_385,
    95_000,
    "gpt-5.6-sol",
    "high",
    pro,
    900_000,
    2,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    222_386,
    95_000,
    "gpt-5.6-sol",
    "high",
    pro,
    900_000,
    2,
  )).toThrow("two-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    269_999,
    80_000,
    "gpt-5.6-sol",
    "high",
    plus,
    900_000,
    3,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    270_000,
    80_000,
    "gpt-5.6-sol",
    "high",
    plus,
    900_000,
    3,
  )).toThrow("270,000-token three-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    180_000,
    80_000,
    "gpt-5.6-sol",
    "high",
    plus,
    900_000,
    2,
  )).toThrow("180,000-token two-part ceiling");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    280_000,
    103_001,
    "gpt-5.6-sol",
    "high",
    pro,
    900_000,
    3,
  )).toThrow("ChatGPT message boundary");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    20_000,
    10_000,
    "gpt-5.6-luna",
    "low",
    { localToolsEnabled: false, solAvailable: false, proAvailable: false },
    40_000,
    2,
  )).toThrow("unavailable for Luna");
});

test("Bigger Context stages use the lowest account mode that can carry the stage", () => {
  const plus = { localToolsEnabled: false, solAvailable: true, proAvailable: false };
  const business = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: false };
  const pro = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus, "low", 30_000, 200_000).effort).toBe("low");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus, "medium", 30_000, 300_000).effort).toBe("medium");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus, "high", 80_000, 300_000).effort).toBe("medium");
  expect(() => resolveChatGptWebMultipartStagingMode(
    "gpt-5.6-sol",
    plus,
    "high",
    80_001,
    300_000,
  )).toThrow("No ChatGPT effort");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", business, "xhigh", 80_000, 300_000).effort).toBe("medium");
  expect(() => resolveChatGptWebMultipartStagingMode(
    "gpt-5.6-sol",
    business,
    "xhigh",
    80_001,
    300_000,
  )).toThrow("No ChatGPT effort");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", pro, "medium", 100_000, 500_000).effort).toBe("medium");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", pro, "medium", 100_000, 600_000).effort).toBe("medium");
  expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", pro, "max", 104_000, 1_200_000).effort).toBe("max");
  expect(() => resolveChatGptWebMultipartStagingMode(
    "gpt-5.6-luna",
    { localToolsEnabled: false, solAvailable: false, proAvailable: false },
    "low",
    10_000,
    20_000,
  )).toThrow("Luna-only");
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    100_000,
    30_000,
    "gpt-5.6-sol",
    "low",
    plus,
    300_000,
    3,
    {
      stagingEffort: "medium",
      maxStageMessageTokens: 30_000,
      maxStageChars: 300_000,
      finalMessageTokens: 1_000,
      finalMessageChars: 4_000,
    },
  )).not.toThrow();
});

test("browser diagnostics redact context envelopes and capability values", () => {
  const diagnostic = redactChatGptUiDiagnostic(
    "<codex_context_json>private context</codex_context_json> turn_12345678901234567890 binding_12345678901234567890",
  );
  expect(diagnostic).not.toContain("private context");
  expect(diagnostic).not.toContain("12345678901234567890");
  expect(diagnostic).toContain("<codex_context_json>[redacted]</codex_context_json>");
});

test("browser diagnostic state drops every rendered text field before persistence", () => {
  const diagnostic = sanitizeChatGptBrowserDiagnosticState({
    url: "https://chatgpt.com/c/private-conversation-id",
    title: "private conversation title",
    location: { origin: "https://chatgpt.com", pathSegments: 2, temporaryChat: false },
    connectorRows: [{
      tag: "a",
      role: "button",
      testId: "private-account-row",
      text: "private sidebar conversation",
      textChars: 28,
    }],
    overlays: [{ role: "status", text: "private suggestion", textChars: 18 }],
  });
  const encoded = JSON.stringify(diagnostic);
  expect(encoded).not.toContain("private");
  expect(diagnostic).toEqual({
    location: { origin: "https://chatgpt.com", pathSegments: 2, temporaryChat: false },
    connectorRows: [{ tag: "a", role: "button", textChars: 28 }],
    overlays: [{ role: "status", textChars: 18 }],
  });
});

test("browser stage diagnostics use safe bounded artifact names", () => {
  expect(browserDiagnosticCheckpoint("effort menu / before click")).toBe("effort-menu-before-click");
  expect(browserDiagnosticCheckpoint("../turn_token secret")).toBe("turn_token-secret");
  expect(browserDiagnosticCheckpoint("x".repeat(200))).toHaveLength(80);
});

test("visible DOM trace interleaves statuses and explicit intermediate commentary", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const initialBlocks = [
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "commentary", text: "The implementation has a concrete state drift." },
    { kind: "answer", text: "Final answer still streaming" },
  ] as const;
  expect(tracker.observe([...initialBlocks], false, 1_000)).toEqual([]);
  expect(tracker.observe([...initialBlocks], false, 1_100)).toEqual([
    { kind: "reasoning", text: "Reviewed architecture documentation" },
    { kind: "commentary", text: "The implementation has a concrete state drift." },
  ]);
  const commentaryBlocks = [
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "commentary", text: "The implementation has a concrete state drift." },
    { kind: "status", text: "Inspecting runtime evidence" },
    { kind: "commentary", text: "The browser DOM confirms the boundary." },
    { kind: "answer", text: "Final answer still streaming" },
  ] as const;
  expect(tracker.observe([...commentaryBlocks], false, 1_200)).toEqual([]);
  expect(tracker.observe([...commentaryBlocks], false, 1_300)).toEqual([
    { kind: "reasoning", text: "Inspecting runtime evidence" },
    { kind: "commentary", text: "The browser DOM confirms the boundary." },
  ]);
  expect(tracker.observe([
    { kind: "answer", text: "Final answer complete" },
  ], true)).toEqual([]);
});

test("visible DOM trace does not duplicate a phase after a transient DOM disappearance", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  expect(tracker.observe([{ kind: "status", text: "Thinking" }], false, 1_000)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "Thinking" }], false, 1_100)).toEqual([
    { kind: "reasoning", text: "Thinking" },
  ]);
  expect(tracker.observe([], false, 1_150)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "Thinking" }], false, 1_300)).toEqual([]);
});

test("streaming commentary resumes by delta after a transient DOM disappearance", () => {
  const tracker = new ChatGptVisibleTraceTracker(0);
  expect(tracker.observe([{ kind: "commentary", text: "Checking sources" }], false, 1_000)).toEqual([
    { kind: "commentary", text: "Checking sources" },
  ]);
  expect(tracker.observe([], false, 1_010)).toEqual([]);
  expect(tracker.observe([
    { kind: "commentary", text: "Checking sources and dates" },
  ], false, 1_020)).toEqual([
    { kind: "commentary", text: " and dates", continuation: true },
  ]);
});

test("visible DOM trace emits a short-lived reasoning label on its first observation", () => {
  const tracker = new ChatGptVisibleTraceTracker(0);
  expect(tracker.observe([
    { kind: "status", text: "Binding Codex turn context" },
  ], false, 1_000)).toEqual([
    { kind: "reasoning", text: "Binding Codex turn context" },
  ]);
});

test("completed-turn evidence flushes a short-lived reasoning label immediately", () => {
  const tracker = new ChatGptVisibleTraceTracker(10_000);
  expect(tracker.observe([
    { kind: "status", text: "Reviewing ChatGPT Web Prompt and State Handling" },
  ], true, 1_000)).toEqual([
    { kind: "reasoning", text: "Reviewing ChatGPT Web Prompt and State Handling" },
  ]);
});

test("a structurally completed trailing Pro commentary does not wait for another parsed trace block", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const commentary = [{
    kind: "commentary",
    text: "The tracked worktree is clean; I’m preserving the untracked user artifacts.",
    complete: true,
  }] as const;
  expect(tracker.observe([...commentary], false, 1_000)).toEqual([]);
  expect(tracker.observe([...commentary], false, 1_100)).toEqual([{
    kind: "commentary",
    text: "The tracked worktree is clean; I’m preserving the untracked user artifacts.",
  }]);
});

test("visible DOM trace emits one complete commentary paragraph before the next action", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const initial = [
    { kind: "commentary", text: "I’m reading", complete: false },
  ] as const;
  expect(tracker.observe([...initial], false, 1_000)).toEqual([]);
  const expanded = [
    { kind: "commentary", text: "I’m reading the repository’s mandatory architecture", complete: false },
  ] as const;
  expect(tracker.observe([...expanded], false, 1_150)).toEqual([]);
  const completed = [
    { kind: "commentary", text: "I’m reading the repository’s mandatory architecture", complete: true },
    { kind: "status", text: "Read context file contents" },
  ] as const;
  expect(tracker.observe([...completed], false, 1_250)).toEqual([
    { kind: "commentary", text: "I’m reading the repository’s mandatory architecture" },
  ]);
  expect(tracker.observe([...completed], false, 1_350)).toEqual([
    { kind: "reasoning", text: "Read context file contents" },
  ]);
  expect(tracker.observe([...completed], false, 1_450)).toEqual([]);
});

test("persistent Stopped thinking is a terminal cancelled turn", () => {
  expect(CHATGPT_STOPPED_THINKING_GRACE_MS).toBe(5_000);
  const tracker = new ChatGptStoppedThinkingTracker();
  expect(tracker.update(true, 1_000)).toBeFalse();
  expect(tracker.update(true, 5_999)).toBeFalse();
  expect(tracker.update(false, 6_000)).toBeFalse();
  expect(tracker.update(true, 10_000)).toBeFalse();
  expect(tracker.update(true, 15_000)).toBeTrue();
  expect(chatGptStoppedThinkingError()).toMatchObject({
    status: 499,
    errorType: "client_closed_request",
    code: "client_cancelled",
    retryable: false,
  });
});

test("visible DOM trace keeps a complete action phrase instead of a nested count", () => {
  expect(new ChatGptVisibleTraceTracker(0).observe([
    { kind: "status", text: "Searched\n5\nsites" },
  ], false)).toEqual([
    { kind: "reasoning", text: "Searched 5 sites" },
  ]);
});

test("visible DOM trace waits out animated Pro fragments and appends genuine growth", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  expect(tracker.observe([{ kind: "status", text: "I" }], false, 1_000)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "I’m" }], false, 1_025)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "’m seeking" }], false, 1_050)).toEqual([]);
  expect(tracker.observe([{ kind: "status", text: "a concrete stack" }], false, 1_075)).toEqual([]);
  expect(tracker.observe([
    { kind: "status", text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity" },
  ], false, 1_100)).toEqual([]);
  expect(tracker.observe([
    { kind: "status", text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity" },
  ], false, 1_200)).toEqual([{
    kind: "reasoning",
    text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity",
  }]);

  expect(tracker.observe([
    { kind: "status", text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity, including validation" },
  ], false, 1_250)).toEqual([]);
  expect(tracker.observe([
    { kind: "status", text: "I’m seeking a concrete stack to automate dump.cs → RVA → Ghidra → rewrite → Unity, including validation" },
  ], false, 1_350)).toEqual([{
    kind: "reasoning",
    text: ", including validation",
    continuation: true,
  }]);
});

test("trace parsing excludes the Answer now UI control", () => {
  expect(isChatGptTraceControl({ kind: "status", text: "Answer now" })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "Thinking" })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "Switch model", uiControl: true })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "More actions", uiControl: true })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "Inspecting models", uiControl: false })).toBe(false);
  expect(isChatGptTraceControl({ kind: "status", text: "Reviewing repository invariants" })).toBe(false);
  expect(isChatGptTraceControl({ kind: "answer", text: "Answer now" })).toBe(false);
});

test("trace parsing removes an Answer now control appended to live reasoning", () => {
  expect(stripChatGptTraceControlSuffix({
    kind: "status",
    text: "Pro thinking\nAnswer now",
  })).toEqual({
    kind: "status",
    text: "Pro thinking",
  });
  expect(stripChatGptTraceControlSuffix({
    kind: "status",
    text: "Answer now",
  })).toEqual({
    kind: "status",
    text: "",
  });
  expect(stripChatGptTraceControlSuffix({
    kind: "answer",
    text: "Tell the user to select Answer now",
  })).toEqual({
    kind: "answer",
    text: "Tell the user to select Answer now",
  });
});

test("browser DOM health fails closed on a vanished or empty ChatGPT response", () => {
  const missing = new ChatGptTurnDomHealthTracker(1_000, 500);
  const absent = {
    responsePresent: false,
    running: true,
    currentText: "",
    completionActionVisible: false,
  };
  expect(missing.update(absent, 1_000)).toBeUndefined();
  expect(missing.update(absent, 2_000)).toContain("did not create a response DOM");

  const empty = new ChatGptTurnDomHealthTracker(1_000, 500);
  const terminal = {
    ...absent,
    responsePresent: true,
    running: false,
    completionActionVisible: true,
  };
  expect(empty.update(terminal, 1_000)).toBeUndefined();
  expect(empty.update(terminal, 1_500)).toContain("completed without a final answer");

  const missingCompletionAction = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
  const completedWithoutMarker = {
    ...terminal,
    currentText: "complete answer",
    completionActionVisible: false,
  };
  expect(missingCompletionAction.update(completedWithoutMarker, 1_000)).toBeUndefined();
  expect(missingCompletionAction.update(completedWithoutMarker, 1_749)).toBeUndefined();
  expect(missingCompletionAction.update(completedWithoutMarker, 1_750)).toBeUndefined();
});

test("stalled-turn diagnostics record DOM metrics without response or overlay content", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const start = workerSource.indexOf("private async stalledTurnDiagnostic");
  const end = workerSource.indexOf("private async runExclusive", start);
  const diagnosticSource = workerSource.slice(start, end);
  expect(diagnosticSource).toContain("textChars:");
  expect(diagnosticSource).toContain("htmlChars:");
  expect(diagnosticSource).not.toContain("innerText.trim()");
  expect(diagnosticSource).toContain('innerText ?? candidate.textContent ?? ""');
  expect(diagnosticSource).not.toMatch(/\btext:\s*(?:root|candidate)\.innerText/);
  expect(diagnosticSource).not.toMatch(/\bariaLabel:\s*candidate\.getAttribute/);
});

test("browser completion treats ChatGPT's response-scoped copy action as optional strong evidence", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/chatgpt-session.ts", import.meta.url), "utf8");
  expect(sessionSource).toContain('button[data-testid="copy-turn-action-button"]');
  expect(sessionSource).toContain('button[aria-label="Copy"]');
  expect(sessionSource).toContain('button[aria-label="复制"]');
  expect(sessionSource).toContain('button[aria-label="複製"]');
  expect(workerSource).toContain("CHATGPT_COMPLETION_ACTION_SELECTOR");
  expect(workerSource).toContain("fall back to a bounded text+HTML stability");
  expect(workerSource).not.toContain('root.querySelectorAll<HTMLElement>("button")');
});

test("browser send accepts only conclusive ChatGPT submission evidence", () => {
  const idle = {
    initialUserTurnCount: 1,
    userTurnCount: 1,
    initialAssistantTurnCount: 2,
    assistantTurnCount: 2,
    generationRunning: false,
  };
  expect(chatGptSubmissionEvidence(idle)).toBeUndefined();
  expect(chatGptSubmissionEvidence({ ...idle, userTurnCount: 2 })).toBe("user_turn");
  expect(chatGptSubmissionEvidence({ ...idle, assistantTurnCount: 3 })).toBe("assistant_turn");
  expect(chatGptSubmissionEvidence({ ...idle, generationRunning: true })).toBe("generation_running");
});

test("visible reasoning keeps the browser turn healthy before final assistant markdown exists", () => {
  const health = new ChatGptTurnDomHealthTracker(1_000, 500);
  const reasoning = {
    responsePresent: true,
    running: false,
    currentText: "",
    completionActionVisible: false,
  };
  expect(health.update(reasoning, 1_000)).toBeUndefined();
  expect(health.update(reasoning, 10_000)).toBeUndefined();
});

test("suspending DOM health for proven MCP progress restarts the missing-response window", () => {
  const tracker = new ChatGptTurnDomHealthTracker(1_000, 500);
  const absent = {
    responsePresent: false,
    running: true,
    currentText: "",
    completionActionVisible: false,
  };

  // The response DOM is unavailable from the first observation, so the window opens here.
  expect(tracker.update(absent, 1_000)).toBeUndefined();

  // Proven tool-call activity suspends the check. Charging that suspended stretch against the
  // grace period is what let a live turn be cancelled the moment liveness lapsed.
  tracker.clearMissingResponse();

  expect(tracker.update(absent, 10_000)).toBeUndefined();
  expect(tracker.update(absent, 10_999)).toBeUndefined();
  expect(tracker.update(absent, 11_000)).toContain("did not create a response DOM");
});

test("clearing the missing-response window preserves whether a response was ever observed", () => {
  const tracker = new ChatGptTurnDomHealthTracker(1_000, 500);
  const present = {
    responsePresent: true,
    running: true,
    currentText: "partial",
    completionActionVisible: false,
  };
  const absent = { ...present, responsePresent: false, currentText: "" };

  expect(tracker.update(present, 1_000)).toBeUndefined();
  expect(tracker.update(absent, 1_500)).toBeUndefined();
  tracker.clearMissingResponse();
  expect(tracker.update(absent, 5_000)).toBeUndefined();
  expect(tracker.update(absent, 6_000)).toContain("response DOM disappeared");
});

test("the launcher helper transport carries MCP progress into the out-of-process browser worker", () => {
  const client = readFileSync("src/adapters/chatgpt-web/launcher-helper-client.ts", "utf8");
  const helper = readFileSync("src/adapters/chatgpt-web/browser-helper-main.ts", "utf8");

  // The browser worker runs in the helper process while the Codex MCP broker runs in the daemon.
  // If progress stops crossing that boundary the worker silently observes "never live" and cancels
  // turns whose tool calls are still completing, so both ends of the transport are asserted here.
  expect(client).toContain("forwardProgress");
  expect(client).toMatch(/type: "progress", id: turn\.traceId, snapshot/);
  expect(helper).toMatch(/message\.type === "progress"/);
  expect(helper).toContain("ChatGptMirroredTurnProgress");
  expect(helper).toMatch(/externalProgress: progress/);
});

test("turn cancellation heuristics defer to proven MCP progress in both wait loops", () => {
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  // A stale "Stopped thinking" label must not cancel a turn that is still driving tool calls, and
  // the multipart staging loop must not be the one place that skips the liveness guard.
  expect((worker.match(/stoppedThinkingTracker\.clear\(\)/g) ?? []).length).toBe(2);
  expect((worker.match(/domHealthTracker\.clearMissingResponse\(\)/g) ?? []).length).toBe(2);
});

test("proven MCP progress vetoes terminal DOM conclusions while missing actions remain non-terminal", () => {
  // Tool activity remains authoritative when the response DOM is present. A missing completed-turn
  // action is no longer itself an error because ChatGPT can virtualize that shared action row.
  const stalled = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
  const answeredWithoutCompletionAction = {
    responsePresent: true,
    running: false,
    currentText: "partial answer",
    completionActionVisible: false,
  };

  expect(stalled.update({ ...answeredWithoutCompletionAction, externalProgressLive: true }, 1_000)).toBeUndefined();
  expect(stalled.update({ ...answeredWithoutCompletionAction, externalProgressLive: true }, 10_000)).toBeUndefined();

  // Once the model genuinely stops, the window starts fresh rather than charging the live stretch.
  expect(stalled.update(answeredWithoutCompletionAction, 10_100)).toBeUndefined();
  expect(stalled.update(answeredWithoutCompletionAction, 10_849)).toBeUndefined();
  expect(stalled.update(answeredWithoutCompletionAction, 10_850)).toBeUndefined();

  const empty = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
  const completedEmpty = {
    responsePresent: true,
    running: false,
    currentText: "",
    completionActionVisible: true,
  };
  expect(empty.update({ ...completedEmpty, externalProgressLive: true }, 1_000)).toBeUndefined();
  expect(empty.update({ ...completedEmpty, externalProgressLive: true }, 9_000)).toBeUndefined();
  expect(empty.update(completedEmpty, 9_100)).toBeUndefined();
  expect(empty.update(completedEmpty, 9_600)).toContain("completed without a final answer");
});

test("live external progress still records that a response DOM was observed", () => {
  const tracker = new ChatGptTurnDomHealthTracker(1_000, 500);
  const absent = {
    responsePresent: false,
    running: true,
    currentText: "",
    completionActionVisible: false,
  };

  expect(tracker.update({
    responsePresent: true,
    running: true,
    currentText: "",
    completionActionVisible: false,
    externalProgressLive: true,
  }, 1_000)).toBeUndefined();

  // The turn is reported as vanished rather than never created, so `sawResponse` survived.
  expect(tracker.update(absent, 2_000)).toBeUndefined();
  expect(tracker.update(absent, 3_000)).toContain("response DOM disappeared");
});

test("an accepted turn survives internal observation faults instead of being torn down", () => {
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");

  // A TypeError while reading the page is a defect in this worker, not evidence about ChatGPT.
  // Failing the turn on one loses an accepted ChatGPT turn that is never resent.
  expect(MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS).toBeGreaterThan(1);
  expect(worker).toContain("if (!(error instanceof TypeError) || observedThisIteration) throw error;");
  expect(worker).toContain("internalObservationFaults = 0;");
  expect(worker).toMatch(/internalObservationFaults > MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS/);

  // Liveness may postpone a verdict but never waive it, so a tool call that never returns cannot
  // hold an undeadlined turn open forever.
  expect(CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS).toBeGreaterThan(CHATGPT_RESPONSE_DOM_GRACE_MS);

  // Chain-of-thought containment is commentary regardless of document position.
  expect(worker).toContain('candidate.closest(\'[data-testid^="cot-v5"]\') !== null');
});

test("stale MCP progress stops suppressing DOM health without penalising long active turns", () => {
  const outstanding = {
    revision: 2,
    lastToolBatchRevision: 2,
    activeToolCalls: 1,
    lastProgressAt: 1_000,
  };

  // An outstanding call reports liveness regardless of age, so age is bounded separately: a tool
  // that never returns must not hold a turn open forever, since turns carry no deadline by default.
  expect(chatGptExternalProgressSuppressesDomHealth(outstanding, 1_000)).toBeTrue();
  expect(chatGptExternalProgressSuppressesDomHealth(
    outstanding,
    1_000 + CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS - 1,
  )).toBeTrue();
  expect(chatGptExternalProgressSuppressesDomHealth(
    outstanding,
    1_000 + CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS,
  )).toBeFalse();

  // A turn that keeps calling tools stays suppressed no matter how long it has been running, so
  // the bound is silence since the last activity rather than total turn duration.
  const hoursIn = 4 * 60 * 60_000;
  expect(chatGptExternalProgressSuppressesDomHealth(
    { ...outstanding, lastProgressAt: hoursIn },
    hoursIn + 1_000,
  )).toBeTrue();

  // No recorded activity is never evidence.
  expect(chatGptExternalProgressSuppressesDomHealth(undefined, 1_000)).toBeFalse();
  expect(chatGptExternalProgressSuppressesDomHealth(
    { revision: 0, lastToolBatchRevision: 0, activeToolCalls: 0 },
    1_000,
  )).toBeFalse();
});

test("the daemon prefers the browser helper that shipped beside its own entrypoint", () => {
  const client = readFileSync("src/adapters/chatgpt-web/launcher-helper-client.ts", "utf8");
  const helper = readFileSync("src/adapters/chatgpt-web/browser-helper-main.ts", "utf8");

  // The launcher advertises the helper inside its signed application bundle while the daemon runs
  // from a versioned runtime directory, so the two update independently. A daemon that spoke a
  // newer protocol to an older helper had its frame routed to the run handler, which dereferenced
  // a turn the frame never carried and destroyed the turn with an opaque TypeError.
  expect(client).toContain("bundledHelperScript()");
  expect(client).toMatch(/browserHelperScriptPath \?\? this\.bundledHelperScript\(\) \?\? descriptor\.helper\.script/);

  // Belt and braces: negotiate the frame, and never treat an unrecognised frame as a run.
  expect(client).toContain('this.helperFeatures.has("progress")');
  expect(client).toContain('this.helperFeatures.has("tool-boundary-ack")');
  expect(client).toContain('this.helperFeatures.has("completion-fence")');
  expect(helper).toMatch(/message\.type === "run"/);
  expect(helper).toContain("Browser helper received an unsupported message type");

  // A malformed liveness hint is not authoritative evidence that the active turn failed.
  expect(helper).toContain("discarded an invalid MCP progress frame");
});


test("proven progress forgets a Stopped thinking window rather than merely ignoring it", () => {
  const tracker = new ChatGptStoppedThinkingTracker(5_000);

  // The label appears while a tool call is outstanding. Clearing progress also clears the window,
  // so the next observation starts a new grace period.
  expect(tracker.update(true, 1_000)).toBeFalse();
  expect(tracker.update(true, 3_000)).toBeFalse();
  tracker.clear();

  // Progress has ended and the window starts again from here, not from the original sighting.
  expect(tracker.update(true, 6_500)).toBeFalse();
  expect(tracker.update(true, 11_499)).toBeFalse();
  expect(tracker.update(true, 11_500)).toBeTrue();
});

test("the shipped commentary classifier separates answer Markdown from reasoning in a real DOM", () => {
  // The classifier runs inside page.evaluate, so it cannot be imported. Extract and execute the
  // exact shipped source so the test covers the code that actually runs.
  // domino ships without module typings; it is already present as a turndown dependency and is
  // the only DOM implementation available to this suite.
  const { createDocument } = require("@mixmark-io/domino") as {
    createDocument: (html: string) => {
      body: { querySelectorAll: (selector: string) => ArrayLike<HTMLElement> };
    };
  };
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  const source = worker.split("// CHATGPT_COMMENTARY_CLASSIFIER_BEGIN")[1]?.split("// CHATGPT_COMMENTARY_CLASSIFIER_END")[0];
  if (!source) throw new Error("commentary classifier sentinels are missing from browser-worker.ts");
  const javascript = source
    .replace(/:\s*HTMLElement\[\]/g, "")
    .replace(/\):\s*\{[^}]*\}\s*=>/, ") =>");
  const selectChatGptAnswerRoots = new Function(
    `${javascript}; return selectChatGptAnswerRoots;`,
  )() as (roots: unknown[], statuses: unknown[]) => { answerRoots: Array<{ textContent: string }> };

  const answerFor = (html: string): string => {
    const document = createDocument(`<body>${html}</body>`);
    // domino's NodeList is array-like rather than iterable.
    const roots = Array.from(document.body.querySelectorAll(".markdown"))
      .filter(candidate => !candidate.parentElement?.closest(".markdown"));
    const statuses = Array.from(document.body.querySelectorAll("[data-streaming-response-status]"));
    return selectChatGptAnswerRoots(roots, statuses).answerRoots
      .map(root => (root.textContent ?? "").trim())
      .filter(Boolean)
      .join(" | ");
  };

  // Commentary that precedes the live status, and commentary nested inside one, stay excluded.
  expect(answerFor(
    '<div class="markdown">COMMENTARY</div>'
    + '<div data-streaming-response-status>live</div>'
    + '<div class="markdown">ANSWER</div>',
  )).toBe("ANSWER");
  expect(answerFor(
    '<div data-streaming-response-status><div class="markdown">NESTED</div></div>'
    + '<div class="markdown">ANSWER</div>',
  )).toBe("ANSWER");

  // Reasoning rendered inside a chain-of-thought component is commentary wherever it sits.
  expect(answerFor(
    '<div data-streaming-response-status>s1</div>'
    + '<div data-testid="cot-v5-block"><div class="markdown">THINKING</div></div>'
    + '<div class="markdown">ANSWER</div>',
  )).toBe("ANSWER");

  // A later status container must not hide answer text that appears before it in the DOM.
  expect(answerFor(
    '<div data-streaming-response-status>s1</div>'
    + '<div class="markdown">ANSWER</div>'
    + '<div data-streaming-response-status>s2</div>',
  )).toBe("ANSWER");
  expect(answerFor(
    '<div data-streaming-response-status>s1</div>'
    + '<div class="markdown">PART ONE</div>'
    + '<div data-streaming-response-status>s2</div>'
    + '<div class="markdown">PART TWO</div>',
  )).toBe("PART ONE | PART TWO");

  // A turn with no status container at all is entirely answer.
  expect(answerFor('<div class="markdown">ONLY ANSWER</div>')).toBe("ONLY ANSWER");
});

test("proven MCP progress vetoes completion, not only the health verdicts", () => {
  const tracker = new ChatGptCompletionTracker(500);
  const finishedLooking = {
    responsePresent: true,
    running: false,
    currentText: "partial answer so far",
    currentHtml: "<p>partial answer so far</p>",
    completionActionVisible: true,
  };

  // Between two tool calls the rendered message can look finished. Completing there returns a
  // truncated answer and retires the turn while its own tool calls are still in flight.
  expect(tracker.update({ ...finishedLooking, externalToolCallsInFlight: true }, 1_000)).toBeFalse();
  expect(tracker.update({ ...finishedLooking, externalToolCallsInFlight: true }, 5_000)).toBeFalse();

  // Once the model is genuinely idle the settle window starts fresh rather than completing at once.
  expect(tracker.update(finishedLooking, 5_100)).toBeFalse();
  expect(tracker.update(finishedLooking, 5_599)).toBeFalse();
  expect(tracker.update(finishedLooking, 5_600)).toBeTrue();
});

test("Full mode has no fixed post-tool final-answer deadline", () => {
  const progress = new ChatGptExternalTurnProgress();
  const tracker = new ChatGptCompletionTracker();
  const partialLookingFinal = {
    responsePresent: true,
    running: false,
    currentText: "partial answer",
    currentHtml: "<p>partial answer</p>",
    completionActionVisible: true,
  };

  progress.recordToolBatch(1, 1_000);
  const activeToolProgress = progress.snapshot();
  expect(chatGptExternalToolCallsAreInFlight(activeToolProgress)).toBeTrue();
  expect(tracker.observeToolBatch(
    activeToolProgress.lastToolBatchRevision,
    partialLookingFinal.currentText,
  )).toBeTrue();
  expect(tracker.update({
    ...partialLookingFinal,
    externalToolCallsInFlight: chatGptExternalToolCallsAreInFlight(activeToolProgress),
  }, 1_500)).toBeFalse();

  progress.recordToolResult(2_000);
  const betweenTools = progress.snapshot();
  // Recent progress remains a DOM-health grace, but it no longer imposes #272's 60-second
  // completion delay. The unchanged partial answer still cannot complete in the #274 gap.
  expect(chatGptExternalProgressSuppressesDomHealth(betweenTools, 2_001)).toBeTrue();
  expect(tracker.update({
    ...partialLookingFinal,
    externalToolCallsInFlight: false,
  }, 2_001)).toBeFalse();

  progress.recordToolBatch(1, 2_500);
  const secondToolInFlight = progress.snapshot();
  expect(tracker.observeToolBatch(
    secondToolInFlight.lastToolBatchRevision,
    partialLookingFinal.currentText,
  )).toBeTrue();
  expect(tracker.update({
    ...partialLookingFinal,
    externalToolCallsInFlight: true,
  }, 2_501)).toBeFalse();

  progress.recordToolResult(3_000);
  const completed = progress.snapshot();
  // Hiding the tool row cannot release a stale partial answer after a newer batch.
  expect(tracker.update({
    ...partialLookingFinal,
    externalToolCallsInFlight: false,
  }, 3_001)).toBeFalse();

  const finalAnswer = {
    ...partialLookingFinal,
    currentText: "complete final answer",
    currentHtml: "<p>complete final answer</p>",
  };
  expect(tracker.update({
    ...finalAnswer,
  }, 3_100)).toBeFalse();
  expect(tracker.update({
    ...finalAnswer,
  }, 3_100 + CHATGPT_COMPLETION_SETTLE_MS - 1)).toBeFalse();
  expect(tracker.update({
    ...finalAnswer,
  }, 3_100 + CHATGPT_COMPLETION_SETTLE_MS)).toBeTrue();
});

test("Full mode fails closed when ChatGPT exposes completion without a post-tool final answer", () => {
  const tracker = new ChatGptCompletionTracker(500, 1_000);
  const partialLookingFinal = {
    responsePresent: true,
    running: false,
    currentText: "partial answer",
    currentHtml: "<p>partial answer</p>",
    completionActionVisible: true,
  };

  expect(tracker.observeToolBatch(1, partialLookingFinal.currentText)).toBeTrue();
  expect(tracker.update(partialLookingFinal, 1_000)).toBeFalse();
  // Citation/markup hydration is not a new final answer and cannot release the boundary.
  expect(tracker.update({ ...partialLookingFinal, currentHtml: '<p data-hydrated="true">partial answer</p>' }, 1_999)).toBeFalse();
  expect(() => tracker.update(partialLookingFinal, 2_000))
    .toThrow("completed without producing a final answer after its last Codex tool call");
});

test("a future progress timestamp is not treated as liveness", () => {
  const base = {
    revision: 2,
    lastToolBatchRevision: 2,
    activeToolCalls: 1,
  };

  // "now - lastProgressAt < ceiling" is satisfied by any future timestamp, which would have kept a
  // stuck tool call suppressing DOM health forever.
  expect(chatGptExternalProgressSuppressesDomHealth(
    { ...base, lastProgressAt: 10_000 + CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS * 10 },
    10_000,
  )).toBeFalse();

  // Modest skew between the recording daemon and the observing helper is still accepted.
  expect(chatGptExternalProgressSuppressesDomHealth(
    { ...base, lastProgressAt: 10_000 + CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS - 1 },
    10_000,
  )).toBeTrue();
});

test("the bundled helper is adopted only for the packaged runtime layout", () => {
  const client = readFileSync("src/adapters/chatgpt-web/launcher-helper-client.ts", "utf8");

  // Any daemon launched some other way keeps the launcher-advertised helper rather than adopting
  // an unrelated sibling that merely shares a filename.
  expect(client).toContain('basename(entrypoint) !== "cli.js"');

  // Trace ids are derived deterministically and can repeat, so a run must not inherit revisions
  // recorded for an earlier turn that happened to share the id.
  const helper = readFileSync("src/adapters/chatgpt-web/browser-helper-main.ts", "utf8");
  expect(helper).toContain("const progress = message.turn.externalProgress");
  expect(helper).toContain("? new ChatGptMirroredTurnProgress(revision => {");

  // A consumer callback must not be retried as though the page could not be read.
  const worker = readFileSync("src/adapters/chatgpt-web/browser-worker.ts", "utf8");
  const heartbeat = worker.indexOf("turn.onHeartbeat?.();");
  const tryStart = worker.search(/ {7}try \{\r?\n {8}observedThisIteration = false;/);
  expect(heartbeat).toBeGreaterThan(0);
  expect(tryStart).toBeGreaterThan(0);
  expect(heartbeat).toBeLessThan(tryStart);
});

test("a staged Bigger Context part gets an acknowledgement window sized to its payload", () => {
  // A staged part is much larger than an ordinary prompt and ChatGPT reads it before answering.
  expect(CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS).toBeGreaterThan(CHATGPT_RESPONSE_DOM_GRACE_MS);

  // No MCP activity exists while an inert part is being ingested, so the response and send budgets
  // bound the same exchange.
  expect(CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS).toBe(browserStageTimeouts.multipartStageSend);
  expect(browserStageTimeouts.multipartStageAcknowledgement).toBe(CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS);

});

test("the suspension clock charges only tick gaps that mean the process was frozen", () => {
  const clock = new ChatGptSuspensionClock(1_000, 5_000);
  clock.tick(1_000);
  clock.tick(2_000);
  clock.tick(3_100);
  expect(clock.suspendedMs()).toBe(0);

  // Fifteen minutes without a tick is a sleep; the ordinary interval is refunded from the charge.
  clock.tick(3_100 + 15 * 60_000);
  expect(clock.suspendedMs()).toBe(15 * 60_000 - 1_000);
});

test("remaining stage budget refunds slept time and stands once the awake budget is spent", () => {
  expect(remainingStageBudgetMs(120_000, 900_000, 890_000)).toBe(110_000);
  expect(remainingStageBudgetMs(120_000, 120_000, 0)).toBe(0);
  expect(remainingStageBudgetMs(120_000, 900_000, 0)).toBe(0);
  expect(remainingStageBudgetMs(200, 210, 50)).toBe(250);
});

test("a stage that spans a system sleep is not charged for the slept time", async () => {
  // When the suspension exceeds the whole stage budget, the first timer firing must re-arm rather
  // than charge time during which both the browser and worker were frozen.
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://suspension-stage-${Date.now()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, proAvailable: true },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider) as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
      clock?: { suspendedMs(): number },
    ): Promise<T>;
  };

  let suspended = 0;
  const clock = { suspendedMs: () => suspended };
  const outcome: string[] = [];
  const stage = worker.runStage(
    "suspension-test",
    "probe",
    200,
    () => new Promise<never>(() => {}),
    clock,
  ).catch(error => { outcome.push((error as Error).message); });

  // The sleep is discovered when the first timer fires: 300ms slept against a 200ms budget.
  suspended = 300;
  await Bun.sleep(320);
  expect(outcome).toEqual([]);

  // No further sleep: the re-armed timer now expires on genuinely awake time.
  await stage;
  expect(outcome).toEqual(["ChatGPT browser stage timed out: probe"]);
}, 10_000);
