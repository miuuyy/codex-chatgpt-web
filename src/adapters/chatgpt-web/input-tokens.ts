import { estimateTokens } from "../../lib/token-estimate";
import type { CompiledChatGptWebPrompt } from "./prompt";

// ChatGPT's product system prompt and the fixed Codex Native MCP schemas are not present in the
// visible composer text. Reserve them explicitly; over-counting fails safe by compacting earlier.
const CHATGPT_PLATFORM_RESERVE_TOKENS = 8_192;
const CHATGPT_IMAGE_RESERVE_TOKENS = 4_096;
const CHATGPT_ORIGINAL_IMAGE_RESERVE_TOKENS = 8_192;

/**
 * The Free/Luna product accepted measured browser inputs at 25,400 and 28,547 estimated tokens,
 * but rejected the same shape at 32,283 before producing a response. This is a ChatGPT browser
 * transport boundary, not Luna's model context window, and applies to normal and checkpoint turns.
 */
export const CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET = 28_000;

/** Tokens present in the one visible browser message, excluding hidden product/tool reserves. */
export function estimateCompiledChatGptWebMessageTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  return estimateTokens(compiled.text, modelId);
}

export function estimateCompiledChatGptWebInputTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
): number {
  const imageTokens = compiled.images.reduce(
    (total, image) => total + (image.detail === "original"
      ? CHATGPT_ORIGINAL_IMAGE_RESERVE_TOKENS
      : CHATGPT_IMAGE_RESERVE_TOKENS),
    0,
  );
  return CHATGPT_PLATFORM_RESERVE_TOKENS
    + estimateCompiledChatGptWebMessageTokens(compiled, modelId)
    + imageTokens;
}
