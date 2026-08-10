import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Page } from "playwright-core";
import { CHATGPT_PROMPT_INSERT_CHUNK_CHARS, ChatGptBrowserWorker, ChatGptTurnDomHealthTracker, ChatGptVisibleTraceTracker, MAX_CHATGPT_BROWSER_TABS, assertChatGptWebInputWithinLimits, browserDiagnosticCheckpoint, browserDiagnosticIncludesScreenshot, chatGptSubmissionEvidence, composeChatGptPromptReadback, isChatGptTraceControl, redactChatGptUiDiagnostic, resolveBrowserConfig, resolveChatGptToolConfirmation, stripChatGptTraceControlSuffix, throwIfChatGptRateLimitDialog, throwIfChatGptSessionFailureAlert, throwIfChatGptTerminalErrorAlert } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_CONNECTOR_NAME, defaultChromeExecutable } from "../src/config";
import { parseChatGptEffortSliderState } from "../src/chatgpt-session";

test("Codex context uses the owned CDP composer transport, never the operating-system clipboard", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain('composer.fill("")');
  expect(workerSource).toContain("this.insertPromptText(page, prompt, submissionBaseline)");
  expect(workerSource).toContain("this.insertPromptText(page, ` ${prompt}`, submissionBaseline)");
  expect(workerSource).not.toMatch(/\bclipboard\b|pbcopy|pbpaste/i);
});

test("completed prompts activate the scoped semantic send control", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain('.getByTestId("send-button")');
  expect(workerSource).toContain('await sendButton.press("Enter")');
  expect(workerSource).not.toContain('getByTestId("send-button").dispatchEvent("click")');
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
    connectorMentionRowTitles: async () => ["Codex Native", "Codex Native2"],
  }, {}, 4);
  expect(mixedMessage).not.toContain("Legacy ChatGPT connector");
  expect(mixedMessage).toContain('no row named "Codex Native2"');
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

test("closing the launcher page is an immediate terminal turn error", async () => {
  const responseDomSnapshot = (ChatGptBrowserWorker.prototype as unknown as {
    responseDomSnapshot(responseTurn: unknown): Promise<unknown>;
  }).responseDomSnapshot;
  const responseTurn = {
    evaluate: async () => { throw new Error("Target page has been closed"); },
    page: () => ({ isClosed: () => true }),
  };

  await expect(responseDomSnapshot.call({}, responseTurn)).rejects.toThrow(
    "ChatGPT browser tab was closed; the Codex turn was terminated",
  );
});

test("connector verification and real tool turns share one Playwright selector", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource.match(/this\.selectConnector\(page(?:, captureDiagnostic)?\)/g)?.length).toBe(2);
  expect(workerSource.match(/this\.prepareTemporaryChatSurface\(\s*page/g)?.length).toBe(4);
  expect(workerSource).toContain('"temporary_chat_preparation"');
  expect(workerSource).toContain('if (page.url() !== CHATGPT_TEMPORARY_CHAT_URL)');
  expect(workerSource).toContain('composer.pressSequentially("@c", { delay: 25 })');
  expect(workerSource).toContain('page.locator(\'.__menu-item[tabindex="0"]\')');
  expect(workerSource).toContain("await appResult.click({ force: true, timeout: 10_000 })");
  expect(workerSource).not.toContain("highlightConnectorMenuRow");
  expect(workerSource).not.toContain('await appResult.dispatchEvent("click")');
  expect(workerSource).not.toContain('appResult.press("Enter")');
  expect(workerSource).toContain("this.selectedConnectorControl(selectedComposer)");
  expect(workerSource).toContain("'[data-id^=\"plugin:\"][data-keyword]'");
  expect(workerSource).toContain("const selectedComposer = await this.activeComposer(page)");
});

