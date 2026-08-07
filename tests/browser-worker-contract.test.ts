import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { buildBrowserHelperBundle, watchBrowserHelperBundle } from "../scripts/build-browser-helper";
import { CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS, ChatGptBrowserWorker, ChatGptTurnDomHealthTracker, ChatGptVisibleTraceTracker, chatGptSubmissionEvidence, isChatGptTraceControl, redactChatGptUiDiagnostic } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_INTERNAL_COMPACTION_MARKER, CHATGPT_TASK_CONTEXT_FILENAME, containsChatGptCompactionMarker, stripChatGptTransportMarkers } from "../src/adapters/chatgpt-web/prompt";

const validContextAttachment = {
  name: CHATGPT_TASK_CONTEXT_FILENAME,
  mimeType: "text/plain" as const,
  text: [
    "<codex_context_json>",
    JSON.stringify({ version: 3, system: [], messages: [] }),
    "</codex_context_json>",
  ].join("\n"),
};

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

test("browser turns have no fixed application concurrency cap", async () => {
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
    prepare: async () => ({ text: traceId, images: [], contextAttachment: validContextAttachment, release() {} }),
    onTextDelta() {},
  });

  const active = Array.from({ length: 15 }, (_unused, index) => worker.run(browserTurn(`trace_${index + 1}`)));
  await Promise.resolve();
  expect(releases.size).toBe(15);
  await expect(worker.run(browserTurn("trace_1"))).rejects.toThrow("Duplicate ChatGPT web browser turn");
  for (const release of releases.values()) release();
  await Promise.all(active);
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

