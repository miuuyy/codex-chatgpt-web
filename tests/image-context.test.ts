import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareImageContext, accessImageContext, projectImageContext, imageContextId } from "../src/adapters/chatgpt-web/image-context";
import type { CodexMessage } from "../src/types";
const roots: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), "image-context-")); roots.push(p); return p; };
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const url = (s: string) => `data:image/png;base64,${Buffer.from(s).toString("base64")}`;
const image = (s: string): CodexMessage => ({ role: "user", timestamp: 0, content: [{ type: "text", text: s }, { type: "image", imageUrl: url(s) }] });
test("new screenshots replace the working set; text follow-ups retain it; original history is immutable", () => {
  const r = root(), a = image("old"), b = image("new"), messages = [a, b]; const before = JSON.stringify(messages);
  expect(prepareImageContext("one", [a], r).active).toEqual([imageContextId(url("old"))]);
  const c = prepareImageContext("one", messages, r);
  expect(c.active).toEqual([imageContextId(url("new"))]);
  expect(JSON.stringify(projectImageContext(messages, c))).toContain("Historical image");
  expect(JSON.stringify(messages)).toBe(before);
  expect(prepareImageContext("one", [...messages, { role: "user", timestamp: 1, content: "move left" }], r).active).toEqual(c.active);
});
test("old originals can be retrieved, added for comparison and explicitly removed, across store reads", () => {
  const r = root(), messages = [image("a"), image("b")]; prepareImageContext("one", messages, r);
  const a = imageContextId(url("a")), b = imageContextId(url("b"));
  expect(accessImageContext("one", "get", [a], r).content[1]).toEqual({ type: "image", mimeType: "image/png", data: Buffer.from("a").toString("base64") });
  accessImageContext("one", "add", [a], r);
  expect(prepareImageContext("one", messages, r).active).toEqual([b, a]);
  accessImageContext("one", "replace", [], r);
  expect(prepareImageContext("one", messages, r).active).toEqual([]);
  expect(prepareImageContext("one", [...messages, image("c")], r).active).toEqual([imageContextId(url("c"))]);
});
test("thread isolation and unknown IDs fail closed; nonembedded images are never fetched", () => {
  const r = root(); prepareImageContext("one", [image("a")], r);
  expect(() => accessImageContext("two", "get", [imageContextId(url("a"))], r)).toThrow("unavailable");
  const remote: CodexMessage = { role: "user", timestamp: 0, content: [{ type: "image", imageUrl: "http://127.0.0.1/private" }] };
  const c = prepareImageContext("remote", [remote], r);
  expect(accessImageContext("remote", "get", c.active, r).content).toHaveLength(2);
  expect(accessImageContext("remote", "get", c.active, r).content[1]?.type).toBe("text");
});
test("tool images stay available and oversized current sets are rejected instead of silently trimmed", () => {
  const r = root(); const tool: CodexMessage = { role: "toolResult", timestamp: 0, toolCallId: "tool", toolName: "view_image", isError: false, content: [{ type: "image", imageUrl: url("tool") }] };
  expect(prepareImageContext("one", [image("a"), tool], r).active).toContain(imageContextId(url("tool")));
  const many: CodexMessage = { role: "user", timestamp: 0, content: Array.from({ length: 11 }, (_, i) => ({ type: "image", imageUrl: url(String(i)) })) };
  expect(() => prepareImageContext("one", [many], r)).toThrow("exceeds 10");
});

import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { parseRequest } from "../src/responses/parser";
test("compiled prompts attach only the selected set, deduplicate copies and keep stable references", () => {
  const r = root(); const messages = [image("a"), image("b"), image("b")];
  const context = prepareImageContext("thread", messages, r);
  const parsed = parseRequest({ model: "gpt-5.6-sol", input: [{ role: "user", content: "task" }] });
  parsed.context.messages = messages;
  const capabilities = { localToolsEnabled: true, solAvailable: true, proAvailable: false, extraHighAvailable: false };
  const compiled = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012", { imageContext: context });
  expect(compiled.images).toHaveLength(1);
  expect(compiled.images[0]?.ref).toBe(imageContextId(url("b")));
  expect(compiled.text).toContain(imageContextId(url("a")));
  expect(compiled.text).toContain("not attached");
  expect(compiled.text).not.toContain(url("a"));
  const rebuilt = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012", { imageContext: context });
  expect(rebuilt.images).toEqual(compiled.images);
});
