import { afterEach, expect, test } from "bun:test";
import { insertPlainTextIntoComposer } from "../src/adapters/chatgpt-web/browser-worker";

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


// Bun's test harness is not a browser; InputEvent exists in the real ChatGPT page.
if (typeof (globalThis as { InputEvent?: unknown }).InputEvent !== "function") {
  class FakeInputEvent extends Event {
    inputType: string;
    data: string | null;
    constructor(type: string, init: EventInit & { inputType?: string; data?: string | null } = {}) {
      super(type, init);
      this.inputType = init.inputType ?? "";
      this.data = init.data ?? null;
    }
  }
  (globalThis as Record<string, unknown>).InputEvent = FakeInputEvent;
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
  const dispatched: Array<{ type: string; inputType?: string; data?: string | null }> = [];
  const composer = {
    focus() { if (options.focusable) fakeDocument.activeElement = composer; },
    contains: (node: object | null) => node === inside || node === composer,
    dispatchEvent(event: Event) {
      const input = event as InputEvent;
      dispatched.push({
        type: event.type,
        inputType: input.inputType,
        data: input.data,
      });
      return true;
    },
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
  return { composer: composer as unknown as HTMLElement, calls, selection, fakeDocument, dispatched };
}

test("places the caret itself when focus has not yet produced one in the composer", () => {
  // A focusable composer may be ready before the browser has placed a caret inside it.
  const { composer, calls, selection, dispatched } = harness({ focusable: true, caretInsideComposer: false });

  expect(insertPlainTextIntoComposer(composer, "staged part")).toBeTrue();
  expect(calls).toEqual([{ command: "insertText", value: "staged part" }]);
  expect(selection.isCollapsed).toBeTrue();
  expect(dispatched).toEqual([{ type: "input", inputType: "insertText", data: "staged part" }]);
});

test("leaves an existing caret inside the composer exactly where it is", () => {
  const { composer, calls, selection, dispatched } = harness({ focusable: true, caretInsideComposer: true });
  const anchorBefore = selection.anchorNode;

  expect(insertPlainTextIntoComposer(composer, "second part")).toBeTrue();
  expect(selection.anchorNode).toBe(anchorBefore);
  expect(calls).toEqual([{ command: "insertText", value: "second part" }]);
  expect(dispatched).toEqual([{ type: "input", inputType: "insertText", data: "second part" }]);
});

test("refuses to insert when the composer cannot take focus at all", () => {
  // A covered or detached composer must still fail rather than have text typed somewhere else.
  const { composer, calls, dispatched } = harness({ focusable: false, caretInsideComposer: false });

  expect(insertPlainTextIntoComposer(composer, "staged part")).toBeFalse();
  expect(calls).toEqual([]);
  expect(dispatched).toEqual([]);
});

test("reports a genuinely rejected edit as a failure", () => {
  const { composer, dispatched } = harness({
    focusable: true,
    caretInsideComposer: true,
    execCommandResult: false,
  });

  expect(insertPlainTextIntoComposer(composer, "staged part")).toBeFalse();
  expect(dispatched).toEqual([]);
});