test("browser responses have no absolute wall-clock deadline", () => {
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).not.toContain("DEFAULT_CHATGPT_TURN_TIMEOUT_MS");
  expect(workerSource).not.toContain("ChatGPT web turn timed out");
  expect(workerSource).not.toContain("this.config.turnTimeoutMs");
  expect(workerSource).toContain("CHATGPT_RESPONSE_DOM_GRACE_MS");
  expect(workerSource).toContain("CHATGPT_EMPTY_RESPONSE_GRACE_MS");
  expect(workerSource).toContain("ChatGPT browser tab was closed");
  expect(workerSource).toContain("retry only when the recognized blocking dialog was");
  expect(workerSource).toContain("await this.waitForSubmissionAccepted(");
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
  expect(workerSource.match(/this\.selectConnector\(page/g)?.length).toBe(2);
  expect(workerSource).toContain('composer.pressSequentially("@c", { delay: 25 })');
  expect(workerSource).toContain('page.locator(\'.__menu-item[tabindex="0"]\')');
  expect(workerSource).toContain('appResult.dispatchEvent("click")');
  expect(workerSource).not.toContain('composer.press("Enter")');
  expect(workerSource).toContain("this.selectedConnectorControl(selectedComposer)");
  expect(workerSource).toContain("'[data-id^=\"plugin:\"][data-keyword]'");
  expect(workerSource).toContain("const selectedComposer = await this.activeComposer(page, 30_000, abortSignal)");
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

const attachmentMethods = ChatGptBrowserWorker.prototype as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>;

function attachmentWorker(activeComposer: () => Promise<unknown>): Record<string, unknown> {
  return {
    activeComposer,
    inspectFileInput: attachmentMethods.inspectFileInput,
    compatibleFileInput: attachmentMethods.compatibleFileInput,
    attachmentAlerts: attachmentMethods.attachmentAlerts,
    exactAttachmentTileVisible: attachmentMethods.exactAttachmentTileVisible,
    selectedInputFileNames: attachmentMethods.selectedInputFileNames,
    currentSendState: attachmentMethods.currentSendState,
    waitForPromptAttachmentsReady: attachmentMethods.waitForPromptAttachmentsReady,
  };
}

function genericFileInput(
  onSetFiles: (files: Array<{ name: string }>) => Promise<void> = async () => {},
): {
  input: Record<string, unknown>;
  inputs: Record<string, unknown>;
} {
  const element = {
    accept: ".txt,text/plain,image/*,application/zip,.zip",
    disabled: false,
    multiple: true,
    files: [] as Array<{ name: string }>,
    getAttribute: (name: string) => name === "data-testid" ? "upload-files-input" : null,
  };
  const input = {
    evaluate: async (callback: (target: typeof element) => unknown) => callback(element),
    setInputFiles: async (files: Array<{ name: string }>) => {
      element.files = files.map(file => ({ name: file.name }));
      await onSetFiles(files);
    },
  };
  return {
    input,
    inputs: {
      count: async () => 1,
      nth: () => input,
    },
  };
}

test("attachment readiness uploads the task document and carried images before sending", async () => {
  const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const calls: Array<[string, string?]> = [];
  const send = {
    isVisible: async () => true,
    isEnabled: async () => {
      calls.push(["sendEnabled"]);
      return true;
    },
    getAttribute: async () => null,
  };
  const composerForm = {
    getByRole: (role: string, options: { name: string; exact: boolean }) => {
      expect(role).toBe("group");
      expect(options.exact).toBe(true);
      return {
        isVisible: async () => {
          calls.push(["fileTile", options.name]);
          return true;
        },
      };
    },
    getByText: () => ({ isVisible: async () => false }),
    getByTestId: (testId: string) => {
      expect(testId).toBe("send-button");
      return send;
    },
    locator: (selector: string) => {
      expect(selector).toBe('input[type="file"]');
      return inputs;
    },
  };
  const composer = {
    locator: (selector: string) => {
      expect(selector).toBe("xpath=ancestor::form[1]");
      return composerForm;
    },
  };
  const { inputs } = genericFileInput(async files => {
      calls.push(["setFiles", files.map(file => file.name).join(",")]);
  });
  const page = {
    locator: (selector: string) => {
      if (selector === '[role="alert"]') {
        return { allInnerTexts: async () => [] };
      }
      if (selector === 'input[type="file"]') return inputs;
      throw new Error(`unexpected selector: ${selector}`);
    },
  };
  const attachFiles = (ChatGptBrowserWorker.prototype as unknown as {
    attachFiles(page: unknown, prompt: unknown): Promise<void>;
  }).attachFiles;

  await attachFiles.call(attachmentWorker(async () => composer), page, {
    text: "summarize with the attached context",
    contextAttachment: validContextAttachment,
    images: [{ ref: "codex-input-image-1", imageUrl }],
  });

  expect(calls).toEqual([
    ["setFiles", `${CHATGPT_TASK_CONTEXT_FILENAME},codex-input-image-1.png`],
    ["fileTile", CHATGPT_TASK_CONTEXT_FILENAME],
    ["fileTile", "codex-input-image-1.png"],
    ["sendEnabled"],
  ]);
  const workerSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  expect(workerSource).not.toContain('aria-label^="Remove file "');
});

test("attachment readiness re-resolves the composer form after upload replacement", async () => {
  let composerPolls = 0;
  const form = (enabled: boolean) => ({
    getByRole: () => ({ waitFor: async () => {} }),
    getByTestId: () => ({ isEnabled: async () => enabled }),
  });
  const forms = [form(false), form(true)];
  const activeComposer = async () => ({
    locator: () => forms[Math.min(composerPolls++, forms.length - 1)],
  });
  const page = {
    locator: () => ({ allInnerTexts: async () => [] }),
  };
  const input = {};
  const waitForPromptAttachmentsReady = attachmentMethods.waitForPromptAttachmentsReady as (
    page: unknown,
    input: unknown,
    files: unknown[],
  ) => Promise<void>;

  await waitForPromptAttachmentsReady.call(
    attachmentWorker(activeComposer),
    page,
    input,
    [{ name: CHATGPT_TASK_CONTEXT_FILENAME, mimeType: "text/plain", buffer: Buffer.from("context") }],
  );

  expect(composerPolls).toBe(2);
});

test("upload rejects when the generic input rejects the coherent batch", async () => {
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
  const { inputs } = genericFileInput(async () => { throw new Error("file upload rejected"); });
  const composer = {
    locator: (selector: string) => selector === "xpath=ancestor::form[1]"
      ? { ...composerForm, locator: () => inputs }
      : undefined,
  };
  const page = {
    locator: (selector: string) => selector === 'input[type="file"]'
      ? inputs
      : { allInnerTexts: async () => [] },
  };
  const attachFiles = (ChatGptBrowserWorker.prototype as unknown as {
    attachFiles(page: unknown, prompt: unknown): Promise<void>;
  }).attachFiles;

  await expect(attachFiles.call(attachmentWorker(async () => composer), page, {
    text: "summarize",
    images: [{ ref: "codex-input-image-1", imageUrl: "data:image/png;base64,aGVsbG8=" }],
    contextAttachment: validContextAttachment,
  })).rejects.toThrow("file upload rejected");
  expect(tileChecked).toBeFalse();
  expect(sendChecked).toBeFalse();
});

test("upload rejects an alert when the exact attachment tiles never appear", async () => {
  let sendChecked = false;
  const composerForm = {
    getByRole: () => ({
      isVisible: async () => false,
    }),
    getByText: () => ({ isVisible: async () => false }),
    getByTestId: () => {
      sendChecked = true;
      return { isEnabled: async () => true };
    },
  };
  const { inputs } = genericFileInput();
  const composer = {
    locator: () => ({ ...composerForm, locator: () => inputs }),
  };
  const page = {
    locator: (selector: string) => {
      if (selector === 'input[type="file"]') return inputs;
      if (selector === '[role="alert"]') {
        return { allInnerTexts: async () => ["Unsupported file type"] };
      }
      throw new Error(`unexpected selector: ${selector}`);
    },
  };
  const attachFiles = (ChatGptBrowserWorker.prototype as unknown as {
    attachFiles(page: unknown, prompt: unknown): Promise<void>;
  }).attachFiles;

  await expect(attachFiles.call(attachmentWorker(async () => composer), page, {
    text: "summarize",
    images: [{ ref: "codex-input-image-1", imageUrl: "data:image/png;base64,aGVsbG8=" }],
    contextAttachment: validContextAttachment,
  })).rejects.toThrow("ChatGPT did not accept all prompt attachments: Unsupported file type");
  expect(sendChecked).toBeFalse();
});

test("upload rejects before send when attachments never enable the message", async () => {
  const originalNow = Date.now;
  let now = Date.UTC(2024, 0, 2, 0, 0, 0, 0);
  Date.now = () => {
    now += 61_001;
    return now;
  };
  try {
    const composerForm = {
      getByRole: () => ({ waitFor: async () => {} }),
      getByTestId: () => ({ isEnabled: async () => false }),
    };
    const { inputs } = genericFileInput();
    const composer = { locator: () => ({ ...composerForm, locator: () => inputs }) };
    const page = {
      locator: (selector: string) => selector === 'input[type="file"]'
        ? inputs
        : { allInnerTexts: async () => [] },
    };
    const attachFiles = (ChatGptBrowserWorker.prototype as unknown as {
      attachFiles(page: unknown, prompt: unknown): Promise<void>;
    }).attachFiles;

    await expect(attachFiles.call(attachmentWorker(async () => composer), page, {
      text: "summarize",
      images: [{ ref: "codex-input-image-1", imageUrl: "data:image/png;base64,aGVsbG8=" }],
      contextAttachment: validContextAttachment,
    })).rejects.toThrow("did not make the message ready to send");
  } finally {
    Date.now = originalNow;
  }
});

test("attachment readiness stops immediately when its stage is cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const waitForPromptAttachmentsReady = attachmentMethods.waitForPromptAttachmentsReady as (
    page: unknown,
    input: unknown,
    files: unknown[],
    signal: AbortSignal,
  ) => Promise<void>;
  await expect(waitForPromptAttachmentsReady.call(
    attachmentWorker(async () => { throw new Error("must not resolve composer"); }),
    {},
    {},
[{ name: CHATGPT_TASK_CONTEXT_FILENAME, mimeType: "text/plain", buffer: Buffer.from("context") }],
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
});

test("file mounting revalidates the complete composer state before send", () => {
  const source = readFileSync(
    new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url),
    "utf8",
  );
  const fileStage = source.indexOf('"file_attachment"');
  const attachments = source.indexOf("this.ensureFilesAttached(page, prepared", fileStage);
  const composerState = source.indexOf("this.ensurePromptAndConnector(page, prepared.text", attachments);
  const sendStage = source.indexOf('"send"', composerState);
  expect(fileStage).toBeGreaterThan(-1);
  expect(attachments).toBeGreaterThan(fileStage);
  expect(composerState).toBeGreaterThan(attachments);
  expect(sendStage).toBeGreaterThan(composerState);
});

type TransientRecoveryState = {
  dismissals: number;
  pickerNeedsResync: boolean;
  modelNeedsVerification: boolean;
  lastFingerprint?: string;
  lastDismissedAt?: number;
  persistentStreak?: number;
  cooldownMs?: number;
  graceMs?: number;
};

const transientRecovery = (ChatGptBrowserWorker.prototype as unknown as {
  recoverTransientLimitDialogs(
    page: unknown,
    recovery: TransientRecoveryState,
    abortSignal: AbortSignal | undefined,
    stage: string,
    pickerMode?: "defer" | "open" | "close" | "best-effort-close",
  ): Promise<boolean>;
}).recoverTransientLimitDialogs;

function recognizedTransientDialog(fingerprint: string, onClick: () => void): { kind: "recognized"; fingerprint: string; dialog: unknown } {
  return {
    kind: "recognized",
    fingerprint,
    dialog: {
      locator: () => ({
        filter: () => ({
          first: () => ({
            evaluate: async () => { onClick(); },
          }),
        }),
      }),
    },
  };
}

function inspectionWorker(inspections: Array<{
  kind: "recognized" | "none" | "ambiguous";
  fingerprint?: string;
  dialog?: unknown;
  diagnostic?: string;
}>, pickerResyncs: { count: number }) {
  return {
    inspectTransientLimitDialog: async () => {
      const next = inspections.shift() ?? { kind: "none" };
      if (next.kind === "none") return { kind: "none" };
      if (next.kind === "ambiguous") return { kind: "ambiguous", diagnostic: next.diagnostic ?? "two buttons" };
      return { kind: "recognized", dialog: next.dialog, fingerprint: next.fingerprint };
    },
    resynchronizeEffortPicker: async () => {
      pickerResyncs.count += 1;
      return true;
    },
  };
}

test("transient recovery dismisses sequential matching dialogs and resynchronizes the picker once", async () => {
  let clicks = 0;
  const pickerResyncs = { count: 0 };
  // Each recognized dialog is followed by a `none` frame: the click verified the dialog closed.
  const dialog1 = recognizedTransientDialog("rate-limit #1", () => { clicks += 1; });
  const dialog2 = recognizedTransientDialog("rate-limit #2", () => { clicks += 1; });
  const worker = inspectionWorker([
    { kind: "recognized", fingerprint: "rate-limit #1", dialog: dialog1.dialog },
    { kind: "none" },
    { kind: "recognized", fingerprint: "rate-limit #2", dialog: dialog2.dialog },
    { kind: "none" },
    { kind: "none" },
  ], pickerResyncs);
  const recovery: TransientRecoveryState = {
    dismissals: 0,
    pickerNeedsResync: false,
    modelNeedsVerification: false,
    cooldownMs: 0,
  };

  expect(await transientRecovery.call(
    worker,
    { isClosed: () => false },
    recovery,
    undefined,
    "test stage",
    "close",
  )).toBeTrue();
  expect(clicks).toBe(2);
  expect(pickerResyncs.count).toBe(1);
  expect(recovery).toEqual({
    dismissals: 2,
    pickerNeedsResync: false,
    modelNeedsVerification: true,
    lastFingerprint: "rate-limit #2",
    lastDismissedAt: expect.any(Number) as number,
    persistentStreak: 0,
    cooldownMs: 0,
  } satisfies TransientRecoveryState);
});

test("transient recovery never counts an un-closed dialog as a dismissal; it escalates a persistence streak to a typed error", async () => {
  let clicks = 0;
  const pickerResyncs = { count: 0 };
  // A dialog that re-mounts on every frame (click never closes it): zero dismissals counted,
  // and a persistence streak of the same fingerprint escalates to the typed transient-limit error.
  const dialog = recognizedTransientDialog("same", () => { clicks += 1; });
  const worker = inspectionWorker([
    { kind: "recognized", fingerprint: "same", dialog: dialog.dialog },
    { kind: "recognized", fingerprint: "same", dialog: dialog.dialog },
    { kind: "recognized", fingerprint: "same", dialog: dialog.dialog },
    { kind: "recognized", fingerprint: "same", dialog: dialog.dialog },
    { kind: "recognized", fingerprint: "same", dialog: dialog.dialog },
  ], pickerResyncs);
  const recovery: TransientRecoveryState = {
    dismissals: 0,
    pickerNeedsResync: false,
    modelNeedsVerification: false,
    cooldownMs: 1,
    graceMs: 60_000,
  };

  await expect(transientRecovery.call(
    worker,
    { isClosed: () => false },
    recovery,
    undefined,
    "test stage",
    "close",
  )).rejects.toThrow("persisted during test stage");
  expect(clicks).toBe(1);
  expect(recovery.dismissals).toBe(0);
  expect(recovery.persistentStreak).toBeGreaterThanOrEqual(3);
});

test("transient recovery never activates an unrelated or ambiguous dialog", async () => {
  let pickerResyncs = 0;
  const recovery: TransientRecoveryState = {
    dismissals: 0,
    pickerNeedsResync: false,
    modelNeedsVerification: false,
  };
  const worker = {
    inspectTransientLimitDialog: async () => ({ kind: "ambiguous", diagnostic: "two buttons" }),
    resynchronizeEffortPicker: async () => {
      pickerResyncs += 1;
      return true;
    },
  };

  await expect(transientRecovery.call(
    worker,
    { isClosed: () => false },
    recovery,
    undefined,
    "test stage",
    "close",
  )).rejects.toThrow("refusing to activate it");
  expect(recovery.dismissals).toBe(0);
  expect(pickerResyncs).toBe(0);
});

test("transient recovery refuses activation once the dismissal cap is spent", async () => {
  let clicks = 0;
  const dialog = recognizedTransientDialog("distinct", () => { clicks += 1; });
  const recovery: TransientRecoveryState = {
    dismissals: CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS,
    pickerNeedsResync: false,
    modelNeedsVerification: false,
    cooldownMs: 0,
  };
  const worker = {
    inspectTransientLimitDialog: async () => ({ kind: "recognized", fingerprint: "distinct", dialog }),
    resynchronizeEffortPicker: async () => true,
  };

  await expect(transientRecovery.call(
    worker,
    { isClosed: () => false },
    recovery,
    undefined,
    "test stage",
    "close",
  )).rejects.toThrow("persisted during test stage");
  expect(clicks).toBe(0);
  expect(recovery.dismissals).toBe(CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS);
});

test("transient recovery is abort-safe and page-close-safe", async () => {
  let inspections = 0;
  const worker = {
    inspectTransientLimitDialog: async () => {
      inspections += 1;
      return { kind: "none" };
    },
    resynchronizeEffortPicker: async () => true,
  };
  const recovery = (): TransientRecoveryState => ({
    dismissals: 0,
    pickerNeedsResync: false,
    modelNeedsVerification: false,
  });
  const controller = new AbortController();
  controller.abort();

  await expect(transientRecovery.call(
    worker,
    { isClosed: () => false },
    recovery(),
    controller.signal,
    "test stage",
  )).rejects.toMatchObject({ name: "AbortError" });
  await expect(transientRecovery.call(
    worker,
    { isClosed: () => true },
    recovery(),
    undefined,
    "test stage",
  )).rejects.toThrow("browser tab was closed");
  expect(inspections).toBe(0);
});

test("transient dialog recognition accepts the observed unfocused single-action limit dialog", async () => {
  const inspectTransientLimitDialog = (ChatGptBrowserWorker.prototype as unknown as {
    inspectTransientLimitDialog(page: unknown): Promise<{ kind: string; dialog?: unknown; fingerprint?: string }>;
  }).inspectTransientLimitDialog;
  const button = {
    disabled: false,
    innerText: "Got it",
    getAttribute: () => null,
    getClientRects: () => [{}],
    contains: () => false,
  };
  const dialog = {
    innerText: "Too many requests. You are making requests too quickly. We temporarily limited access to protect your data. Please wait a few minutes before trying again.",
    getAttribute: (name: string) => name === "role" ? "dialog" : null,
    getBoundingClientRect: () => ({ left: 300, top: 275, width: 400, height: 250 }),
    getClientRects: () => [{}],
    contains: (element: unknown) => element === dialog,
    querySelectorAll: (selector: string) => {
      if (selector === "button" || selector.includes("button:not([disabled])")) return [button];
      return [];
    },
  };
  const saved = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    getComputedStyle: Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle"),
    innerHeight: Object.getOwnPropertyDescriptor(globalThis, "innerHeight"),
    innerWidth: Object.getOwnPropertyDescriptor(globalThis, "innerWidth"),
  };
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: { activeElement: null, elementFromPoint: () => dialog } },
    getComputedStyle: { configurable: true, value: () => ({ display: "block", visibility: "visible" }) },
    innerHeight: { configurable: true, value: 800 },
    innerWidth: { configurable: true, value: 1_000 },
  });
  try {
    const dialogLocator = {
      evaluateAll: async (callback: (elements: unknown[]) => unknown) => callback([dialog]),
      nth: () => dialog,
    };
    const result = await inspectTransientLimitDialog.call({
      locator: () => dialogLocator,
    }, {
      locator: () => dialogLocator,
    });
    expect(result).toEqual({
      kind: "recognized",
      dialog,
      fingerprint: "Too many requests. You are making requests too quickly. We temporarily limited access to protect your data. Please wait a few minutes before trying again.|Got it",
    });
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});

