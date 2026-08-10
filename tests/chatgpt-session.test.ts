import { expect, test } from "bun:test";
import {
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  detectChatGptAccountCapabilities,
} from "../src/chatgpt-session";

test("the effort selector identifies the model slider instead of any composer menu button", () => {
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).toContain('[data-animated-slider-trigger="true"]');
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).toContain('[data-testid="model-switcher-dropdown-button"]');
  expect(CHATGPT_EFFORT_CONTROL_SELECTOR).not.toBe('button[aria-haspopup="menu"]');
});

test("turn selectors support role nodes without conversation-turn test ids", () => {
  expect(CHATGPT_ASSISTANT_TURN_SELECTOR)
    .toContain('body:not(:has([data-testid^="conversation-turn-"])) [data-message-author-role="assistant"]');
  expect(CHATGPT_USER_TURN_SELECTOR)
    .toContain('body:not(:has([data-testid^="conversation-turn-"])) [data-message-author-role="user"]');
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
