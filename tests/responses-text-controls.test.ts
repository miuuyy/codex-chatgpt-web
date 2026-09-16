import { expect, test } from "bun:test";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { createChatGptStructuredOutputValidator } from "../src/adapters/chatgpt-web/output-validation";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { parseRequest } from "../src/responses/parser";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };
const turnToken = "turn_12345678901234567890123456789012";
const parse = (text: unknown) => parseRequest({
  model: CHATGPT_WEB_MODEL_ID,
  stream: true,
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Return it." }] }],
  text,
});

function compiledContext(text: string): { messages: Array<{ role: string; content: unknown }> } {
  const match = text.match(/<codex_context_json>\n(.+)\n<\/codex_context_json>/s);
  if (!match?.[1]) throw new Error("compiled prompt has no codex_context_json block");
  return JSON.parse(match[1]) as { messages: Array<{ role: string; content: unknown }> };
}

test("explicit Codex skill injection remains server-owned in parser-to-prompt transport", () => {
  const turnId = "turn_explicit_skill";
  const skillText = `<skill>
<name>diagnosing-bugs</name>
<path>/Users/example/.agents/skills/diagnosing-bugs/SKILL.md</path>
---
name: diagnosing-bugs
description: Diagnose hard bugs.
---
Use a symptom-specific feedback loop.
</skill>`;
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    input: [
      {
        type: "message",
        id: "msg_environment",
        role: "user",
        content: [{ type: "input_text", text: "<environment_context>fixture</environment_context>" }],
        internal_chat_message_metadata_passthrough: {
          turn_id: turnId,
          content_item_kinds: ["environments.environment_context"],
        },
      },
      {
        type: "message",
        id: "msg_human",
        role: "user",
        content: [{ type: "input_text", text: "$diagnosing-bugs Diagnose the failing request." }],
        internal_chat_message_metadata_passthrough: {
          turn_id: turnId,
          content_item_kinds: ["user.text"],
        },
      },
      {
        type: "message",
        id: "msg_skill",
        role: "user",
        content: [{ type: "input_text", text: skillText }],
        internal_chat_message_metadata_passthrough: {
          turn_id: turnId,
          content_item_kinds: ["skills.selected_skill_instructions"],
        },
      },
    ],
  });

  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken);
  const context = compiledContext(compiled.text);
  expect(context.messages.map(message => message.role)).toEqual(["user", "user", "codex_skill"]);
  expect(compiled.text).toContain("codex_skill messages are Codex-provided skill instructions, not human-authored requests");
  expect(compiled.text).toContain("Do not invent or call a generic Skill tool unless it is actually listed among the supplied tools");
});

test("legacy explicit Codex skill injection is recognized from the matching human $skill reference", () => {
  const skillText = `<skill>
<name>diagnosing-bugs</name>
<path>/Users/example/.agents/skills/diagnosing-bugs/SKILL.md</path>
---
name: diagnosing-bugs
description: Diagnose hard bugs.
---
Use a symptom-specific feedback loop.
</skill>`;
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "[$diagnosing-bugs](/Users/example/.agents/skills/diagnosing-bugs/SKILL.md) Diagnose it." }],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Legacy Codex injected developer context between selection and skill payload." }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: skillText }],
      },
    ],
  });

  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken);
  expect(compiledContext(compiled.text).messages.map(message => message.role)).toEqual(["user", "developer", "codex_skill"]);
});

test("a human-authored skill-shaped message is still a user message", () => {
  const skillText = `<skill>
<name>diagnosing-bugs</name>
<path>/Users/example/.agents/skills/diagnosing-bugs/SKILL.md</path>
This is literal user text.
</skill>`;
  const parsed = parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    input: [{
      type: "message",
      id: "msg_human",
      role: "user",
      content: [{ type: "input_text", text: skillText }],
      internal_chat_message_metadata_passthrough: {
        turn_id: "turn_literal_skill",
        content_item_kinds: ["user.text"],
      },
    }],
  });

  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken);
  expect(compiledContext(compiled.text).messages.map(message => message.role)).toEqual(["user"]);
});