test("transient dialog recognition rejects unrelated and capacity single-action dialogs", async () => {
  const inspectTransientLimitDialog = (ChatGptBrowserWorker.prototype as unknown as {
    inspectTransientLimitDialog(page: unknown): Promise<{ kind: string; diagnostic?: string }>;
  }).inspectTransientLimitDialog;
  const button = {
    disabled: false,
    innerText: "Continue",
    getAttribute: () => null,
    getClientRects: () => [{}],
    contains: (element: unknown) => element === button,
  };
  const dialog = {
    innerText: "This action changes your current workspace settings and may affect future conversations. Review the choice before continuing.",
    getAttribute: (name: string) => name === "role" ? "dialog" : null,
    getBoundingClientRect: () => ({ left: 300, top: 275, width: 400, height: 250 }),
    getClientRects: () => [{}],
    contains: (element: unknown) => element === dialog,
    querySelectorAll: (selector: string) => {
      if (selector === "button" || selector.includes("button:not([disabled])")) return [button];
      return [];
    },
  };
  const saved = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    getComputedStyle: Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle"),
    innerHeight: Object.getOwnPropertyDescriptor(globalThis, "innerHeight"),
    innerWidth: Object.getOwnPropertyDescriptor(globalThis, "innerWidth"),
  };
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: { activeElement: button, elementFromPoint: () => dialog } },
    getComputedStyle: { configurable: true, value: () => ({ display: "block", visibility: "visible" }) },
    innerHeight: { configurable: true, value: 800 },
    innerWidth: { configurable: true, value: 1_000 },
  });
  try {
    const dialogLocator = {
      evaluateAll: async (callback: (elements: unknown[]) => unknown) => callback([dialog]),
      nth: () => dialog,
    };
    const result = await inspectTransientLimitDialog.call({
      locator: () => dialogLocator,
    }, {
      locator: () => dialogLocator,
    });
    expect(result.kind).toBe("ambiguous");
    expect(result.diagnostic).toContain('"activeOnOnlyButton":true');
    expect(result.diagnostic).toContain('"rateLimitText":false');

    dialog.innerText = "Selected model is at capacity. Please try a different model.";
    const capacityResult = await inspectTransientLimitDialog.call({
      locator: () => dialogLocator,
    }, {
      locator: () => dialogLocator,
    });
    expect(capacityResult.kind).toBe("ambiguous");
    expect(capacityResult.diagnostic).toContain('"rateLimitText":false');
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});

