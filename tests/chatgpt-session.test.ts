import { expect, test } from "bun:test";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  activateChatGptEffortMenu,
  chatGptEffortMenuForControl,
  detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";

test("the effort menu is bound to the control-owned surface without localized text", async () => {
  const ownedMenu = {} as never;
  const control = { getAttribute: async () => "radix-effort-menu" };
  const page = { locator: (selector: string) => {
    expect(selector).toBe('[id="radix-effort-menu"]');
    return ownedMenu;
  } };
  await expect(chatGptEffortMenuForControl(page as never, control as never)).resolves.toBe(ownedMenu);
});

test("effort activation uses one primary pointerdown only after click did not open the owned surface", async () => {
  let visible = false;
  const events: unknown[] = [];
  const control = {
    click: async (options: unknown) => { events.push(["click", options]); },
    getAttribute: async () => "false",
    dispatchEvent: async (name: string, detail: unknown) => {
      events.push([name, detail]);
      visible = true;
    },
  };
  const surface = { isVisible: async () => visible };
  const page = { keyboard: { press: async () => {} } };
  await expect(activateChatGptEffortMenu(page as never, control as never, surface as never, surface as never, {
    settleMs: 0,
  })).resolves.toBe("pointerdown");
  expect(events).toEqual([
    ["click", { force: true }],
    ["pointerdown", { button: 0, buttons: 1, pointerType: "mouse", isPrimary: true }],
  ]);
});

test("effort activation fails closed when neither activation exposes a structural surface", async () => {
  const control = {
    click: async () => {},
    getAttribute: async () => "false",
    dispatchEvent: async () => {},
  };
  const surface = { isVisible: async () => false };
  const page = { keyboard: { press: async () => {} } };
  await expect(activateChatGptEffortMenu(page as never, control as never, surface as never, surface as never, {
    settleMs: 0,
  })).rejects.toThrow("did not expose its owned menu or slider");
});

test("login keeps the established turn composer contract", () => {
  const turnSelectors = CHATGPT_COMPOSER_SELECTOR.split(",").map(selector => selector.trim());
  expect(turnSelectors).toContain('[data-testid="prompt-textarea"]');
  expect(turnSelectors).toContain("#prompt-textarea");
  expect(turnSelectors).toContain('[contenteditable="true"][data-lexical-editor="true"]');
  expect(turnSelectors).not.toContain('form [contenteditable="true"]');
  expect(turnSelectors).not.toContain("form textarea[placeholder]");
});

test("the effort selector identifies the model slider instead of any composer menu button", () => {
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).toContain('button[aria-haspopup="menu"][data-tone="neutral"]');
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).toContain('[data-testid="model-switcher-dropdown-button"]');
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).not.toBe('button[aria-haspopup="menu"]');
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
  })).resolves.toEqual({ solAvailable: false, proAvailable: false });
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
  })).resolves.toEqual({ solAvailable: false, proAvailable: false });
  expect(visibilityReads).toBe(2);
});

test("the new model rows cannot hide an authoritative five-step Pro effort slider", async () => {
  const effortButton = {
    last() { return this; },
    isVisible: async () => true,
    getAttribute: async () => "true",
  };
  const composerForm = {
    locator: () => effortButton,
  };
  const composers = {
    filter() { return this; },
    last() { return this; },
    locator: () => composerForm,
  };
  const efforts = {
    first() { return this; },
    waitFor: async () => {},
    count: async () => 2,
  };
  const menu = {
    last() { return this; },
    isVisible: async () => true,
    locator: () => efforts,
  };
  const slider = {
    filter() { return this; },
    last() { return this; },
    waitFor: async () => {},
    isVisible: async () => true,
    getAttribute: async (name: string) => ({
      "aria-valuemin": "0",
      "aria-valuemax": "4",
      "aria-valuenow": "3",
    })[name] ?? null,
  };
  const page = {
    locator: (selector: string) => {
      if (selector === CHATGPT_COMPOSER_SELECTOR) return composers;
      if (selector === CHATGPT_EFFORT_MENU_SELECTOR) return menu;
      if (selector === CHATGPT_EFFORT_SLIDER_SELECTOR) return slider;
      throw new Error(`Unexpected selector: ${selector}`);
    },
    keyboard: { press: async () => {} },
  };

  await expect(detectChatGptAccountCapabilities(page as never)).resolves.toEqual({
    solAvailable: true,
    proAvailable: true,
  });
});
