import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../src/responses/parser";
import { extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { estimateChatGptWebInputTokens } from "../src/adapters/chatgpt-web/usage";
import { ChatGptMarkdownBuffer } from "../src/adapters/chatgpt-web/markdown";
import {
  CHATGPT_LUNA_CHECKPOINT_MAX_TOKENS,
  CHATGPT_LUNA_CHECKPOINT_MARKER,
  ChatGptLunaCheckpointStore,
  ChatGptLunaCheckpointStream,
  hashChatGptLunaAnswer,
  type ChatGptLunaCheckpoint,
} from "../src/adapters/chatgpt-web/rolling-checkpoint";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const checkpoint: ChatGptLunaCheckpoint = {
  version: 1,
  objective: "Finish the requested repository audit.",
  state: ["The transport was inspected."],
  evidence: ["tests/rolling-checkpoint.test.ts covers the stream boundary."],
  decisions: ["Use an exact-parent checkpoint only on Luna."],
  pending: ["Inspect the remaining files."],
};

function message(role: "developer" | "user" | "assistant", text: string, turnId: string): Record<string, unknown> {
  return {
    type: "message",
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function request(
  threadId: string,
  turnId: string,
  input: Record<string, unknown>[],
) {
  return parseRequest({
    model: "gpt-5.6-luna",
    input,
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
  });
}

test("Luna checkpoint stream hides a marker split across arbitrary DOM deltas", () => {
  const stream = new ChatGptLunaCheckpointStream();
  const checkpointText = "Objective:\nFinish the requested repository audit.\nPending:\n- Inspect remaining files.";
  const raw = `Visible answer.\n\n${CHATGPT_LUNA_CHECKPOINT_MARKER}\n${checkpointText}`;
  let visible = "";
  for (let index = 0; index < raw.length; index += (index % 7) + 1) {
    const next = raw.slice(index, index + (index % 7) + 1);
    visible += stream.push(next);
  }
  const completed = stream.finish(raw);
  expect(visible).toBe("Visible answer.");
  expect(completed.answer).toBe("Visible answer.");
  expect(completed.captured.checkpoint).toEqual({ version: 2, summary: checkpointText });
  expect(completed.captured.answerHash).toBe(hashChatGptLunaAnswer("Visible answer."));
  expect(visible).not.toContain("CHECKPOINT");
});

test("Luna checkpoint marker survives the real ChatGPT DOM-to-Markdown serializer", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const domCheckpoint = "State:\n- Inspect src/foo_bar.ts and preserve *literal* [evidence].";
  const segments = [
    { key: "answer", html: "<p>Visible answer.</p>", text: "Visible answer.", streamable: true },
    {
      key: "marker",
      html: `<p>${CHATGPT_LUNA_CHECKPOINT_MARKER}</p>`,
      text: CHATGPT_LUNA_CHECKPOINT_MARKER,
      streamable: true,
    },
    {
      key: "checkpoint",
      html: `<p>${domCheckpoint}</p>`,
      text: domCheckpoint,
      streamable: false,
    },
  ];
  const stream = new ChatGptLunaCheckpointStream();
  const delta = buffer.observe(segments, 0);
  const final = buffer.finish();
  let visible = stream.push(delta);
  visible += stream.push(final.delta);
  const raw = `Visible answer.\n\n${CHATGPT_LUNA_CHECKPOINT_MARKER}\n${domCheckpoint}`;
  const completed = stream.finish(raw);
  expect(final.markdown).toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  expect(final.markdown).toContain("foo\\_bar.ts");
  expect(visible).toBe("Visible answer.");
  expect(completed.captured.checkpoint).toEqual({ version: 2, summary: domCheckpoint });
});

test("Luna checkpoint treats the malformed quoted payload from issue 89 as opaque semantic state", () => {
  const stream = new ChatGptLunaCheckpointStream();
  const checkpointText = `{"version":1,"objective":"Acknowledge the user's latest message.","state":["Latest human-authored request was "di OK".","No substantive task was requested in the provided context."],"evidence":["The final human message in the task context is "di OK"."],"decisions":["Respond with a concise acknowledgment."],"pending":[]}`;
  const raw = `OK.\n\n${CHATGPT_LUNA_CHECKPOINT_MARKER}\n${checkpointText}`;
  stream.push(raw);

  expect(stream.finish(raw)).toEqual({
    answer: "OK.",
    captured: {
      checkpoint: { version: 2, summary: checkpointText },
      answerHash: hashChatGptLunaAnswer("OK."),
    },
  });
});

test("Luna checkpoint stream preserves the answer and skips the cache when the model omits its private tail", () => {
  const stream = new ChatGptLunaCheckpointStream();
  const visible = stream.push("A normal answer without a checkpoint.");
  expect(visible).toBe("");
  expect(stream.finishOptional("A normal answer without a checkpoint.")).toEqual({
    answer: "A normal answer without a checkpoint.",
    visibleRemainder: "A normal answer without a checkpoint.",
  });
});

test("Luna checkpoint stream still rejects a marker that was lost by Markdown serialization", () => {
  const stream = new ChatGptLunaCheckpointStream();
  stream.push("A normal answer whose Markdown stream omitted the marker.");
  expect(() => stream.finishOptional(
    `A normal answer.\n\n${CHATGPT_LUNA_CHECKPOINT_MARKER}\nState:\n- preserved only in DOM text`,
  )).toThrow("not preserved in the Markdown stream");
});

test("Luna prompt requests the strict private checkpoint only when capture is enabled", () => {
  const parsed = request("thread_prompt", "turn_prompt", [message("user", "Inspect it.", "turn_prompt")]);
  const capabilities = { localToolsEnabled: false, solAvailable: false, proAvailable: false };
  const normal = compileChatGptWebPrompt(parsed, capabilities);
  const rolling = compileChatGptWebPrompt(parsed, capabilities, undefined, { captureLunaCheckpoint: true });
  expect(normal.text).not.toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  expect(rolling.text).toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  expect(rolling.text).toContain("Do not write JSON");
  expect(rolling.text).toContain("never permit an empty checkpoint");
  expect(rolling.text).toContain("Objective:");
  expect(rolling.text).toContain(`${CHATGPT_LUNA_CHECKPOINT_MAX_TOKENS.toLocaleString("en-US")} tokens`);
});

test("Luna checkpoint replaces only exact-parent history and preserves the current native turn", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-luna-checkpoint-"));
  roots.push(root);
  const path = join(root, "checkpoints.json");
  const threadId = "thread_luna_checkpoint";
  const sourceTurnId = "turn_source";
  const originalTask = `Original task ${"x".repeat(40_000)}`;
  const source = request(threadId, sourceTurnId, [
    message("developer", "Current operational contract", sourceTurnId),
    message("user", originalTask, sourceTurnId),
  ]);
  const answer = "Completed the first step.";
  const store = new ChatGptLunaCheckpointStore(path);
  const textCheckpoint: ChatGptLunaCheckpoint = {
    version: 2,
    summary: "Objective:\nFinish the requested repository audit.\nPending:\n- Inspect the remaining files.",
  };
  store.commit(source, { checkpoint: textCheckpoint, answerHash: hashChatGptLunaAnswer(answer) }, answer);

  const nextTurnId = "turn_next";
  const next = request(threadId, nextTurnId, [
    message("developer", "Old operational contract", sourceTurnId),
    message("user", originalTask, sourceTurnId),
    message("assistant", answer, sourceTurnId),
    message("developer", "Fresh operational contract", nextTurnId),
    message("user", "Continue with the second step", nextTurnId),
  ]);
  const applied = new ChatGptLunaCheckpointStore(path).apply(next);
  expect(applied.applied).toBe(true);
  expect(extractChatGptTurnUserRevision(applied.parsed)).toEqual(
    extractChatGptTurnUserRevision(next),
  );
  const encoded = JSON.stringify(applied.parsed.context.messages);
  expect(encoded).toContain("Compressed Luna task history");
  expect(encoded).toContain("Fresh operational contract");
  expect(encoded).toContain("Continue with the second step");
  expect(encoded).not.toContain("Old operational contract");
  expect(encoded).not.toContain("Original task");
  const capabilities = { localToolsEnabled: false, solAvailable: false, proAvailable: false };
  expect(estimateChatGptWebInputTokens(applied.parsed, capabilities))
    .toBeLessThan(estimateChatGptWebInputTokens(next, capabilities));

  const continued = request(threadId, nextTurnId, [
    message("developer", "Old operational contract", sourceTurnId),
    message("user", originalTask, sourceTurnId),
    message("assistant", answer, sourceTurnId),
    message("developer", "Fresh operational contract", nextTurnId),
    message("user", "Continue with the second step", nextTurnId),
    message("assistant", "Current-turn progress commentary", nextTurnId),
    {
      type: "function_call",
      call_id: "call_luna_current",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "pwd" }),
    },
    {
      type: "function_call_output",
      call_id: "call_luna_current",
      output: "current tool evidence",
    },
  ]);
  const appliedContinuation = store.apply(continued);
  expect(appliedContinuation.applied).toBe(true);
  const continuedEncoded = JSON.stringify(appliedContinuation.parsed.context.messages);
  expect(continuedEncoded).toContain("Current-turn progress commentary");
  expect(continuedEncoded).toContain("current tool evidence");
  expect(continuedEncoded).not.toContain("Original task");
  expect(estimateChatGptWebInputTokens(appliedContinuation.parsed, capabilities))
    .toBeGreaterThan(estimateChatGptWebInputTokens(applied.parsed, capabilities));

  const branch = request(threadId, "turn_branch", [
    message("assistant", "A different parent answer.", sourceTurnId),
    message("user", "Continue on another branch", "turn_branch"),
  ]);
  const rejected = new ChatGptLunaCheckpointStore(path).apply(branch);
  expect(rejected.applied).toBe(false);
  expect(rejected.reason).toContain("exact parent");

  const repeatedAnswerWithoutCheckpoint = request(threadId, "turn_after_repeat", [
    message("assistant", answer, "turn_without_checkpoint"),
    message("user", "Continue after the repeated answer", "turn_after_repeat"),
  ]);
  const stale = new ChatGptLunaCheckpointStore(path).apply(repeatedAnswerWithoutCheckpoint);
  expect(stale.applied).toBe(false);
  expect(stale.reason).toContain("source turn");
});

test("Luna checkpoint preserves the server-resolved backend model when the raw body carries a route slug", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-luna-route-checkpoint-"));
  roots.push(root);
  const path = join(root, "checkpoints.json");
  const threadId = "thread_luna_route";
  const sourceTurnId = "turn_route_source";
  const source = request(threadId, sourceTurnId, [message("user", "Start", sourceTurnId)]);
  const answer = "Started.";
  const store = new ChatGptLunaCheckpointStore(path);
  store.commit(source, { checkpoint, answerHash: hashChatGptLunaAnswer(answer) }, answer);

  const nextTurnId = "turn_route_next";
  const next = request(threadId, nextTurnId, [
    message("assistant", answer, sourceTurnId),
    message("user", "Continue", nextTurnId),
  ]);
  (next._rawBody as { model: string }).model = "chatgpt-web/luna";
  next.modelId = "gpt-5.6-luna";
  next.options.reasoning = "low";

  const applied = store.apply(next);
  expect(applied.applied).toBeTrue();
  expect(applied.parsed.modelId).toBe("gpt-5.6-luna");
  expect(applied.parsed.options.reasoning).toBe("low");
});
