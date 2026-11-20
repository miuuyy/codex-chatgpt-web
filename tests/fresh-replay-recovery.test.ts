import { expect, test } from "bun:test";
import { compiledChatGptWebMessages, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { compileBiggerContextPrompt, compileFreshChatGptWebPrompt } from "../src/adapters/chatgpt-web/usage";
import { parseRequest } from "../src/responses/parser";
import type { CodexMessage } from "../src/types";

const caps = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false };
const token = "turn_" + "0".repeat(32);
const options = { messageLimits: { chars: 145_000, tokens: 42_000 }, experimentalBiggerContext: true };
const output = "const value = objects[0]?.name ?? '#test';\n".repeat(270);

function request() {
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: "Continue the saved work." });
  parsed._chatgptModelFamily = "5.6";
  const history: CodexMessage[] = [{ role: "user", content: "Keep the original product constraints.", timestamp: 0 }];
  for (let index = 0; index < 26; index++) {
    const id = `shell-${index}`;
    history.push({
      role: "assistant", timestamp: index + 1,
      content: [{ type: "toolCall", id, name: "exec_command", arguments: { cmd: "read saved evidence" } }],
    }, {
      role: "toolResult", toolName: "exec_command", toolCallId: id, timestamp: index + 1,
      isError: index === 0, content: `Recorded header ${index}\n${output}Middle evidence ${index}\n${output.slice(0, 500)}Process status ${index}`,
    });
  }
  history.push({
    role: "toolResult", toolName: "read_thread", toolNamespace: "mcp__codex_app",
    toolCallId: "prior-thread", timestamp: 29, isError: false,
    content: "Verified plan evidence. ".repeat(120),
  });
  parsed.context.messages.unshift(...history);
  return parsed;
}

test("a blocked fresh replay fits using historical shell excerpts and keeps canonical history", () => {
  const parsed = request();
  const canonical = structuredClone(parsed);
  expect(() => compileBiggerContextPrompt(parsed, caps, token, options)).toThrow("120,000-token");
  const prepared = compileFreshChatGptWebPrompt(parsed, caps, token, options);
  expect(prepared.historicalShellExcerpts).toBe(24);
  expect(estimateCompiledChatGptWebInputTokens(prepared, parsed.modelId)).toBeLessThan(120_000);
  const submitted = compiledChatGptWebMessages(prepared).join("\n");
  expect(submitted).toContain("Keep the original product constraints.");
  expect(submitted).toContain("Continue the saved work.");
  expect(submitted).toContain("Verified plan evidence. ".repeat(120));
  expect(submitted).toContain("Recorded header 0");
  expect(submitted).toContain("Process status 0");
  expect(submitted).not.toContain("Middle evidence 0");
  expect(submitted).toContain("Middle evidence 24");
  expect(submitted).toContain("Middle evidence 25");
  expect(parsed).toEqual(canonical);
}, 30_000);

test("live tool-result continuations keep their existing preflight behavior", () => {
  const parsed = request();
  parsed.context.messages.push({
    role: "toolResult", toolName: "exec_command", toolCallId: "current-output",
    isError: false, content: "A live result belongs to the current user message.", timestamp: 30,
  });
  expect(() => compileFreshChatGptWebPrompt(parsed, caps, token, options)).toThrow("120,000-token");
}, 30_000);

test("a fitting fresh request preserves the complete tool result", () => {
  const parsed = request();
  parsed.context.messages.splice(3, parsed.context.messages.length - 4);
  const prepared = compileFreshChatGptWebPrompt(parsed, caps, token, options);
  expect(prepared.historicalShellExcerpts).toBeUndefined();
  expect(prepared.text).toContain("Middle evidence 0");
});
