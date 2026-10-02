import { expect, test } from "bun:test";
import { compileChatGptWebPrompt, createChatGptWebPromptPreparation, isChatGptWebMultipartPartCount } from "../src/adapters/chatgpt-web/prompt";
import { resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { compiledChatGptWebMessages, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits } from "../src/adapters/chatgpt-web/browser-worker";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";

const plus = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };

test("one request preparation reuses records while another request cannot reuse its history or capability", () => {
  const parsed = fixture(2);
  const preparation = createChatGptWebPromptPreparation(parsed);
  compileChatGptWebPrompt(parsed, plus, "turn_11111111111111111111111111111111", { experimentalMultipartParts: 6, preparation });
  const original = preparation.records!.prepared;
  const next = compileChatGptWebPrompt(parsed, plus, "turn_22222222222222222222222222222222", { experimentalMultipartParts: 8, preparation });
  expect(preparation.records!.prepared).toBe(original);
  expect(next.multipart!.commit).toContain("turn_22222222222222222222222222222222");
  expect(next.multipart!.commit).not.toContain("turn_11111111111111111111111111111111");
  expect(() => compileChatGptWebPrompt(fixture(2), plus, "turn_22222222222222222222222222222222", { experimentalMultipartParts: 6, preparation }))
    .toThrow("another request");
});

function fixture(recordCount = 24): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol", stream: false, options: { reasoning: "high" },
    context: { messages: Array.from({ length: recordCount }, (_, index) => ({
      role: "user", timestamp: index, content: `record ${index}: ${"history word ".repeat(1_550)}end`,
    })) },
  };
}

test.each([false, true])("large Plus history respects every server message boundary (compaction=%s)", compaction => {
  const parsed = fixture();
  if (compaction) parsed._compactionRequest = true;
  const parts = resolveBiggerContextMultipartParts(parsed, plus);
  expect(parts).toBeGreaterThan(6);
  const compiled = compileChatGptWebPrompt(parsed, plus, compaction ? undefined : "turn_00000000000000000000000000000000", { experimentalMultipartParts: parts });
  const messages = compiledChatGptWebMessages(compiled);
  expect(Math.max(...messages.map(m => m.length))).toBeLessThanOrEqual(60_000);
  expect(compiled.multipart!.parts.flatMap(p => JSON.parse(p).records).map(r => r.message.content))
    .toEqual(parsed.context.messages.map(m => m.content));
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId),
    Math.max(...messages.map(m => estimateTokens(m))), parsed.modelId, "high", plus,
    Math.max(...messages.map(m => m.length)), parts!,
  )).not.toThrow();
}, 30_000);

test("thirty-two transport parts do not enlarge the advertised total context", () => {
  for (let count = 2; count <= 32; count += 2) expect(isChatGptWebMultipartPartCount(count)).toBe(true);
  for (const count of [0, 1, 3, 13, 33, 34, 2.5]) expect(isChatGptWebMultipartPartCount(count)).toBe(false);
  expect(() => assertChatGptWebMultipartInputWithinLimits(270_000, 20_000, "gpt-5.6-sol", "high", plus, 50_000, 32))
    .toThrow("270,000-token 32-part ceiling");
});

test.each([false, true])("history beyond twelve transport parts preserves whole records (compaction=%s)", compaction => {
  const parsed = fixture(44);
  if (compaction) parsed._compactionRequest = true;
  const parts = resolveBiggerContextMultipartParts(parsed, plus, true);
  expect(parts).toBeGreaterThan(12);
  const compiled = compileChatGptWebPrompt(parsed, plus, compaction ? undefined : "turn_00000000000000000000000000000000", {
    experimentalMultipartParts: parts, experimentalSkillAttachments: true,
  });
  const messages = compiledChatGptWebMessages(compiled);
  expect(Math.max(...messages.map(message => message.length))).toBeLessThanOrEqual(60_000);
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId),
    Math.max(...messages.map(message => estimateTokens(message))), parsed.modelId, "high", plus,
    Math.max(...messages.map(message => message.length)), parts!,
  )).not.toThrow();
}, 30_000);
