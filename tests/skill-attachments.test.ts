import { estimateChatGptWebUsage } from "../src/adapters/chatgpt-web/usage";
import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptPromptFilePayloads } from "../src/adapters/chatgpt-web/browser-worker";
import { retainedConversationResumeRequest } from "../src/adapters/chatgpt-web/conversation-key";
import { estimateCompiledChatGptWebInputTokens, estimateCompiledChatGptWebMessageTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { skillFileTokens } from "../src/adapters/chatgpt-web/skill-attachments";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true, proPlan: true };
const token = "turn_12345678901234567890123456789012";
const text = (name = "testing", body = "Read references/checks.md. Verify café 日本語.") =>
  `<skill>\n<name>${name}</name>\n<path>/workspace/skills/${name}/SKILL.md</path>\n${body}\n</skill>`;
const input = (content: string, kinds = ["skills.selected_skill_instructions"]) => ({
  role: "user", content: [{ type: "input_text", text: content }],
  internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
});
const parse = (items: unknown[]) => parseRequest({ model: CHATGPT_WEB_MODEL_ID, input: items, reasoning: { effort: "high" } });
const compile = (items: unknown[], enabled = true) => compileChatGptWebPrompt(parse(items), capabilities, token, { experimentalSkillAttachments: enabled });

test("only native selected-skill provenance enables attachment transport; default stays inline", () => {
  const skill = text();
  const compiled = compile([input(skill), input("Use $testing", ["user.text"])]);
  expect(compiled.skillFiles).toHaveLength(1);
  expect(compiled.text).not.toContain("Read references/checks.md");
  expect(compiled.text).toContain('"origin":"codex_skill"');
  expect(compiled.text).toContain('"filename":"testing--');
  const [file] = chatGptPromptFilePayloads(compiled);
  expect(file!.name).toMatch(/^testing--[a-f0-9]{16}\.txt$/);
  expect(file!.mimeType).toBe("text/plain");
  expect(file!.buffer.toString("utf8")).toBe(skill);
  expect(compile([input(skill)], false).text).toContain("Read references/checks.md");
  expect(compile([input(skill)], false).skillFiles).toBeUndefined();
  for (const item of [
    { role: "user", content: skill },
    input(skill, ["user.text"]),
    input(skill, ["skills.selected_skill_instructions", "user.text"]),
    { ...input(skill), role: "developer" },
  ]) {
    const literal = compile([input("$testing", ["user.text"]), item]);
    expect(literal.skillFiles).toBeUndefined();
    expect(literal.text).toContain("Read references/checks.md");
  }
});

test("files preserve resource authority and distinguish same-named versions without a persistent cache", () => {
  const first = text("../plugin:test", '<resource_access>{"main_resource":"skill://test","package":"plugin"}</resource_access>\nfirst');
  const changed = first.replace("\nfirst", "\nsecond");
  const compiled = compile([input(first), input(first), input(changed)]);
  expect(compiled.skillFiles).toHaveLength(2);
  const files = chatGptPromptFilePayloads(compiled);
  expect(files[0]!.name).not.toBe(files[1]!.name);
  expect(files[0]!.name).not.toMatch(/[/:\\]/);
  expect(files[0]!.buffer.toString()).toBe(first);
  expect(files[1]!.buffer.toString()).toBe(changed);
  expect(compile([input(first)]).skillFiles).toEqual([compiled.skillFiles![0]!]);
  const tampered = structuredClone(compiled);
  tampered.skillFiles![0]!.text += " changed";
  expect(() => chatGptPromptFilePayloads(tampered)).toThrow("does not match");
});

test("retained turns reuse prior attachments; fresh chats rebuild them and new skills still upload", () => {
  const history = [input(text()), { role: "assistant", content: [{ type: "output_text", text: "Done" }] }, input("Continue", ["user.text"])];
  const parsed = parse(history);
  const resumed = retainedConversationResumeRequest(parsed)!;
  expect(compileChatGptWebPrompt(resumed, capabilities, token, { experimentalSkillAttachments: true }).skillFiles).toBeUndefined();
  expect(compile(history).skillFiles).toHaveLength(1);
  const next = retainedConversationResumeRequest(parse([...history, input(text("next"))]))!;
  const compiled = compileChatGptWebPrompt(next, capabilities, token, { experimentalSkillAttachments: true });
  expect(compiled.skillFiles).toHaveLength(1);
  expect(compiled.skillFiles![0]!.name).toStartWith("next--");
});

test("skill content counts toward input and final-message budgets, including multipart", () => {
  const parsed = parse([input(text("testing", "check this carefully\n".repeat(1000))), input("Do it", ["user.text"])]);
  for (const parts of [undefined, 6] as const) {
    const compiled = compileChatGptWebPrompt(parsed, capabilities, token, { experimentalSkillAttachments: true, experimentalMultipartParts: parts });
    const withoutFiles = { ...compiled, skillFiles: undefined };
    const fileTokens = skillFileTokens(compiled.skillFiles, parsed.modelId);
    expect(fileTokens).toBeGreaterThan(1000);
    expect(estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)
      - estimateCompiledChatGptWebInputTokens(withoutFiles, parsed.modelId)).toBe(fileTokens);
    expect(estimateCompiledChatGptWebMessageTokens(compiled, parsed.modelId)).toBeGreaterThan(fileTokens);
    if (parts) {
      expect(compiled.multipart!.parts.join(" ")).not.toContain("check this carefully");
      expect(compiled.multipart!.commit).toContain("skill_attachment");
    }
  }
});

test("over-limit, malformed and manual requests fail explicitly without silently losing skill content", () => {
  const ten = Array.from({ length: 10 }, (_, i) => input(text(`skill-${i}`)));
  expect(chatGptPromptFilePayloads(compile(ten))).toHaveLength(10);
  expect(() => chatGptPromptFilePayloads(compile([...ten, input(text("eleventh"))]))).toThrow("10 attachments");
  const image = { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,iVBORw==" }] };
  expect(() => chatGptPromptFilePayloads(compile([...ten, image]))).toThrow("10 attachments");
  expect(() => compile([input("Not a skill envelope")])).toThrow("invalid Codex envelope");
  expect(() => compileChatGptWebPrompt(parse([input(text())]), capabilities, token, {
    experimentalSkillAttachments: true, manualControl: true,
  })).toThrow("Zero Risk");
});


test("usage accounts for skills accumulated over many turns without applying a per-message upload cap", () => {
  const parsed = parse(Array.from({ length: 11 }, (_, i) => input(text(`skill-${i}`))));
  const usage = estimateChatGptWebUsage(parsed, { answer: "done" }, capabilities, false, true);
  expect(usage.inputTokens).toBeGreaterThan(0);
  expect(usage.estimated).toBe(true);
});
