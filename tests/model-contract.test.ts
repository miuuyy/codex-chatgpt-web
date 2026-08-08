import { expect, test } from "bun:test";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";

test("the browser adapter maps fixed routed efforts to the visible ChatGPT modes", () => {
  const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: true };
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
    localTools: false,
  });
});

test("capabilities gate tools and Pro-only efforts explicitly without changing the selected model", () => {
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "high", {
    localToolsEnabled: false,
    solAvailable: true,
    proAvailable: true,
  })).toMatchObject({ localTools: false });
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "max", {
    localToolsEnabled: false,
    solAvailable: true,
    proAvailable: false,
  })).toThrow("Pro effort is not available");
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "xhigh", {
    localToolsEnabled: true,
    solAvailable: true,
    proAvailable: false,
  })).toThrow("Extra High effort is not available");
  expect(() => resolveChatGptWebModelMode("unknown", "high", {
    localToolsEnabled: false,
    solAvailable: true,
    proAvailable: true,
  })).toThrow("model is not supported");
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "turbo", {
    localToolsEnabled: false,
    solAvailable: true,
    proAvailable: true,
  })).toThrow("effort is not supported");
});

test("Luna-only capability binds the default model without a UI effort selector", () => {
  expect(resolveChatGptWebModelMode(CHATGPT_WEB_LUNA_MODEL_ID, "low", {
    localToolsEnabled: true,
    solAvailable: false,
    proAvailable: false,
  })).toEqual({
    modelId: CHATGPT_WEB_LUNA_MODEL_ID,
    effort: "low",
    displayLabel: "Luna",
    uiEffortIndex: null,
    localTools: true,
  });
  expect(() => resolveChatGptWebModelMode(CHATGPT_WEB_MODEL_ID, "low", {
    localToolsEnabled: false,
    solAvailable: false,
    proAvailable: false,
  })).toThrow("Luna-only account");
});
