import { expect, test } from "bun:test";
import {
  assertAuthenticatedChatGptPage,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";

interface TestLocator {
  count(): Promise<number>;
  nth(): { isVisible(): Promise<boolean> };
  or(other: TestLocator): TestLocator;
}

// Observed ChatGPT Temporary Chat DOM fixture: the logged-in composer is a
// textarea with the accessible name "Chat with ChatGPT" and placeholder
// "Temporary chat". The logged-out surface exposes these exact controls.
const CURRENT_CHATGPT_TEMPORARY_CHAT_FIXTURE = {
  composer: {
    tagName: "textarea",
    ariaLabel: "Chat with ChatGPT",
    placeholder: "Temporary chat",
    visible: true,
  },
  loggedOutControls: ["Log in", "Sign up for free"],
} as const;

function visibleLocator(visible: boolean): TestLocator {
  return {
    count: async () => visible ? 1 : 0,
    nth: () => ({ isVisible: async () => visible }),
    or(other: TestLocator) {
      return visible ? this : other;
    },
  };
}

function authenticationPage({ visibleLoginControls = [] }: { visibleLoginControls?: readonly string[] } = {}) {
  const composer = visibleLocator(CURRENT_CHATGPT_TEMPORARY_CHAT_FIXTURE.composer.visible);
  const matchesName = (name: unknown, label: string): boolean => {
    if (name instanceof RegExp) return name.test(label);
    return name === label;
  };
  return {
    locator: () => composer,
    getByRole: (role: string, options?: { name?: string | RegExp }) => {
      if (role !== "button" && role !== "link") return visibleLocator(false);
      return visibleLocator(visibleLoginControls.some(label => matchesName(options?.name, label)));
    },
  };
}

test("composer selector accepts ChatGPT's current accessible textarea", () => {
  expect(CHATGPT_COMPOSER_SELECTOR).toContain('textarea[aria-label="Chat with ChatGPT"]');
  expect(CHATGPT_COMPOSER_SELECTOR).toContain('textarea[placeholder="Temporary chat"]');
  expect(CURRENT_CHATGPT_TEMPORARY_CHAT_FIXTURE.composer).toEqual({
    tagName: "textarea",
    ariaLabel: "Chat with ChatGPT",
    placeholder: "Temporary chat",
    visible: true,
  });
});

test("authentication rejects a visible logged-out ChatGPT prompt", async () => {
  await expect(assertAuthenticatedChatGptPage(authenticationPage({
    visibleLoginControls: CURRENT_CHATGPT_TEMPORARY_CHAT_FIXTURE.loggedOutControls,
  }) as never))
    .rejects.toThrow("visible login controls are present");
});

test("authentication accepts a composer when login controls are absent", async () => {
  await expect(assertAuthenticatedChatGptPage(authenticationPage() as never)).resolves.toBeUndefined();
});

test("the effort selector identifies the model slider instead of any composer menu button", () => {
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).toContain('[data-animated-slider-trigger="true"]');
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
