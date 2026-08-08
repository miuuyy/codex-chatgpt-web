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
  const raw = `Visible answer.\n\n${CHATGPT_LUNA_CHECKPOINT_MARKER}\n${JSON.stringify(checkpoint)}`;
  let visible = "";
  for (let index = 0; index < raw.length; index += (index % 7) + 1) {
    const next = raw.slice(index, index + (index % 7) + 1);
    visible += stream.push(next);
  }
  const completed = stream.finish(raw);
  expect(visible).toBe("Visible answer.");
  expect(completed.answer).toBe("Visible answer.");
  expect(completed.captured.checkpoint).toEqual(checkpoint);
  expect(completed.captured.answerHash).toBe(hashChatGptLunaAnswer("Visible answer."));
  expect(visible).not.toContain("CHECKPOINT");
});

test("Luna checkpoint marker survives the real ChatGPT DOM-to-Markdown serializer", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const domCheckpoint: ChatGptLunaCheckpoint = {
    ...checkpoint,
    state: ["Inspect src/foo_bar.ts and preserve *literal* [evidence]."],
  };
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
      html: `<p>${JSON.stringify(domCheckpoint)}</p>`,
      text: JSON.stringify(domCheckpoint),
      streamable: false,
    },
  ];
  const stream = new ChatGptLunaCheckpointStream();
  const delta = buffer.observe(segments, 0);
  const final = buffer.finish();
  let visible = stream.push(delta);
  visible += stream.push(final.delta);
  const raw = `Visible answer.\n\n${CHATGPT_LUNA_CHECKPOINT_MARKER}\n${JSON.stringify(domCheckpoint)}`;
  const completed = stream.finish(raw);
  expect(final.markdown).toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  expect(final.markdown).toContain("foo\\_bar.ts");
  expect(visible).toBe("Visible answer.");
  expect(completed.captured.checkpoint).toEqual(domCheckpoint);
});

test("Luna checkpoint stream fails closed when the model omits its private tail", () => {
  const stream = new ChatGptLunaCheckpointStream();
  const visible = stream.push("A normal answer without a checkpoint.");
  expect(visible).toBe("");
  expect(stream.flushVisibleRemainder()).toBe("A normal answer without a checkpoint.");
  expect(() => stream.finish("A normal answer without a checkpoint.")).toThrow("without the required");
});

test("Luna prompt requests the strict private checkpoint only when capture is enabled", () => {
  const parsed = request("thread_prompt", "turn_prompt", [message("user", "Inspect it.", "turn_prompt")]);
  const capabilities = { localToolsEnabled: false, solAvailable: false, proAvailable: false };
  const normal = compileChatGptWebPrompt(parsed, capabilities);
  const rolling = compileChatGptWebPrompt(parsed, capabilities, undefined, { captureLunaCheckpoint: true });
  expect(normal.text).not.toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  expect(rolling.text).toContain(CHATGPT_LUNA_CHECKPOINT_MARKER);
  expect(rolling.text).toContain('"version":1');
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
  store.commit(source, { checkpoint, answerHash: hashChatGptLunaAnswer(answer) }, answer);

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

  const branch = request(threadId, "turn_branch", [
    message("assistant", "A different parent answer.", sourceTurnId),
    message("user", "Continue on another branch", "turn_branch"),
  ]);
  const rejected = new ChatGptLunaCheckpointStore(path).apply(branch);
  expect(rejected.applied).toBe(false);
  expect(rejected.reason).toContain("exact parent");
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
