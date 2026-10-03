import { afterEach, expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker, insertPlainTextIntoComposer } from "../src/adapters/chatgpt-web/browser-worker";

/**
 * The composer insert runs inside the page, where the caret state is whatever the last UI
 * interaction left behind. Effort selection closes a menu immediately before a staged part is
 * attached, so these fixtures model the focus and selection states that actually occur there.
 */
interface FakeSelection {
  isCollapsed: boolean;
  anchorNode: object | null;
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
  const selection: FakeSelection = {
    isCollapsed: options.collapsed ?? true,
    anchorNode: options.caretInsideComposer ? inside : { name: "node-in-the-effort-menu" },
    removeAllRanges() { selection.anchorNode = null; },
    addRange() { selection.anchorNode = inside; selection.isCollapsed = true; },
  };
  const fakeDocument = {
    activeElement: null as unknown,
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand(command: string, _ui: boolean, value: string) {
      calls.push({ command, value });
      return options.execCommandResult ?? true;
    },
  };
  (globalThis as Record<string, unknown>).document = fakeDocument;
  (globalThis as Record<string, unknown>).window = { getSelection: () => selection };
  return { composer: composer as unknown as HTMLElement, calls, selection, fakeDocument };
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

for (const modern of [false, true]) for (const hasStaleDraft of [false, true])
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`a selected ${modern ? "modern" : "classic"} connector never appends to ${hasStaleDraft ? "an old" : "an empty"} draft`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      config: { appName: "Codex Native2" },
    });
    const prompt = "Task context\n".repeat(5_000) + "\nrequest_id: current";
    const pill = modern
      ? '<span app-mention-path="app://fixture" app-mention-display-name="Codex Native2" contenteditable="false">Codex Native2</span>'
      : '<span data-id="plugin:fixture" data-keyword="Codex Native2" contenteditable="false">Codex Native2</span>';
    const staleDraft = hasStaleDraft ? prompt.replace("current", "earlier") : "";
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
  } finally { await browser.close(); }
}, 45_000);