test("minified transient dialog inspection is self-contained in the browser realm", async () => {
  const outputRoot = resolve("output", "browser-worker-contract");
  mkdirSync(outputRoot, { recursive: true });
  const root = mkdtempSync(join(outputRoot, "browser-realm-"));
  const entrypoint = join(root, "entry.ts");
  const bundle = join(root, "browser-realm.cjs");
  const workerUrl = pathToFileURL(resolve("src", "adapters", "chatgpt-web", "browser-worker.ts")).href;
  writeFileSync(entrypoint, [
    `import { ChatGptBrowserWorker } from ${JSON.stringify(workerUrl)};`,
    "export const inspectTransientLimitDialog = ChatGptBrowserWorker.prototype.inspectTransientLimitDialog;",
  ].join("\n"));

  const evaluateDialogCallback = (callback: (elements: unknown[]) => unknown): unknown => runInNewContext(`
    (() => {
      const button = {
        disabled: false,
        innerText: "Got it",
        getAttribute: () => null,
        getClientRects: () => [{}],
        contains: () => false,
      };
      const dialog = {
        innerText: "Too many requests. You are making requests too quickly. We temporarily limited access to protect your data. Please wait a few minutes before trying again.",
        getAttribute: name => name === "role" ? "dialog" : null,
        getBoundingClientRect: () => ({ left: 300, top: 275, width: 400, height: 250 }),
        getClientRects: () => [{}],
        contains: element => element === dialog,
        querySelectorAll: selector => selector === "button" || selector.includes("button:not([disabled])") ? [button] : [],
      };
      globalThis.document = { activeElement: null, elementFromPoint: () => dialog };
      globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
      globalThis.innerHeight = 800;
      globalThis.innerWidth = 1000;
      return (${callback.toString()})([dialog]);
    })()
  `);

  try {
    const P1 = (text: string): boolean => text.toLowerCase().includes("too many requests");
    expect(() => evaluateDialogCallback(elements => elements.map(element => ({
      rateLimitText: P1((element as { innerText: string }).innerText),
    })))).toThrow("P1 is not defined");

    await buildBrowserHelperBundle(entrypoint, bundle);
    const loaded = createRequire(import.meta.url)(bundle) as {
      inspectTransientLimitDialog(
        this: unknown,
        page: unknown,
      ): Promise<{ kind: string; dialog?: unknown; fingerprint?: string }>;
    };
    const dialogLocator = {
      evaluateAll: async (callback: (elements: unknown[]) => unknown) => evaluateDialogCallback(callback),
      nth: () => "recognized-dialog",
    };
    const result = await loaded.inspectTransientLimitDialog.call({}, {
      locator: () => dialogLocator,
    });
    expect(result).toEqual({
      kind: "recognized",
      dialog: "recognized-dialog",
      fingerprint: "Too many requests. You are making requests too quickly. We temporarily limited access to protect your data. Please wait a few minutes before trying again.|Got it",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser helper watch mode rebuilds the minified artifact", async () => {
  const outputRoot = resolve("output", "browser-worker-contract");
  mkdirSync(outputRoot, { recursive: true });
  const root = mkdtempSync(join(outputRoot, "browser-watch-"));
  const entrypoint = join(root, "entry.ts");
  const bundle = join(root, "browser-watch.cjs");
  const controller = new AbortController();
  let watchFailure: unknown;
  writeFileSync(entrypoint, 'export const helperVersion = "v1";\n');
  const watcher = watchBrowserHelperBundle(entrypoint, bundle, controller.signal).catch(error => {
    watchFailure = error;
    return -1;
  });
  const waitForBundleText = async (text: string): Promise<void> => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (watchFailure) throw watchFailure;
      try {
        if (readFileSync(bundle, "utf8").includes(text)) return;
      } catch {}
      await new Promise(resolveSleep => setTimeout(resolveSleep, 25));
    }
    throw new Error(`Browser helper watcher did not emit ${text}`);
  };

  try {
    await waitForBundleText("v1");
    writeFileSync(entrypoint, 'export const helperVersion = "v2";\n');
    await waitForBundleText("v2");
  } finally {
    controller.abort();
    await watcher;
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);

test("transient dialog recognition accepts ChatGPT dialogs without aria-modal", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const start = source.indexOf("private async inspectTransientLimitDialog");
  const end = source.indexOf("private async resynchronizeEffortPicker", start);
  const recognition = source.slice(start, end);
  expect(recognition).toContain('descriptor.ariaModal !== "false"');
  expect(recognition).not.toContain('descriptor.ariaModal === "true"');
  expect(recognition).toContain("descriptor.buttonCount === 1");
  expect(recognition).toContain("descriptor.focusableCount === 1");
  expect(recognition).toContain("activeOnOnlyButton");
  expect(recognition).toContain("&& descriptor.rateLimitText");
  expect(recognition).not.toContain("descriptor.activeOnOnlyButton || descriptor.rateLimitText");
  expect(recognition).not.toContain("Too many requests");
  expect(recognition).not.toContain("Got it");
});

test("dialog inspection survives a page that replaced Array.prototype methods", async () => {
  const inspectTransientLimitDialog = (ChatGptBrowserWorker.prototype as unknown as {
    inspectTransientLimitDialog(page: unknown): Promise<{ kind: string; dialog?: unknown; fingerprint?: string }>;
  }).inspectTransientLimitDialog;
  const button = {
    disabled: false,
    innerText: "Got it",
    getAttribute: () => null,
    getClientRects: () => [{}],
    contains: () => false,
  };
  const dialog = {
    innerText: "Too many requests. You are making requests too quickly. We temporarily limited access to protect your data. Please wait a few minutes before trying again.",
    getAttribute: (name: string) => name === "role" ? "dialog" : null,
    getBoundingClientRect: () => ({ left: 300, top: 275, width: 400, height: 250 }),
    getClientRects: () => [{}],
    contains: (element: unknown) => element === dialog,
    querySelectorAll: (selector: string) => {
      if (selector === "button" || selector.includes("button:not([disabled])")) return [button];
      return [];
    },
  };
  const saved = {
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    getComputedStyle: Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle"),
    innerHeight: Object.getOwnPropertyDescriptor(globalThis, "innerHeight"),
    innerWidth: Object.getOwnPropertyDescriptor(globalThis, "innerWidth"),
  };
  const patchedArrayMethod = (): never => {
    throw new ReferenceError("P1 is not defined");
  };
  const patchedMethods = [
    "map",
    "filter",
    "forEach",
    "find",
    "findIndex",
    "some",
    "every",
    "reduce",
    "flatMap",
    "sort",
    "slice",
    "at",
  ] as const;
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: { activeElement: null, elementFromPoint: () => dialog } },
    getComputedStyle: { configurable: true, value: () => ({ display: "block", visibility: "visible" }) },
    innerHeight: { configurable: true, value: 800 },
    innerWidth: { configurable: true, value: 1_000 },
  });
  try {
    const savedMethods = new Map<string, unknown>();
    for (const name of patchedMethods) savedMethods.set(name, Array.prototype[name]);
    // Simulate a ChatGPT page that replaced the array methods while the evaluateAll callback
    // executes in page context. The callback must not rely on any of them.
    const dialogLocator = {
      evaluateAll: async (callback: (elements: unknown[]) => unknown) => {
        for (const name of patchedMethods) {
          Object.defineProperty(Array.prototype, name, {
            configurable: true,
            writable: true,
            value: patchedArrayMethod,
          });
        }
        try {
          return callback([dialog]);
        } finally {
          for (const name of patchedMethods) {
            Object.defineProperty(Array.prototype, name, {
              configurable: true,
              writable: true,
              value: savedMethods.get(name),
            });
          }
        }
      },
      nth: () => dialog,
    };
    const result = await inspectTransientLimitDialog.call({
      locator: () => dialogLocator,
    }, {
      locator: () => dialogLocator,
    });
    expect(result).toEqual({
      kind: "recognized",
      dialog,
      fingerprint: "Too many requests. You are making requests too quickly. We temporarily limited access to protect your data. Please wait a few minutes before trying again.|Got it",
    });
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});

