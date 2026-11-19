import { expect, test } from "bun:test";
import { resolveChatGptWebContextLimits } from "../src/chatgpt-web-models";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { assertChatGptWebInputWithinLimits } from "../src/adapters/chatgpt-web/browser-worker";

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

