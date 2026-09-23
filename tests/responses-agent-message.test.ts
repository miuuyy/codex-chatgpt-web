import { expect, test } from "bun:test";
import {
  CHATGPT_WEB_BRIEF_ONLY_MARKER,
  compileChatGptWebPrompt,
} from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
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

test("marked thread-spawn child sends only the direct brief", () => {
  const raw = {
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    instructions: "large inherited system contract that must not cross",
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: "thread_child",
        turn_id: "turn_child",
        parent_thread_id: "thread_parent",
        agent_name: "/root/researcher",
        subagent_kind: "thread_spawn",
      }),
    },
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "large inherited developer context" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "old parent conversation" }] },
      {
        type: "agent_message",
        id: "amsg_research",
        author: "/root",
        recipient: "/root/researcher",
        content: [{ type: "input_text", text: `${CHATGPT_WEB_BRIEF_ONLY_MARKER}\nImplement the focused child task.` }],
      },
    ],
  };
  const compiled = compileChatGptWebPrompt(parseRequest(raw), capabilities, turnToken);
  const envelope = JSON.parse(compiled.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/)![1]!) as {
    system: string[];
    messages: Array<Record<string, unknown>>;
  };

  expect(envelope.system).toEqual([]);
  expect(envelope.messages).toEqual([{
    role: "agent_message",
    author: "/root",
    recipient: "/root/researcher",
    content: "Implement the focused child task.",
  }]);
  expect(compiled.text).not.toContain(CHATGPT_WEB_BRIEF_ONLY_MARKER);
  expect(compiled.text).not.toContain("large inherited system contract");
  expect(compiled.text).not.toContain("large inherited developer context");
  expect(compiled.text).not.toContain("old parent conversation");
  expect(compiled.text).toContain("single direct brief below is the complete task context");
  expect(compiled.text).toContain("use the attached Codex Native tools directly");
});

test("brief-only marker is inert without trusted thread-spawn metadata", () => {
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    instructions: "preserve-root-system",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${CHATGPT_WEB_BRIEF_ONLY_MARKER}\nroot request` }],
    }],
  });
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken);
  const envelope = JSON.parse(compiled.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/)![1]!) as {
    system: string[];
    messages: Array<Record<string, unknown>>;
  };

  expect(envelope.system).toEqual(["preserve-root-system"]);
  expect(envelope.messages).toEqual([{ role: "user", content: `${CHATGPT_WEB_BRIEF_ONLY_MARKER}\nroot request` }]);
});

test("inherited stale marker cannot compact an unmarked child instruction", () => {
  const raw = {
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    instructions: "preserve-child-system",
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: "thread_child",
        turn_id: "turn_child",
        parent_thread_id: "thread_parent",
        agent_name: "/root/researcher",
        subagent_kind: "thread_spawn",
      }),
    },
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `${CHATGPT_WEB_BRIEF_ONLY_MARKER}\nstale parent text` }],
      },
      {
        type: "agent_message",
        id: "amsg_current",
        author: "/root",
        recipient: "/root/researcher",
        content: [{ type: "input_text", text: "ordinary current child task" }],
      },
    ],
  };
  const compiled = compileChatGptWebPrompt(parseRequest(raw), capabilities, turnToken);
  const envelope = JSON.parse(compiled.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/)![1]!) as {
    system: string[];
    messages: Array<Record<string, unknown>>;
  };

  expect(envelope.system).toEqual(["preserve-child-system"]);
  expect(envelope.messages).toHaveLength(2);
  expect(envelope.messages.at(-1)).toMatchObject({ role: "agent_message", content: "ordinary current child task" });
});