test("dialog inspection degrades to ambiguous instead of throwing when probes fail", async () => {
  const inspectTransientLimitDialog = (ChatGptBrowserWorker.prototype as unknown as {
    inspectTransientLimitDialog(page: unknown): Promise<{ kind: string; dialog?: unknown; fingerprint?: string }>;
  }).inspectTransientLimitDialog;
  const dialogLocator = {
    evaluateAll: async () => { throw new ReferenceError("P1 is not defined"); },
    nth: () => undefined,
  };
  const result = await inspectTransientLimitDialog.call({
    locator: () => dialogLocator,
  }, {
    locator: () => dialogLocator,
  });
  expect(result).toMatchObject({ kind: "ambiguous" });
  expect((result as unknown as { diagnostic: string }).diagnostic).toContain("dialog inspection failed");
});

test("composer recovery is postcondition-driven and never duplicates an exact prompt", async () => {
  const ensurePromptAndConnector = (ChatGptBrowserWorker.prototype as unknown as {
    ensurePromptAndConnector(
      page: unknown,
      prompt: string,
      localTools: boolean,
      recovery: TransientRecoveryState,
      abortSignal?: AbortSignal,
    ): Promise<void>;
  }).ensurePromptAndConnector;
  let repairs = 0;
  const prompt = "complete prompt";
  const worker = {
    recoverTransientLimitDialogs: async () => false,
    activeComposer: async () => ({}),
    attachedPromptText: async () => prompt,
    connectorIsSelected: async () => true,
    attachPrompt: async () => { repairs += 1; },
  };

  await ensurePromptAndConnector.call(
    worker,
    { isClosed: () => false },
    prompt,
    true,
    { dismissals: 0, pickerNeedsResync: false, modelNeedsVerification: false },
  );
  expect(repairs).toBe(0);
});

