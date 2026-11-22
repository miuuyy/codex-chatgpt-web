import { createHash } from "node:crypto";
import { ChatGptWebAdapterError } from "./adapter-error";
import type { BrowserTurn } from "./browser-worker";

const TURN_TOKEN_PATTERN = /^turn_[A-Za-z0-9_-]{32}$/;
const NATIVE_TOOLS = new Set(["codex_exec", "codex_write_stdin", "codex_apply_patch", "codex_view_image",
  "codex_tool_inventory", "codex_tool_call", "codex_turn_start", "codex_turn_complete"]);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Reads only current assistant-to-plugin call envelopes, never quoted user/model prose. */
export class ChatGptTokenCopyObserver {
  private userSeen = false;
  private userCreatedAt?: number;
  private call?: { id: unknown; text: string; status?: string };
  private preview?: { id: string; finished: boolean };
  private replayUnsafe = false;
  private path?: string;
  private operation?: string;
  private rejected = false;
  private verifying?: { id: unknown; digest: string };

  constructor(
    private readonly expected: string,
    private readonly connectorNamespace: string,
    private readonly reject: () => void,
    private readonly verifyRejected?: (digest: string) => Promise<boolean>,
  ) {}

  accept(event: Record<string, unknown>): void {
    const whole = object(event.message) ?? object(object(event.v)?.message)
      ?? (event.type === "input_message" ? object(event.input_message) : undefined);
    if (whole) {
      const role = object(whole.author)?.role;
      if (role === "user") {
        this.userSeen = true;
        this.userCreatedAt = typeof whole.create_time === "number" ? whole.create_time : undefined;
      }
      const content = object(whole.content);
      const current = this.userCreatedAt === undefined || typeof whole.create_time !== "number"
        || whole.create_time >= this.userCreatedAt;
      if (this.preview && this.preview.id !== whole.id) {
        if (!this.preview.finished) this.replayUnsafe = true;
        this.preview = undefined;
      }
      const metadata = object(whole.metadata);
      // The live backend emits an empty, hidden preview ahead of the actual API
      // call. Only this exact envelope is harmless; a populated or changed
      // functions.exec message stays an ambiguous dispatch.
      const preview = role === "assistant" && whole.recipient === "functions.exec" && whole.channel === "commentary"
        && typeof whole.id === "string" && metadata?.message_type === "next"
        && metadata.is_visually_hidden_from_conversation === true && content?.content_type === "text"
        && Array.isArray(content.parts) && content.parts.length === 1 && content.parts[0] === "";
      if (this.userSeen && current && role === "assistant" && typeof whole.recipient === "string"
        && whole.recipient !== "all" && whole.recipient !== "api_tool.call_tool" && !preview) {
        this.replayUnsafe = true;
      }
      // A tool envelope that disappears before its outcome is known could have been dispatched.
      if (this.call && this.call.id !== whole.id && this.call.status !== "finished_successfully") {
        this.replayUnsafe = true;
      }
      if (preview) this.preview = { id: whole.id as string, finished: whole.status === "finished_successfully" };
      else if (this.preview) { this.preview = undefined; this.replayUnsafe = true; }
      this.call = this.userSeen && current && role === "assistant" && whole.recipient === "api_tool.call_tool"
        && content?.content_type === "code"
        ? { id: whole.id, text: typeof content.text === "string" ? content.text : "", status: String(whole.status ?? "") }
        : undefined;
      this.check();
      return;
    }
    this.patch(event);
  }

  private patch(event: Record<string, unknown>, depth = 0, inheritedPath = this.path, inheritedOperation = this.operation): void {
    if (depth > 8) return;
    const path = typeof event.p === "string" ? event.p : inheritedPath;
    const operation = typeof event.o === "string" ? event.o : inheritedOperation;
    const value = object(event.v);
    if (value?.message) { this.accept({ message: value.message }); return; }
    if (path === "/message" && value) { this.accept({ message: value }); return; }
    if (depth === 0) { this.path = path; this.operation = operation; }
    if (operation === "patch" && Array.isArray(event.v)) {
      let childPath = path;
      let childOperation: string | undefined;
      for (const item of event.v.slice(0, 256)) {
        const child = object(item);
        if (!child) continue;
        childPath = typeof child.p === "string" ? child.p : childPath;
        childOperation = typeof child.o === "string" ? child.o : childOperation;
        this.patch(child, depth + 1, childPath, childOperation);
      }
      return;
    }
    if (this.preview) {
      if (path === "/message/status") this.preview.finished = event.v === "finished_successfully";
      else if (path !== "/message/end_turn" && path !== "/message/metadata") this.replayUnsafe = true;
      return;
    }
    if (!this.call) return;
    if (path === "/message/content/text" && typeof event.v === "string") {
      this.call.text = operation === "append" ? this.call.text + event.v : event.v;
      if (this.call.text.length > 256_000) { this.replayUnsafe = true; this.call = undefined; return; }
    }
    if (path === "/message/status" && typeof event.v === "string") this.call.status = event.v;
    this.check();
  }

