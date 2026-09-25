import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
  activateChatGptEffortMenu,
  assertNewChatPage,
  chatGptNewChatUrl,
  detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";

test("saved chats start empty and cannot reuse an arbitrary conversation or a Temporary Chat", async () => {
  expect(chatGptNewChatUrl()).toBe("https://chatgpt.com/?temporary-chat=true");
  expect(chatGptNewChatUrl(true)).toBe("https://chatgpt.com/");
  const prepare = (ChatGptBrowserWorker.prototype as any).prepareChatSurface;
  for (const saved of [false, true]) {
    let url = "https://chatgpt.com/c/previous-task";
    const navigations: string[] = [];
    const absent: any = { filter: () => absent, last: () => absent, isVisible: async () => false };
    const composer: any = { count: async () => 1, nth: () => composer, isVisible: async () => true };
    const page: any = {
      url: () => url,
      goto: async (next: string) => { url = next; navigations.push(next); },
      locator: (selector: string) => selector === CHATGPT_COMPOSER_SELECTOR ? composer : absent,
    };
    expect(await prepare.call({ activeComposer: async () => composer }, page, undefined, saved)).toBe(composer);
    expect(navigations).toEqual([chatGptNewChatUrl(saved)]);
    await expect(assertNewChatPage(page, !saved)).rejects.toThrow("requested new");
    url = "https://chatgpt.com/c/previous-task";
    await expect(assertNewChatPage(page, saved)).rejects.toThrow("requested new");
  }
});

test("composer and effort selectors exclude unrelated editable fields and menu buttons", () => {
  const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
  const document = createDocument(`<body><form>
    <div contenteditable="true" id="unrelated-editor"></div>
    <textarea placeholder="Search" id="search"></textarea>
    <button aria-haspopup="menu" id="attachments"></button>
    <div data-testid="prompt-textarea" id="composer-testid"></div>
    <div id="prompt-textarea"></div>
    <div contenteditable="true" data-lexical-editor="true" id="composer-lexical"></div>
    <button aria-haspopup="menu" data-tone="neutral" id="effort"></button>
    <button aria-haspopup="menu" data-testid="model-switcher-dropdown-button" id="model"></button>
  </form>
  <div contenteditable="true" data-composer-markdown role="textbox" id="unowned-power-editor"></div>
  <form data-chatgpt-composer>
    <div contenteditable="true" data-composer-markdown role="textbox" id="power-editor"></div>
    <button data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning" aria-haspopup="menu" id="power-effort"></button>
  </form></body>`);
  const matches = (selector: string) => Array.from(document.querySelectorAll(selector)).map(element => element.id);
  expect(matches(CHATGPT_COMPOSER_SELECTOR)).toEqual(["composer-testid", "prompt-textarea", "composer-lexical", "power-editor"]);
  expect(matches(CHATGPT_EFFORT_CONTROL_SELECTOR)).toEqual(["effort", "model", "power-effort"]);
});

test("effort activation binds the owned menu after the control opens", async () => {
  let opened = false;
  const ownedMenu = { isVisible: async () => opened };
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    isVisible: async () => false,
  };
  const control = {
    getAttribute: async (name: string) => {
      if (name === "aria-controls") return opened ? "radix-effort-menu" : null;
      if (name === "aria-expanded") return opened ? "true" : "false";
      if (name === "data-state") return opened ? "open" : "closed";
      return null;
    },
    click: async (options: unknown) => {
      expect(options).toEqual({ force: true, timeout: 1 });
      opened = true;
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === '[id="radix-effort-menu"]') return ownedMenu;
      return hiddenSurface;
    },
    keyboard: { press: async () => {} },
  };

  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 });
  expect(activation.method).toBe("click");
  expect(activation.menu).toBe(ownedMenu as never);
});

