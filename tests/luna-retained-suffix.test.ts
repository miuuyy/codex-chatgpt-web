import { expect, test } from "bun:test";
import {
  chatGptConversationKey,
  isRetainedConversationSupported,
  retainedConversationResumeRequest,
} from "../src/adapters/chatgpt-web/conversation-key";
import type { CodexParsedRequest } from "../src/types";

function lunaRequest(): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-luna",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "My roll number is 12", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Noted roll 12" }], timestamp: 2 },
        { role: "user", content: "Yes, generate it", timestamp: 3 },
      ],
    },
    options: { reasoning: "low" },
    _compactionRequest: false,
    _rawBody: {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Yes, generate it" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn_two" },
        },
      ],
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_luna_suffix",
          turn_id: "turn_two",
        }),
      },
    },
  };
}

test("luna is eligible for retained suffix reuse with or without tools", () => {
  expect(isRetainedConversationSupported("gpt-5.6-luna", false)).toBe(true);
  expect(isRetainedConversationSupported("gpt-5.6-luna", true)).toBe(true);
  expect(isRetainedConversationSupported("gpt-5.6-sol", true)).toBe(true);
  expect(isRetainedConversationSupported("gpt-5.6-sol", false)).toBe(false);
});

test("luna conversation key is stable within epoch and rotates on thread/effort/compaction", () => {
  const before = lunaRequest();
  const sameTurn = structuredClone(before);
  expect(chatGptConversationKey(sameTurn, "provider")).toBe(chatGptConversationKey(before, "provider"));

  const otherThread = structuredClone(before);
  (otherThread._rawBody as { client_metadata: Record<string, unknown> }).client_metadata = {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_other", turn_id: "turn_two" }),
  };
  expect(chatGptConversationKey(otherThread, "provider")).not.toBe(chatGptConversationKey(before, "provider"));

  const otherEffort = structuredClone(before);
  otherEffort.options.reasoning = "medium";
  expect(chatGptConversationKey(otherEffort, "provider")).not.toBe(chatGptConversationKey(before, "provider"));

  const afterCompact = structuredClone(before);
  (afterCompact._rawBody as { input: unknown[] }).input.unshift({ type: "compaction", encrypted_content: "ocx1:x" });
  expect(chatGptConversationKey(afterCompact, "provider")).not.toBe(chatGptConversationKey(before, "provider"));
});

test("luna retained resume sends only the new user suffix", () => {
  const resumed = retainedConversationResumeRequest(lunaRequest());
  expect(resumed?.context.messages).toEqual([{ role: "user", content: "Yes, generate it", timestamp: 3 }]);
});
