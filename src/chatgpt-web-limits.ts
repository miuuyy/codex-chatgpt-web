/** Default tested budget for one ChatGPT Web turn. */
export const CHATGPT_WEB_CONTEXT_WINDOW = 256_000;

/**
 * Preferred room for hidden reasoning plus the visible checkpoint summary.
 * A 12k reserve admits the observed 236,093-token replay in a 256k window
 * while retaining a substantial checkpoint budget.
 */
export const CHATGPT_COMPACTION_OUTPUT_RESERVE_TOKENS = 12_000;

/**
 * Codex checks auto-compaction after a completed turn, so one large turn can
 * overshoot the advertised trigger. Keep a separate replay-growth allowance
 * between the trigger and the compaction preflight ceiling.
 */
export const CHATGPT_COMPACTION_REPLAY_GROWTH_HEADROOM_TOKENS = 24_000;

export function chatGptWebAutoCompactTokenLimit(
  contextWindowTokens: number,
): number {
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) {
    throw new Error("ChatGPT Web context window must be a positive integer");
  }

  const minimumWindow =
    CHATGPT_COMPACTION_OUTPUT_RESERVE_TOKENS
    + CHATGPT_COMPACTION_REPLAY_GROWTH_HEADROOM_TOKENS;

  if (contextWindowTokens <= minimumWindow) {
    throw new Error(
      `ChatGPT Web context window must exceed ${minimumWindow} tokens`,
    );
  }

  return contextWindowTokens - minimumWindow;
}

export const CHATGPT_WEB_AUTO_COMPACT_TOKEN_LIMIT =
  chatGptWebAutoCompactTokenLimit(CHATGPT_WEB_CONTEXT_WINDOW);
