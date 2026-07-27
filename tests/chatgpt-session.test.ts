import { describe, expect, test } from "bun:test";
import { assertAuthenticatedChatGptPage, type ChatGptSessionState } from "../src/chatgpt-session";
import type { CdpPage } from "../src/chrome-cdp";

const state = (overrides: Partial<ChatGptSessionState> = {}): ChatGptSessionState => ({
  url: "https://chatgpt.com/?temporary-chat=true",
  atChatGpt: true,
  temporaryChat: true,
  loginVisible: false,
  sessionAuthenticated: true,
  accountVisible: false,
  composerVisible: true,
  webdriver: false,
  ...overrides,
});

const page = (value: ChatGptSessionState): CdpPage => ({
  evaluate: async () => value,
}) as unknown as CdpPage;

describe("ChatGPT session verification", () => {
  test("accepts an authenticated session when the profile control is absent", async () => {
    await expect(assertAuthenticatedChatGptPage(page(state()))).resolves.toBeUndefined();
  });

  test("keeps the visible account control as a fallback", async () => {
    await expect(assertAuthenticatedChatGptPage(page(state({
      sessionAuthenticated: false,
      accountVisible: true,
    })))).resolves.toBeUndefined();
  });

  test("rejects a signed-out page", async () => {
    await expect(assertAuthenticatedChatGptPage(page(state({
      loginVisible: true,
      sessionAuthenticated: false,
    })))).rejects.toThrow("signed out");
  });

  test("rejects an authenticated page without a composer", async () => {
    await expect(assertAuthenticatedChatGptPage(page(state({
      composerVisible: false,
    })))).rejects.toThrow("composer is unavailable");
  });
});