test("attachment recovery does not upload files whose exact tiles already exist", async () => {
  const ensureFilesAttached = (ChatGptBrowserWorker.prototype as unknown as {
    ensureFilesAttached(
      page: unknown,
      prompt: unknown,
      recovery: TransientRecoveryState,
      abortSignal?: AbortSignal,
    ): Promise<void>;
  }).ensureFilesAttached;
  let uploads = 0;
  let readinessChecks = 0;
  const worker = {
    recoverTransientLimitDialogs: async () => false,
    attachmentTileState: async () => ({ visible: 1, total: 1 }),
    waitForPromptAttachmentsReady: async () => { readinessChecks += 1; },
    attachFiles: async () => { uploads += 1; },
  };

  await ensureFilesAttached.call(
    worker,
    { isClosed: () => false },
    { text: "prompt", images: [], contextAttachment: validContextAttachment },
    { dismissals: 0, pickerNeedsResync: false, modelNeedsVerification: false },
  );
  expect(uploads).toBe(0);
  expect(readinessChecks).toBe(1);
});

test("submission evidence observed after popup recovery permanently closes the retry branch", async () => {
  const waitForSubmissionAccepted = (ChatGptBrowserWorker.prototype as unknown as {
    waitForSubmissionAccepted(
      page: unknown,
      userTurns: unknown,
      responseTurns: unknown,
      initialUserTurnCount: number,
      initialResponseTurnCount: number,
      recovery: TransientRecoveryState,
      abortSignal?: AbortSignal,
    ): Promise<unknown>;
  }).waitForSubmissionAccepted;
  const evidence = [undefined, "user_turn"];
  let recoveries = 0;
  const worker = {
    currentSubmissionEvidence: async () => evidence.shift(),
    recoverTransientLimitDialogs: async () => {
      recoveries += 1;
      return true;
    },
  };

  expect(await waitForSubmissionAccepted.call(
    worker,
    { isClosed: () => false },
    {},
    {},
    0,
    0,
    { dismissals: 0, pickerNeedsResync: false, modelNeedsVerification: false },
  )).toBe("user_turn");
  expect(recoveries).toBe(1);
});

test("submission acknowledgement retries only after a recognized dialog was dismissed", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const start = source.indexOf("private async waitForSubmissionAccepted");
  const end = source.indexOf("private async waitForSubmissionEvidenceWithoutRetry", start);
  const acknowledgement = source.slice(start, end);
  expect(acknowledgement).toContain("recoverTransientLimitDialogs");
  expect(acknowledgement).toContain('return evidenceAfterRecovery ?? "transient_interruption"');
  expect(acknowledgement).not.toContain("activationProbeDeadline");
  expect(acknowledgement).not.toContain("attachedPromptText");
  expect(acknowledgement).not.toContain("currentSendState");
});

test("ambiguous post-send acknowledgement waits without a deadline or resend", () => {
  const source = readFileSync(new URL("../src/adapters/chatgpt-web/browser-worker.ts", import.meta.url), "utf8");
  const start = source.indexOf("private async waitForSubmissionEvidenceWithoutRetry");
  const end = source.indexOf("private async attachedPromptText", start);
  const acknowledgement = source.slice(start, end);
  expect(acknowledgement).toContain("for (;;)");
  expect(acknowledgement).not.toContain("Date.now()");
  expect(acknowledgement).not.toContain("CHATGPT_RESPONSE_DOM_GRACE_MS");
  expect(acknowledgement).not.toContain("sendButton");
});

