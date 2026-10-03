import { expect, test } from "bun:test";
import { chatGptRoundFailureEvidence, isChatGptObserverAbort } from "../src/adapters/chatgpt-web/round-observer";

test("an aborted observer does not classify validation and browser errors as disconnection", () => {
  const signal = AbortSignal.abort();
  expect(isChatGptObserverAbort(new Error("environment changed"), signal)).toBeFalse();
  expect(isChatGptObserverAbort(Object.assign(new Error(), { name: "AbortError" }))).toBeFalse();
  expect(isChatGptObserverAbort(Object.assign(new Error(), { code: "ABORT_ERR" }), signal)).toBeTrue();
});

test("failure evidence exposes only fixed classifications, including nested private error data", () => {
  const privateValue = "private_credential_and_prompt";
  const error = Object.assign(new Error(privateValue, { cause: new Error(privateValue) }), {
    name: privateValue, code: privateValue, stack: privateValue,
  });
  expect(chatGptRoundFailureEvidence(error)).toEqual({ errorName: "unknown", errorCode: "unknown" });
  expect(chatGptRoundFailureEvidence(Object.assign(new Error(privateValue), {
    code: "codex_tool_timeout",
  }))).toEqual({ errorName: "Error", errorCode: "codex_tool_timeout" });
});
