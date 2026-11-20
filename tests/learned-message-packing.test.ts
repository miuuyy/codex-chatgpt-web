import { expect, test } from "bun:test";
import { compileChatGptWebPrompt, formatChatGptWebMultipartCommit, formatChatGptWebMultipartStage } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { skillFileTokens } from "../src/adapters/chatgpt-web/skill-attachments";
import { resolveChatGptWebContextLimits } from "../src/chatgpt-web-models";
import { SUMMARY_PREFIX } from "../src/responses/compaction";
import { estimateTokens } from "../src/lib/token-estimate";
import { parseRequest } from "../src/responses/parser";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/transport-budget";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
const limits = { chars: 89_811, tokens: 31_861 };
const token = `turn_${"0".repeat(32)}`;

function restoredRecords(parts: readonly string[]): unknown[] {
  const records = parts.flatMap(part => JSON.parse(part).records);
  const restored: unknown[] = [];
  for (let index = 0; index < records.length;) {
    const record = records[index]!;
    if (record.kind !== "record_fragment") {
      restored.push(record);
      index++;
      continue;
    }
    const fragments = records.slice(index, index + record.total_fragments);
    expect(fragments).toHaveLength(record.total_fragments);
    fragments.forEach((fragment, fragmentIndex) => {
      expect(fragment.kind).toBe("record_fragment");
      expect(fragment.record_index).toBe(record.record_index);
      expect(fragment.fragment_index).toBe(fragmentIndex);
      expect(fragment.total_fragments).toBe(record.total_fragments);
    });
    restored.push(JSON.parse(fragments.map(fragment => fragment.json).join("")));
    index += fragments.length;
  }
  return restored;
}

test("known native composer limits split a large record without waiting for a server rejection", () => {
  const content = "background ".repeat(60_000);
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: content });
  parsed._chatgptModelFamily = "5.6";
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(2);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, token, { experimentalBiggerContext: true, experimentalMultipartParts: parts });
  const wire = compiledChatGptWebMessages(compiled), sizes = wire.map(text => estimateTokens(text));
  expect(restoredRecords(compiled.multipart!.parts)).toEqual([{ kind: "message", message_index: 0, message: { role: "user", content } }]);
  expect(wire.every(text => text.length <= 500_000)).toBeTrue();
  const stage = resolveChatGptWebMultipartStagingMode(parsed.modelId, capabilities, sizes[0]!, wire[0]!.length);
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId), Math.max(...sizes), parsed.modelId, "high", capabilities,
    Math.max(...wire.map(text => text.length)), parts!, { stagingEffort: stage.effort, maxStageMessageTokens: sizes[0]!,
      maxStageChars: wire[0]!.length, finalMessageTokens: sizes[1]!, finalMessageChars: wire[1]!.length }, "5.6",
  )).not.toThrow();
}, 30_000);

test.each([
  { count: 12, content: "word ".repeat(8_500) },
  { count: 13, content: "loudness ".repeat(4_300) },
])("learned limits split medium records at part boundaries without losing context ($count records)", ({ count, content }) => {
  const input = Array.from({ length: count }, (_, index) => ({ role: "user", content: `record ${index} ${content}` }));
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input });
  parsed._chatgptModelFamily = "5.6";
  const before = structuredClone(parsed);
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities, false, "Codex Native2", limits);
  expect(parts).toBe(6);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, token, {
    appName: "Codex Native2", experimentalMultipartParts: parts, messageLimits: limits,
  });
  const messages = compiledChatGptWebMessages(compiled);
  expect(messages).toHaveLength(6);
  for (const message of messages) {
    expect(message.length).toBeLessThanOrEqual(limits.chars);
    expect(estimateTokens(message, parsed.modelId)).toBeLessThanOrEqual(limits.tokens);
  }
  const transaction = "ctx_abcdef0123456789abcdef0123456789";
  const wire = compiled.multipart!.parts.slice(0, -1).map((payload, index) =>
    formatChatGptWebMultipartStage(payload, transaction, index + 1, 6).text);
  wire.push(formatChatGptWebMultipartCommit(compiled.multipart!, transaction));
  expect(wire.every(message => estimateTokens(message) <= limits.tokens && message.length <= limits.chars)).toBeTrue();
  expect(restoredRecords(compiled.multipart!.parts)).toEqual(input.map((message, message_index) => ({
    kind: "message", message_index, message,
  })));
  expect(parsed).toEqual(before);
}, 30_000);

