import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptWebTurnRetryPolicy } from "../src/adapters/chatgpt-web/retry-policy";

const rateLimit = () => new ChatGptWebAdapterError(
  "ChatGPT rate limit: too many requests. Try again in a few minutes.",
  { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
);

test("rate-limit cooldown escalates 15m then 30m then 60m across repeated 429s", () => {
  const policy = new ChatGptWebTurnRetryPolicy();
  const scope = "account-a";

  const first = policy.recordRateLimit(scope, "turn-1", rateLimit(), 0);
  expect(first.message).toContain("900s");
  expect(policy.cooldownError(scope, 15 * 60_000)).toBeUndefined();

  const second = policy.recordRateLimit(scope, "turn-2", rateLimit(), 15 * 60_000);
  expect(second.message).toContain("1800s");
  expect(policy.cooldownError(scope, 45 * 60_000)).toBeUndefined();

  const third = policy.recordRateLimit(scope, "turn-3", rateLimit(), 45 * 60_000);
  expect(third.message).toContain("3600s");
});

test("a successful browser completion resets the account cooldown escalation", () => {
  const policy = new ChatGptWebTurnRetryPolicy();
  const scope = "account-b";
  policy.recordRateLimit(scope, "turn-1", rateLimit(), 0);
  policy.recordRateLimit(scope, "turn-2", rateLimit(), 15 * 60_000);

  policy.recordSuccess(scope, "turn-2");
  const afterSuccess = policy.recordRateLimit(scope, "turn-3", rateLimit(), 16 * 60_000);
  expect(afterSuccess.message).toContain("900s");
});
