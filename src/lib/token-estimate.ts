import { get_encoding, type Tiktoken } from "tiktoken";

/**
 * Token accounting for ChatGPT Web prompts.
 *
 * A character ratio is not safe here: dense JSON/base64 can contain far more tokens than prose
 * of the same length. Count with the tokenizer used by the GPT-5 generation instead.
 */

const TOKENIZER_CHUNK_CHARS = 4_096;
const MAX_CACHED_CHUNKS = 256;
let tokenizer: Tiktoken | undefined;

function chatGptTokenizer(): Tiktoken {
  tokenizer ??= get_encoding("o200k_base");
  return tokenizer;
}

function countChunk(text: string, encoding: Tiktoken, chunkTokenCounts?: Map<string, number>): number {
  if (!chunkTokenCounts) return encoding.encode_ordinary(text).length;
  const cached = chunkTokenCounts.get(text);
  if (cached !== undefined) {
    chunkTokenCounts.delete(text);
    chunkTokenCounts.set(text, cached);
    return cached;
  }
  const count = encoding.encode_ordinary(text).length;
  if (chunkTokenCounts.size >= MAX_CACHED_CHUNKS) {
    chunkTokenCounts.delete(chunkTokenCounts.keys().next().value!);
  }
  chunkTokenCounts.set(text, count);
  return count;
}

/**
 * Count ordinary text conservatively without handing pathological multi-megabyte runs to one
 * tokenizer call. Independent chunks can only lose cross-boundary merges, so their sum may
 * over-count slightly but cannot under-count because of a missed boundary token.
 */
function countTokens(text: string, modelId?: string, chunks?: Map<string, number>): number {
  void modelId;
  if (!text) return 0;

  const encoding = chatGptTokenizer();
  let count = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + TOKENIZER_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const previous = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
        end -= 1;
      }
    }
    count += countChunk(text.slice(start, end), encoding, chunks);
    start = end;
  }
  return count;
}

export type TokenEstimator = (text: string, modelId?: string) => number;

export const estimateTokens: TokenEstimator = (text, modelId) => countTokens(text, modelId);

/** Conversation text exists only in the caller's synchronous request preparation scope. */
export function createRequestTokenEstimator(): TokenEstimator {
  const chunks = new Map<string, number>();
  const messages = new Map<string, number>();
  return (text, modelId) => {
    const existing = messages.get(text);
    if (existing !== undefined) return existing;
    const count = countTokens(text, modelId, chunks);
    if (messages.size >= 64) messages.delete(messages.keys().next().value!);
    messages.set(text, count);
    return count;
  };
}
