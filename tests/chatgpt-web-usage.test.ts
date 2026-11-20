import { resolveChatGptWebModelMode } from "../src/adapters/chatgpt-web/model";
import { checkChatGptWebTransport } from "../src/adapters/chatgpt-web/transport-budget";
import { expect, test } from "bun:test";
import { compileBiggerContextPrompt, estimateChatGptWebInputTokens, estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { assertChatGptWebMultipartInputWithinLimits, resolveChatGptWebMultipartStagingMode } from "../src/adapters/chatgpt-web/transport-budget";
import { estimateTokens } from "../src/lib/token-estimate";
import type { CodexParsedRequest } from "../src/types";
import { resolveChatGptWebMessageTokenBudget, resolveChatGptWebMultipartContextWindow, resolveChatGptWebStagingTokenBudget } from "../src/chatgpt-web-models";
import { parseRequest } from "../src/responses/parser";

const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };

function request(text: string): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: text, timestamp: 1 }] },
    options: { reasoning: "high" },
  };
}

test.each([undefined, 2] as const)("context diagnostics separate instructions from history without logging contents (%s parts)", parts => {
  const parsed = parseRequest({
    model: "gpt-5.6-sol",
    instructions: "PRIVATE_SYSTEM top-level instructions ".repeat(100),
    input: [
      { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "PRIVATE_TOOL", parameters: { type: "object" } }] },
      { type: "message", role: "developer", content: "PRIVATE_DEVELOPER instructions" },
      { type: "message", role: "user", content: "PRIVATE_USER request" },
      { type: "message", role: "assistant", content: "PRIVATE_ANSWER" },
      { type: "function_call_output", call_id: "PRIVATE_CALL", output: "PRIVATE_RESULT" },
    ],
    reasoning: { effort: "high" },
  });
  const options = { experimentalMultipartParts: parts };
  const plain = compileChatGptWebPrompt(parsed, capabilities, undefined, options);
  const measured = compileChatGptWebPrompt(parsed, capabilities, undefined, { ...options, includeContextTokenBreakdown: true });
  const { contextTokenBreakdown: counts, ...prompt } = measured;
  expect(prompt).toEqual(plain);
  expect(estimateCompiledChatGptWebInputTokens(measured, parsed.modelId))
    .toBe(estimateCompiledChatGptWebInputTokens(plain, parsed.modelId));
  expect(Object.keys(counts!).sort()).toEqual(["assistant", "developer", "system", "tool_result", "user"]);
  expect(counts!.developer!.records).toBe(1); // additional_tools is a registry, not a developer message.
  expect(counts!.system!.tokens).toBeGreaterThan(counts!.user!.tokens);
  expect(JSON.stringify(counts)).not.toContain("PRIVATE");
  const { sanitizeForExport } = require("../launcher/electron/logging.cjs");
  const logLine = `[chatgpt-web] context_token_breakdown ${JSON.stringify({ byRole: counts })}`;
  expect(sanitizeForExport(logLine)).toBe(logLine);
  for (const group of Object.values(counts!)) {
    expect(Object.keys(group).sort()).toEqual(["chars", "records", "tokens"]);
    expect(group.records).toBe(1);
    expect(group.tokens).toBeGreaterThan(0);
  }
});

test("usage counts the configured plugin name carried by the submitted prompt", () => {
  const parsed = request("Inspect the repository.");
  const caps = { ...capabilities, localToolsEnabled: true };
  const appName = `Codex ${"測試_".repeat(16)}`;
  const token = `turn_${"0".repeat(32)}`;
  const compiled = compileChatGptWebPrompt(parsed, caps, token, { appName });
  const expected = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
  expect(expected).not.toBe(estimateChatGptWebInputTokens(parsed, caps));
  for (const biggerContext of [false, true]) {
    expect(estimateChatGptWebUsage(parsed, {}, caps, biggerContext, false, appName).inputTokens).toBe(expected);
  }
});

test.each([
  ["highly compressible", "a".repeat(480_000)],
  ["ordinary repeated words", `${"word ".repeat(79_999)}word`],
])("%s context uses tokenizer-derived usage without character-pressure inflation", (_label, text) => {
  expect(estimateChatGptWebInputTokens(request(text), capabilities)).toBeLessThan(100_000);
}, 15_000);

