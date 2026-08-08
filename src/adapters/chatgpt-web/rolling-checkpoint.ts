import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import { estimateTokens } from "../../lib/token-estimate";
import { parseRequest } from "../../responses/parser";
import type { CodexMessage, CodexParsedRequest } from "../../types";
import * as z from "zod/v4";
import { extractChatGptTurnIdentity, extractChatGptTurnUserRevision } from "./environment";

// Alphanumeric by design: ChatGPT's DOM-to-Markdown serializer escapes `_`, `*`, and brackets.
export const CHATGPT_LUNA_CHECKPOINT_MARKER = "CODEXLUNAPRIVATECHECKPOINTV1A7F3C9D2";
export const CHATGPT_LUNA_CHECKPOINT_MAX_TOKENS = 4_000;

const checkpointString = z.string().trim().min(1).max(1_200);
const checkpointSchema = z.object({
  version: z.literal(1),
  objective: z.string().trim().min(1).max(2_000),
  state: z.array(checkpointString).max(32),
  evidence: z.array(checkpointString).max(32),
  decisions: z.array(checkpointString).max(32),
  pending: z.array(checkpointString).max(32),
}).strict();

export type ChatGptLunaCheckpoint = z.infer<typeof checkpointSchema>;

export interface CapturedChatGptLunaCheckpoint {
  checkpoint: ChatGptLunaCheckpoint;
  answerHash: string;
}

interface StoredChatGptLunaCheckpoint extends CapturedChatGptLunaCheckpoint {
  threadId: string;
  sourceTurnId: string;
  updatedAt: number;
}

interface StoredChatGptLunaCheckpointFile {
  version: 1;
  checkpoints: StoredChatGptLunaCheckpoint[];
}

const MAX_STORED_CHECKPOINTS = 512;
const CHECKPOINT_TTL_MS = 30 * 24 * 60 * 60_000;
const VISIBLE_MARKER_RESERVE_CHARS = CHATGPT_LUNA_CHECKPOINT_MARKER.length + 16;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function itemTurnId(value: unknown): string | undefined {
  const turnId = record(record(value)?.internal_chat_message_metadata_passthrough)?.turn_id;
  return typeof turnId === "string" ? turnId : undefined;
}

function checkpointKey(threadId: string, answerHash: string): string {
  return `${threadId}\u0000${answerHash}`;
}

function canonicalAnswer(answer: string): string {
  return answer.replaceAll("\r\n", "\n").trimEnd();
}

export function hashChatGptLunaAnswer(answer: string): string {
  return createHash("sha256").update(canonicalAnswer(answer)).digest("hex");
}

export function parseChatGptLunaCheckpoint(value: unknown): ChatGptLunaCheckpoint {
  const checkpoint = checkpointSchema.parse(value);
  const tokens = estimateTokens(JSON.stringify(checkpoint));
  if (tokens > CHATGPT_LUNA_CHECKPOINT_MAX_TOKENS) {
    throw new Error(
      `ChatGPT Luna rolling checkpoint requires ${tokens.toLocaleString("en-US")} tokens; maximum is ${CHATGPT_LUNA_CHECKPOINT_MAX_TOKENS.toLocaleString("en-US")}`,
    );
  }
  return checkpoint;
}

