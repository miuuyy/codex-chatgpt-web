import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChatGptWebContextLimits } from "../src/chatgpt-web-models";
import { parseRequest } from "../src/responses/parser";
import { CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET, chatGptPromptJsonBytes, compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateCompiledChatGptWebInputTokens, estimateCompiledChatGptWebMessageTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { ChatGptMessageLimitStore, runWithMessageLimitRecovery } from "../src/adapters/chatgpt-web/message-limit-recovery";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { assertChatGptWebInputWithinLimits } from "../src/adapters/chatgpt-web/transport-budget";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";

const caps = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
const token = `turn_${"0".repeat(32)}`;
const request = () => {
  const p = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: "loudness ".repeat(46_000) });
  p._chatgptModelFamily = "5.6";
  return p;
};

test.each(["5.6", "6"] as const)("Plus Thinking uses its input budget rather than multiplying message windows (%s)", family => {
  const profile = resolveChatGptWebContextLimits("gpt-5.6-sol", "high", { ...caps, experimentalBiggerContext: true }, family);
  expect(profile.contextWindow).toBe(120_000);
  expect(profile.autoCompactTokenLimit).toBe(110_000);
});

test.each([false, true])("Bigger Context keeps a full fitting 100k inline request (local tools=%s)", localToolsEnabled => {
  const p = request(), capabilities = { ...caps, localToolsEnabled };
  const parts = resolveBiggerContextMultipartParts(p, capabilities);
  expect(parts).toBeUndefined();
  const compiled = compileChatGptWebPrompt(p, capabilities, localToolsEnabled ? token : undefined, { experimentalBiggerContext: true });
  const actual = estimateCompiledChatGptWebInputTokens(compiled, p.modelId);
  expect(actual).toBeGreaterThan(90_000);
  expect(actual).toBeLessThan(110_000);
  expect(compiled.biggerContext).toBeTrue();
  expect(estimateChatGptWebUsage(p, { answer: "Done" }, capabilities, true).inputTokens).toBe(actual);
  expect(() => assertChatGptWebInputWithinLimits(actual, actual - 8_192, "gpt-5.6-sol", "high",
    { ...capabilities, experimentalBiggerContext: true }, compiled.text.length, "5.6")).not.toThrow();
  expect(() => assertChatGptWebInputWithinLimits(120_000, 1, "gpt-5.6-sol", "high",
    { ...capabilities, experimentalBiggerContext: true }, 1, "5.6")).toThrow("120,000-token");
}, 30_000);

test.each(["5.6", "6"] as const)("Plus Thinking keeps a full fitting compaction inline (%s)", family => {
  const p = request();
  p._chatgptModelFamily = family;
  p._compactionRequest = true;
  p.context.messages.push({ role: "user", content: "Summarize the checkpoint.", timestamp: 0 });
  const options = { experimentalBiggerContext: true };
  const before = compileChatGptWebPrompt(p, caps, undefined, { ...options, probeUntrimmedCompaction: true });
  expect(chatGptPromptJsonBytes(before.text)).toBeGreaterThan(CHATGPT_COMPACTION_PROMPT_JSON_BYTE_BUDGET);
  const inputTokens = estimateCompiledChatGptWebInputTokens(before, p.modelId);
  expect(inputTokens).toBeGreaterThan(90_000);
  expect(inputTokens).toBeLessThan(120_000);

  for (const messageLimits of [undefined, { chars: 80_000, tokens: 24_000, probeInline: true as const }]) {
    const parts = resolveBiggerContextMultipartParts(p, caps, false, undefined, messageLimits);
    expect(parts).toBeUndefined();
    const compiled = compileChatGptWebPrompt(p, caps, undefined, { ...options, messageLimits, experimentalMultipartParts: parts });
    expect(compiled.text).toBe(before.text);
    expect(compiled.trimmedCompactionMessages).toBeUndefined();
    expect(() => assertChatGptWebInputWithinLimits(inputTokens,
      estimateCompiledChatGptWebMessageTokens(compiled, p.modelId), p.modelId, "high",
      { ...caps, experimentalBiggerContext: true }, compiled.text.length, family)).not.toThrow();
  }
  expect(resolveBiggerContextMultipartParts(p, caps, false, undefined, { chars: 100_000, tokens: 40_000 }))
    .toBeGreaterThan(1);
}, 30_000);

