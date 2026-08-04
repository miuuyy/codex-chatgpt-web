import { expect, test } from "bun:test";
import {
  CHATGPT_COMPACTION_CONTEXT_FILENAME,
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

test("compaction prompts are isolated summarization turns without local or native tool instructions", () => {
  const compact = request("high");
  compact._compactionRequest = true;
  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, proAvailable: true },
  );

  expect(compiled.text).toContain("This is a Codex history-compaction checkpoint, not a normal task turn.");
  expect(compiled.text).toContain("Produce the requested checkpoint summary now without calling tools.");
  expect(compiled.text).not.toContain("codex_bind_turn");
  expect(compiled.text).not.toContain("web search, browsing, research");
  expect(compiled.text).not.toContain("missing local-computer bridge");
  expect(compiled.text).toContain(`attached UTF-8 document named ${CHATGPT_COMPACTION_CONTEXT_FILENAME}`);
  expect(compiled.text).toContain("Read the complete attached document before acting.");
  expect(compiled.text).not.toContain("<codex_context_json>");
  expect(compiled.contextAttachment).toMatchObject({
    name: CHATGPT_COMPACTION_CONTEXT_FILENAME,
    mimeType: "text/plain",
  });
  const encoded = compiled.contextAttachment!.text.match(/^<codex_context_json>\n(.+)\n<\/codex_context_json>$/s)?.[1];
  expect(JSON.parse(encoded!)).toEqual({
    version: 3,
    system: ["preserve-system"],
    messages: [
      { role: "developer", content: "preserve-developer" },
      { role: "user", content: "perform the task" },
    ],
  });
});

test("assigns prior assistant output to the model and never attributes Codex context to the human", () => {
  const attributed = request("max");
  attributed.context.messages = [
    { role: "user", content: "hi", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: "Hi! How can I help?" }],
      timestamp: 2,
    },
    {
      role: "user",
      content: "what did I write before?\n<environment_context><cwd>/private/project</cwd></environment_context>",
      timestamp: 3,
    },
  ];
  const compiled = compileChatGptWebPrompt(
    attributed,
    { localToolsEnabled: true, proAvailable: true },
  );
  const encoded = compiled.text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s)?.[1];
  const envelope = JSON.parse(encoded!) as { messages: Array<Record<string, unknown>> };

  expect(envelope.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "text", text: "Hi! How can I help?" }],
  });
  expect(compiled.text).toContain("assistant messages are your own earlier replies");
  expect(compiled.text).toContain("environment_context, are operational context rather than human-authored text");
  expect(compiled.text).toContain("answer only from the human-authored text in user messages");
  expect(compiled.text).toContain("do not attribute, quote, summarize, or otherwise mention them");
});

test("a long task keeps the newest images and drops the overflow instead of failing", () => {
  const image = (marker: string) => ({
    type: "image" as const,
    imageUrl: `data:image/png;base64,${marker}`,
  });
  const markers = Array.from({ length: 13 }, (_unused, index) => `IMG${index + 1}`);
  const replayed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: markers.map((marker, index) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: `step ${index + 1}` }, image(marker)],
        timestamp: index + 1,
      })),
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(
    replayed,
    { localToolsEnabled: true, proAvailable: true },
    "turn_12345678901234567890123456789012",
  );

  expect(compiled.images.map(entry => entry.imageUrl)).toEqual(
    markers.slice(-10).map(marker => `data:image/png;base64,${marker}`),
  );
  expect(compiled.text).toContain("older image not attached");
  expect(compiled.text).toContain("step 1");
  expect(compiled.text).toContain("step 13");
});

test("compaction reserves one attachment slot and keeps the newest nine images", () => {
  const image = (marker: string) => ({
    type: "image" as const,
    imageUrl: `data:image/png;base64,${marker}`,
  });
  const markers = Array.from({ length: 13 }, (_unused, index) => `IMG${index + 1}`);
  const compact: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      messages: markers.map((marker, index) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: `step ${index + 1}` }, image(marker)],
        timestamp: index + 1,
      })),
    },
    stream: true,
    options: { reasoning: "high" },
    _compactionRequest: true,
  };

  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, proAvailable: true },
  );

  expect(compiled.images.map(entry => entry.imageUrl)).toEqual(
    markers.slice(-9).map(marker => `data:image/png;base64,${marker}`),
  );
  expect(compiled.contextAttachment?.text).toContain("only 9 image slots are available for this message");
  expect(compiled.contextAttachment?.text.match(/older image not attached/g)).toHaveLength(4);
  expect(compiled.contextAttachment?.text.match(/"type":"image_attachment"/g)).toHaveLength(9);
  expect(compiled.contextAttachment?.text).not.toContain("data:image");
  for (const marker of markers) expect(compiled.contextAttachment?.text).not.toContain(marker);
  expect(compiled.text).not.toContain("older image not attached");
});