test("new ChatGPT chats select the requested effort and submit the first real turn directly", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const requestedSelection = workerSource.indexOf('"effort_selection"');
  const promptAttachment = workerSource.indexOf('"prompt_attachment"', requestedSelection);
  expect(workerSource).not.toContain("CHATGPT_WARMUP_PROMPT");
  expect(workerSource).not.toContain('"warmup_effort_selection"');
  expect(workerSource).not.toContain('"chat_warmup"');
  expect(workerSource).toMatch(/turn\.modelId,\s+turn\.reasoning/);
  expect(requestedSelection).toBeGreaterThan(-1);
  expect(promptAttachment).toBeGreaterThan(requestedSelection);
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

test("large read-only context is inserted as contiguous low-load edits before exact verification", async () => {
  const prompt = `Act as the model backend for the Codex task encoded below.\n${"x".repeat(819_343)}`;
  const calls: Array<[string, string?]> = [];
  let asserted = "";
  const composer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
  };
  const page = {
    keyboard: {
      insertText: async (value: string) => { calls.push(["insertText", value]); },
      press: async (value: string) => { calls.push(["press", value]); },
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
    promptSubmissionBaseline: async () => ({ initialUserTurnCount: 0, initialAssistantTurnCount: 0 }),
    insertPromptText,
    waitForPromptChunkAttached: async (_page: unknown, expected: string) => {
      calls.push(["chunkCommitted", String(expected.length)]);
    },
    reanchorPromptCaret: async () => {},
    assertPromptAttached: async (_page: unknown, value: string) => { asserted = value; },
  }, page, prompt, false);

  const inserted = calls.filter(call => call[0] === "insertText").map(call => call[1] ?? "");
  const fullChunkCount = Math.floor((prompt.length - 1) / CHATGPT_PROMPT_INSERT_CHUNK_CHARS);
  expect(CHATGPT_PROMPT_INSERT_CHUNK_CHARS).toBeLessThanOrEqual(16_000);
  expect(calls.slice(0, 2)).toEqual([["fill", ""], ["focus"]]);
  expect(inserted.every(chunk => chunk.length <= CHATGPT_PROMPT_INSERT_CHUNK_CHARS)).toBeTrue();
  expect(inserted.length).toBe(Math.ceil(prompt.length / CHATGPT_PROMPT_INSERT_CHUNK_CHARS));
  expect(inserted.join("")).toBe(prompt);
  expect(calls.filter(call => call[0] === "chunkCommitted")).toEqual(
    Array.from({ length: fullChunkCount }, (_value, index) => [
      "chunkCommitted",
      String((index + 1) * CHATGPT_PROMPT_INSERT_CHUNK_CHARS),
    ]),
  );
  expect(calls.filter(call => call[0] === "press")).toEqual([]);
  expect(asserted).toBe(prompt);
});

test("multi-chunk prompt insertion preserves the native caret after each committed prefix", async () => {
  const prompt = "a".repeat(CHATGPT_PROMPT_INSERT_CHUNK_CHARS)
    + "b".repeat(CHATGPT_PROMPT_INSERT_CHUNK_CHARS)
    + "c";
  const calls: Array<[string, string?]> = [];
  let attached = "";
  let caret = 0;
  const page = {
    keyboard: {
      insertText: async (value: string) => {
        attached = `${attached.slice(0, caret)}${value}${attached.slice(caret)}`;
        caret += value.length;
        calls.push(["insertText", String(value.length)]);
      },
    },
  };
  const insertPromptText = (ChatGptBrowserWorker.prototype as unknown as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  }).insertPromptText;

  await insertPromptText.call({
    waitForPromptChunkAttached: async (_page: unknown, expected: string) => {
      expect(attached).toBe(expected);
      calls.push(["chunkCommitted", String(expected.length)]);
    },
    reanchorPromptCaret: async () => { calls.push(["reanchor"]); },
  }, page, prompt);

  expect(attached).toBe(prompt);
  expect(calls.filter(call => call[0] === "reanchor")).toHaveLength(0);
  expect(calls).toEqual([
    ["insertText", String(CHATGPT_PROMPT_INSERT_CHUNK_CHARS)],
    ["chunkCommitted", String(CHATGPT_PROMPT_INSERT_CHUNK_CHARS)],
    ["insertText", String(CHATGPT_PROMPT_INSERT_CHUNK_CHARS)],
    ["chunkCommitted", String(CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 2)],
    ["insertText", "1"],
  ]);
});