test("multipart selection accounts for whole-record and composer fit before submission", () => {
  const plus = { ...capabilities, extraHighAvailable: false, proAvailable: false };
  for (const [contents, expected] of [
    [["small task"], undefined],
    [[50_000, 40_000, 50_000, 5_000].map(n => "word ".repeat(n)), 6],
    [Array.from({ length: 3 }, () => " ".repeat(450_000)), 6],
  ] as const) {
    const parsed = request("");
    parsed.context.messages = contents.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const parts = resolveBiggerContextMultipartParts(parsed, plus);
    expect(parts).toBe(expected);
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: parts });
    if (parts) {
      expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
        .toEqual([...contents]);
    }
  }
  // Low-token text can still exceed the reasoning model's server character ceiling.
  // Stage the complete record instead of sending it inline or dropping its contents.
  const sparsePro = request("x".repeat(600_000));
  expect(resolveBiggerContextMultipartParts(sparsePro, capabilities)).toBe(2);
  const stagedPro = compileChatGptWebPrompt(sparsePro, capabilities, undefined, { experimentalMultipartParts: 2 });
  expect(stagedPro.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([sparsePro.context.messages[0]!.content]);
  const proMessages = compiledChatGptWebMessages(stagedPro);
  expect(proMessages[1]!.length).toBeLessThanOrEqual(500_000);
  expect(resolveChatGptWebMultipartStagingMode(
    "gpt-5.6-sol", capabilities, estimateTokens(proMessages[0]!), proMessages[0]!.length,
  ).effort).toBe("max");
}, 60_000);

test("Bigger Context compaction stages intact history above the inline byte budget", () => {
  const parsed = request("x".repeat(160_000));
  parsed._compactionRequest = true;
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBe(2);
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual([parsed.context.messages[0]!.content]);
});

test("GPT-6 Sol stages complete Plus and Pro history with consistent usage accounting", () => {
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 4 }, (_, index) => ({
    role: "user", content: `record-${index}: ${"word ".repeat(24_000)}`, timestamp: index + 1,
  }));
  const original = structuredClone(parsed);
  for (const proAvailable of [false, true]) {
    const caps = { ...capabilities, proAvailable };
    const parts = resolveBiggerContextMultipartParts(parsed, caps);
    expect(parts).toBeUndefined();
    const staged = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts });
    const messages = staged.multipart
      ? staged.multipart.parts.flatMap(part => JSON.parse(part).records).map(record => record.message)
      : JSON.parse(staged.text.match(/<codex_context_json>\n([\s\S]*?)\n<\/codex_context_json>/)![1]!).messages;
    expect(messages.map((message: { content: string }) => message.content))
      .toEqual(parsed.context.messages.map(message => message.content));
    expect(estimateChatGptWebUsage(parsed, { answer: "done" }, caps, true).inputTokens)
      .toBe(estimateCompiledChatGptWebInputTokens(staged, parsed.modelId));
    expect(parsed).toEqual(original);
  }
}, 30_000);

test("GPT-6 compaction respects the selected account and effort", () => {
  const parsed = { ...request("Summarize this task."), _chatgptModelFamily: "6" as const, _compactionRequest: true };
  for (const proAvailable of [false, true]) {
    const caps = { ...capabilities, proAvailable };
    for (const effort of ["low", "medium", "high", "xhigh"] as const) {
      parsed.options.reasoning = effort;
      const supported = effort !== "low";
      const parts = resolveBiggerContextMultipartParts(parsed, caps);
      if (supported) {
        expect(parts).toBeUndefined();
        const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: parts });
        expect(compiled.text).toContain("Summarize this task.");
        expect(compiled.trimmedCompactionMessages).toBeUndefined();
        expect(estimateChatGptWebUsage(parsed, { answer: "summary" }, caps, true).inputTokens)
          .toBe(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId));
      } else {
        expect(parts).toBeUndefined();
        expect(estimateChatGptWebUsage(parsed, { answer: "summary" }, caps, true))
          .toEqual(estimateChatGptWebUsage(parsed, { answer: "summary" }, caps, false));
        expect(() => compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6 }))
          .toThrow("GPT-6 Instant uses standard context");
      }
    }
  }
  parsed.options.reasoning = "max";
  const parts = resolveBiggerContextMultipartParts(parsed, capabilities);
  expect(parts).toBeUndefined();
  const compiled = compileChatGptWebPrompt(parsed, capabilities, undefined, { experimentalMultipartParts: parts });
  expect(compiled.text).toContain("Summarize this task.");
  expect(compiled.trimmedCompactionMessages).toBeUndefined();
});