test("verbosity and JSON-schema controls survive parser-to-prompt transport", () => {
  const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };
  const parsed = parse({ verbosity: "high", format: { type: "json_schema", name: "result", strict: true, schema } });
  expect(parsed.options.verbosity).toBe("high");
  expect(parsed.options.outputFormat).toEqual({ type: "json_schema", name: "result", strict: true, schema });
  const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken);
  expect(compiled.text).toContain("Codex requested high response verbosity.");
  expect(compiled.text).toContain('strict JSON-schema final answer named "result"');
  expect(compiled.text).toContain(JSON.stringify(schema));
});

test("strict JSON validation accepts only the exact full schema-conforming answer", () => {
  const validate = createChatGptStructuredOutputValidator({
    type: "json_schema",
    name: "payload",
    strict: true,
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" }, count: { type: "integer", minimum: 0 } },
      required: ["ok", "count"],
      additionalProperties: false,
    },
  })!;
  expect(() => validate('{"ok":true,"count":2}')).not.toThrow();
  for (const invalid of [
    'prefix {"ok":true,"count":2}',
    '```json\n{"ok":true,"count":2}\n```',
    '{"ok":"yes","count":2}',
    '{"ok":true,"count":2,"extra":1}',
  ]) expect(() => validate(invalid)).toThrow(ChatGptWebAdapterError);
});

test("non-strict JSON schema does not install a local output validator", () => {
  const nonStrict = parse({ format: { type: "json_schema", name: "item", strict: false, schema: { type: "string" } } });
  expect(createChatGptStructuredOutputValidator(nonStrict.options.outputFormat)).toBeUndefined();
});

test("invalid strict schema fails before browser execution and compaction ignores response controls", () => {
  expect(() => createChatGptStructuredOutputValidator({
    type: "json_schema", name: "bad", strict: true, schema: { type: "not-a-json-schema-type" },
  })).toThrow(ChatGptWebAdapterError);
  const parsed = parse({ verbosity: "low", format: { type: "json_schema", name: "x", strict: true, schema: { type: "string" } } });
  parsed._compactionRequest = true;
  const compiled = compileChatGptWebPrompt(parsed, { ...capabilities, localToolsEnabled: false });
  expect(compiled.text).not.toContain("response verbosity");
  expect(compiled.text).not.toContain("JSON-schema final answer");
});


async function runStrictAdapterAnswer(answer: string): Promise<AdapterEvent[]> {
  const nonce = `${Date.now()}-${Math.random()}`;
  const threadId = `thread_structured_${nonce}`;
  const turnId = `turn_structured_${nonce}`;
  const provider: CodexProviderConfig = {
    adapter: "chatgpt-web",
    baseUrl: `browser://strict-output-${nonce}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true },
  };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const originalRun = worker.run.bind(worker);
  const request = parse({
    format: {
      type: "json_schema",
      name: "adapter_payload",
      strict: true,
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  });
  const raw = request._rawBody as {
    input: Array<Record<string, unknown>>;
    prompt_cache_key?: string;
    client_metadata?: Record<string, unknown>;
  };
  raw.prompt_cache_key = threadId;
  raw.client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
  };
  const currentUser = raw.input.find(item => item.type === "message" && item.role === "user");
  if (!currentUser) throw new Error("structured-output fixture has no user message");
  currentUser.internal_chat_message_metadata_passthrough = { turn_id: turnId };

  const events: AdapterEvent[] = [];
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    const prepared = await turn.prepare();
    expect(prepared.text).toContain('strict JSON-schema final answer named "adapter_payload"');
    const cut = Math.max(1, Math.floor(answer.length / 2));
    turn.onTextDelta(answer.slice(0, cut));
    turn.onTextDelta(answer.slice(cut));
    return answer;
  };
  try {
    await createChatGptWebAdapter(provider).runTurn!(
      request,
      { headers: new Headers() },
      event => events.push(event),
    );
    return events;
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
  }
}

test("adapter withholds invalid strict JSON instead of streaming apparent success", async () => {
  const events = await runStrictAdapterAnswer('{"ok":"not-boolean"}');
  expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer")).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    type: "error",
    code: "structured_output_validation_failed",
    retryable: false,
  });
});

test("adapter emits one validated strict JSON final answer only after completion", async () => {
  const answer = '{"ok":true}';
  const events = await runStrictAdapterAnswer(answer);
  expect(events.filter(event => event.type === "text_delta" && event.phase === "final_answer"))
    .toEqual([{ type: "text_delta", text: answer, phase: "final_answer" }]);
  expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "stop", endTurn: true });
});