test.each(["aria-expanded", "data-state"])("effort activation does not bind a closing menu (%s)", async attribute => {
  let opened = false;
  let clicks = 0;
  // Escape closes the control immediately, but the outgoing menu remains visible
  // through its exit animation. Its stale range must not authorize a new selection.
  const surface = {
    filter() { return this; }, last() { return this; }, locator() { return this; },
    isVisible: async () => true,
  };
  const control = {
    getAttribute: async (name: string) => name === attribute
      ? attribute === "aria-expanded" ? String(opened) : opened ? "open" : "closed"
      : null,
    click: async () => { clicks++; opened = true; },
  };
  const page = { locator: () => surface, keyboard: { press: async () => {} } };
  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 });
  expect(activation.method).toBe("click");
  expect(clicks).toBe(1);
});

test("effort activation retries one ghost click with a primary pointerdown", async () => {
  let ghostOpen = false;
  let pointerOpened = false;
  const events: unknown[] = [];
  const ownedMenu = { isVisible: async () => pointerOpened };
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    isVisible: async () => false,
  };
  const control = {
    getAttribute: async (name: string) => {
      if (name === "aria-controls") return pointerOpened ? "radix-effort-menu" : null;
      if (name === "aria-expanded") return ghostOpen ? "true" : "false";
      if (name === "data-state") return ghostOpen ? "open" : "closed";
      return null;
    },
    click: async (options: unknown) => {
      events.push(["click", options]);
      ghostOpen = true;
    },
    dispatchEvent: async (name: string, detail: unknown) => {
      events.push([name, detail]);
      ghostOpen = true;
      pointerOpened = true;
    },
  };
  const page = {
    locator: (selector: string) => {
      if (selector === '[id="radix-effort-menu"]') return ownedMenu;
      return hiddenSurface;
    },
    keyboard: {
      press: async (key: string) => {
        events.push(["keyboard", key]);
        ghostOpen = false;
      },
    },
  };

  const activation = await activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 });
  expect(activation.method).toBe("pointerdown");
  expect(activation.menu).toBe(ownedMenu as never);
  expect(events).toEqual([
    ["click", { force: true, timeout: 1 }],
    ["keyboard", "Escape"],
    ["pointerdown", { button: 0, buttons: 1, pointerType: "mouse", isPrimary: true }],
  ]);
});

test("effort activation fails closed when neither event exposes a structural surface", async () => {
  const hiddenSurface = {
    filter() { return this; },
    last() { return this; },
    locator() { return this; },
    isVisible: async () => false,
  };
  const control = {
    getAttribute: async () => null,
    click: async () => {},
    dispatchEvent: async () => {},
  };
  const page = {
    locator: () => hiddenSurface,
    keyboard: { press: async () => {} },
  };

  await expect(activateChatGptEffortMenu(page as never, control as never, { settleMs: 0 }))
    .rejects.toThrow("did not expose its owned menu or structural slider");
});

test("a complete authenticated composer with no effort selector is Luna-only", async () => {
  const effortButton = {
    filter() { return this; },
    last() { return this; },
    isVisible: async () => false,
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composer = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    locator: () => composerForm,
  };
  const page = {
    locator: () => composer,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, extraHighAvailable: false, proAvailable: false });
});

test("a transient effort control does not turn a Luna-only account into Sol", async () => {
  let visibilityReads = 0;
  const effortButton = {
    filter() { return this; },
    last() { return this; },
    isVisible: async () => {
      visibilityReads += 1;
      return visibilityReads === 1;
    },
  };
  const composerForm = {
    count: async () => 1,
    locator: () => effortButton,
  };
  const composers = {
    filter() { return this; },
    last() { return this; },
    count: async () => 1,
    locator: () => composerForm,
  };
  const page = {
    locator: () => composers,
    evaluate: async () => true,
  };

  await expect(detectChatGptAccountCapabilities(page as never, {
    selectorTimeoutMs: 100,
    stableAbsenceMs: 0,
  })).resolves.toEqual({ solAvailable: false, extraHighAvailable: false, proAvailable: false });
  expect(visibilityReads).toBe(2);
});

