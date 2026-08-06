import { expect, test } from "bun:test";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import {
  assertCompactionFitsContext,
  estimateChatGptWebInputTokens,
} from "../src/adapters/chatgpt-web/usage";
import {
  CHATGPT_COMPACTION_OUTPUT_RESERVE_TOKENS,
  CHATGPT_COMPACTION_REPLAY_GROWTH_HEADROOM_TOKENS,
  CHATGPT_WEB_AUTO_COMPACT_TOKEN_LIMIT,
  CHATGPT_WEB_CONTEXT_WINDOW,
  chatGptWebAutoCompactTokenLimit,
} from "../src/chatgpt-web-limits";
import type { CodexParsedRequest } from "../src/types";

test("default limits admit the observed compaction replay", () => {
  const maxCompactionInput =
    CHATGPT_WEB_CONTEXT_WINDOW
    - CHATGPT_COMPACTION_OUTPUT_RESERVE_TOKENS;

  expect(maxCompactionInput).toBe(244_000);
  expect(maxCompactionInput).toBeGreaterThanOrEqual(236_093);
});

test(
  "auto-compaction leaves replay-growth room before the hard preflight ceiling",
  () => {
    const maxCompactionInput =
      CHATGPT_WEB_CONTEXT_WINDOW
      - CHATGPT_COMPACTION_OUTPUT_RESERVE_TOKENS;

    expect(
      maxCompactionInput - CHATGPT_WEB_AUTO_COMPACT_TOKEN_LIMIT,
    ).toBe(CHATGPT_COMPACTION_REPLAY_GROWTH_HEADROOM_TOKENS);

    expect(CHATGPT_WEB_AUTO_COMPACT_TOKEN_LIMIT).toBe(220_000);
  },
);

test("configured windows derive their matching auto-compaction threshold", () => {
  expect(chatGptWebAutoCompactTokenLimit(272_000)).toBe(236_000);
  expect(() => chatGptWebAutoCompactTokenLimit(36_000)).toThrow();
});

test("compaction preflight accepts the reserve boundary and rejects one token beyond it", () => {
  const request: CodexParsedRequest = {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    context: {
      messages: [{ role: "user", content: "compact this replay", timestamp: 1 }],
    },
    options: { reasoning: "high" },
    _compactionRequest: true,
  };
  const capabilities = { localToolsEnabled: false, proAvailable: true };
  const estimated = estimateChatGptWebInputTokens(request, capabilities);
  const boundary = estimated + CHATGPT_COMPACTION_OUTPUT_RESERVE_TOKENS;

  expect(() => assertCompactionFitsContext(request, capabilities, boundary)).not.toThrow();
  expect(() => assertCompactionFitsContext(request, capabilities, boundary - 1)).toThrow(
    "compaction context is too large",
  );
});