test.each([
  { model: "gpt-5.6-sol", effort: "low", pro: false, ceiling: 41_000 },
  { model: "gpt-5.6-sol", effort: "high", pro: true, ceiling: 111_193 },
  { model: "gpt-5.6-sol", effort: "max", pro: true, ceiling: 112_193 },
  { model: "gpt-5.6-luna", effort: "low", pro: false, ceiling: 28_001 },
] as const)("expanded inline input is limited to the calibrated profile: %j", scenario => {
  const p = parseRequest({ model: scenario.model, reasoning: { effort: scenario.effort }, input: "Control" });
  p._chatgptModelFamily = "5.6";
  const capabilities = { ...caps, proAvailable: scenario.pro, solAvailable: scenario.model !== "gpt-5.6-luna" };
  const compiled = compileChatGptWebPrompt(p, capabilities, undefined, { experimentalBiggerContext: true });
  expect(compiled.biggerContext).toBeUndefined();
  expect(() => assertChatGptWebInputWithinLimits(scenario.ceiling, 1, scenario.model,
    scenario.effort, { ...capabilities, experimentalBiggerContext: true }, 1, "5.6")).toThrow();
});

test("legacy limits permit a bounded fresh inline probe; confirmed single-message limits remain binding", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-legacy-size-")), path = join(root, "limits.json");
  try {
    writeFileSync(path, JSON.stringify({ version: 1, entries: [{ key: "route", limits: { chars: 89_811, tokens: 31_861 }, expiresAt: Date.now() + 60_000 }] }));
    const legacy = new ChatGptMessageLimitStore(path).get("route");
    expect(legacy?.probeInline).toBeTrue();
    expect(resolveBiggerContextMultipartParts(request(), caps, false, undefined, legacy)).toBeUndefined();
    const confirmed = new ChatGptMessageLimitStore().learn("route", { chars: 138_000, tokens: 49_000 });
    expect(confirmed?.probeInline).toBeUndefined();
    expect(resolveBiggerContextMultipartParts(request(), caps, false, undefined, confirmed)).toBeGreaterThan(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test("staged rejection permits a fresh inline retry without permanently narrowing message capacity", async () => {
  const store = new ChatGptMessageLimitStore();
  let recompiled = false, attempts = 0;
  const turn: BrowserTurn = { traceId: "scope-test", modelId: "gpt-5.6-sol", reasoning: "high", capabilities: caps,
    prepare: async () => recompiled ? { text: "complete inline history", images: [], release() {} }
      : { text: "commit", images: [], multipart: { parts: Array.from({ length: 6 }, () => "{}"), commit: "commit" }, release() {} },
    onTextDelta() {},
  };
  const answer = await runWithMessageLimitRecovery(turn, async next => {
    const p = await next.prepare(); attempts++;
    if (attempts === 1) throw new ChatGptWebAdapterError("Observed current input rejection", {
      status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false,
      inputRejected: true, rejectedMessageSize: { chars: 138_000, tokens: 49_000 },
    });
    expect(p.multipart).toBeUndefined();
    next.onTextDelta("Accepted");
    return "Accepted";
  }, "route", limits => { expect(limits.probeInline).toBeTrue(); recompiled = true; }, store);
  expect(answer).toBe("Accepted");
  expect(attempts).toBe(2);
  expect(store.get("route")).toBeUndefined();
});

test("fresh evidence supersedes legacy guesses and remains persistent across context-only failures", () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-size-confidence-")), path = join(root, "limits.json");
  try {
    const store = new ChatGptMessageLimitStore(path);
    store.learn("route", { chars: 138_000, tokens: 49_000 }, true);
    const restarted = new ChatGptMessageLimitStore(path);
    expect(restarted.get("route")?.probeInline).toBeTrue();
    const confirmed = restarted.learn("route", { chars: 400_000, tokens: 90_000 });
    expect(confirmed).toEqual({ chars: 260_000, tokens: 58_500 });
    const fresh = new ChatGptMessageLimitStore(path);
    expect(fresh.get("route")).toEqual(confirmed);
    fresh.learn("route", { chars: 80_000, tokens: 24_000 }, true);
    expect(new ChatGptMessageLimitStore(path).get("route")).toEqual(confirmed);
    fresh.forget("route");
    expect(new ChatGptMessageLimitStore(path).get("route")).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a successful abbreviated retained message cannot invalidate a full-request limit", async () => {
  const store = new ChatGptMessageLimitStore();
  store.learn("route", { chars: 138_000, tokens: 49_000 }, true);
  const turn: BrowserTurn = { traceId: "retained-scope-test", modelId: "gpt-5.6-sol", capabilities: caps,
    prepare: async () => ({ text: "full context", images: [], release() {} }),
    prepareResume: async () => ({ text: "small suffix", images: [], release() {} }), onTextDelta() {},
  };
  await runWithMessageLimitRecovery(turn, async next => {
    await next.onPreparedSelected?.(true);
    await next.prepareResume!();
    return "Accepted suffix";
  }, "route", () => {}, store);
  expect(store.get("route")?.probeInline).toBeTrue();
});