function reasoningPicker(options: { max?: string; locks?: Array<string | null>; delay?: number; missing?: boolean; loseSelectionOnClose?: boolean; power?: boolean; disabled?: string } = {}) {
  let value = 0;
  let opened = true;
  const keys: string[] = [];
  const hidden = {
    filter() { return this; }, last() { return this; }, getByText() { return this; },
    isVisible: async () => false,
    waitFor: ({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  };
  const sliderControl = { press: async (key: string) => { keys.push(key); value += key === "ArrowRight" ? 1 : -1; } };
  const slider = {
    isVisible: async () => false, // Live DOM: aria-hidden=true, zero-width semantic span.
    filter: () => { throw new Error("Semantic input must not be visibility-filtered"); },
    waitFor: async ({ state }: { state: string }) => { expect(state).toBe("attached"); },
    getAttribute: async (name: string) => ({ "aria-valuemin": "0", "aria-valuemax": options.max ?? "4", "aria-valuenow": String(value), "aria-hidden": "true" })[name] ?? null,
    locator: () => sliderControl,
  };
  const container = {
    filter() { return this; }, last() { return this; },
    locator: () => slider,
    evaluate: async (read: (element: Element) => unknown) => {
      const { createDocument } = require("@mixmark-io/domino") as { createDocument(html: string): Document };
      // Captured Plus DOM: the slider root and each tick have data-locked, but only
      // ticks have data-selected. Its fourth position is a locked Pro upsell.
      const locks = options.locks ?? Array.from({ length: Number(options.max ?? "4") + 1 }, () => "false");
      const attribute = options.power ? "data-model-picker-power-slider" : "data-model-reasoning-effort-slider";
      const document = createDocument(`<div ${attribute}>
        <span data-locked="false" data-orientation="horizontal" aria-disabled="${options.disabled ?? "false"}"><span>${locks.map((lock, index) =>
          `<span data-selected="${index <= value}"${lock === null ? "" : ` data-locked="${lock}"`}></span>`).join("")}
        </span></span></div>`);
      return read(document.querySelector(`[${attribute}]`)!);
    },
    isVisible: async () => true,
    waitFor: async ({ state }: { state: string }) => {
      expect(state).toBe("visible");
      if (options.missing) throw new Error("effort container never hydrated");
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
    },
  };
  const control = {
    first() { return this; }, filter() { return this; }, last() { return this; },
    count: async () => 1, waitFor: async () => {}, isVisible: async () => true,
    click: async () => { opened = true; },
    innerText: async () => opened ? "Thinking effort" : ["Instant", "Medium", "High", "Extra High", "Pro"][value]!,
    getAttribute: async (name: string) => name === "aria-expanded" ? String(opened) : null,
  };
  const composer = { filter() { return this; }, last() { return this; }, isEditable: async () => true, locator: () => ({ locator: () => control }) };
  const modelRows = { count: async () => 3, first() { return this; }, waitFor: async () => {}, nth: () => { throw new Error("Model rows are not effort choices"); } };
  const menu = { filter() { return this; }, last() { return this; }, isVisible: async () => true, locator: () => modelRows };
  const page = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composer;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return menu;
      if (selector === CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR) return container;
      return hidden;
    },
    keyboard: { press: async () => {
      opened = false;
      if (options.loseSelectionOnClose) value = 0;
    } },
  };
  return { page, composer, keys, value: () => value };
}

test.each([0, 50])("capabilities wait for the visible container and read its hidden semantic input (delay=%s)", async delay => {
  const fixture = reasoningPicker({ delay });
  await expect(detectChatGptAccountCapabilities(fixture.page as never)).resolves.toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: true });
});

test("an absent effort slider cannot turn three model rows into a saved non-Pro capability", async () => {
  const fixture = reasoningPicker({ missing: true });
  await expect(detectChatGptAccountCapabilities(fixture.page as never)).rejects.toThrow("never hydrated");
});

test("the authoritative three-step range is non-Pro; a malformed range fails closed", async () => {
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "2" }).page as never)).resolves.toEqual({ solAvailable: true, extraHighAvailable: false, proAvailable: false });
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "bad" }).page as never)).rejects.toThrow("model controls are unavailable");
});

