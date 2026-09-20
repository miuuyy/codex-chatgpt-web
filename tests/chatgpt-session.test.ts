import { expect, test } from "bun:test";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
  activateChatGptEffortMenu,
  chatGptEffortSliderTickOffset,
  closeChatGptEffortMenu,
  detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";

test("effort menu close clicks the trigger in-page when Escape never collapses it", async () => {
  let opened = true;
  let triggerClicks = 0;
  const control = {
    getAttribute: async (name: string) => {
      if (name === "aria-expanded") return String(opened);
      if (name === "data-state") return opened ? "open" : "closed";
      return null;
    },
    evaluate: async () => { triggerClicks += 1; opened = false; },
  };
  const page = {
    keyboard: { press: async () => {} },
    evaluate: async () => {},
    locator: () => ({ last: () => ({ evaluate: async () => { throw new Error("composer unused"); } }) }),
  };
  await expect(closeChatGptEffortMenu(page as never, control as never)).resolves.toBe(true);
  expect(triggerClicks).toBe(1);
}, 8_000);

test("effort menu close retries Escape until the trigger collapses", async () => {
  let escapes = 0;
  let opened = true;
  const control = {
    getAttribute: async (name: string) => {
      if (name === "aria-expanded") return String(opened);
      if (name === "data-state") return opened ? "open" : "closed";
      return null;
    },
  };
  const page = {
    keyboard: { press: async () => { escapes += 1; if (escapes >= 2) opened = false; } },
    evaluate: async () => {},
    locator: () => ({ last: () => ({ click: async () => { throw new Error("composer click should not be required"); } }) }),
  };
  await expect(closeChatGptEffortMenu(page as never, control as never)).resolves.toBe(true);
  expect(escapes).toBe(2);
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
  </form></body>`);
  const matches = (selector: string) => Array.from(document.querySelectorAll(selector)).map(element => element.id);
  expect(matches(CHATGPT_COMPOSER_SELECTOR)).toEqual(["composer-testid", "prompt-textarea", "composer-lexical"]);
  expect(matches(CHATGPT_EFFORT_CONTROL_SELECTOR)).toEqual(["effort", "model"]);
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
    ["pointerup", { button: 0, buttons: 0, pointerType: "mouse", isPrimary: true }],
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

function reasoningPicker(options: { max?: string; delay?: number; missing?: boolean; loseSelectionOnClose?: boolean; initial?: number; ignoreKeys?: boolean; ignoreClicks?: boolean } = {}) {
  let value = options.initial ?? 0;
  let opened = true;
  const keys: string[] = [];
  const clicks: unknown[] = [];
  const hidden = {
    filter() { return this; }, last() { return this; }, getByText() { return this; },
    isVisible: async () => false,
    waitFor: ({ signal }: { signal: AbortSignal }) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
  };
  const sliderControl = {
    press: async (key: string, pressOptions?: { force?: boolean; timeout?: number }) => {
      expect(pressOptions).toEqual({ force: true, timeout: 1_000 });
      keys.push(key);
      if (!options.ignoreKeys) value += key === "ArrowRight" ? 1 : -1;
    },
  };
  const slider = {
    isVisible: async () => false, // Live DOM: aria-hidden=true, zero-width semantic span.
    filter: () => { throw new Error("Semantic input must not be visibility-filtered"); },
    waitFor: async ({ state }: { state: string }) => { expect(state).toBe("attached"); },
    getAttribute: async (name: string) => ({ "aria-valuemin": "0", "aria-valuemax": options.max ?? "4", "aria-valuenow": String(value), "aria-hidden": "true" })[name] ?? null,
    locator: () => sliderControl,
    press: async () => {},
  };
  const ticks = ["Instant", "Medium", "High", "Extra High", "Pro"];
  const tickLocator = (name: string) => {
    const self = {
      filter() { return self; },
      last() { return self; },
      count: async () => ticks.includes(name) ? 1 : 0,
      click: async (clickOptions: unknown) => {
        clicks.push(["text", name, clickOptions]);
        if (!options.ignoreClicks) value = ticks.indexOf(name);
      },
    };
    return self;
  };
  const container = {
    boundingBox: async () => ({ x: 0, y: 0, width: 240, height: 40 }),
    press: async () => {},
    getByText: (name: string) => tickLocator(name),
    evaluate: async (_fn: unknown, arg: unknown) => {
      if (arg === undefined) return { count: 3, checkedIndex: 0 };
      if (typeof arg === "string") {
        if (!ticks.includes(arg)) return false;
        clicks.push(["evaluate", arg]);
        if (!options.ignoreClicks) value = ticks.indexOf(arg);
        return true;
      }
      if (arg && typeof arg === "object" && "targetValue" in arg) {
        const targetValue = (arg as { targetValue: number }).targetValue;
        clicks.push(["apply", targetValue]);
        if (!options.ignoreClicks) value = targetValue;
        return value;
      }
      return undefined;
    },
    click: async (clickOptions: { position: { x: number; y: number }; force?: boolean; timeout?: number }) => {
      clicks.push(clickOptions);
      expect(clickOptions.force).toBe(true);
      expect(clickOptions.timeout).toBe(1_000);
      if (!options.ignoreClicks) value = Math.round(clickOptions.position.x / 240 * Number(options.max ?? "4"));
    },
    filter() { return this; }, last() { return this; },
    locator: () => slider,
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
  return { page, composer, keys, clicks, value: () => value };
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

test("Pro selection uses the live Extra High tick when ChatGPT hides Pro", async () => {
  const fixture = reasoningPicker({ max: "3", initial: 1 });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => fixture.composer,
  }) as { selectModelAndEffort(...args: unknown[]): Promise<{ uiEffortIndex: number }> };
  await expect(worker.selectModelAndEffort(
    fixture.page,
    "gpt-5.6-sol",
    "max",
    { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  )).resolves.toMatchObject({ uiEffortIndex: 4 });
  expect(fixture.value()).toBe(3);
});

test("the four-step browser range keeps Extra High available when Pro is unavailable", async () => {
  await expect(detectChatGptAccountCapabilities(reasoningPicker({ max: "3" }).page as never))
    .resolves.toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: false });
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


test.each([false, true])("effort selection verifies pointer fallback when menu arrow keys stop working (ignored click=%s)", async ignoreClicks => {
  const fixture = reasoningPicker({ initial: 4, ignoreKeys: true, ignoreClicks });
  const worker = Object.assign(Object.create(ChatGptBrowserWorker.prototype), {
    activeComposer: async () => fixture.composer,
  }) as { selectModelAndEffort(...args: unknown[]): Promise<{ uiEffortIndex: number }> };
  const result = worker.selectModelAndEffort(fixture.page,
    "gpt-5.6-sol", "xhigh", { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true });
  if (ignoreClicks) {
    await expect(result).rejects.toMatchObject({ status: 502, code: "chatgpt_model_control_unavailable", retryable: false });
    expect(fixture.value()).toBe(4);
  } else {
    await expect(result).resolves.toMatchObject({ uiEffortIndex: 3 });
    expect(fixture.value()).toBe(3);
  }
  expect(fixture.keys).toEqual(["ArrowLeft"]);
  expect(fixture.clicks[0]).toEqual(["apply", 3]);
  if (ignoreClicks) {
    expect(fixture.clicks[1]).toEqual({
      force: true,
      timeout: 1_000,
      position: {
        x: chatGptEffortSliderTickOffset(240, { min: 0, max: 4 }, 3),
        y: 20,
      },
    });
  } else {
    expect(fixture.clicks).toHaveLength(1);
  }
}, 10_000);

test("slider tick offsets sit on the inset track, not the container edge", () => {
  const state = { min: 0, max: 4 };
  expect(chatGptEffortSliderTickOffset(240, state, 0)).toBe(16);
  expect(chatGptEffortSliderTickOffset(240, state, 4)).toBe(224);
  expect(chatGptEffortSliderTickOffset(240, state, 3)).toBe(172);
});

test("Instant selection does not treat the first Medium radio as Instant", async () => {
  const fixture = reasoningPicker({ initial: 1, ignoreKeys: true, ignoreClicks: true });
  const select = (ChatGptBrowserWorker.prototype as unknown as {
    selectModelAndEffort(...args: unknown[]): Promise<unknown>;
  }).selectModelAndEffort;
  await expect(select.call(
    { activeComposer: async () => fixture.composer },
    fixture.page,
    "gpt-5.6-sol",
    "low",
    { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  )).rejects.toMatchObject({ status: 502, code: "chatgpt_model_control_unavailable", retryable: false });
  expect(fixture.value()).toBe(1);
  expect(fixture.keys).toEqual(["ArrowLeft"]);
}, 10_000);