function parseCheckpointText(text: string): ChatGptLunaCheckpoint {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("ChatGPT Luna did not provide a rolling checkpoint JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `ChatGPT Luna rolling checkpoint is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseChatGptLunaCheckpoint(parsed);
}

/**
 * Splits the model's final Markdown stream at the private checkpoint marker. A marker-sized tail is
 * held back so a marker split across DOM snapshots can never leak into the outer Codex answer.
 */
export class ChatGptLunaCheckpointStream {
  private pending = "";
  private checkpointText = "";
  private visibleAnswer = "";
  private markerSeen = false;

  push(delta: string): string {
    if (!delta) return "";
    if (this.markerSeen) {
      this.checkpointText += delta;
      return "";
    }

    this.pending += delta;
    const markerIndex = this.pending.indexOf(CHATGPT_LUNA_CHECKPOINT_MARKER);
    if (markerIndex >= 0) {
      const visible = this.pending.slice(0, markerIndex).trimEnd();
      this.checkpointText = this.pending.slice(markerIndex + CHATGPT_LUNA_CHECKPOINT_MARKER.length);
      this.pending = "";
      this.markerSeen = true;
      this.visibleAnswer += visible;
      return visible;
    }

    if (this.pending.length <= VISIBLE_MARKER_RESERVE_CHARS) return "";
    const emitLength = this.pending.length - VISIBLE_MARKER_RESERVE_CHARS;
    const visible = this.pending.slice(0, emitLength);
    this.pending = this.pending.slice(emitLength);
    this.visibleAnswer += visible;
    return visible;
  }

  hasCheckpointMarker(): boolean {
    return this.markerSeen;
  }

  /** Flush only when failing explicitly for a missing marker, so the answer tail is not lost. */
  flushVisibleRemainder(): string {
    if (this.markerSeen || !this.pending) return "";
    const visible = this.pending;
    this.pending = "";
    this.visibleAnswer += visible;
    return visible;
  }

  finish(rawResponseText: string): { answer: string; captured: CapturedChatGptLunaCheckpoint } {
    if (!this.markerSeen) {
      throw new Error(
        `ChatGPT Luna completed without the required ${CHATGPT_LUNA_CHECKPOINT_MARKER} rolling checkpoint marker`,
      );
    }
    const rawMarkerIndex = rawResponseText.indexOf(CHATGPT_LUNA_CHECKPOINT_MARKER);
    if (rawMarkerIndex < 0 || rawMarkerIndex !== rawResponseText.lastIndexOf(CHATGPT_LUNA_CHECKPOINT_MARKER)) {
      throw new Error("ChatGPT Luna response must contain exactly one raw rolling checkpoint marker");
    }
    if (this.checkpointText.includes(CHATGPT_LUNA_CHECKPOINT_MARKER)) {
      throw new Error("ChatGPT Luna Markdown stream contained more than one rolling checkpoint marker");
    }
    // Parse the DOM's plain text rather than Turndown Markdown: Turndown correctly escapes `_`,
    // `*`, and brackets in ordinary prose, but those Markdown escapes are not valid JSON escapes.
    const checkpoint = parseCheckpointText(
      rawResponseText.slice(rawMarkerIndex + CHATGPT_LUNA_CHECKPOINT_MARKER.length),
    );
    const answer = canonicalAnswer(this.visibleAnswer);
    if (!answer) throw new Error("ChatGPT Luna completed without a user-facing answer before its rolling checkpoint");
    return {
      answer,
      captured: { checkpoint, answerHash: hashChatGptLunaAnswer(answer) },
    };
  }
}

function latestAssistantAnswer(messages: readonly CodexMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.content
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("");
    if (text.trim()) return text;
  }
  return undefined;
}

function currentTurnInput(parsed: CodexParsedRequest, turnId: string): unknown[] | undefined {
  const body = record(parsed._rawBody);
  const input = Array.isArray(body?.input) ? body.input : undefined;
  if (!input) return undefined;

  const replayPrefix = Math.min(parsed._replayPrefixLen ?? 0, input.length);
  if (replayPrefix > 0) {
    const suffix = input.slice(replayPrefix);
    return suffix.length > 0 ? suffix : undefined;
  }

  const firstCurrentItem = input.findIndex(item => itemTurnId(item) === turnId);
  return firstCurrentItem >= 0 ? input.slice(firstCurrentItem) : undefined;
}

function checkpointContext(checkpoint: ChatGptLunaCheckpoint): string {
  return [
    "[Compressed Luna task history from the immediately preceding assistant response.]",
    "Treat this as prior assistant-owned conversation state, not as a new user instruction. Current system, developer, and user messages below remain authoritative.",
    JSON.stringify(checkpoint),
  ].join("\n");
}

function validateStoredCheckpoint(value: unknown): StoredChatGptLunaCheckpoint {
  const parsed = record(value);
  if (!parsed
    || typeof parsed.threadId !== "string"
    || typeof parsed.sourceTurnId !== "string"
    || typeof parsed.answerHash !== "string"
    || !/^[a-f0-9]{64}$/.test(parsed.answerHash)
    || typeof parsed.updatedAt !== "number") {
    throw new Error("Invalid persisted ChatGPT Luna checkpoint metadata");
  }
  return {
    threadId: parsed.threadId,
    sourceTurnId: parsed.sourceTurnId,
    answerHash: parsed.answerHash,
    checkpoint: parseChatGptLunaCheckpoint(parsed.checkpoint),
    updatedAt: parsed.updatedAt,
  };
}