test("ordinary uploads use smaller Instant stages while checkpoints retain their selected mode", () => {
  const plus = { ...capabilities, proAvailable: false, extraHighAvailable: false };
  const parsed = request("");
  parsed.context.messages = Array.from({ length: 28 }, (_, index) => ({
    role: "user", content: `record-${index}: ${"word ".repeat(3000)}`, timestamp: index + 1,
  }));
  for (const compaction of [false, true]) {
    parsed._compactionRequest = compaction;
    const compiled = compileChatGptWebPrompt(parsed, plus, undefined, { experimentalMultipartParts: 6 });
    const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
    expect(records.map(record => record.message.content)).toEqual(parsed.context.messages.map(message => message.content));
    expect(compiled.trimmedCompactionMessages).toBeUndefined();
    const messages = compiledChatGptWebMessages(compiled);
    const stagingTokens = messages.slice(0, -1).map(text => estimateTokens(text));
    const stagingBudget = compaction ? resolveChatGptWebMessageTokenBudget("gpt-5.6-sol", "high", plus)
      : resolveChatGptWebStagingTokenBudget("gpt-5.6-sol", "low", plus);
    expect(Math.max(...stagingTokens)).toBeLessThanOrEqual(stagingBudget);
    if (!compaction) expect(resolveChatGptWebMultipartStagingMode("gpt-5.6-sol", plus,
      Math.max(...stagingTokens), Math.max(...messages.slice(0, -1).map(text => text.length))).effort).toBe("low");
    const finalTokens = estimateTokens(messages.at(-1)!);
    if (!compaction) expect(finalTokens).toBeGreaterThan(Math.max(...stagingTokens));
    expect(finalTokens).toBeLessThanOrEqual(resolveChatGptWebMessageTokenBudget("gpt-5.6-sol", "high", plus));
  }
}, 30_000);

test("multipart planning leaves room for final attachments and execution instructions without losing history", () => {
  for (const scenario of [
    { extraHighAvailable: false, proAvailable: false, images: 3, schema: false },
    { extraHighAvailable: true, proAvailable: true, images: 10, schema: false },
    { extraHighAvailable: false, proAvailable: false, images: 0, schema: true },
  ]) {
    const caps = { ...capabilities, proAvailable: scenario.proAvailable };
    const parsed = request("");
    const texts = Array.from({ length: scenario.proAvailable ? 36 : 12 }, (_, index) => `record ${index}: ${"word ".repeat(5_000)}`);
    parsed.context.messages = texts.map((content, index) => ({ role: "user", content, timestamp: index + 1 }));
    const images = Array.from({ length: scenario.images }, (_, index) => ({
      type: "image" as const, imageUrl: `data:image/png;base64,partition-image-${index}`, detail: "original" as const,
    }));
    if (images.length) parsed.context.messages.push({ role: "user", content: images, timestamp: texts.length + 1 });
    if (scenario.schema) parsed.options.outputFormat = {
      type: "json_schema", name: "result", strict: true, schema: { type: "string", description: "schema ".repeat(24_000) },
    };
    const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6 });
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
      parsed.modelId, "high", caps, Math.max(...chars), 6,
      { stagingEffort: stage.effort, maxStageMessageTokens, maxStageChars, finalMessageTokens: tokens.at(-1)!, finalMessageChars: chars.at(-1)!, finalImageTokens: estimateChatGptWebImageTokens(compiled) },
    )).not.toThrow();
  }
}, 30_000);

test("GPT-6 Plus keeps a fitting inline request when multipart encoding would overflow", () => {
  const caps = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 11 }, (_, index) => ({
    role: "user", timestamp: index + 1,
    content: "const value = objects[0]?.name ?? '#test';\n".repeat(500),
  }));
  const original = structuredClone(parsed);
  const token = "turn_" + "0".repeat(32);
  const inline = compileChatGptWebPrompt(parsed, caps, token);
  const inlineInput = estimateCompiledChatGptWebInputTokens(inline, parsed.modelId);
  expect(inlineInput).toBeGreaterThan(80_000);
  expect(inlineInput).toBeLessThan(90_000);
  const staged = compileChatGptWebPrompt(parsed, caps, token, { experimentalMultipartParts: 2 });
  expect(estimateCompiledChatGptWebInputTokens(staged, parsed.modelId)).toBeGreaterThan(120_000);
  expect(resolveBiggerContextMultipartParts(parsed, caps)).toBeUndefined();
  expect(parsed).toEqual(original);
  const usage = estimateChatGptWebUsage(parsed, { answer: "Saved the completed step." }, caps, true);
  expect(usage.inputTokens).toBe(inlineInput);
  expect(usage.estimated).toBeTrue();
}, 15_000);

