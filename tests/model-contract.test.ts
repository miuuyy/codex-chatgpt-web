import { expect, test } from "bun:test";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, nextChatGptWebFallbackEffort, resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";

test("the browser adapter maps fixed routed efforts to the visible ChatGPT modes", () => {
  const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", capabilities)).toMatchObject({
    displayLabel: "Instant",
    uiEffortIndex: 0,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "medium", capabilities)).toMatchObject({
    uiEffortIndex: 1,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", capabilities)).toMatchObject({
    uiEffortIndex: 2,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", capabilities)).toMatchObject({
    uiEffortIndex: 3,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "max", capabilities)).toMatchObject({
    uiEffortIndex: 4,
    localTools: true,
  });
});

test("a failing reasoning mode steps down to the next account-visible effort", () => {
  const pro = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
  expect(nextChatGptWebFallbackEffort("max", pro)).toBe("xhigh");
  expect(nextChatGptWebFallbackEffort("xhigh", pro)).toBe("high");
  expect(nextChatGptWebFallbackEffort("high", pro)).toBe("medium");
  expect(nextChatGptWebFallbackEffort("medium", pro)).toBe("low");
  expect(nextChatGptWebFallbackEffort("low", pro)).toBeUndefined();
  expect(nextChatGptWebFallbackEffort("max", {
    localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: true,
  })).toBe("high");
  expect(nextChatGptWebFallbackEffort("low", pro, CHATGPT_WEB_LUNA_MODEL_ID)).toBeUndefined();
});

test("capabilities gate tools and Pro-only efforts explicitly without changing the selected model", () => {
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true, proAvailable: true,
  })).toMatchObject({ localTools: false });
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "max", {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: false, proAvailable: false,
  })).toThrow("Pro effort is not available");
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", {
    localToolsEnabled: true,
    solAvailable: true,
    extraHighAvailable: false, proAvailable: false,
  })).toThrow("Extra High effort is not available");
  expect(() => resolveChatGptWebModelMode("unknown", "high", {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true, proAvailable: true,
  })).toThrow("model is not supported");
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "turbo", {
    localToolsEnabled: false,
    solAvailable: true,
    extraHighAvailable: true, proAvailable: true,
  })).toThrow("effort is not supported");
});

test("Luna-only capability binds the default model without a UI effort selector", () => {
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, "low", {
    localToolsEnabled: true,
    solAvailable: false,
    extraHighAvailable: false, proAvailable: false,
  })).toEqual({
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    effort: "low",
    displayLabel: "Luna",
    uiEffortIndex: null,
    thinkEnabled: false,
    localTools: true,
  });
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, "medium", {
    localToolsEnabled: true,
    solAvailable: false,
    extraHighAvailable: false, proAvailable: false,
  })).toEqual({
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    effort: "medium",
    displayLabel: "Think",
    uiEffortIndex: null,
    thinkEnabled: true,
    localTools: true,
  });
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", {
    localToolsEnabled: false,
    solAvailable: false,
    extraHighAvailable: false, proAvailable: false,
  })).toThrow("Luna-only account");
});