  private check(): void {
    if (this.rejected || this.replayUnsafe || this.call?.status !== "finished_successfully"
      || !TURN_TOKEN_PATTERN.test(this.expected)) return;
    let invocation: Record<string, unknown> | undefined;
    try { invocation = object(JSON.parse(this.call.text)); } catch { /* The call outcome is unknown. */ }
    const path = typeof invocation?.path === "string" ? invocation.path : undefined;
    const prefix = `${this.connectorNamespace}/`;
    const name = path?.startsWith(prefix) ? path.slice(prefix.length) : undefined;
    const copied = object(invocation?.args)?.turn_token;
    const digest = typeof copied === "string" && TURN_TOKEN_PATTERN.test(copied)
      ? createHash("sha256").update(copied).digest("hex") : undefined;
    if (this.verifying) {
      if (!name || !NATIVE_TOOLS.has(name) || this.verifying.id !== this.call.id || this.verifying.digest !== digest) {
        this.replayUnsafe = true;
      }
      return;
    }
    const missingCharacter = typeof copied === "string" && copied.length === this.expected.length - 1
      && Array.from(this.expected).some((_, index) => this.expected.slice(0, index) + this.expected.slice(index + 1) === copied);
    if (name && NATIVE_TOOLS.has(name) && missingCharacter) {
      this.rejected = true;
      this.reject();
      return;
    }
    if (!name || !NATIVE_TOOLS.has(name) || !this.verifyRejected || !digest || copied === this.expected) {
      // Another plugin call might have run even when the native broker has not reported progress.
      this.replayUnsafe = true;
      return;
    }
    // A full-length value could authorize a different live turn. Recover only
    // when this exact capability was actually denied by the local broker.
    this.verifying = { id: this.call.id, digest };
    void this.verifyRejected(digest).then(denied => {
      if (!denied || this.replayUnsafe || this.rejected) return;
      this.rejected = true;
      this.reject();
    }).catch(() => { this.replayUnsafe = true; });
  }
}

export function canReplayTokenCopy(turn: BrowserTurn, outputObserved: boolean): boolean {
  const progress = turn.externalProgress?.snapshot();
  return !outputObserved && !turn.abortSignal?.aborted
    && !(progress && (progress.lastToolBatchRevision > 0 || progress.activeToolCalls > 0));
}

/** Replay only a proven miscopied capability, before any answer or tool execution. */
export async function runWithTokenCopyRecovery(turn: BrowserTurn, run: (turn: BrowserTurn) => Promise<string>): Promise<string> {
  const prepareRetry = turn.prepareTokenCopyRetry;
  if (!prepareRetry) return run(turn);
  let outputObserved = false;
  let current = turn;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run({ ...current,
        onTextDelta: text => { outputObserved ||= Boolean(text.trim()); turn.onTextDelta(text); },
        onCommentary: (text, continuation) => {
          outputObserved ||= Boolean(text.trim()); turn.onCommentary?.(text, continuation);
        },
      });
    } catch (error) {
      if (!(error instanceof ChatGptWebAdapterError) || !error.tokenCopyRejected
        || !canReplayTokenCopy(turn, outputObserved)) throw error;
      if (attempt >= 2) {
        throw new ChatGptWebAdapterError(error.message, {
          status: error.status, errorType: error.errorType, code: "chatgpt_token_copy_retries_exhausted",
          retryable: false, tokenCopyRejected: true, cause: error,
        });
      }
      console.info(`[chatgpt-web] token_copy_recovery ${JSON.stringify({ attempt: attempt + 1 })}`);
      current = { ...turn, traceId: `${turn.traceId}_token${attempt + 1}`, prepareResume: undefined,
        prepare: prepareRetry,
        retainConversation: false, requireRetainedConversation: false, conversationKey: undefined };
    }
  }
}
