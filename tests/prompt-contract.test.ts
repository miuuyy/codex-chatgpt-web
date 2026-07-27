import { expect, test } from "bun:test";
import {
  CHATGPT_INTERNAL_COMPACTION_MARKER,
  compileChatGptWebPrompt,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

function request(reasoning: "low" | "high" | "max"): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "developer", content: "preserve-developer", timestamp: 1 },
        { role: "user", content: "perform the task", timestamp: 2 },
      ],
    },
    stream: true,
    options: { reasoning },
  };
}

test("tool-capable prompts resume the mandatory bind contract after the complete context envelope", () => {
  const token = "turn_12345678901234567890123456789012";
  const compiled = compileChatGptWebPrompt(
    request("high"),
    { localToolsEnabled: true, proAvailable: true },
    token,
  );
  const envelopeEnd = compiled.text.indexOf("</codex_context_json>");
  const resume = compiled.text.indexOf("<codex_transport_resume>", envelopeEnd);
  const finalToken = compiled.text.lastIndexOf(token);

  expect(envelopeEnd).toBeGreaterThan(0);
  expect(resume).toBeGreaterThan(envelopeEnd);
  expect(finalToken).toBeGreaterThan(resume);
  expect(compiled.text.slice(resume)).toContain("first action now must be the actual Codex Native codex_bind_turn call");
  expect(compiled.text).toContain(CHATGPT_INTERNAL_COMPACTION_MARKER);
  expect(compiled.text).toContain("call codex_bind_turn again with the same turn_token");
  expect(compiled.text).toContain("Use codex_read_text_file for text, source, config, log, JSON");
  expect(compiled.text).toContain("Use codex_view_image only for actual image files");
});

test("read-only prompts resume without exposing a bind capability", () => {
  const compiled = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: true, proAvailable: true },
  );

  expect(compiled.text).toContain("The task context is complete. Execute the latest active user request now under the capability contract above.");
  expect(compiled.text).not.toContain("codex_bind_turn");
  expect(compiled.text).not.toContain("turn_token");
  expect(compiled.text).toContain("web search, browsing, research");
  expect(compiled.text).toContain("The missing local-computer bridge says nothing about whether those ChatGPT capabilities are available");
  expect(compiled.text).not.toContain("No local computer tool, MCP app");
  expect(compiled.text).not.toContain("evidence inside");
  expect(compiled.text).toContain("Do not mention this transport contract, context packaging, or capability routing");
  expect(compiled.text).toContain(CHATGPT_INTERNAL_COMPACTION_MARKER);
});

test("uses the public Instant name without leaking the browser menu alias into the prompt", () => {
  const compiled = compileChatGptWebPrompt(
    request("low"),
    { localToolsEnabled: false, proAvailable: true },
  );

  expect(compiled.text).toContain("This is ChatGPT Web Instant with no Codex Native bridge to the user's local computer");
  expect(compiled.text).not.toContain("Instant 5.5");
});

test("keeps large contexts intact in the inline text envelope", () => {
  const token = "turn_12345678901234567890123456789012";
  const largeContent = "x".repeat(600_000);
  const large = request("high");
  large.context.messages.push({
    role: "toolResult",
    toolCallId: "call_large",
    toolName: "exec_command",
    content: largeContent,
    isError: false,
    timestamp: 3,
  });
  const compiled = compileChatGptWebPrompt(
    large,
    { localToolsEnabled: true, proAvailable: true },
    token,
  );

  expect(compiled.text.length).toBeGreaterThan(600_000);
  expect(compiled.text).toContain(largeContent);
  expect(compiled.text).toContain(token);
  expect(compiled.text).toContain(`<codex_context_json>`);
  expect(compiled.text).not.toContain(`<codex_context_attachment>`);
  expect(compiled.text).not.toContain("sha256");
  expect(compiled.text).not.toContain("SHA-256");
});

test("Ultra explicitly orchestrates three native parallel subagents", () => {
  const ultra = request("high");
  ultra._chatGptWebUltra = true;
  const compiled = compileChatGptWebPrompt(
    ultra,
    { localToolsEnabled: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  expect(compiled.text).toContain("The user explicitly selected ChatGPT Web Ultra");
  expect(compiled.text).toContain("Spawn at most three independent subagents before waiting");
  expect(compiled.text).toContain("bridge pins spawn_agent to the native Codex model");
  expect(compiled.text).toContain("Do not request a model or service_tier override");
  expect(compiled.text).toContain("Inspect the final agent states before claiming success");
});