test("prompt insertion stops after a stage abort before another native edit", async () => {
  const prompt = "x".repeat(CHATGPT_PROMPT_INSERT_CHUNK_CHARS * 2 + 1);
  const controller = new AbortController();
  const inserted: string[] = [];
  const page = {
    keyboard: {
      insertText: async (value: string) => {
        inserted.push(value);
        controller.abort();
      },
    },
  };
  const insertPromptText = (ChatGptBrowserWorker.prototype as unknown as {
    insertPromptText(
      page: unknown,
      text: string,
      baseline: { initialUserTurnCount: number; initialAssistantTurnCount: number },
      abortSignal?: AbortSignal,
    ): Promise<void>;
  }).insertPromptText;

  await expect(insertPromptText.call({
    waitForPromptChunkAttached: async () => {},
  }, page, prompt, { initialUserTurnCount: 0, initialAssistantTurnCount: 0 }, controller.signal))
    .rejects.toThrow("aborted");
  expect(inserted).toHaveLength(1);
});

test("composer readback removes ignored root nodes before adding block separators", () => {
  expect(composeChatGptPromptReadback([
    { text: "prefix", ignored: false },
    { text: "Codex Native2", ignored: true },
    { text: "suffix", ignored: false },
  ])).toBe("prefix\nsuffix");
  expect(composeChatGptPromptReadback([
    { text: "first", ignored: false },
    { text: "", ignored: false },
    { text: "third", ignored: false },
  ])).toBe("first\n\nthird");
});

test("caret re-anchor fails closed when the live selection cannot be verified", async () => {
  const reanchorPromptCaret = (ChatGptBrowserWorker.prototype as unknown as {
    reanchorPromptCaret(page: unknown): Promise<void>;
  }).reanchorPromptCaret;
  let evaluateOptions: unknown;
  const composer = {
    focus: async () => {},
    evaluate: async (_fn: unknown, _arg: unknown, options: unknown) => {
      evaluateOptions = options;
      return false;
    },
  };

  await expect(reanchorPromptCaret.call({
    activeComposer: async () => composer,
  }, {})).rejects.toThrow("could not re-anchor the prompt caret");
  expect(evaluateOptions).toEqual({ timeout: 20_000 });
});

test("caret re-anchor uses the live Selection API and excludes connector-only nodes", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const reanchorSource = workerSource.slice(
    workerSource.indexOf("private async reanchorPromptCaret"),
    workerSource.indexOf("private async insertPromptText"),
  );
  expect(reanchorSource).toContain("window.getSelection()");
  expect(reanchorSource).toContain("document.createRange()");
  expect(reanchorSource).toContain("selection.addRange(range)");
  expect(reanchorSource).toContain('node.tagName === "P"');
  expect(reanchorSource).toContain("range.setStartBefore(cursorTarget)");
  expect(reanchorSource).toContain("[data-id^=\"plugin:\"][data-keyword]");
  expect(reanchorSource).toContain("[data-inline-selection-pill-cursor-target]");
  expect(reanchorSource).not.toContain("CHATGPT_COMPOSER_DOCUMENT_END_KEY");
});

test("long prompt insertion prefers a nearby text boundary over an unstable Unicode tail", async () => {
  const prompt = `${"x".repeat(CHATGPT_PROMPT_INSERT_CHUNK_CHARS - 10)} ${"y".repeat(7)}☹️tail`;
  const inserted: string[] = [];
  const page = {
    keyboard: {
      insertText: async (value: string) => { inserted.push(value); },
    },
  };
  const insertPromptText = (ChatGptBrowserWorker.prototype as unknown as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  }).insertPromptText;

  await insertPromptText.call({
    waitForPromptChunkAttached: async () => {},
    reanchorPromptCaret: async () => {},
  }, page, prompt);

  expect(inserted.join("")).toBe(prompt);
  expect(inserted[0]?.length).toBe(CHATGPT_PROMPT_INSERT_CHUNK_CHARS - 10);
  expect(inserted[0]?.endsWith("x")).toBeTrue();
  expect(inserted[1]?.startsWith(" ")).toBeTrue();
});