async function runEffortPickerScenario(options: {
  initiallyOpen: boolean;
  firstPressOpens: boolean;
  abortBeforeRecovery?: boolean;
  replaceMenuAfterVisible?: boolean;
}): Promise<{
  uiEffortIndex: number | undefined;
  errorName: string | undefined;
  controlPresses: number;
  pointerClicks: number;
  keyboardPresses: string[];
}> {
  let menuOpen = options.initiallyOpen;
  let controlPresses = 0;
  let pointerClicks = 0;
  let choiceWaits = 0;
  let menuReplaced = false;
  const keyboardPresses: string[] = [];
  const controller = new AbortController();
  const timeoutError = (): Error => Object.assign(new Error("picker stayed closed"), { name: "TimeoutError" });

  const effortChoice = {
    waitFor: async () => {
      choiceWaits += 1;
      if (!menuOpen && options.abortBeforeRecovery && choiceWaits === 1) controller.abort();
      if (!menuOpen) throw timeoutError();
      if (options.replaceMenuAfterVisible && !menuReplaced) {
        menuReplaced = true;
        menuOpen = false;
      }
    },
  };
  const effortChoices = {
    nth: (index: number) => {
      expect(index).toBe(2);
      return effortChoice;
    },
  };
  const effortMenu = {
    locator: () => effortChoices,
  };
  const effortMenus = {
    filter: () => ({ last: () => effortMenu }),
    evaluateAll: async (_callback: unknown, input: { focus: boolean }) => ({
      open: menuOpen,
      checked: menuOpen ? "true" : null,
      count: menuOpen ? 5 : 0,
      focused: menuOpen && input.focus,
    }),
  };
  const currentEffort = {
    waitFor: async () => {},
    getAttribute: async () => menuOpen ? "true" : "false",
    press: async (key: string) => {
      expect(key).toBe("Enter");
      controlPresses += 1;
      if (options.firstPressOpens || controlPresses > 1) menuOpen = true;
    },
    click: async () => {
      pointerClicks += 1;
      throw new Error("pointer click must not be used for the effort control");
    },
  };
  const composerForm = {
    locator: () => ({ last: () => currentEffort }),
  };
  const composer = {
    locator: () => composerForm,
  };
  const page = {
    locator: () => effortMenus,
    keyboard: {
      press: async (key: string) => { keyboardPresses.push(key); },
    },
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => composer,
advancedPickerState: async () => ({
      pickerOpen: false,
      advancedFound: false,
      effortControlFound: false,
      effortValueFound: false,
      effortValueSelected: null,
      controlMatchesEffort: false,
      focused: false,
    }),
    resynchronizeEffortPicker: async () => {
      if (controller.signal.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      await currentEffort.press("Enter");
      return true;
    },
  });
  const selectModelAndEffort = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(
      page: unknown,
      modelId: string,
      reasoning: string | undefined,
      capabilities: { localToolsEnabled: boolean; proAvailable: boolean },
      abortSignal?: AbortSignal,
    ): Promise<{ uiEffortIndex: number }>;
  }).selectModelAndEffort;

  let mode: { uiEffortIndex: number } | undefined;
  let errorName: string | undefined;
  try {
    mode = await selectModelAndEffort.call(
      worker,
      page,
      "gpt-5.6-sol",
      "high",
      { localToolsEnabled: false, proAvailable: true },
      controller.signal,
    );
  } catch (error) {
    if (!options.abortBeforeRecovery) throw error;
    errorName = error instanceof Error ? error.name : undefined;
  }

  return {
    uiEffortIndex: mode?.uiEffortIndex,
    errorName,
    controlPresses,
    pointerClicks,
    keyboardPresses,
  };
}

test("effort selection leaves an already-open picker alone", async () => {
  const result = await runEffortPickerScenario({ initiallyOpen: true, firstPressOpens: false });

  expect(result.controlPresses).toBe(0);
  expect(result.pointerClicks).toBe(0);
});

test("effort selection opens the picker once on the normal path", async () => {
  const result = await runEffortPickerScenario({ initiallyOpen: false, firstPressOpens: true });

  expect(result.controlPresses).toBe(1);
  expect(result.pointerClicks).toBe(0);
});

test("effort selection reactivates the picker when the first activation is consumed", async () => {
  const result = await runEffortPickerScenario({ initiallyOpen: false, firstPressOpens: false });

  expect(result.uiEffortIndex).toBe(2);
  expect(result.controlPresses).toBe(2);
  expect(result.pointerClicks).toBe(0);
  expect(result.keyboardPresses).toEqual(["Escape"]);
});

test("effort selection does not click the picker after cancellation", async () => {
  const result = await runEffortPickerScenario({
    initiallyOpen: false,
    firstPressOpens: false,
    abortBeforeRecovery: true,
  });

  expect(result.errorName).toBe("AbortError");
  expect(result.controlPresses).toBe(1);
  expect(result.pointerClicks).toBe(0);
});

test("effort selection re-resolves a picker replaced after visibility", async () => {
  const result = await runEffortPickerScenario({
    initiallyOpen: false,
    firstPressOpens: true,
    replaceMenuAfterVisible: true,
  });

  expect(result.uiEffortIndex).toBe(2);
  expect(result.controlPresses).toBe(2);
  expect(result.pointerClicks).toBe(0);
  expect(result.keyboardPresses).toEqual(["Escape"]);
});