test("the four-step browser range keeps Extra High available when Pro is unavailable", async () => {
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "3" }).page as never))
    .resolves.toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: false });
});

test("capabilities probe stabilizes when slider ARIA max transitions during hydration to match rendered ticks", async () => {
  let reads = 0;
  const fixture = reasoningPicker({
    max: "3",
    locks: ["false", "false", "false", "false"],
  });
  const container = (fixture.page as any).locator(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR);
  const slider = container.locator();
  const origGetAttribute = slider.getAttribute;
  slider.getAttribute = async (name: string) => {
    if (name === "aria-valuemax") {
      reads += 1;
      return reads === 1 ? "4" : "3";
    }
    return origGetAttribute(name);
  };
  await expect(detectChatGptAccountCapabilities(fixture.page as never))
    .resolves.toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: false });
  expect(reads).toBeGreaterThanOrEqual(2);
});

test("capabilities exclude the observed locked Plus upsell and reject unknown lock state", async () => {
  await expect(detectChatGptAccountCapabilities(reasoningPicker({
    max: "3", locks: ["false", "false", "false", "true"],
  }).page as never)).resolves.toEqual({ solAvailable: true, extraHighAvailable: false, proAvailable: false });
  await expect(detectChatGptAccountCapabilities(reasoningPicker({
    locks: ["false", "false", "false", "false", "true"],
  }).page as never)).resolves.toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: false });
  for (const locks of [[], ["false", "false", "false", null], ["false", "false", "false", "unknown"]]) {
    await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "3", locks }).page as never))
      .rejects.toThrow("availability");
  }
});

test("power picker omission of lock attributes requires its enabled structural owner and complete ticks", async () => {
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ power: true, locks: Array(5).fill(null) }).page as never))
    .resolves.toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: true });
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ power: true, locks: [null, null, null, "true", "true"] }).page as never))
    .resolves.toEqual({ solAvailable: true, extraHighAvailable: false, proAvailable: false });
  for (const options of [
    { power: false }, { power: true, disabled: "true" }, { power: true, disabled: "unknown" },
    { power: true, max: "3" },
  ]) await expect(detectChatGptAccountCapabilities(reasoningPicker({ ...options, locks: Array(5).fill(null) }).page as never))
    .rejects.toThrow("availability");
});

test("stale saved capabilities cannot activate a locked effort; High remains selectable", async () => {
  for (const effort of ["xhigh", "high"] as const) {
    const fixture = reasoningPicker({ max: "3", locks: ["false", "false", "false", "true"] });
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      activeComposer: async () => fixture.composer,
    }) as { selectModelAndEffort(...args: unknown[]): Promise<{ selection: { label: string } }> };
    const selection = worker.selectModelAndEffort(fixture.page, "gpt-5.6-sol", effort, {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    });
    if (effort === "xhigh") {
      await expect(selection).rejects.toMatchObject({ code: "chatgpt_effort_locked", retryable: false });
      expect(fixture.keys).toEqual([]);
    } else {
      expect((await selection).selection.label).toBe("High");
      expect(fixture.keys).toEqual(["ArrowRight", "ArrowRight"]);
    }
  }
});

test("Pro selection verifies the persisted hidden slider through its visible owner, never model rows", async () => {
  for (const loseSelectionOnClose of [false, true]) {
    const fixture = reasoningPicker({ delay: 50, loseSelectionOnClose });
    const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
      activeComposer: async () => fixture.composer,
    }) as { selectModelAndEffort(...args: unknown[]): Promise<{ selection: { label: string } }> };
    const selection = worker.selectModelAndEffort(fixture.page, "gpt-5.6-sol", "max", {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    });
    if (loseSelectionOnClose) await expect(selection).rejects.toMatchObject({ retryable: false });
    else expect((await selection).selection.label).toBe("Pro");
    expect(fixture.keys).toEqual(["ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight"]);
    expect(fixture.value()).toBe(loseSelectionOnClose ? 0 : 4);
  }
});
