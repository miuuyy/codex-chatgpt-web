import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { chatGptWebErrorLogFields, formatChatGptWebLog } from "../src/adapters/chatgpt-web/debug-log";

test("verbose ChatGPT logs stay one-line and omit empty fields", () => {
  expect(formatChatGptWebLog("stage_failed", {
    trace: "abc",
    stage: "send",
    durationMs: 180003,
    timedOut: true,
    unused: undefined,
  })).toBe("[chatgpt-web] event=stage_failed trace=abc stage=send durationMs=180003 timedOut=true");
});

test("verbose ChatGPT logs quote values that contain spaces", () => {
  expect(formatChatGptWebLog("turn_failed", {
    error: "ChatGPT browser stage timed out: send",
  })).toBe("[chatgpt-web] event=turn_failed error=\"ChatGPT browser stage timed out: send\"");
});

test("adapter errors expose code and retryable for bug reports", () => {
  expect(chatGptWebErrorLogFields(new ChatGptWebAdapterError("boom", {
    status: 502,
    errorType: "server_error",
    code: "upstream_server_error",
    retryable: true,
  }))).toMatchObject({
    error: "boom",
    code: "upstream_server_error",
    retryable: true,
    status: 502,
  });
});
