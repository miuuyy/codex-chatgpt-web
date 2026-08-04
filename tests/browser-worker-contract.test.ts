import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ChatGptBrowserWorker, ChatGptTurnDomHealthTracker, ChatGptVisibleTraceTracker, MAX_CHATGPT_BROWSER_TABS, chatGptSubmissionEvidence, isChatGptTraceControl, redactChatGptUiDiagnostic } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_INTERNAL_COMPACTION_MARKER, containsChatGptCompactionMarker, stripChatGptTransportMarkers } from "../src/adapters/chatgpt-web/prompt";

test("Codex context uses the owned CDP composer transport, never the operating-system clipboard", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain('composer.fill("")');
  expect(workerSource).toContain("page.keyboard.insertText(prompt)");
  expect(workerSource).toContain("page.keyboard.insertText(` ${prompt}`)");
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
    capabilities: { localToolsEnabled: false, proAvailable: true },
    prepare: async () => ({ text: traceId, images: [], contextAttachment: null, release() {} }),
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

test("turn cancellation aborts the active file attachment stage", async () => {
  const controller = new AbortController();
  let attachmentAborted = false;
  const runStage = (ChatGptBrowserWorker.prototype as unknown as {
    runStage<T>(
      traceId: string,
      stage: string,
      timeoutMs: number,
      action: (signal: AbortSignal) => Promise<T>,
      turnAbortSignal?: AbortSignal,
    ): Promise<T>;
  }).runStage;

  const result = runStage.call(
    {},
    "trace_cancelled_upload",
    "file_attachment",
    60_000,
    async (signal) => await new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        attachmentAborted = true;
        reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
      }, { once: true });
    }),
    controller.signal,
  );
  controller.abort();

  await expect(result).rejects.toMatchObject({ name: "AbortError" });
  expect(attachmentAborted).toBeTrue();
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
  expect(workerSource.match(/this\.selectConnector\(page\)/g)?.length).toBe(2);
  expect(workerSource).toContain('composer.pressSequentially("@c", { delay: 25 })');
  expect(workerSource).toContain('page.locator(\'.__menu-item[tabindex="0"]\')');
  expect(workerSource).toContain('appResult.dispatchEvent("click")');
  expect(workerSource).not.toContain('composer.press("Enter")');
  expect(workerSource).toContain("this.selectedConnectorControl(selectedComposer)");
  expect(workerSource).toContain("'[data-id^=\"plugin:\"][data-keyword]'");
  expect(workerSource).toContain("const selectedComposer = await this.activeComposer(page)");
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

test("read-only multiline context is inserted atomically before exact verification", async () => {
  const prompt = `Act as the model backend for the Codex task encoded below.\n${"x".repeat(44_550)}`;
  const calls: Array<[string, string?]> = [];
  let asserted = "";
  const composer = {
    fill: async (value: string) => { calls.push(["fill", value]); },
    focus: async () => { calls.push(["focus"]); },
  };
  const page = {
    keyboard: {
      insertText: async (value: string) => { calls.push(["insertText", value]); },
    },
  };
  const attachPrompt = (ChatGptBrowserWorker.prototype as unknown as {
    attachPrompt(page: unknown, prompt: string, localTools: boolean): Promise<void>;
  }).attachPrompt;

  await attachPrompt.call({
    activeComposer: async () => composer,
    assertPromptAttached: async (_page: unknown, value: string) => { asserted = value; },
  }, page, prompt, false);

  expect(calls).toEqual([
    ["fill", ""],
    ["focus"],
    ["insertText", prompt],
  ]);
  expect(asserted).toBe(prompt);
});

