import { afterEach, expect, test } from "bun:test";
import { chromium } from "playwright-core";
import {
  ChatGptBrowserWorker,
  insertPlainTextIntoComposer,
  replacePlainTextInComposer,
} from "../src/adapters/chatgpt-web/browser-worker";

/**
 * The composer insert runs inside the page, where the caret state is whatever the last UI
 * interaction left behind. Effort selection closes a menu immediately before a staged part is
 * attached, so these fixtures model the focus and selection states that actually occur there.
 */
interface FakeSelection {
  isCollapsed: boolean;
  anchorNode: object | null;
  focusNode?: object | null;
  removeAllRanges(): void;
  addRange(range: object): void;
}

const originals = { document: globalThis.document, window: globalThis.window };
afterEach(() => {
  (globalThis as Record<string, unknown>).document = originals.document;
  (globalThis as Record<string, unknown>).window = originals.window;
});

function harness(options: {
  focusable: boolean;
  caretInsideComposer: boolean;
  collapsed?: boolean;
  execCommandResult?: boolean;
}) {
  const inside = { name: "text-node-inside-composer" };
  const composer = {
    focus() { if (options.focusable) fakeDocument.activeElement = composer; },
    contains: (node: object | null) => node === inside || node === composer,
  };
  const calls: Array<{ command: string; value: string }> = [];
  let selectedNode: unknown = null;
  let collapsedRange: boolean | undefined;
  const selection: FakeSelection = {
    isCollapsed: options.collapsed ?? true,
    anchorNode: options.caretInsideComposer ? inside : { name: "node-in-the-effort-menu" },
    focusNode: options.caretInsideComposer ? inside : { name: "node-in-the-effort-menu" },
    removeAllRanges() { selection.anchorNode = null; selection.focusNode = null; },
    addRange() {
      selection.anchorNode = inside;
      selection.focusNode = inside;
      selection.isCollapsed = collapsedRange === true;
    },
  };
  const fakeDocument = {
    activeElement: null as unknown,
    createRange: () => ({
      selectNodeContents(node: unknown) { selectedNode = node; collapsedRange = false; },
      collapse() { collapsedRange = true; },
    }),
    execCommand(command: string, _ui: boolean, value: string) {
      calls.push({ command, value });
      return options.execCommandResult ?? true;
    },
  };
  (globalThis as Record<string, unknown>).document = fakeDocument;
  (globalThis as Record<string, unknown>).window = { getSelection: () => selection };
  return {
    composer: composer as unknown as HTMLElement,
    calls,
    selection,
    fakeDocument,
    selectedNode: () => selectedNode,
    collapsedRange: () => collapsedRange,
  };
}

test("places the caret itself when focus has not yet produced one in the composer", () => {
  // A focusable composer may be ready before the browser has placed a caret inside it.
  const { composer, calls, selection } = harness({ focusable: true, caretInsideComposer: false });

  expect(insertPlainTextIntoComposer(composer, "staged part")).toBeTrue();
  expect(calls).toEqual([{ command: "insertText", value: "staged part" }]);
  expect(selection.isCollapsed).toBeTrue();
});

test("leaves an existing caret inside the composer exactly where it is", () => {
  const { composer, calls, selection } = harness({ focusable: true, caretInsideComposer: true });
  const anchorBefore = selection.anchorNode;

  expect(insertPlainTextIntoComposer(composer, "second part")).toBeTrue();
  expect(selection.anchorNode).toBe(anchorBefore);
  expect(calls).toEqual([{ command: "insertText", value: "second part" }]);
});

test("refuses to insert when the composer cannot take focus at all", () => {
  // A covered or detached composer must still fail rather than have text typed somewhere else.
  const { composer, calls } = harness({ focusable: false, caretInsideComposer: false });

  expect(insertPlainTextIntoComposer(composer, "staged part")).toBeFalse();
  expect(calls).toEqual([]);
});

test("reports a genuinely rejected edit as a failure", () => {
  const { composer } = harness({
    focusable: true,
    caretInsideComposer: true,
    execCommandResult: false,
  });

  expect(insertPlainTextIntoComposer(composer, "staged part")).toBeFalse();
});

test("replaces a restored draft in plain composer attachments even when a caret is already inside (#977)", () => {
  const { composer, calls, selection, selectedNode, collapsedRange } = harness({
    focusable: true,
    caretInsideComposer: true,
  });

  expect(replacePlainTextInComposer(composer, "staged part")).toBeTrue();
  expect(selectedNode()).toBe(composer);
  expect(collapsedRange()).toBeFalse();
  expect(selection.isCollapsed).toBeFalse();
  expect(calls).toEqual([{ command: "insertText", value: "staged part" }]);
});

test("refuses plain replacement when focus cannot enter the composer (#977)", () => {
  const { composer, calls } = harness({ focusable: false, caretInsideComposer: false });

  expect(replacePlainTextInComposer(composer, "staged part")).toBeFalse();
  expect(calls).toEqual([]);
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a selected connector never appends a new request to an old draft", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { appName: "Codex Native2" },
    });
    const prompt = "Task context\n".repeat(5_000) + "\nrequest_id: current";
    for (const modern of [false, true]) {
      const pill = modern
        ? '<span app-mention-path="app://fixture" app-mention-display-name="Codex Native2" contenteditable="false">Codex Native2</span>'
        : '<span data-id="plugin:fixture" data-keyword="Codex Native2" contenteditable="false">Codex Native2</span>';
      for (const staleDraft of ["", prompt.replace("current", "earlier")]) {
        await page.setContent(`<form><div id="prompt-textarea" contenteditable="true" style="min-height:40px"></div></form>
          <div id="mention-menu" hidden><div class="__menu-item" tabindex="0" data-highlighted><span>Codex Native2</span></div></div>`);
        await page.locator("#prompt-textarea").evaluate((element, { pill, staleDraft }) => {
          element.innerHTML = pill;
          element.appendChild(document.createTextNode(staleDraft ? " " + staleDraft : ""));
          const menu = document.getElementById("mention-menu")!;
          element.addEventListener("input", () => { menu.hidden = element.textContent !== "@codex"; });
          element.addEventListener("keydown", event => {
            if ((event as KeyboardEvent).key !== "Enter" || menu.hidden) return;
            event.preventDefault();
            element.innerHTML = pill;
            menu.hidden = true;
          });
        }, { pill, staleDraft });
        await worker.attachPrompt(page, prompt, true);
        expect(await worker.attachedPromptText(page)).toBe(prompt);
        expect(await worker.connectorIsSelected(page.locator("#prompt-textarea"))).toBeTrue();
      }
    }
  } finally { await browser.close(); }
}, 45_000);