test("GPT-6 Plus plans against its full context ceiling", () => {
  const caps = { ...capabilities, proAvailable: false };
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 23 }, (_, index) => ({
    role: "user", timestamp: index + 1, content: "Record " + index + " " + "word ".repeat(5000),
  }));
  expect(resolveBiggerContextMultipartParts(parsed, caps)).toBe(6);
}, 15_000);


test.each([
  { family: "6", pro: false, parts: 2, ceiling: 120_000 },
  { family: "6", pro: false, parts: 6, ceiling: 120_000 },
  { family: "6", pro: true, parts: 2, ceiling: 222_386 },
  { family: "6", pro: true, parts: 6, ceiling: 240_000 },
  { family: "5.6", pro: false, parts: 2, ceiling: 120_000 },
  { family: "5.6", pro: false, parts: 6, ceiling: 120_000 },
] as const)("planner and preflight enforce the same selected context ceiling %j", scenario => {
  const caps = { ...capabilities, proAvailable: scenario.pro };
  const cap = resolveChatGptWebMultipartContextWindow("gpt-5.6-sol", "high", caps, scenario.parts, scenario.family);
  expect(cap).toBe(scenario.ceiling);
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    cap - 1, 1, "gpt-5.6-sol", "high", caps, 1, scenario.parts, undefined, scenario.family,
  )).not.toThrow();
  expect(() => assertChatGptWebMultipartInputWithinLimits(
    cap, 1, "gpt-5.6-sol", "high", caps, 1, scenario.parts, undefined, scenario.family,
  )).toThrow("ceiling");
});

test("a fitting inline task below the normal checkpoint threshold retains exact usage", () => {
  const caps = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 9 }, (_, index) => ({
    role: "user", timestamp: index + 1,
    content: "const value = objects[0]?.name ?? '#test';\n".repeat(500),
  }));
  const prompt = compileChatGptWebPrompt(parsed, caps, "turn_" + "0".repeat(32));
  expect(estimateChatGptWebUsage(parsed, { answer: "Done" }, caps, true).inputTokens)
    .toBe(estimateCompiledChatGptWebInputTokens(prompt, parsed.modelId));
}, 15_000);

test("a retained checkpoint does not repeatedly request compaction without new tool results", async () => {
  const { encodeCompactionSummary } = await import("../src/responses/compaction");
  const caps = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: [
    { type: "compaction", encrypted_content: encodeCompactionSummary("The completed step and its result remain established.") },
    ...Array.from({ length: 11 }, (_, index) => ({
      type: "message", role: "user",
      content: "const value = objects[0]?.name ?? '#test';\n".repeat(500),
    })),
  ] });
  parsed._chatgptModelFamily = "6";
  const actual = estimateChatGptWebInputTokens(parsed, caps, { captureLunaCheckpoint: false });
  expect(actual).toBeGreaterThan(80_000);
  expect(actual).toBeLessThan(90_000);
  expect(estimateChatGptWebUsage(parsed, { answer: "The checkpoint is still current." }, caps, true).inputTokens).toBe(actual);
  parsed.context.messages.push({
    role: "toolResult", toolCallId: "new-completed-call", toolName: "exec_command",
    content: "Completed a new step", isError: false, timestamp: Date.now(),
  });
  expect(estimateChatGptWebUsage(parsed, { answer: "A new step is complete." }, caps, true).inputTokens)
    .toBe(estimateChatGptWebInputTokens(parsed, caps, { captureLunaCheckpoint: false }));
}, 15_000);