test("connector selection re-resolves the active composer after ChatGPT replaces it", async () => {
  const calls: Array<[string, string?]> = [];
  let connectorSelected = false;
  const appResult = {
    waitFor: async () => { calls.push(["waitForResult"]); },
    count: async () => 1,
    dispatchEvent: async (event: string) => {
      expect(event).toBe("click");
      connectorSelected = true;
      calls.push(["dispatchResult", event]);
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
          expect(options).toEqual({ hasText: "Codex Native", visible: true });
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
      expect(text).toBe("Codex Native");
      expect(options).toEqual({ exact: true });
      return { exactConnectorLabel: true };
    },
    locator: (selector: string) => {
      if (selector.includes("__menu-item")) {
        return {
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
    config: { appName: "Codex Native" },
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
    ["dispatchResult", "click"],
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
    dispatchEvent: async () => {
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
      ? { filter: () => appResult }
      : (() => { throw new Error(`Unexpected locator: ${selector}`); })(),
  };
  const selectConnector = (ChatGptBrowserWorker.prototype as unknown as {
    selectConnector(page: unknown): Promise<unknown>;
  }).selectConnector;

  let activeComposerCalls = 0;
  await selectConnector.call({
    config: { appName: "Codex Native" },
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
    dispatchEvent: async () => {
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
      ? { filter: () => appResult }
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

  let activeComposerCalls = 0;
  await attachPrompt.call({
    config: { appName: "Codex Native" },
    selectConnector,
    connectorIsSelected: async () => selected,
    selectedConnectorControl: () => selectedConnector,
    activeComposer: async () => {
      activeComposerCalls += 1;
      return selected ? selectedComposer : initialComposer;
    },
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
    ["selectedFocus"],
    ["press", "End"],
    ["insertText", " context"],
    ["assertPrompt"],
  ]);
});

test("compaction attachment readiness uploads one document and image batch before sending", async () => {
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
      expect([
        "codex-compaction-context.txt",
        "codex-input-image-1.png",
      ]).toContain(options.name);
      expect(options.exact).toBe(true);
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
    contextAttachment: {
      name: "codex-compaction-context.txt",
      mimeType: "text/plain",
      text: "<codex_context_json>\n{}\n</codex_context_json>",
    },
    images: [{ ref: "codex-input-image-1", imageUrl }],
  });

  expect(calls).toEqual([
    ["inputReady"],
    ["setFiles", "codex-compaction-context.txt,codex-input-image-1.png"],
    ["fileTile", "codex-compaction-context.txt"],
    ["fileTile", "codex-input-image-1.png"],
    ["sendEnabled"],
  ]);
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).not.toContain('aria-label^="Remove file "');
});

test("compaction upload rejects when the document input rejects text/plain", async () => {
  let tileChecked = false;
  let sendChecked = false;
  const composerForm = {
    getByRole: () => {
      tileChecked = true;
      return { waitFor: async () => {} };
    },
    getByTestId: () => {
      sendChecked = true;
      return { isEnabled: async () => true };
    },
  };
  const composer = { locator: () => composerForm };
  const page = {
    locator: (selector: string) => selector === 'input[data-testid="upload-photos-input"]'
      ? {
        waitFor: async () => {},
        setInputFiles: async () => { throw new Error("text/plain upload rejected"); },
      }
      : { allInnerTexts: async () => [] },
  };
  const attachFiles = (ChatGptBrowserWorker.prototype as unknown as {
    attachFiles(page: unknown, prompt: unknown): Promise<void>;
  }).attachFiles;

  await expect(attachFiles.call({ activeComposer: async () => composer }, page, {
    text: "summarize",
    images: [],
    contextAttachment: {
      name: "codex-compaction-context.txt",
      mimeType: "text/plain",
      text: "<codex_context_json>\n{}\n</codex_context_json>",
    },
  })).rejects.toThrow("text/plain upload rejected");
  expect(tileChecked).toBeFalse();
  expect(sendChecked).toBeFalse();
});

test("compaction upload rejects an alert when the exact document tile never appears", async () => {
  let sendChecked = false;
  const composerForm = {
    getByRole: () => ({
      waitFor: async () => { throw new Error("tile timeout"); },
    }),
    getByTestId: () => {
      sendChecked = true;
      return { isEnabled: async () => true };
    },
  };
  const composer = { locator: () => composerForm };
  const page = {
    locator: (selector: string) => {
      if (selector === 'input[data-testid="upload-photos-input"]') {
        return { waitFor: async () => {}, setInputFiles: async () => {} };
      }
      if (selector === '[role="alert"]') {
        return { allInnerTexts: async () => ["Unsupported document type"] };
      }
      throw new Error(`unexpected selector: ${selector}`);
    },
  };
  const attachFiles = (ChatGptBrowserWorker.prototype as unknown as {
    attachFiles(page: unknown, prompt: unknown): Promise<void>;
  }).attachFiles;

  await expect(attachFiles.call({ activeComposer: async () => composer }, page, {
    text: "summarize",
    images: [],
    contextAttachment: {
      name: "codex-compaction-context.txt",
      mimeType: "text/plain",
      text: "<codex_context_json>\n{}\n</codex_context_json>",
    },
  })).rejects.toThrow("ChatGPT did not accept all prompt attachments: Unsupported document type");
  expect(sendChecked).toBeFalse();
});

test("compaction upload rejects before send when attachments never enable the message", async () => {
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => {
    now += 60_001;
    return now;
  };
  try {
    const composerForm = {
      getByRole: () => ({ waitFor: async () => {} }),
      getByTestId: () => ({ isEnabled: async () => false }),
    };
    const composer = { locator: () => composerForm };
    const page = {
      locator: (selector: string) => selector === 'input[data-testid="upload-photos-input"]'
        ? { waitFor: async () => {}, setInputFiles: async () => {} }
        : { allInnerTexts: async () => [] },
    };
    const attachFiles = (ChatGptBrowserWorker.prototype as unknown as {
      attachFiles(page: unknown, prompt: unknown): Promise<void>;
    }).attachFiles;

    await expect(attachFiles.call({ activeComposer: async () => composer }, page, {
      text: "summarize",
      images: [],
      contextAttachment: {
        name: "codex-compaction-context.txt",
        mimeType: "text/plain",
        text: "<codex_context_json>\n{}\n</codex_context_json>",
      },
    })).rejects.toThrow("did not make the message ready to send");
  } finally {
    Date.now = originalNow;
  }
});

test("effort selection uses structural menu indices instead of localized labels", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const sessionSource = readFileSync(new URL("../src/chatgpt-session.ts", import.meta.url), "utf8");
  expect(workerSource).toContain("mode.uiEffortIndex");
  expect(workerSource).toContain("CHATGPT_EFFORT_MENU_SELECTOR");
  expect(workerSource).toContain("CHATGPT_EFFORT_ITEM_SELECTOR");
  expect(workerSource).toContain('timeout: 70_000');
  expect(sessionSource).toContain('[role="menu"]:has([role="menuitemradio"])');
  expect(sessionSource).toContain('[role="group"]:has([role="menuitemradio"])');
  expect(sessionSource).toContain('[role="menuitemradio"]');
  expect(sessionSource).not.toContain(":popover-open");
  expect(sessionSource).not.toContain("data-radix-collection-item");
  expect(workerSource).toContain('getAttribute("aria-checked")');
  expect(workerSource).toContain('getAttribute("aria-expanded")');
  expect(workerSource).not.toContain("currentLabel === targetLabel");
  expect(workerSource).not.toContain("chatGptEffortLabelsMatch");
  expect(workerSource).not.toMatch(/getByRole\("button", \{\s*name: "(?:Instant|Medium|High|Extra High|Pro)"/);
});

test("browser diagnostics redact context envelopes and capability values", () => {
  const diagnostic = redactChatGptUiDiagnostic(
    "<codex_context_json>private context</codex_context_json> turn_12345678901234567890 binding_12345678901234567890",
  );
  expect(diagnostic).not.toContain("private context");
  expect(diagnostic).not.toContain("12345678901234567890");
  expect(diagnostic).toContain("<codex_context_json>[redacted]</codex_context_json>");
});

test("visible DOM trace emits statuses but leaves every Markdown root to the final answer stream", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const initialBlocks = [
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "markdown", text: "The implementation has a concrete state drift." },
  ] as const;
  expect(tracker.observe([...initialBlocks], false, 1_000)).toEqual([]);
  expect(tracker.observe([...initialBlocks], false, 1_100)).toEqual([
    { kind: "reasoning", text: "Reviewed architecture documentation" },
  ]);
  const commentaryBlocks = [
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "markdown", text: "The implementation has a concrete state drift." },
    { kind: "status", text: "Inspecting runtime evidence" },
    { kind: "markdown", text: "Final answer still streaming" },
  ] as const;
  expect(tracker.observe([...commentaryBlocks], false, 1_200)).toEqual([
  ]);
  expect(tracker.observe([...commentaryBlocks], false, 1_300)).toEqual([
    { kind: "reasoning", text: "Inspecting runtime evidence" },
  ]);
  expect(tracker.observe([
    { kind: "markdown", text: "Final answer complete" },
  ], true)).toEqual([]);
});

test("visible DOM trace never reclassifies growing Markdown as commentary", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const initial = [
    { kind: "markdown", text: "I’m reading" },
    { kind: "status", text: "Read context file contents" },
  ] as const;
  expect(tracker.observe([...initial], false, 1_000)).toEqual([]);
  const expanded = [
    { kind: "markdown", text: "I’m reading the repository’s mandatory architecture" },
    { kind: "status", text: "Read context file contents" },
  ] as const;
  expect(tracker.observe([...expanded], false, 1_050)).toEqual([]);
  expect(tracker.observe([...expanded], false, 1_100)).toEqual([
    { kind: "reasoning", text: "Read context file contents" },
  ]);
  expect(tracker.observe([...expanded], false, 1_150)).toEqual([]);
  expect(tracker.observe([...expanded], false, 1_250)).toEqual([]);
});

test("response DOM aggregation keeps every top-level Markdown root in the final answer", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).toContain('const renderedRoots = [...root.querySelectorAll<HTMLElement>(".markdown")]');
  expect(workerSource).toContain('fullHtml: renderedRoots.map(candidate => candidate.innerHTML).join("")');
  expect(workerSource).toContain('...renderedRoots.slice(0, -1).map(candidate => candidate.innerHTML)');
  expect(workerSource).not.toContain('fullHtml: rendered?.innerHTML ?? ""');
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

test("visible DOM trace translates the explicit ChatGPT compaction marker once", () => {
  const tracker = new ChatGptVisibleTraceTracker();
  expect(tracker.observe([
    { kind: "markdown", text: CHATGPT_INTERNAL_COMPACTION_MARKER },
  ], false)).toEqual([{ kind: "reasoning", text: "Context automatically compacted" }]);
  expect(tracker.observe([
    { kind: "status", text: CHATGPT_INTERNAL_COMPACTION_MARKER },
  ], false)).toEqual([]);
  expect(stripChatGptTransportMarkers(
    `Before\n\n${CHATGPT_INTERNAL_COMPACTION_MARKER}\n\nAfter`,
  )).toBe("Before\n\nAfter");
  const partial = "[[CODEX_INTERNAL_CONTEXT_COMPACT";
  expect(containsChatGptCompactionMarker(partial)).toBe(true);
  expect(stripChatGptTransportMarkers(partial)).toBe("");
  expect(new ChatGptVisibleTraceTracker().observe([
    { kind: "markdown", text: partial },
  ], false)).toEqual([{ kind: "reasoning", text: "Context automatically compacted" }]);
});

test("trace parsing excludes the Answer now UI control", () => {
  expect(isChatGptTraceControl({ kind: "status", text: "Answer now" })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "Reviewing repository invariants" })).toBe(false);
  expect(isChatGptTraceControl({ kind: "markdown", text: "Answer now" })).toBe(false);
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
