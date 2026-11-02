import { expect, test } from "bun:test";
import {
  compileChatGptWebPrompt,
  type CompiledChatGptWebPrompt,
} from "../src/adapters/chatgpt-web/prompt";
import {
  compiledChatGptWebMessages,
  estimateChatGptWebImageTokens,
  estimateCompiledChatGptWebInputTokens,
} from "../src/adapters/chatgpt-web/input-tokens";
import {
  assertChatGptWebMultipartInputWithinLimits,
  resolveChatGptWebMultipartStagingMode,
} from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "../src/adapters/chatgpt-web/model";
import { skillFileTokens } from "../src/adapters/chatgpt-web/skill-attachments";
import { estimateTokens } from "../src/lib/token-estimate";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import type { CodexParsedRequest } from "../src/types";

const capabilities: ChatGptWebCapabilities = {
  localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true, proPlan: true,
};
const turnToken = `turn_${"0".repeat(32)}`;

function request(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    _chatgptModelFamily: "6",
    _compactionRequest: true,
    context: { systemPrompt: ["preserve system instructions"], messages: [] },
    stream: false,
    options: { reasoning: "xhigh" },
  };
}

function assertMultipartFits(
  compiled: CompiledChatGptWebPrompt,
  parsed: CodexParsedRequest,
  caps = capabilities,
): void {
  const messages = compiledChatGptWebMessages(compiled);
  const tokens = messages.map(message => estimateTokens(message, parsed.modelId));
  const chars = messages.map(message => message.length);
  const maxStageMessageTokens = Math.max(...tokens.slice(0, -1));
  const maxStageChars = Math.max(...chars.slice(0, -1));
  const staging = resolveChatGptWebMultipartStagingMode(parsed.modelId, caps, maxStageMessageTokens, maxStageChars);
  const finalMessageTokens = tokens.at(-1)! + skillFileTokens(compiled.skillFiles, parsed.modelId);
  assertChatGptWebMultipartInputWithinLimits(
    estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId),
    Math.max(...tokens.slice(0, -1), finalMessageTokens),
    parsed.modelId, resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, caps).effort,
    caps, Math.max(...chars), compiled.multipart!.parts.length,
    { stagingEffort: staging.effort, maxStageMessageTokens, maxStageChars,
      finalMessageTokens, finalMessageChars: chars.at(-1)!, finalImageTokens: estimateChatGptWebImageTokens(compiled) },
    parsed._chatgptModelFamily,
  );
}

test.each(["string", "text parts"] as const)("#930: GPT-6 Pro compaction recovers above the six-part ceiling (%s checkpoint)", checkpointFormat => {
  const parsed = request();
  const checkpoint = `${SUMMARY_PREFIX}\nVerified cumulative progress and pending work`;
  parsed.context.messages = [
    { role: "user", content: `${SUMMARY_PREFIX}\nObsolete checkpoint`, timestamp: 1 },
    { role: "user", content: checkpointFormat === "text parts" ? [{ type: "text", text: checkpoint }] : checkpoint, timestamp: 2 },
    ...Array.from({ length: 12 }, (_, index) => ({
      role: "toolResult" as const, toolCallId: `read-${index}`, toolName: "read", isError: false,
      content: `history-${index} ${"word ".repeat(22_000)}`, timestamp: index + 3,
    })),
    { role: "assistant", content: [{ type: "text", text: "recent verified progress" }], timestamp: 15 },
    { role: "user", content: "Produce the cumulative checkpoint now.", timestamp: 16 },
  ];
  const before = structuredClone(parsed);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 });

  expect(() => assertMultipartFits(compiled, parsed)).not.toThrow();
  expect(compiled.multipart!.parts).toHaveLength(6);
  expect(compiled.trimmedCompactionMessages).toBe(3);
  const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
  expect(records[0].content).toBe(parsed.context.systemPrompt![0]);
  const messages = records.filter(record => record.kind === "message").map(record => record.message);
  expect(messages[0].content).toBe(checkpoint);
  expect(messages.slice(1, -2).map(message => message.tool_call_id))
    .toEqual(Array.from({ length: 10 }, (_, index) => `read-${index + 2}`));
  expect(messages.at(-2).content).toEqual([{ type: "text", text: "recent verified progress" }]);
  expect(messages.at(-1).content).toBe("Produce the cumulative checkpoint now.");
  expect(compiled.multipart!.commit).toContain("3 earlier history items were omitted");
  expect(compiled.multipart!.commit).toContain("the supplied history is incomplete");
  expect(compiled.multipart!.commit).toContain("Preserve still-relevant progress, constraints and pending work");
  expect(compiled.multipart!.commit).not.toContain("The task context is complete.");
  expect(parsed).toEqual(before);
}, 30_000);

