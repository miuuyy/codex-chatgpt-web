import { expect, test } from "bun:test";
import {
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  chatGptAuthenticationSurfaceReady,
  detectChatGptAccountCapabilities,
  isAuthenticatedTemporaryChatPage,
} from "../src/chatgpt-session";

test("login keeps the established turn composer contract", () => {
  const turnSelectors = CHATGPT_COMPOSER_SELECTOR.split(",").map(selector => selector.trim());
  expect(turnSelectors).toContain('[data-testid="prompt-textarea"]');
  expect(turnSelectors).toContain("#prompt-textarea");
  expect(turnSelectors).toContain('[contenteditable="true"][data-lexical-editor="true"]');
  expect(turnSelectors).not.toContain('form [contenteditable="true"]');
  expect(turnSelectors).not.toContain("form textarea[placeholder]");
});

test("login requires one atomic Temporary Chat composer observation", async () => {
  expect(chatGptAuthenticationSurfaceReady({
    url: "https://chatgpt.com/auth/login",
    visibleComposerCount: 1,
    sessionAuthenticated: true,
  })).toBe(false);
  expect(chatGptAuthenticationSurfaceReady({
    url: "https://chatgpt.com/?temporary-chat=true",
    visibleComposerCount: 0,
    sessionAuthenticated: true,
  })).toBe(false);
  expect(chatGptAuthenticationSurfaceReady({
    url: "https://chatgpt.com/?temporary-chat=true",
    visibleComposerCount: 2,
    sessionAuthenticated: true,
  })).toBe(false);
  expect(chatGptAuthenticationSurfaceReady({
    url: "https://example.com/?temporary-chat=true",
    visibleComposerCount: 1,
    sessionAuthenticated: true,
  })).toBe(false);
  expect(chatGptAuthenticationSurfaceReady({
    url: "https://chatgpt.com/?temporary-chat=true",
    visibleComposerCount: 1,
    sessionAuthenticated: false,
  })).toBe(false);
  expect(chatGptAuthenticationSurfaceReady({
    url: "https://chatgpt.com/?temporary-chat=true",
    visibleComposerCount: 1,
    sessionAuthenticated: true,
  })).toBe(true);

  let evaluations = 0;
  let callbackSource = "";
  const page = {
    evaluate: async (callback: unknown, input: { composerSelector: string }) => {
      evaluations += 1;
      callbackSource = String(callback);
      expect(input.composerSelector).toBe(CHATGPT_COMPOSER_SELECTOR);
      return {
        url: "https://chatgpt.com/?temporary-chat=true",
        visibleComposerCount: 1,
        sessionAuthenticated: true,
      };
    },
  };
  await expect(isAuthenticatedTemporaryChatPage(page as never)).resolves.toBe(true);
  expect(evaluations).toBe(1);
  expect(callbackSource).toContain("location.href");
  expect(callbackSource).toContain("document.querySelectorAll(composerSelector)");
  expect(callbackSource).toContain("bounds.width > 0");
  expect(callbackSource).toContain("bounds.height > 0");
  expect(callbackSource).toContain('/api/auth/session');
  expect(callbackSource).toContain("session.user");

  const navigatingPage = {
    evaluate: async () => { throw new Error("Execution context was destroyed"); },
  };
  await expect(isAuthenticatedTemporaryChatPage(navigatingPage as never)).resolves.toBe(false);
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