test("physical upload pressure schedules native compaction only after productive work", () => {
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: [
    { role: "user", content: `${SUMMARY_PREFIX}\nRetain verified work` },
    ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `${index} ${"loudness ".repeat(4_300)}` })),
  ] });
  parsed._chatgptModelFamily = "5.6";
  const limits = { chars: 56_000, tokens: 31_861 };
  const threshold = resolveChatGptWebContextLimits("gpt-5.6-sol", "high", { ...capabilities, experimentalBiggerContext: true }, "5.6").autoCompactTokenLimit;
  const idle = estimateChatGptWebUsage(parsed, { answer: "Checkpoint unchanged" }, capabilities, true, false, undefined, limits);
  expect(idle.inputTokens).toBeLessThan(threshold);
  parsed.context.messages.push({ role: "toolResult", toolCallId: "completed-call", toolName: "exec_command",
    content: "Verified the next step", isError: false, timestamp: 0 });
  const progressed = estimateChatGptWebUsage(parsed, { answer: "Completed" }, capabilities, true, false, undefined, limits);
  expect(progressed.inputTokens).toBeGreaterThanOrEqual(threshold);
}, 30_000);

test("truly excessive uploads fail with a transport error and usage can still request automatic compaction", () => {
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: "loudness ".repeat(70_000) });
  parsed._chatgptModelFamily = "5.6";
  try {
    compileChatGptWebPrompt(parsed, capabilities, token, { experimentalMultipartParts: 6, messageLimits: limits });
    throw new Error("Expected a physical upload rejection");
  } catch (error: any) {
    expect(error.code).toBe("chatgpt_message_transport_capacity_exceeded");
    expect(error.message).toContain("per-message transport limit");
  }
  const threshold = resolveChatGptWebContextLimits("gpt-5.6-sol", "high", { ...capabilities, experimentalBiggerContext: true }, "5.6").autoCompactTokenLimit;
  expect(estimateChatGptWebUsage(parsed, { answer: "Tool round complete" }, capabilities, true, false, undefined, limits).inputTokens)
    .toBeGreaterThanOrEqual(threshold);
}, 30_000);

test("learned final-message token limits include attached skill content", () => {
  const skill = `<skill>\n<name>packing</name>\n<path>/workspace/packing/SKILL.md</path>\n${"word ".repeat(8_000)}\n</skill>`;
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: [
    { role: "user", content: [{ type: "input_text", text: skill }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["skills.selected_skill_instructions"] } },
    ...Array.from({ length: 7 }, (_, index) => ({ role: "user", content: `${index} ${"word ".repeat(5_000)}` })),
  ] });
  parsed._chatgptModelFamily = "5.6";
  const learned = { chars: limits.chars, tokens: 12_000 };
  const compiled = compileChatGptWebPrompt(parsed, capabilities, token, {
    experimentalMultipartParts: 6, experimentalSkillAttachments: true, messageLimits: learned,
  });
  const files = skillFileTokens(compiled.skillFiles, parsed.modelId);
  expect(compiled.skillFiles![0]!.text).toBe(skill);
  expect(files).toBeGreaterThan(8_000);
  compiledChatGptWebMessages(compiled).forEach((message, index, messages) => {
    expect(estimateTokens(message) + (index === messages.length - 1 ? files : 0)).toBeLessThanOrEqual(learned.tokens);
    expect(message.length).toBeLessThanOrEqual(learned.chars);
  });
}, 30_000);

test("required compaction context above upload limits is preserved and diagnosed separately from model capacity", () => {
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: "Make the checkpoint" });
  parsed._chatgptModelFamily = "5.6";
  parsed._compactionRequest = true;
  parsed.context.systemPrompt = ["background ".repeat(60_000)];
  const before = structuredClone(parsed);
  try {
    compileChatGptWebPrompt(parsed, capabilities, token, { experimentalMultipartParts: 6, messageLimits: limits });
    throw new Error("Expected required context to exceed upload capacity");
  } catch (error: any) {
    expect(error.code).toBe("chatgpt_message_transport_capacity_exceeded");
    expect(error.message).toContain("total model context window is not exhausted");
  }
  expect(parsed).toEqual(before);
}, 30_000);