test.each([
  { family: "6", pro: true, effort: "xhigh", parts: 2, count: 12, words: 20_000, ceiling: 222_386 },
  { family: "6", pro: false, effort: "high", parts: 2, count: 7, words: 20_000, ceiling: 120_000 },
  { family: "6", pro: false, effort: "high", parts: 6, count: 7, words: 20_000, ceiling: 120_000 },
  { family: "5.6", pro: false, effort: "high", parts: 6, count: 14, words: 20_000, ceiling: 270_000 },
  { family: "5.6", pro: true, effort: "high", parts: 6, count: 17, words: 20_000, ceiling: 333_579 },
  { family: "6", pro: true, effort: "max", parts: 6, count: 17, words: 20_000, ceiling: 336_579 },
] as const)("compaction uses the browser's account, family, effort and part-count ceiling: %j", scenario => {
  const parsed = request();
  parsed._chatgptModelFamily = scenario.family;
  parsed.options.reasoning = scenario.effort;
  parsed.context.messages = [
    ...Array.from({ length: scenario.count }, (_, index) => ({
      // Keep character pressure independent of the total-token boundary under test.
      role: "user" as const, content: `history-${index} ${"x ".repeat(scenario.words)}`, timestamp: index + 1,
    })),
    { role: "user", content: "checkpoint now", timestamp: scenario.count + 1 },
  ];
  const caps = { ...capabilities, proAvailable: scenario.pro, proPlan: scenario.pro };
  const compiled = compileChatGptWebPrompt(parsed, caps, turnToken, { experimentalMultipartParts: scenario.parts });
  expect(compiled.trimmedCompactionMessages).toBeGreaterThan(0);
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeLessThan(scenario.ceiling);
  expect(() => assertMultipartFits(compiled, parsed, caps)).not.toThrow();
  const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
  const contents = records.filter(record => record.kind === "message").map(record => record.message.content);
  expect(contents).toEqual(parsed.context.messages.slice(compiled.trimmedCompactionMessages).map(message => message.content));
  expect(compiled.multipart!.commit).toContain(`${compiled.trimmedCompactionMessages} earlier history items were omitted`);
}, 30_000);

test("Luna multipart compaction uses its experimental ceiling instead of its rolling context window", () => {
  const parsed = request();
  parsed.modelId = CHATGPT_WEB_LUNA_MODEL_ID;
  delete parsed._chatgptModelFamily;
  parsed.options.reasoning = "low";
  parsed.context.messages = [
    ...Array.from({ length: 11 }, (_, index) => ({
      role: "user" as const, content: `history-${index} ${"word ".repeat(8_000)}`, timestamp: index + 1,
    })),
    { role: "user", content: "checkpoint now", timestamp: 12 },
  ];
  const caps = { ...capabilities, solAvailable: false, extraHighAvailable: false, proAvailable: false, proPlan: false };
  const compiled = compileChatGptWebPrompt(parsed, caps, turnToken, { experimentalMultipartParts: 6 });
  expect(compiled.trimmedCompactionMessages).toBeGreaterThan(0);
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeLessThan(84_000);
  expect(() => assertMultipartFits(compiled, parsed, caps)).not.toThrow();
});

test("multipart compaction keeps history just below the ceiling without an extra percentage margin", () => {
  const parsed = request();
  parsed.context.messages = [
    ...Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const, content: `history-${index} ${"word ".repeat(22_400)}`, timestamp: index + 1,
    })),
    { role: "user", content: "checkpoint now", timestamp: 11 },
  ];
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 });
  const tokens = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
  expect(tokens).toBeGreaterThan(235_000);
  expect(tokens).toBeLessThan(240_000);
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .filter(record => record.kind === "message").map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  expect(compiled.multipart!.commit).not.toContain("history is incomplete");
  expect(() => assertMultipartFits(compiled, parsed)).not.toThrow();
});

