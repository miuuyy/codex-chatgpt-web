import { expect, test } from "bun:test";
import { compileChatGptWebPrompt, inertMultipartContextJson } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";

test("serialized history does not invoke directive or file-mention rendering", () => {
  // Observed in a stock 6.1.12 multipart user bubble: directive examples became
  // __codex_directive_* placeholders and an @scope/path became a file chip.
  // These public synthetic strings carry no account or research data.
  const original = {
    example: 'Emit ::created-thread{threadId="fixture"} as a literal example.',
    file: "/fixture/node_modules/@scope/tool/bin/worker.mjs",
    url: "https://example.test/a",
    "key:with@punctuation": { value: 1.25, literal: "\\u003a `code`" },
  };
  const encoded = inertMultipartContextJson(JSON.stringify(original));
  expect(JSON.parse(encoded)).toEqual(original);
  expect(encoded).not.toContain("::created-thread");
  expect(encoded).not.toContain("@scope/");
  expect(encoded).not.toContain("https:");
  expect(encoded).toContain("1.25");
  expect(inertMultipartContextJson(encoded)).toBe(encoded);
});

test("encoding transport syntax preserves escaped quotes, backslashes and keys", () => {
  const original = {
    "colon:key": ["::code-comment{body=\"quoted\\\\value\"}", "a@b", "\\u0040", "\\u003a"],
    nested: { text: "real\nnewline\tand unicode λ", truth: true, nil: null },
  };
  const encoded = inertMultipartContextJson(JSON.stringify(original));
  expect(JSON.parse(encoded)).toEqual(original);
  expect(encoded).toContain("\\u003a\\u003acode-comment");
  expect(encoded).toContain("a\\u0040b");
});

test("actual multipart partitioning emits the encoded representation without losing records", () => {
  const content = 'Literal ::created-thread{threadId="fixture"} and @scope/tool.mjs ' + "x".repeat(5000);
  const compiled = compileChatGptWebPrompt({
    modelId: CHATGPT_WEB_MODEL_ID, stream: true, options: { reasoning: "high" },
    context: { systemPrompt: ["Synthetic transport test."], messages: Array.from({ length: 24 },
      (_, index) => ({ role: "user" as const, content, timestamp: index + 1 })) },
  }, { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  undefined, { experimentalMultipartParts: 2 });
  expect(compiled.multipart?.parts).toHaveLength(2);
  const parts = compiled.multipart!.parts;
  expect(parts.join("")).not.toContain("::created-thread");
  expect(parts.join("")).not.toContain("@scope/");
  const messages = parts.flatMap(part => JSON.parse(part).records)
    .filter(record => record.kind === "message");
  expect(messages.map(record => record.message.content)).toEqual(Array(24).fill(content));
});