test("long prompt insertion never divides a UTF-16 surrogate pair", async () => {
  const prompt = `${"x".repeat(CHATGPT_PROMPT_INSERT_CHUNK_CHARS - 1)}😀tail`;
  const inserted: string[] = [];
  const page = {
    keyboard: {
      insertText: async (value: string) => { inserted.push(value); },
    },
  };
  const insertPromptText = (ChatGptBrowserWorker.prototype as unknown as {
    insertPromptText(page: unknown, text: string): Promise<void>;
  }).insertPromptText;

  await insertPromptText.call({
    waitForPromptChunkAttached: async () => {},
    reanchorPromptCaret: async () => {},
  }, page, prompt);

  expect(inserted.join("")).toBe(prompt);
  expect(inserted[0]?.length).toBe(CHATGPT_PROMPT_INSERT_CHUNK_CHARS - 1);
  for (const chunk of inserted) {
    const lastCodeUnit = chunk.charCodeAt(chunk.length - 1);
    expect(lastCodeUnit < 0xd800 || lastCodeUnit > 0xdbff).toBeTrue();
  }
});

test("intermediate prompt verification never accepts a stable equal-length boundary rewrite", async () => {
  const expected = "x".repeat(CHATGPT_PROMPT_INSERT_CHUNK_CHARS);
  const normalized = `${expected.slice(0, -2)}yz`;
  const waitForPromptChunkAttached = (ChatGptBrowserWorker.prototype as unknown as {
    waitForPromptChunkAttached(page: unknown, value: string): Promise<void>;
  }).waitForPromptChunkAttached;

  await expect(waitForPromptChunkAttached.call({
    exactPromptSnapshot: async () => normalized,
  }, {}, expected)).rejects.toThrow("commonPrefixChars=");
});

test("prompt verification allows a delayed Lexical commit beyond five observations", async () => {
  const expected = "expected prompt";
  let observations = 0;
  const exactPromptSnapshot = (ChatGptBrowserWorker.prototype as unknown as {
    exactPromptSnapshot(
      page: unknown,
      value: string,
      baseline: { initialUserTurnCount: number; initialAssistantTurnCount: number },
      timeoutMs?: number,
    ): Promise<string>;
  }).exactPromptSnapshot;

  const observed = await exactPromptSnapshot.call({
    waitForPromptComposerSettle: async () => {},
    promptAttachmentSnapshot: async () => {
      observations += 1;
      return { text: observations < 6 ? "pending" : expected };
    },
  }, {}, expected, { initialUserTurnCount: 0, initialAssistantTurnCount: 0 }, 5_000);

  expect(observed).toBe(expected);
  expect(observations).toBe(6);
});

test("intermediate and final prompt verification retain separate UI deadlines", async () => {
  const expected = "expected prompt";
  const timeouts: number[] = [];
  const exactPromptSnapshot = async (...args: unknown[]) => {
    timeouts.push(Number(args[3]));
    return expected;
  };
  const waitForPromptChunkAttached = (ChatGptBrowserWorker.prototype as unknown as {
    waitForPromptChunkAttached(page: unknown, value: string): Promise<void>;
  }).waitForPromptChunkAttached;
  const assertPromptAttached = (ChatGptBrowserWorker.prototype as unknown as {
    assertPromptAttached(page: unknown, value: string): Promise<void>;
  }).assertPromptAttached;

  await waitForPromptChunkAttached.call({ exactPromptSnapshot }, {}, expected);
  await assertPromptAttached.call({ exactPromptSnapshot }, {}, expected);

  expect(timeouts).toEqual([20_000, 10_000]);
});

test("prompt verification stops immediately when ChatGPT submits during insertion", async () => {
  const waitForPromptChunkAttached = (ChatGptBrowserWorker.prototype as unknown as {
    waitForPromptChunkAttached(page: unknown, value: string): Promise<void>;
  }).waitForPromptChunkAttached;
  const exactPromptSnapshot = (ChatGptBrowserWorker.prototype as unknown as {
    exactPromptSnapshot(page: unknown, value: string): Promise<string>;
  }).exactPromptSnapshot;
  let observations = 0;

  await expect(waitForPromptChunkAttached.call({
    exactPromptSnapshot,
    waitForPromptComposerSettle: async () => {},
    promptAttachmentSnapshot: async () => {
      observations += 1;
      return { text: "expected prompt", submissionEvidence: "generation_running" };
    },
  }, {}, "expected prompt")).rejects.toThrow("submitted before prompt verification completed");

  expect(observations).toBe(1);
});

