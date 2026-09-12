import { get_encoding, type Tiktoken } from "tiktoken";

/**
 * Token accounting for ChatGPT Web prompts.
 *
 * A character ratio is not safe here: dense JSON/base64 can contain far more tokens than prose
 * of the same length. Count with the tokenizer used by the GPT-5 generation instead.
 */

const TOKENIZER_CHUNK_CHARS = 4_096;
let tokenizer: Tiktoken | undefined;

function chatGptTokenizer(): Tiktoken {
  tokenizer ??= get_encoding("o200k_base");
  return tokenizer;
}

/**
 * Count ordinary text conservatively without handing pathological multi-megabyte runs to one
 * tokenizer call. Independent chunks can only lose cross-boundary merges, so their sum may
 * over-count slightly but cannot under-count because of a missed boundary token.
 */
export function estimateTokens(text: string, modelId?: string): number {
  void modelId;
  if (!text) return 0;

  const encoding = chatGptTokenizer();
  // Repeated low-density chunks (spaces, padding, generated data) are particularly expensive
  // for BPE. Reuse their exact counts within this call, without retaining prompt text globally.
  // Cap the cache so a large, non-repeating prompt cannot create unbounded extra storage.
  const chunkCounts = new Map<string, number>();
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
    const chunk = text.slice(start, end);
    let chunkCount = chunkCounts.get(chunk);
    if (chunkCount === undefined) {
      chunkCount = encoding.encode_ordinary(chunk).length;
      if (chunkCounts.size < 256) chunkCounts.set(chunk, chunkCount);
    }
    count += chunkCount;
    start = end;
  }
  return count;
}