test("effort selection uses Advanced then the matching Effort option in the new picker", async () => {
  let pickerOpen = false;
  let advancedOpen = false;
  let effortOpen = false;
  let effortSelected = false;
  let focused: "advanced" | "effort-control" | "effort-value" | undefined;
  let controlPresses = 0;
  const keyboardPresses: string[] = [];

  const effortMenu = {
    locator: () => ({
      nth: () => ({ waitFor: async () => {} }),
    }),
  };
  const effortMenus = {
    filter: () => ({ last: () => effortMenu }),
    evaluateAll: async () => ({
      open: pickerOpen,
      checked: pickerOpen ? "false" : null,
      count: pickerOpen ? 3 : 0,
      focused: false,
    }),
  };
  const currentEffort = {
    waitFor: async () => {},
    getAttribute: async () => pickerOpen ? "true" : "false",
    press: async (key: string) => {
      expect(key).toBe("Enter");
      controlPresses += 1;
      pickerOpen = true;
    },
  };
  const composer = {
    locator: () => ({ locator: () => ({ last: () => currentEffort }) }),
  };
  const page = {
    isClosed: () => false,
    locator: () => effortMenus,
    keyboard: {
      press: async (key: string) => {
        keyboardPresses.push(key);
        if (key === "Enter" && focused === "advanced") advancedOpen = true;
        if (key === "Enter" && focused === "effort-control") effortOpen = true;
        if (key === "Enter" && focused === "effort-value") {
          effortSelected = true;
          effortOpen = false;
        }
        if (key === "Escape") pickerOpen = false;
      },
    },
  };
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => composer,
    advancedPickerState: async (
      _page: unknown,
      effortLabel: string,
      focus?: "advanced" | "effort-control" | "effort-value",
    ) => {
      expect(effortLabel).toBe("High");
      const advancedFound = pickerOpen && !advancedOpen;
      const effortControlFound = pickerOpen && advancedOpen && !effortOpen && !effortSelected;
      const effortValueFound = pickerOpen && advancedOpen && effortOpen;
      const focusAvailable = focus === "advanced"
        ? advancedFound
        : focus === "effort-control"
          ? effortControlFound
          : focus === "effort-value"
            ? effortValueFound
            : false;
      if (focus && focusAvailable) focused = focus;
      return {
        pickerOpen,
        advancedFound,
        effortControlFound,
        effortValueFound,
        effortValueSelected: effortValueFound ? effortSelected : null,
        controlMatchesEffort: effortSelected,
        focused: Boolean(focus && focusAvailable),
      };
    },
  });
  const selectModelAndEffort = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(
      page: unknown,
      modelId: string,
      reasoning: string,
      capabilities: { localToolsEnabled: boolean; proAvailable: boolean },
    ): Promise<{ uiEffortIndex: number }>;
  }).selectModelAndEffort;

  const result = await selectModelAndEffort.call(
    worker,
    page,
    "gpt-5.6-sol",
    "high",
    { localToolsEnabled: false, proAvailable: true },
  );

  expect(result.uiEffortIndex).toBe(2);
  expect(effortSelected).toBe(true);
  expect(controlPresses).toBe(1);
  expect(keyboardPresses).toEqual(["Enter", "Enter", "Enter", "Escape"]);
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
  expect(workerSource).toContain('getAttribute("aria-expanded"');
  expect(workerSource).not.toContain("currentEffort.click");
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
  const start = workerSource.indexOf("private async responseDomSnapshot");
  const end = workerSource.indexOf("private async stalledTurnDiagnostic", start);
  const snapshot = workerSource.slice(start, end);
  expect(snapshot).toContain('renderedRoots.push(candidate)');
  expect(snapshot).toContain('fullHtml += candidate.innerHTML');
  expect(snapshot).toContain('stableHtml += renderedChildren[i].outerHTML');
  expect(snapshot).toContain("const captureAnswer = !input.running || completionAction !== undefined");
  expect(snapshot).not.toContain('renderedRoots.map(');
  expect(snapshot).not.toContain('rendered?.innerHTML ?? ""');
});

test("response inspection timeouts retry without becoming missing DOM", async () => {
  const responseDomSnapshot = (ChatGptBrowserWorker.prototype as unknown as {
    responseDomSnapshot(responseTurn: unknown, running: boolean): Promise<{
      inspection: "ok" | "retry";
      responsePresent: boolean;
    }>;
  }).responseDomSnapshot;
  const page = { isClosed: () => false };
  const timeout = Object.assign(new Error("renderer was busy"), { name: "TimeoutError" });
  const retry = await responseDomSnapshot.call({}, {
    count: async () => 1,
    evaluate: async () => { throw timeout; },
    page: () => page,
  }, true);
  expect(retry).toMatchObject({ inspection: "retry", responsePresent: false });

  const missing = await responseDomSnapshot.call({}, {
    count: async () => 0,
    page: () => page,
  }, false);
  expect(missing).toMatchObject({ inspection: "ok", responsePresent: false });

  await expect(responseDomSnapshot.call({}, {
    count: async () => 1,
    evaluate: async () => { throw new Error("CDP disconnected"); },
    page: () => page,
  }, false)).rejects.toThrow("ChatGPT response inspection failed: CDP disconnected");
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
  expect(missing.update(absent, 60_000)).toBeUndefined();
  expect(missing.update({ ...absent, running: false }, 60_000)).toBeUndefined();
  expect(missing.update({ ...absent, running: false }, 61_000)).toContain("did not create a response DOM");

  const vanished = new ChatGptTurnDomHealthTracker(1_000, 500);
  expect(vanished.update({ ...absent, responsePresent: true }, 1_000)).toBeUndefined();
  expect(vanished.update(absent, 60_000)).toBeUndefined();
  expect(vanished.update({ ...absent, running: false }, 60_000)).toBeUndefined();
  expect(vanished.update({ ...absent, running: false }, 61_000)).toContain("response DOM disappeared");

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
  expect(workerSource).toContain("abortSignal?: AbortSignal");
  expect(workerSource).toContain("if (abortSignal?.aborted)");
  expect(workerSource).not.toContain("userTurns.nth(initialUserTurnCount).waitFor");
});

test("unbounded submission acknowledgement still honors explicit cancellation", async () => {
  const controller = new AbortController();
  const waitForSubmissionAccepted = (ChatGptBrowserWorker.prototype as unknown as {
    waitForSubmissionAccepted(
      page: unknown,
      userTurns: unknown,
      responseTurns: unknown,
      initialUserTurnCount: number,
      initialResponseTurnCount: number,
      recovery: { dismissals: number; pickerNeedsResync: boolean; modelNeedsVerification: boolean },
      abortSignal?: AbortSignal,
    ): Promise<unknown>;
  }).waitForSubmissionAccepted;
  const idleTurns = { count: async () => 0 };
  const page = {
    isClosed: () => false,
    locator: () => ({ filter: () => ({ count: async () => 0 }) }),
  };

  controller.abort();
  const pending = waitForSubmissionAccepted.call(
    {},
    page,
    idleTurns,
    idleTurns,
    0,
    0,
    { dismissals: 0, pickerNeedsResync: false, modelNeedsVerification: false },
    controller.signal,
  );

  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
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