test("final prompt verification still requires an exact snapshot", async () => {
  const expected = "x".repeat(CHATGPT_PROMPT_INSERT_CHUNK_CHARS);
  const normalized = `${expected.slice(0, -2)}yz`;
  let observations = 0;
  const assertPromptAttached = (ChatGptBrowserWorker.prototype as unknown as {
    assertPromptAttached(page: unknown, value: string): Promise<void>;
  }).assertPromptAttached;
  const exactPromptSnapshot = (ChatGptBrowserWorker.prototype as unknown as {
    exactPromptSnapshot(page: unknown, value: string): Promise<string>;
  }).exactPromptSnapshot;

  await assertPromptAttached.call({
    exactPromptSnapshot,
    waitForPromptComposerSettle: async () => {},
    promptAttachmentSnapshot: async () => {
      observations += 1;
      return { text: observations < 4 ? normalized : expected };
    },
  }, {}, expected);

  expect(observations).toBe(4);
});

test("prompt attachment verification uses the existing-turn baseline", async () => {
  const promptAttachmentSnapshot = (ChatGptBrowserWorker.prototype as unknown as {
    promptAttachmentSnapshot(
      page: unknown,
      baseline: { initialUserTurnCount: number; initialAssistantTurnCount: number },
    ): Promise<{ text: string; submissionEvidence?: string }>;
  }).promptAttachmentSnapshot;
  const counts = [3, 4, 0];
  const page = {
    locator: () => {
      const count = counts.shift() ?? 0;
      return {
        count: async () => count,
        filter: () => ({ count: async () => 0 }),
      };
    },
  };

  const snapshot = await promptAttachmentSnapshot.call({
    attachedPromptText: async () => "expected prompt",
  }, page, { initialUserTurnCount: 3, initialAssistantTurnCount: 4 });

  expect(snapshot.text).toBe("expected prompt");
  expect(snapshot.submissionEvidence).toBeUndefined();
});

test("connector selection re-resolves the active composer after ChatGPT replaces it", async () => {
  const calls: Array<[string, string?]> = [];
  let connectorSelected = false;
  const appResult = {
    waitFor: async () => { calls.push(["waitForResult"]); },
    count: async () => 1,
    click: async (options: { force: boolean; timeout: number }) => {
      expect(options).toEqual({ force: true, timeout: 10_000 });
      connectorSelected = true;
      calls.push(["click"]);
    },
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
    pressSequentially: async (value: string, options: { delay: number }) => {
      expect(options).toEqual({ delay: 25 });
      calls.push(["pressSequentially", value]);
    },
  };
  const page = {
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
    ["pressSequentially", "@c"],
    ["waitForResult"],
    ["click"],
    ["waitForSelectedConnector"],
  ]);
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
    click: async (options: { force: boolean; timeout: number }) => {
      expect(options).toEqual({ force: true, timeout: 10_000 });
      selected = true;
      calls.push("activate");
    },
  };
  const selectedComposer = {
    locator: () => ({ filter: () => selectedConnector }),
  };
  const initialComposer = {
    fill: async () => { calls.push("clear"); },
    focus: async () => { calls.push("focus"); },
    pressSequentially: async (value: string) => {
      expect(value).toBe("@c");
      calls.push("type");
    },
  };
  const page = {
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

test("tool-capable prompts use the shared Playwright connector selection before inserting context", async () => {
  const calls: Array<[string, string?]> = [];
  let selected = false;
  const selectedConnector = {
    waitFor: async () => {
      expect(selected).toBeTrue();
      calls.push(["selectedConnector"]);
    },
    count: async () => 1,
  };
  const appResult = {
    waitFor: async () => { calls.push(["connectorMenu"]); },
    count: async () => 1,
    click: async (options: { force: boolean; timeout: number }) => {
      expect(options).toEqual({ force: true, timeout: 10_000 });
      selected = true;
      calls.push(["selectConnector"]);
    },
  };
  const selectedComposer = {
    focus: async () => { calls.push(["selectedFocus"]); },
    locator: () => ({ filter: () => selectedConnector }),
  };
  const initialComposer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
    pressSequentially: async (value: string) => { calls.push(["type", value]); },
  };
  const page = {
    getByText: () => ({ exactConnectorLabel: true }),
    locator: (selector: string) => selector.includes("__menu-item")
      ? { filter: () => appResult, evaluateAll: async () => [] }
      : (() => { throw new Error(`Unexpected locator: ${selector}`); })(),
    keyboard: {
      insertText: async (value: string) => { calls.push(["insertText", value]); },
      press: async (value: string) => { calls.push(["press", value]); },
    },
  };
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: unknown, prompt: string, localTools: boolean): Promise<void>;
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
    promptSubmissionBaseline: async () => ({ initialUserTurnCount: 0, initialAssistantTurnCount: 0 }),
    selectConnector,
    insertPromptText,
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return selected ? selectedComposer : initialComposer;
    },
    reanchorPromptCaret: async () => { calls.push(["reanchor"]); },
    assertPromptAttached: async () => { calls.push(["assertPrompt"]); },
  }, page, "context", true);

  expect(calls).toEqual([
    ["fill", ""],
    ["fill", ""],
    ["focus"],
    ["type", "@c"],
    ["connectorMenu"],
    ["selectConnector"],
    ["selectedConnector"],
    ["reanchor"],
    ["insertText", " context"],
    ["assertPrompt"],
  ]);
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
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).not.toContain('aria-label^="Remove file "');
});

