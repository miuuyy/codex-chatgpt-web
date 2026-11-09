import { expect, test } from "bun:test";
import { estimateTokens } from "../src/lib/token-estimate";
import { compileChatGptWebPrompt, formatChatGptWebMultipartCommit } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { CHATGPT_LUNA_CHECKPOINT_MARKER } from "../src/adapters/chatgpt-web/rolling-checkpoint";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET, CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, resolveChatGptWebMessageTokenBudget } from "../src/chatgpt-web-models";
import { parseRequest } from "../src/responses/parser";
import type { CodexParsedRequest } from "../src/types";

const caps = { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false };
const model = "gpt-5.6-luna";
function request(count: number, words: number, reasoning = "low"): CodexParsedRequest {
  return parseRequest({ model, reasoning: { effort: reasoning }, stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "luna-bigger", turn_id: "turn-one" }) },
    input: Array.from({ length: count }, (_, index) => ({ type: "message", role: "user",
      content: [{ type: "input_text", text: `record ${index}: ${"word ".repeat(words)}` }] })),
  });
}

test("Luna plans 1/2/6 messages against Free budgets and preserves every complete record", () => {
  for (const effort of ["low", "medium"]) for (const [count, words, expected] of [[1, 1000, 1], [4, 7500, 2], [8, 6000, 6]]) {
    const parsed = request(count!, words!, effort);
    const original = structuredClone(parsed);
    const parts = resolveBiggerContextMultipartParts(parsed, caps);
    expect(parts ?? 1).toBe(expected);
    const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts });
    const messages = compiledChatGptWebMessages(compiled);
    expect(messages).toHaveLength(expected!);
    for (const message of messages) expect(estimateTokens(message) + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS)
      .toBeLessThanOrEqual(CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET);
    if (parts) {
      expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
        .toEqual(parsed.context.messages.map(message => message.content));
      expect(() => assertChatGptWebMultipartInputWithinLimits(
        estimateCompiledChatGptWebInputTokens(compiled, model), Math.max(...messages.map(text => estimateTokens(text))),
        model, effort as "low" | "medium", caps, Math.max(...messages.map(text => text.length)), parts,
      )).not.toThrow();
      expect(resolveChatGptWebMultipartStagingMode(model, caps,
        Math.max(...messages.slice(0, -1).map(text => estimateTokens(text))),
        Math.max(...messages.slice(0, -1).map(text => text.length))).displayLabel).toBe("Luna");
    }
    expect(estimateChatGptWebUsage(parsed, { answer: "done" }, caps, true).inputTokens)
      .toBe(estimateCompiledChatGptWebInputTokens(compiled, model));
    expect(compiled.text).not.toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
    expect(parsed).toEqual(original);
  }
}, 30000);

test("Luna multipart preflight bounds the total, each part and final attachments separately", () => {
  expect(resolveChatGptWebMessageTokenBudget(model, "medium", caps, 4096)).toBe(15712);
  expect(() => assertChatGptWebMultipartInputWithinLimits(84000, 18000, model, "low", caps, 100000, 6))
    .toThrow("84,000-token six-part ceiling");
  expect(() => resolveChatGptWebMultipartStagingMode(model, caps, 19809, 100000)).toThrow("No ChatGPT effort");
  expect(() => assertChatGptWebMultipartInputWithinLimits(45000, 18000, model, "medium", caps, 100000, 6, {
    stagingEffort: "low", maxStageMessageTokens: 12000, maxStageChars: 50000,
    finalMessageTokens: 18000, finalMessageChars: 90000, finalImageTokens: 4096,
  })).toThrow("after reserving space for ChatGPT and attachments");
  const parsed = request(1, 25000);
  const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6 });
  // Parts cannot turn one oversized native message into silently truncated data.
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  const largest = Math.max(...compiledChatGptWebMessages(compiled).map(text => estimateTokens(text)));
  expect(() => assertChatGptWebMultipartInputWithinLimits(50000, largest, model, "low", caps, 150000, 6))
    .toThrow("ChatGPT message boundary");
});

test("Luna compaction uses a bounded two-part handoff without also capturing a rolling summary", () => {
  const parsed = request(4, 2000);
  parsed._compactionRequest = true;
  expect(resolveBiggerContextMultipartParts(parsed, caps)).toBe(2);
  const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 2 });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(formatChatGptWebMultipartCommit(compiled.multipart!, `ctx_${"0".repeat(32)}`)).not.toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  parsed._compactionRequest = false;
  expect(compileChatGptWebPrompt(parsed, caps, undefined, { captureLunaCheckpoint: true }).text)
    .toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  expect(() => compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6, captureLunaCheckpoint: true }))
    .toThrow("native compaction");
});