test("the replayed context never carries a finished turn's broker handles", () => {
  const staleToken = "turn_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const staleBinding = "binding_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const token = "turn_12345678901234567890123456789012";
  const replayed: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    context: {
      systemPrompt: ["preserve-system"],
      messages: [
        { role: "user", content: "keep working", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "codex_bind_turn", arguments: { turn_token: staleToken } }],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "codex_bind_turn",
          isError: false,
          content: `{"binding_id":"${staleBinding}"}`,
          timestamp: 3,
        },
      ],
    },
    stream: true,
    options: { reasoning: "high" },
  };

  const compiled = compileChatGptWebPrompt(replayed, { localToolsEnabled: true, proAvailable: true }, token);

  expect(compiled.text).not.toContain(staleToken);
  expect(compiled.text).not.toContain(staleBinding);
  expect(compiled.text).toContain("[retired turn handle]");
  expect(compiled.text).toContain("[retired binding handle]");
  expect(compiled.text).toContain(token);
  expect(compiled.text).toContain("keep working");
  const envelope = compiled.text.split("<codex_context_json>")[1]!.split("</codex_context_json>")[0]!.trim();
  expect(() => JSON.parse(envelope) as unknown).not.toThrow();
});

test("requires ChatGPT-native rich results to include a safe Markdown answer for Codex", () => {
  const compiled = compileChatGptWebPrompt(
    request("max"),
    { localToolsEnabled: true, proAvailable: true },
  );

  expect(compiled.text).toContain("also provide the relevant result as ordinary Markdown in the final answer");
  expect(compiled.text).toContain("A private ChatGPT UI widget never replaces the Markdown answer returned to Codex");
  expect(compiled.text).toContain("Never copy a ChatGPT widget's HTML, CSS, class names, or DOM markup");
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
  expect(compiled.contextAttachment).toBeNull();
  expect(compiled.text).not.toContain(`<codex_context_attachment>`);
  expect(compiled.text).not.toContain("sha256");
  expect(compiled.text).not.toContain("SHA-256");
});

test("moves a large compaction envelope into one exact text attachment without duplication", () => {
  const beginning = "unique-compaction-beginning";
  const middle = "unique-compaction-middle";
  const ending = "unique-compaction-ending";
  const largeContent = `${beginning}${"x".repeat(300_000)}${middle}${"y".repeat(300_000)}${ending}`;
  const compact = request("high");
  compact._compactionRequest = true;
  compact.context.messages.push({
    role: "toolResult",
    toolCallId: "call_large",
    toolName: "exec_command",
    content: `${largeContent} turn_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
    isError: false,
    timestamp: 3,
  });

  const compiled = compileChatGptWebPrompt(
    compact,
    { localToolsEnabled: false, proAvailable: true },
  );

  expect(compiled.text.length).toBeLessThan(10_000);
  expect(compiled.text).not.toContain(beginning);
  expect(compiled.text).not.toContain(middle);
  expect(compiled.text).not.toContain(ending);
  expect(compiled.text).not.toContain("<codex_context_json>");
  expect(compiled.contextAttachment).toMatchObject({
    name: CHATGPT_COMPACTION_CONTEXT_FILENAME,
    mimeType: "text/plain",
  });
  const attachment = compiled.contextAttachment!.text;
  expect(attachment.startsWith("<codex_context_json>\n")).toBe(true);
  expect(attachment.endsWith("\n</codex_context_json>")).toBe(true);
  expect(attachment.match(new RegExp(beginning, "g"))).toHaveLength(1);
  expect(attachment.match(new RegExp(middle, "g"))).toHaveLength(1);
  expect(attachment.match(new RegExp(ending, "g"))).toHaveLength(1);
  expect(attachment).not.toContain("turn_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  expect(attachment).toContain("[retired turn handle]");
  const encoded = attachment.slice("<codex_context_json>\n".length, -"\n</codex_context_json>".length);
  expect(() => JSON.parse(encoded) as unknown).not.toThrow();
});