test("ordinary multipart turns retain all history and fail preflight above the ceiling", () => {
  const parsed = request();
  delete parsed._compactionRequest;
  parsed.context.messages = Array.from({ length: 12 }, (_, index) => ({
    role: "user", content: `history-${index} ${"word ".repeat(22_000)}`, timestamp: index + 1,
  }));
  const before = structuredClone(parsed);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .filter(record => record.kind === "message").map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  expect(() => assertMultipartFits(compiled, parsed)).toThrow("240,000-token six-part ceiling");
  expect(parsed).toEqual(before);
});

test.each(["checkpoint", "final instruction", "system"] as const)(
  "multipart compaction fails closed when required %s exceeds the total ceiling", required => {
    const parsed = request();
    parsed.context.messages = [
      { role: "user", content: "discardable history", timestamp: 1 },
      { role: "user", content: "checkpoint now", timestamp: 3 },
    ];
    const oversized = "word ".repeat(240_000);
    if (required === "checkpoint") {
      parsed.context.messages.splice(1, 0, {
        role: "user", content: `${SUMMARY_PREFIX}\n${oversized}`, timestamp: 2,
      });
    } else if (required === "final instruction") {
      parsed.context.messages.at(-1)!.content = oversized;
    } else {
      parsed.context.systemPrompt = Array.from({ length: 4 }, () => "word ".repeat(60_000));
    }
    const before = structuredClone(parsed);
    let error: unknown;
    try {
      compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "context_length_exceeded", retryable: false, status: 400 });
    expect((error as Error).message).toContain("after other history was trimmed");
    expect((error as Error).message).toContain("240,000-token six-part ceiling");
    if (required === "checkpoint") expect((error as Error).message).toContain("cumulative checkpoint");
    expect((error as Error).message).not.toContain("Run /compact");
    expect(parsed).toEqual(before);
  }, 30_000,
);

test("multipart compaction keeps atomic records below the total ceiling and still rejects oversized stages", () => {
  const parsed = request();
  parsed.context.messages = [
    { role: "user", content: "word ".repeat(110_000), timestamp: 1 },
    { role: "user", content: "checkpoint now", timestamp: 2 },
  ];
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts: 6 });
  expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)).toBeLessThan(240_000);
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records)
    .filter(record => record.kind === "message").map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  expect(() => assertMultipartFits(compiled, parsed)).toThrow("No ChatGPT effort available");
});

test("multipart compaction counts and rebuilds image and skill attachments after trimming", () => {
  const parsed = request();
  parsed.context.messages = [
    { role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,old-image", detail: "original" }], timestamp: 1 },
    { role: "user", origin: "codex_skill", content: `<skill><name>old-skill</name>${"word ".repeat(8_000)}</skill>`, timestamp: 2 },
    ...Array.from({ length: 10 }, (_, index) => ({
      role: "user" as const, content: `history-${index} ${"word ".repeat(22_000)}`, timestamp: index + 3,
    })),
    { role: "user", content: [{ type: "image", imageUrl: "data:image/png;base64,new-image", detail: "original" }], timestamp: 13 },
    { role: "user", origin: "codex_skill", content: `<skill><name>new-skill</name>${"word ".repeat(3_000)}</skill>`, timestamp: 14 },
    { role: "user", content: "checkpoint now", timestamp: 15 },
  ];
  const before = structuredClone(parsed);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, {
    experimentalMultipartParts: 6, experimentalSkillAttachments: true, includeContextTokenBreakdown: true,
  });
  expect(compiled.trimmedCompactionMessages).toBe(3);
  expect(compiled.images).toEqual([{ ref: "codex-input-image-1", imageUrl: "data:image/png;base64,new-image", detail: "original" }]);
  expect(compiled.skillFiles).toHaveLength(1);
  expect(compiled.skillFiles![0]!.text).toBe(parsed.context.messages.at(-2)!.content as string);
  const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
  const messages = records.filter(record => record.kind === "message").map(record => record.message);
  expect(messages.at(-3).content).toEqual([{ type: "image_attachment", attachment_ref: "codex-input-image-1", detail: "original" }]);
  expect(messages.at(-2).content).toEqual([{ type: "skill_attachment", filename: compiled.skillFiles![0]!.name }]);
  expect(messages.at(-1).content).toBe("checkpoint now");
  expect(compiled.contextTokenBreakdown!.user!.records).toBe(messages.length);
  expect(() => assertMultipartFits(compiled, parsed)).not.toThrow();
  expect(parsed).toEqual(before);
}, 30_000);
