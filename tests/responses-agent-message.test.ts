import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";
import { extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true, proPlan: true };
const turnToken = "turn_12345678901234567890123456789012";

function request() {
  return parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    instructions: "Preserve the native conversation semantics.",
    input: [
      {
        type: "agent_message",
        author: "parent",
        recipient: "child",
        content: [{ type: "input_text", text: "Inspect the failing request and report evidence." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue from the agent report." }],
      },
    ],
  });
}

function inlineMessages(text: string): Array<Record<string, unknown>> {
  const match = text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/);
  if (!match?.[1]) throw new Error("inline Codex context JSON missing");
  return (JSON.parse(match[1]) as { messages: Array<Record<string, unknown>> }).messages;
}

test("parser preserves plaintext agent-message routing metadata", () => {
  const parsed = request();
  expect(parsed.context.messages[0]).toEqual({
    role: "agentMessage",
    author: "parent",
    recipient: "child",
    content: "Inspect the failing request and report evidence.",
    timestamp: expect.any(Number),
  });
});

test("inline Web context emits a distinct agent_message envelope", () => {
  const compiled = compileChatGptWebPrompt(request(), capabilities, turnToken);
  const messages = inlineMessages(compiled.text);
  expect(messages[0]).toEqual({
    role: "agent_message",
    author: "parent",
    recipient: "child",
    content: "Inspect the failing request and report evidence.",
  });
  expect(messages[1]).toEqual({
    role: "user",
    content: "Continue from the agent report.",
  });
  expect(compiled.text).toContain("agent_message messages are inter-agent inputs");
  expect(compiled.text).toContain("Exclude agent_message inputs");
});

test("multipart Web context emits the same agent_message envelope", () => {
  const compiled = compileChatGptWebPrompt(
    request(),
    capabilities,
    turnToken,
    { experimentalMultipartParts: 2 },
  );
  const records = compiled.multipart!.parts.flatMap(part => (
    (JSON.parse(part) as { records: Array<Record<string, unknown>> }).records
  ));
  const messages = records
    .filter(record => record.kind === "message")
    .map(record => record.message as Record<string, unknown>);
  expect(messages[0]).toEqual({
    role: "agent_message",
    author: "parent",
    recipient: "child",
    content: "Inspect the failing request and report evidence.",
  });
});

test("ordinary user messages do not gain agent metadata", () => {
  const messages = inlineMessages(compileChatGptWebPrompt(request(), capabilities, turnToken).text);
  expect(messages[1]).not.toHaveProperty("author");
  expect(messages[1]).not.toHaveProperty("recipient");
});

test("agent messages do not invent missing routing identity or fallback content", () => {
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    input: [{ type: "agent_message", content: "" }],
  });
  expect(parsed.context.messages[0]).toMatchObject({ role: "agentMessage", content: "" });
  expect(parsed.context.messages[0]).not.toHaveProperty("author");
  expect(parsed.context.messages[0]).not.toHaveProperty("recipient");
  const messages = inlineMessages(compileChatGptWebPrompt(parsed, capabilities, turnToken).text);
  expect(messages[0]).toEqual({ role: "agent_message", content: "" });
});

function delegation() {
  return {
    type: "function_call_output", id: "fco_current", name: "send_message_to_thread",
    namespace: "codex_app",
    output: "<codex_delegation><source_thread_id>coordinator</source_thread_id><input>Finish &lt;current&gt; &amp; preserve &amp;lt;literal&amp;gt;.</input></codex_delegation>",
    internal_chat_message_metadata_passthrough: { turn_id: "current" },
  };
}

test("native desktop delegation stays an attributed input after an older human task", () => {
  const item = delegation();
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    input: [{ type: "message", role: "user", id: "old", content: "Read goal status only.",
      internal_chat_message_metadata_passthrough: { turn_id: "old" } }, item],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "target", turn_id: "current" }) },
  });
  expect(extractChatGptTurnUserRevision(parsed)).toBe(item.output);
  expect(parsed.context.messages.at(-1)).toMatchObject({ role: "agentMessage", author: "coordinator",
    content: item.output });
  for (const experimentalMultipartParts of [undefined, 2] as const) {
    const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, { experimentalMultipartParts });
    const messages = compiled.multipart ? compiled.multipart.parts.flatMap(part => JSON.parse(part).records)
      .filter(record => record.kind === "message").map(record => record.message) : inlineMessages(compiled.text);
    expect(messages.at(-1)).toEqual({ role: "agent_message", author: "coordinator",
      content: item.output });
    expect(messages[0]).toEqual({ role: "user", content: "Read goal status only." });
  }
});

test("ordinary tool results and malformed delegation text are never promoted", () => {
  const invalid = [
    { ...delegation(), call_id: "actual_call" },
    { ...delegation(), namespace: "another_app" },
    { ...delegation(), name: "read_file" },
    { ...delegation(), id: "" },
    { ...delegation(), internal_chat_message_metadata_passthrough: {} },
    { ...delegation(), output: delegation().output.replace("&lt;current&gt;", "<current>") },
    { ...delegation(), output: delegation().output.replace("&amp;", "&unknown;") },
    { ...delegation(), output: delegation().output + "<input>Extra task</input>" },
  ];
  for (const item of invalid) {
    const parsed = parseRequest({ model: CHATGPT_WEB_MODEL_ID, input: [item] });
    expect(parsed.context.messages[0]?.role).toBe("toolResult");
  }
  const user = parseRequest({ model: CHATGPT_WEB_MODEL_ID,
    input: [{ type: "message", role: "user", content: delegation().output }] });
  expect(user.context.messages[0]?.role).toBe("user");
});