test("fitting code history retains exact usage while small bounded tool results still fit", () => {
  const caps = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 11 }, (_, index) => ({
    role: "user", timestamp: index,
    content: "const value = objects[0]?.name ?? '#test';\n".repeat(500),
  }));
  const before = structuredClone(parsed);
  const tool = { callId: "small-read", wireName: "functions.exec_command", freeform: false,
    arguments: { cmd: "read next section", max_output_tokens: 1_000 } };
  const actual = estimateChatGptWebInputTokens(parsed, caps, { captureLunaCheckpoint: false });
  expect(actual).toBeGreaterThan(80_000);
  expect(actual).toBeLessThan(87_000);
  expect(estimateChatGptWebUsage(parsed, { toolRequests: [tool] }, caps, true).inputTokens).toBe(actual);
  expect(parsed).toEqual(before);
}, 15_000);

test("a bounded tool result that will cross the last fitting transport still schedules automatic compaction", () => {
  const caps = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 14 }, (_, index) => ({
    role: "user", timestamp: index,
    content: "const value = objects[0]?.name ?? '#test';\n".repeat(500),
  }));
  const tool = { callId: "large-read", wireName: "exec_command", freeform: false,
    arguments: { cmd: "read large section", max_output_tokens: 14_000 } };
  expect(estimateChatGptWebUsage(parsed, { toolRequests: [tool] }, caps, true).inputTokens).toBeGreaterThanOrEqual(110_000);
  const next = structuredClone(parsed);
  next.context.messages.push({ role: "toolResult", toolCallId: tool.callId, toolName: "exec_command",
    content: "word ".repeat(14_000), isError: false, timestamp: 12 });
  const parts = resolveBiggerContextMultipartParts(next, caps);
  expect(parts).toBeDefined();
  expect(estimateChatGptWebInputTokens(next, caps, { experimentalMultipartParts: parts })).toBeGreaterThan(120_000);
  // The Pro account profile remains independent of the shared backend identifier.
  const pro = { ...caps, proAvailable: true };
  parsed._chatgptModelFamily = "5.6";
  next._chatgptModelFamily = "5.6";
  expect(estimateChatGptWebUsage(parsed, { toolRequests: [tool] }, pro, true).inputTokens)
    .toBe(estimateChatGptWebInputTokens(parsed, pro, { captureLunaCheckpoint: false }));
  const widerParts = resolveBiggerContextMultipartParts(next, pro);
  expect(widerParts).toBe(2);
  expect(estimateChatGptWebInputTokens(next, pro, { experimentalMultipartParts: widerParts })).toBeLessThan(240_000);
}, 30_000);

test("unbounded tools retain the ordinary reserve even when an unrelated argument looks like a limit", () => {
  const caps = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 14 }, (_, index) => ({
    role: "user", timestamp: index,
    content: "const value = objects[0]?.name ?? '#test';\n".repeat(500),
  }));
  const tool = { callId: "unknown-read", wireName: "third_party.exec_command", freeform: false,
    arguments: { max_output_tokens: 1, cmd: "x ".repeat(2_500) } };
  expect(estimateChatGptWebUsage(parsed, { toolRequests: [tool] }, caps, true).inputTokens).toBeGreaterThanOrEqual(110_000);
}, 15_000);

test("parallel unknown tools share the ordinary reserve while explicit output budgets are summed", () => {
  const caps = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 13 }, (_, index) => ({
    role: "user", timestamp: index,
    content: "const value = objects[0]?.name ?? '#test';\n".repeat(500),
  }));
  const actual = estimateChatGptWebInputTokens(parsed, caps, { captureLunaCheckpoint: false });
  expect(actual).toBeGreaterThan(90_000);
  expect(actual).toBeLessThan(110_000);
  const unknown = ["lookup_a", "lookup_b"].map(wireName => ({ callId: wireName, wireName, freeform: false }));
  expect(estimateChatGptWebUsage(parsed, { toolRequests: unknown }, caps, true).inputTokens).toBe(actual);
  const bounded = unknown.map(tool => ({ ...tool, wireName: "exec_command", arguments: { max_output_tokens: 10_000 } }));
  expect(estimateChatGptWebUsage(parsed, { toolRequests: bounded }, caps, true).inputTokens).toBeGreaterThanOrEqual(110_000);
}, 15_000);