test("effort selection uses structural menu and slider indices instead of localized labels", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/chatgpt-session.ts", import.meta.url), "utf8");
  expect(workerSource).toContain("mode.uiEffortIndex");
  expect(workerSource).toContain("CHATGPT_EFFORT_MENU_SELECTOR");
  expect(workerSource).toContain("CHATGPT_EFFORT_ITEM_SELECTOR");
  expect(workerSource).toContain('timeout: 70_000');
  expect(sessionSource).toContain('[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])');
  expect(sessionSource).toContain('[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])');
  expect(sessionSource).toContain('[role="menuitemradio"]');
  expect(sessionSource).toContain('[data-model-reasoning-effort-slider] [role="slider"]');
  expect(sessionSource).not.toContain(":popover-open");
  expect(sessionSource).not.toContain("data-radix-collection-item");
  expect(workerSource).toContain('getAttribute("aria-checked")');
  expect(workerSource).toContain('getAttribute("aria-expanded")');
  expect(workerSource).toContain('getAttribute("aria-valuenow")');
  expect(workerSource).toContain("sliderControl.press(key)");
  expect(workerSource).not.toContain("currentLabel === targetLabel");
  expect(workerSource).not.toContain("chatGptEffortLabelsMatch");
  expect(workerSource).not.toMatch(/getByRole\("button", \{\s*name: "(?:Instant|Medium|High|Extra High|Pro)"/);
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

test("effort selection handles the known ChatGPT rate-limit dialog before keyboard activation", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const selectionStart = workerSource.indexOf("private async selectModelAndEffort");
  const selectionEnd = workerSource.indexOf("private async activeComposer", selectionStart);
  const selectionSource = workerSource.slice(selectionStart, selectionEnd);
  const guard = selectionSource.indexOf("throwIfChatGptRateLimitDialog(page)");
  const activation = selectionSource.indexOf('currentEffort.press("Enter")');

  expect(workerSource).toContain("Too many requests");
  expect(workerSource).toContain("making requests too quickly");
  expect(guard).toBeGreaterThan(-1);
  expect(activation).toBeGreaterThan(guard);
  expect(selectionSource).not.toContain("currentEffort.click(");
  expect(selectionSource).toContain('effortChoice.press("Enter")');
  expect(selectionSource).not.toContain("effortChoice.click(");
  expect(selectionSource).not.toContain("is unavailable");
});

function dialogPage(text: string): { page: Page; pressed: string[] } {
  let matches = true;
  const pressed: string[] = [];
  const button = {
    last: () => button,
    isVisible: async () => matches,
    press: async (key: string) => { pressed.push(key); },
  };
  const dialog = {
    filter: ({ hasText }: { hasText: string | RegExp }) => {
      matches &&= typeof hasText === "string" ? text.includes(hasText) : hasText.test(text);
      return dialog;
    },
    last: () => dialog,
    isVisible: async () => matches,
    getByRole: () => button,
  };
  return {
    page: {
      locator: () => dialog,
      getByText: (hasText: string | RegExp) => dialog.filter({ hasText }),
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

test("terminal model errors are scoped to the new assistant turn instead of global page alerts", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain("throwIfChatGptTerminalErrorAlert(responseTurn)");
  expect(workerSource).not.toContain("throwIfChatGptTerminalErrorAlert(page)");
});

test("submission acceptance stops when its stage is aborted", async () => {
  const waitForSubmissionAccepted = (ChatGptBrowserWorker.prototype as unknown as {
    waitForSubmissionAccepted(
      page: Page,
      userTurns: unknown,
      responseTurns: unknown,
      responseTurn: unknown,
      initialUserTurnCount: number,
      initialResponseTurnCount: number,
      signal: AbortSignal,
    ): Promise<unknown>;
  }).waitForSubmissionAccepted;
  const controller = new AbortController();
  controller.abort();

  await expect(waitForSubmissionAccepted.call(
    {},
    {} as Page,
    {},
    {},
    {},
    0,
    0,
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
});

test("unrelated ChatGPT alerts are not terminal", async () => {
  const fixture = dialogPage("Your file was uploaded successfully");

  await throwIfChatGptTerminalErrorAlert(fixture.page);
  expect(fixture.pressed).toEqual([]);
});

function toolConfirmationPage(options: { disappearAfterReads?: number } = {}): {
  page: Page;
  pressed: string[];
} {
  let reads = 0;
  let visible = true;
  const pressed: string[] = [];
  const button = (name: string) => ({
    last: () => button(name),
    waitFor: async () => {},
    press: async (key: string) => {
      pressed.push(`${name}:${key}`);
      visible = false;
    },
  });
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
    getByRole: (_role: string, input: { name: string }) => button(input.name),
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("hidden");
      expect(visible).toBeFalse();
    },
  };
  return {
    page: { locator: () => dialog } as unknown as Page,
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

test("browser preflight separates model context from one-message transport limits", () => {
  const plus = { localToolsEnabled: false, solAvailable: true, proAvailable: false };
  const pro = { localToolsEnabled: false, solAvailable: true, proAvailable: true };
  const luna = { localToolsEnabled: false, solAvailable: false, proAvailable: false };

  expect(() => assertChatGptWebInputWithinLimits(90_000, 81_808, "gpt-5.6-sol", "medium", plus)).toThrow(
    "90,000-token context window",
  );
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

test("browser diagnostics redact context envelopes and capability values", () => {
  const diagnostic = redactChatGptUiDiagnostic(
    "<codex_context_json>private context</codex_context_json> turn_12345678901234567890 binding_12345678901234567890",
  );
  expect(diagnostic).not.toContain("private context");
  expect(diagnostic).not.toContain("12345678901234567890");
  expect(diagnostic).toContain("<codex_context_json>[redacted]</codex_context_json>");
});

test("browser failure diagnostics record composer structure and selection without prompt content", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain("childTextChars");
  expect(workerSource).toContain("anchorPath");
  expect(workerSource).toContain("focusPath");
  expect(workerSource).not.toContain("childTexts:");
  const promptReadback = workerSource.slice(
    workerSource.indexOf("private async attachedPromptText"),
    workerSource.indexOf("private async promptAttachmentSnapshot"),
  );
  expect(promptReadback).not.toContain("cloneNode(true)");
});

test("browser stage diagnostics use safe bounded artifact names", () => {
  expect(browserDiagnosticCheckpoint("effort menu / before click")).toBe("effort-menu-before-click");
  expect(browserDiagnosticCheckpoint("../turn_token secret")).toBe("turn_token-secret");
  expect(browserDiagnosticCheckpoint("x".repeat(200))).toHaveLength(80);
});

test("routine browser diagnostics avoid screenshots unless full capture is requested", () => {
  expect(browserDiagnosticIncludesScreenshot("send-ready", false)).toBeFalse();
  expect(browserDiagnosticIncludesScreenshot("response-visible", false)).toBeFalse();
  expect(browserDiagnosticIncludesScreenshot("response-stalled-30s", false)).toBeTrue();
  expect(browserDiagnosticIncludesScreenshot("turn-failed", false)).toBeTrue();
  expect(browserDiagnosticIncludesScreenshot("send-ready", true)).toBeTrue();
});

test("browser stage diagnostics preserve every critical local checkpoint", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  for (const checkpoint of [
    "browser-page-acquired",
    "temporary-chat-navigation-complete",
    "composer-ready",
    "session-verified",
    "effort-control-ready",
    "effort-menu-open-requested",
    "effort-selected",
    "connector-mention-triggered",
    "connector-menu-visible",
    "connector-menu-missing",
    "connector-selected",
    "prompt-attachment-complete",
    "file-attachment-complete",
    "send-ready",
    "send-accepted",
    "tool-confirmation-visible",
    "response-visible",
    "response-stalled-30s",
    "turn-completed",
    "turn-failed",
  ]) {
    expect(workerSource).toContain(`"${checkpoint}"`);
  }
  expect(workerSource).toContain('join(getConfigDir(), "diagnostics", "browser-turns")');
  expect(workerSource).toContain('page.screenshot({ animations: "disabled", caret: "hide"');
  expect(workerSource).toContain("atomicWriteFile(join(this.directory, `${stem}.png`), screenshot)");
  expect(workerSource).toContain("CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT = 10");
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

test("response DOM separates streaming commentary from the final Markdown answer", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain('const allMarkdownRoots = [...root.querySelectorAll<HTMLElement>(".markdown")]');
  expect(workerSource).toContain("const commentaryRoots = allMarkdownRoots.filter");
  expect(workerSource).toContain('candidate.closest("[data-streaming-response-status]") !== null');
  expect(workerSource).toContain("const renderedRoots = allMarkdownRoots.filter");
  expect(workerSource).toContain('fullHtml: renderedRoots.map(candidate => candidate.innerHTML).join("")');
  expect(workerSource).toContain("const markdownSegments = renderedRoots.flatMap");
  expect(workerSource).toContain('key: `${rootIndex}:${childIndex}:${tag}:${itemIndex}`');
  expect(workerSource).toContain("streamable: childIsComplete || itemIndex < listItems.length - 1");
  expect(workerSource).toContain("markdownBuffer.observe(snapshot.markdownSegments)");
  expect(workerSource).not.toContain("stableHtml:");
  expect(workerSource).not.toContain("observeStableHtml");
  expect(workerSource).toContain("const overlapsRenderedAnswer = (candidate: HTMLElement)");
  expect(workerSource).toContain("const statusSemantic = (candidate: HTMLElement)");
  expect(workerSource).toContain('candidate.closest<HTMLElement>("button") ?? candidate');
  expect(workerSource).toContain('candidate.querySelectorAll<HTMLElement>(".sr-only")');
  expect(workerSource).not.toContain("const adjacentCommentary");
  expect(workerSource).toContain('candidate.closest<HTMLElement>("[data-item-anchor]")');
  expect(workerSource).toContain("const traceByKey = new Map<string, ChatGptVisibleTraceBlock>()");
  expect(workerSource).toContain('block.kind === "commentary" ? { complete: index < blocks.length - 1 }');
  expect(workerSource).toContain('uiControl: candidate.matches("button")');
  expect(workerSource).toContain("!overlapsRenderedAnswer(semantic)");
  expect(workerSource).toContain("!overlapsRenderedAnswer(container)");
  expect(workerSource).not.toContain('fullHtml: rendered?.innerHTML ?? ""');
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
  expect(missingCompletionAction.update(completedWithoutMarker, 1_750)).toContain("DOM may have changed");
});

test("stalled-turn diagnostics record DOM metrics without response or overlay content", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const start = workerSource.indexOf("private async stalledTurnDiagnostic");
  const end = workerSource.indexOf("private async runExclusive", start);
  const diagnosticSource = workerSource.slice(start, end);
  expect(diagnosticSource).toContain("textChars:");
  expect(diagnosticSource).toContain("htmlChars:");
  expect(diagnosticSource).not.toMatch(/\btext:\s*(?:root|candidate)\.innerText/);
  expect(diagnosticSource).not.toMatch(/\bariaLabel:\s*candidate\.getAttribute/);
});

test("browser completion requires ChatGPT's response-scoped copy action", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/chatgpt-session.ts", import.meta.url), "utf8");
  expect(sessionSource).toContain('button[data-testid="copy-turn-action-button"]');
  expect(workerSource).toContain("CHATGPT_COMPLETION_ACTION_SELECTOR");
  expect(workerSource).not.toContain('root.querySelectorAll<HTMLElement>("button")');
});

test("browser send accepts only conclusive ChatGPT submission evidence", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
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
  expect(workerSource).toContain("waitForSubmissionAccepted");
  expect(workerSource).not.toContain("userTurns.nth(initialUserTurnCount).waitFor");
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
