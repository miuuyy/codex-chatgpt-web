import { expect, test } from "bun:test";
import { estimateChatGptWebInputTokens, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt, reconstructChatGptWebMultipartRecords } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/browser-worker";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";
import { CHATGPT_WEB_BACKEND_MODEL, resolveChatGptWebMessageTokenBudget } from "../src/chatgpt-web-models";

const capabilities = { localToolsEnabled: false, solAvailable: true, proAvailable: true };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

function reconstructedMessageContents(parts: readonly string[]): unknown[] {
  return reconstructChatGptWebMultipartRecords(parts).map(record => {
    if (record.kind !== "message") throw new Error("expected message records");
    return record.message.content;
  });
}

test.each([
  ["highly compressible", "a".repeat(480_000)],
  ["ordinary repeated words", `${"word ".repeat(79_999)}word`],
])("%s context uses tokenizer-derived usage without character-pressure inflation", (_label, text) => {
  expect(estimateChatGptWebInputTokens(request(text), capabilities)).toBeLessThan(100_000);
}, 15_000);

test("multipart selection accounts for whole-record and composer fit before submission", () => {
  const plus = { ...capabilities, proAvailable: false };
  for (const [contents, expected] of [
    [["small task"], undefined],
    [[50_000, 40_000, 50_000, 5_000].map(n => "word ".repeat(n)), 3],
    [Array.from({ length: 3 }, () => " ".repeat(450_000)), 2],
  ] as const) {
    const parsed = request("");
    parsed.context.messages = contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const parts = resolveBiggerContextMultipartParts(parsed, plus);
    expect(parts).toBe(expected);
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: parts });
    if (parts) {
      expect(reconstructedMessageContents(compiled.multipart!.parts)).toEqual([...contents]);
    }
  }
}, 90_000);

test("multipart selection uses more than three parts when whole records need them", () => {
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 8 }, (_, index) => ({
    role: "user" as const,
    content: `record-${index}-${"word ".repeat(40_000)}`,
    timestamp: index + 1,
  }));
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBeGreaterThanOrEqual(4);
  expect(parts).toBeLessThanOrEqual(8);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.multipart!.parts).toHaveLength(parts!);
  expect(reconstructedMessageContents(compiled.multipart!.parts))
    .toEqual(parsed.context.messages.map(message => message.content));
}, 30_000);

test("Bigger Context compaction selects three parts before the legacy inline byte budget", () => {
  const parsed = request("x".repeat(160_000));
  parsed._compactionRequest = true;
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(3);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(reconstructedMessageContents(compiled.multipart!.parts))
    .toEqual([parsed.context.messages[0]!.content]);
}, 30_000);

test.each([false, true])("compaction tries wider transport before trimming history (single record: %s)", singleRecord => {
  const parsed = request("");
  parsed._compactionRequest = true;
  parsed.context.messages = singleRecord
    ? [{ role: "user", content: "word ".repeat(350_000), timestamp: 1 }]
    : Array.from({ length: 8 }, (_, index) => ({
      role: "user", content: `record-${index}-${"word ".repeat(40_000)}`, timestamp: index + 1,
    }));
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBeGreaterThan(3);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(reconstructedMessageContents(compiled.multipart!.parts))
    .toEqual(parsed.context.messages.map(message => message.content));
}, 30_000);

test.each([40_000, 34_000])("compaction trims only after exhausting all eight parts (%s-word records)", size => {
  const parsed = request("");
  parsed._compactionRequest = true;
  parsed.context.messages = Array.from({ length: 28 }, (_, index) => ({
    role: "user", content: `record-${index}-${"word ".repeat(size)}`, timestamp: index + 1,
  }));
  parsed.context.messages.push({ role: "user", content: "checkpoint now", timestamp: 29 });
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(8);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeGreaterThan(0);
  expect(reconstructedMessageContents(compiled.multipart!.parts))
    .toEqual(parsed.context.messages.slice(compiled.trimmedCompactionMessages).map(message => message.content));
  for (const [index, message] of compiledChatGptWebMessages(compiled).entries()) {
    const effort = index === parts! - 1 ? "high" : "max";
    expect(estimateTokens(message)).toBeLessThanOrEqual(
      resolveChatGptWebMessageTokenBudget(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities),
    );
  }
}, 30_000);

test("multipart planning leaves room for final attachments and execution instructions without losing history", () => {
  for (const scenario of [
    { proAvailable: false, images: 3, schema: false },
    { proAvailable: true, images: 10, schema: false },
    { proAvailable: false, images: 0, schema: true },
  ]) {
    const caps = { ...capabilities, proAvailable: scenario.proAvailable };
    const parsed = request("");
    const texts = Array.from({ length: 36 }, (_, index) => `record ${index}: ${"word ".repeat(5_000)}`);
    parsed.context.messages = texts.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const images = Array.from({ length: scenario.images }, (_, index) => ({
      type: "image" as const, imageUrl: `data:image/png;base64,partition-image-${index}`, detail: "original" as const,
    }));
    if (images.length) parsed.context.messages.push({ role: "user", content: images, timestamp: 37 });
    if (scenario.schema) parsed.options.outputFormat = {
      type: "json_schema", name: "result", strict: true, schema: { type: "string", description: "schema ".repeat(24_000) },
    };
    const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 3 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message_index)).toEqual(parsed.context.messages.map((_, index) => index));
    expect(records.slice(0, texts.length).map(record => record.message.content)).toEqual(texts);
    expect(compiled.images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })))
      .toEqual(images.map(image => ({ imageUrl: image.imageUrl, detail: image.detail })));
    if (scenario.schema) expect(compiled.multipart!.commit).toContain(JSON.stringify(parsed.options.outputFormat!.schema));
    const messages = compiledChatGptWebMessages(compiled);
    const tokens = messages.map(text => estimateTokens(text));
    const chars = messages.map(text => text.length);
    const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
    const maxStageChars = Math.max(...chars.slice(0, -1));
    const stage = resolveChatGptWebMultipartStagingMode(parsed.modelId, caps, maxStageMessageTokens, maxStageChars);
    expect(() => assertChatGptWebMultipartInputWithinLimits(
      estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId), Math.max(...tokens),
      parsed.modelId, "high", caps, Math.max(...chars), 3,
      { stagingEffort: stage.effort, maxStageMessageTokens, maxStageChars, finalMessageTokens: tokens[2]!, finalMessageChars: chars[2]!, finalImageTokens: estimateChatGptWebImageTokens(compiled) },
    )).not.toThrow();
  }
}, 30_000);