test("#1001 keeps a fitting GPT-6 Plus code transcript inline across planning and usage", () => {
  const caps = { ...capabilities, localToolsEnabled: true, proAvailable: false, extraHighAvailable: false };
  const parsed = parseRequest({
    model: "gpt-5.6-sol", reasoning: { effort: "high" },
    input: Array.from({ length: 11 }, () => ({
      role: "user", type: "message", content: 'const title = rows[0]?.key ?? "demo";\n'.repeat(480),
    })),
  });
  parsed._chatgptModelFamily = "6";
  const token = `turn_${"0".repeat(32)}`;
  const inline = compileChatGptWebPrompt(parsed, caps, token, { experimentalBiggerContext: true });
  const inlineTokens = estimateCompiledChatGptWebInputTokens(inline, parsed.modelId);
  const staged = compileChatGptWebPrompt(parsed, caps, token, { experimentalMultipartParts: 2 });
  expect(inlineTokens).toBeGreaterThan(80_000);
  expect(inlineTokens).toBeLessThan(90_000);
  expect(estimateCompiledChatGptWebInputTokens(staged, parsed.modelId)).toBeGreaterThan(120_000);
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, caps);
  const id = "ctx_b6088f32f1ca497eb6b50dfcab1abaca";
  const selected = compileBiggerContextPrompt(parsed, caps, token, { multipartTransactionId: id });
  expect(selected).toEqual(inline);
  expect(checkChatGptWebTransport(selected, parsed.modelId, mode, caps, "6", id).estimatedInputTokens).toBe(inlineTokens);
  expect(() => checkChatGptWebTransport(staged, parsed.modelId, mode, caps, "6", id)).toThrow("120,000-token");
  expect(estimateChatGptWebUsage(parsed, {}, caps, true).inputTokens).toBe(inlineTokens);
}, 30_000);

test("Bigger Context refuses an oversized ordinary GPT-6 Plus transcript before Send and preserves its records", () => {
  const caps = { ...capabilities, proAvailable: false };
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = Array.from({ length: 12 }, (_, i) => ({
    role: "user", timestamp: i, content: "sample ".repeat(11_000),
  }));
  const id = "ctx_b6088f32f1ca497eb6b50dfcab1abaca";
  expect(() => compileBiggerContextPrompt(parsed, caps, undefined, { multipartTransactionId: id }))
    .toThrow("120,000-token six-part ceiling");
  const compiled = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 6, multipartTransactionId: id });
  expect(estimateChatGptWebUsage(parsed, {}, caps, true).inputTokens).toBeGreaterThan(120_000);
  expect(compiled.multipart?.parts.length).toBe(6);
  expect(compiled.multipart!.parts.flatMap(part => JSON.parse(part).records).map(record => record.message.content))
    .toEqual(parsed.context.messages.map(message => message.content));
  const mode = resolveChatGptWebModelMode(parsed.modelId, "high", caps);
  expect(() => checkChatGptWebTransport(compiled, parsed.modelId, mode, caps, "6", id)).toThrow("120,000-token six-part ceiling");
  parsed._compactionRequest = true;
  const compact = compileBiggerContextPrompt(parsed, caps, undefined, { multipartTransactionId: id });
  expect(compact.multipart?.parts.length).toBe(6);
  expect(compact.trimmedCompactionMessages).toBeGreaterThan(0);
  expect(checkChatGptWebTransport(compact, parsed.modelId, mode, caps, "6", id).estimatedInputTokens)
    .toBe(estimateCompiledChatGptWebInputTokens(compact, parsed.modelId, id));
}, 30_000);

test("the selected multipart transaction ID counts toward the GPT-6 Plus ceiling", () => {
  const caps = { ...capabilities, proAvailable: false, extraHighAvailable: false };
  const parsed = request("");
  parsed._chatgptModelFamily = "6";
  parsed.context.messages = [28_000, 28_000, 28_000, 26_220].map((words, timestamp) =>
    ({ role: "user", timestamp, content: "test ".repeat(words) }));
  const id = "ctx_b6088f32f1ca497eb6b50dfcab1abaca";
  const candidate = compileChatGptWebPrompt(parsed, caps, undefined, { experimentalMultipartParts: 2, multipartTransactionId: id });
  expect(estimateCompiledChatGptWebInputTokens(candidate, parsed.modelId)).toBeLessThan(120_000);
  expect(estimateCompiledChatGptWebInputTokens(candidate, parsed.modelId, id)).toBeGreaterThanOrEqual(120_000);
  expect(() => compileBiggerContextPrompt(parsed, caps, undefined, { multipartTransactionId: id })).toThrow("120,000-token six-part ceiling");
}, 30_000);