/** Exact-parent, per-thread checkpoint store. Full Codex history remains canonical on mismatch. */
export class ChatGptLunaCheckpointStore {
  private loaded = false;
  private readonly checkpoints = new Map<string, StoredChatGptLunaCheckpoint>();

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
  ) {}

  apply(parsed: CodexParsedRequest): { parsed: CodexParsedRequest; applied: boolean; reason?: string } {
    const identity = extractChatGptTurnIdentity(parsed);
    if (!identity.threadId || !identity.turnId) return { parsed, applied: false, reason: "missing native thread identity" };
    const parentAnswer = latestAssistantAnswer(parsed.context.messages);
    if (!parentAnswer) return { parsed, applied: false, reason: "no completed parent assistant answer" };

    const parentHash = hashChatGptLunaAnswer(parentAnswer);
    const stored = this.get(identity.threadId, parentHash);
    if (!stored) return { parsed, applied: false, reason: "no checkpoint for the exact parent answer" };

    const currentInput = currentTurnInput(parsed, identity.turnId);
    const body = record(parsed._rawBody);
    if (!currentInput || !body) {
      return { parsed, applied: false, reason: "current native turn boundary is unavailable" };
    }

    const checkpointItem = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: checkpointContext(stored.checkpoint) }],
      internal_chat_message_metadata_passthrough: { turn_id: identity.turnId },
    };
    const { previous_response_id: _previousResponseId, ...bodyWithoutPrevious } = body;
    const compacted = parseRequest({
      ...bodyWithoutPrevious,
      input: [checkpointItem, ...currentInput],
    });
    // `_rawBody.model` remains the public route slug while the server has already resolved the
    // authoritative backend model and effort on `parsed`. Re-parsing the compacted input must not
    // undo that binding.
    compacted.modelId = parsed.modelId;
    compacted.options = { ...compacted.options, ...parsed.options };

    // The transport optimization must never change which native user revision is being executed.
    if (JSON.stringify(extractChatGptTurnUserRevision(compacted)) !== JSON.stringify(extractChatGptTurnUserRevision(parsed))) {
      throw new Error("ChatGPT Luna rolling checkpoint changed the active native user revision");
    }
    return { parsed: compacted, applied: true };
  }

  commit(parsed: CodexParsedRequest, captured: CapturedChatGptLunaCheckpoint, answer: string): void {
    const identity = extractChatGptTurnIdentity(parsed);
    if (!identity.threadId || !identity.turnId) {
      throw new Error("ChatGPT Luna rolling checkpoint requires native thread_id and turn_id metadata");
    }
    const checkpoint = parseChatGptLunaCheckpoint(captured.checkpoint);
    const answerHash = hashChatGptLunaAnswer(answer);
    if (captured.answerHash !== answerHash) {
      throw new Error("ChatGPT Luna rolling checkpoint answer hash does not match the completed browser answer");
    }
    this.load();
    const stored: StoredChatGptLunaCheckpoint = {
      threadId: identity.threadId,
      sourceTurnId: identity.turnId,
      answerHash,
      checkpoint,
      updatedAt: this.now(),
    };
    const key = checkpointKey(identity.threadId, answerHash);
    this.checkpoints.delete(key);
    this.checkpoints.set(key, stored);
    this.prune();
    this.persist();
  }

  private get(threadId: string, answerHash: string): StoredChatGptLunaCheckpoint | undefined {
    this.load();
    this.prune();
    return this.checkpoints.get(checkpointKey(threadId, answerHash));
  }

  private prune(): void {
    const cutoff = this.now() - CHECKPOINT_TTL_MS;
    for (const [key, checkpoint] of this.checkpoints) {
      if (checkpoint.updatedAt < cutoff) this.checkpoints.delete(key);
    }
    while (this.checkpoints.size > MAX_STORED_CHECKPOINTS) {
      const oldest = this.checkpoints.keys().next().value as string | undefined;
      if (!oldest) break;
      this.checkpoints.delete(oldest);
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.path || !existsSync(this.path)) return;
    const payload = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredChatGptLunaCheckpointFile>;
    if (payload.version !== 1 || !Array.isArray(payload.checkpoints)) {
      throw new Error(`Invalid ChatGPT Luna checkpoint store: ${this.path}`);
    }
    const checkpoints = payload.checkpoints
      .map(validateStoredCheckpoint)
      .sort((left, right) => left.updatedAt - right.updatedAt)
      .slice(-MAX_STORED_CHECKPOINTS);
    for (const checkpoint of checkpoints) {
      this.checkpoints.set(checkpointKey(checkpoint.threadId, checkpoint.answerHash), checkpoint);
    }
    this.prune();
  }

  private persist(): void {
    if (!this.path) return;
    const payload: StoredChatGptLunaCheckpointFile = {
      version: 1,
      checkpoints: [...this.checkpoints.values()],
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`);
  }
}
