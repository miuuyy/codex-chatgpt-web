import type { CDPSession, Page } from "playwright-core";

const MAX_FRAME_CHARS = 256_000;
const MAX_MESSAGES = 32;
const ROLES = new Set(["assistant", "user", "tool", "system"]);
const CHANNELS = new Set(["analysis", "commentary", "final", "summary", "notification", "justify", "confidence"]);
const STATUSES = new Set(["in_progress", "finished_successfully", "finished_partial", "error"]);
// CDP errorText is free text. Export only recognized Chromium network codes,
// never arbitrary messages, URLs, certificate subjects or proxy details.
const NETWORK_ERRORS = new Set([
  "net::ERR_FAILED", "net::ERR_ABORTED", "net::ERR_CONNECTION_RESET", "net::ERR_CONNECTION_CLOSED",
  "net::ERR_CONNECTION_REFUSED", "net::ERR_CONNECTION_TIMED_OUT", "net::ERR_TIMED_OUT",
  "net::ERR_NETWORK_CHANGED", "net::ERR_INTERNET_DISCONNECTED", "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_CERT_AUTHORITY_INVALID", "net::ERR_CERT_DATE_INVALID", "net::ERR_CERT_COMMON_NAME_INVALID",
  "net::ERR_SSL_PROTOCOL_ERROR", "net::ERR_HTTP2_PROTOCOL_ERROR", "net::ERR_QUIC_PROTOCOL_ERROR",
]);
type MessageState = { message: number; role?: string; channel?: string; status?: string; endTurn?: boolean };
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Diagnostic observation timed out")), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

/** Diagnostic projection only. It never supplies completion, liveness, retry or tool authority. */
export class ChatGptStreamProjection {
  private buffer = "";
  private discarding = false;
  private readonly decoder = new TextDecoder();
  private readonly messages = new Map<string, MessageState>();
  private current?: MessageState;
  private path?: string;
  private operation?: string;
  private frames = 0;
  private malformed = 0;
  private unresolved = 0;
  private oversized = 0;
  private omittedMessages = 0;
  private messageSequence = 0;
  private done = false;
  private serviceError = false;
  private readonly formats = new Map<string, number>();
  private omittedFormats = 0;

  push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const frame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      if (!this.discarding && frame.length <= MAX_FRAME_CHARS) this.frame(frame);
      else if (!this.discarding) this.oversized += 1;
      this.discarding = false;
    }
    if (this.buffer.length > MAX_FRAME_CHARS) {
      if (!this.discarding) this.oversized += 1;
      this.discarding = true;
      this.buffer = this.buffer.slice(-3); // Retain a possible split CRLF delimiter only.
    }
  }

  snapshot() {
    return { frames: this.frames, doneMarker: this.done, serviceError: this.serviceError,
      malformedFrames: this.malformed, unresolvedPatches: this.unresolved,
      oversizedFrames: this.oversized, omittedMessages: this.omittedMessages,
      incompleteFrame: this.discarding || this.buffer.trim().length > 0,
      messages: [...this.messages.values()].map(state => ({ ...state })),
      omittedFormats: this.omittedFormats,
      formats: [...this.formats].map(([shape, count]) => ({ ...JSON.parse(shape), count })) };
  }

  private frame(frame: string): void {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return;
    if (data === "[DONE]") { this.done = true; return; }
    this.frames += 1;
    let value: unknown;
    try { value = JSON.parse(data); } catch { this.malformed += 1; return; }
    const event = object(value);
    if (!event) { this.unresolved += 1; return; }
    const keys = (item: Record<string, unknown> | undefined) => item
      ? Object.keys(item).filter(key => ["message", "messages", "id", "author", "role", "channel", "status", "end_turn", "content", "p", "o", "v", "type", "message_id", "delta", "metadata"].includes(key)).sort() : [];
    const shape = JSON.stringify({ keys: keys(event), valueKeys: keys(object(event.v)),
      operation: ["add", "append", "replace", "patch"].includes(String(event.o)) ? event.o : "unspecified",
      path: typeof event.p === "string" ? event.p === "" ? "root" : event.p === "/message" ? "message"
        : event.p.startsWith("/message/content/") ? "content" : ["/message/author/role", "/message/channel", "/message/status", "/message/end_turn"].includes(event.p) ? event.p : "other" : "inherited",
      valueType: Array.isArray(event.v) ? "array" : typeof event.v });
    if (!this.formats.has(shape) && this.formats.size >= 8) {
      this.formats.delete(this.formats.keys().next().value!);
      this.omittedFormats += 1;
    }
    this.formats.set(shape, (this.formats.get(shape) ?? 0) + 1);
    if (event.error || event.error_code) this.serviceError = true;
    if (object(event.message)) { this.message(event.message); return; }
    this.patch(event);
  }

  private message(value: unknown): void {
    const message = object(value);
    if (!message || typeof message.id !== "string" || message.id.length > 200) {
      this.current = undefined;
      this.unresolved += 1;
      return;
    }
    let state = this.messages.get(message.id);
    if (!state) {
      if (this.messages.size >= MAX_MESSAGES) {
        this.messages.delete(this.messages.keys().next().value!);
        this.omittedMessages += 1;
      }
      state = { message: ++this.messageSequence };
      this.messages.set(message.id, state);
    }
    this.current = state;
    this.field("/message/author/role", object(message.author)?.role);
    this.field("/message/channel", message.channel);
    this.field("/message/status", message.status);
    this.field("/message/end_turn", message.end_turn);
  }

  private patch(event: Record<string, unknown>, depth = 0, previousPath = this.path, previousOperation = this.operation): void {
    if (depth > 8) { this.unresolved += 1; return; }
    const path = typeof event.p === "string" ? event.p : previousPath;
    const operation = typeof event.o === "string" ? event.o : previousOperation;
    // A patch array has its own path/operation context. Its last child must not
    // redirect the next root-level value-only message into a message field.
    if (depth === 0) { this.path = path; this.operation = operation; }
    if (operation === "patch" && Array.isArray(event.v)) {
      let childPath = path;
      let childOperation: string | undefined;
      for (const entry of event.v.slice(0, 256)) {
        const child = object(entry);
        if (child) {
          childPath = typeof child.p === "string" ? child.p : childPath;
          childOperation = typeof child.o === "string" ? child.o : childOperation;
          this.patch(child, depth + 1, childPath, childOperation);
        }
        else this.unresolved += 1;
      }
      if (event.v.length > 256) this.unresolved += event.v.length - 256;
      return;
    }
    if (!Object.hasOwn(event, "v")) return;
    const value = object(event.v);
    if (value?.message && (path === "" || path === undefined)) { this.message(value.message); return; }
    if (path === "/message" && value) { this.message(value); return; }
    if (path === undefined || operation === undefined) { this.unresolved += 1; return; }
    if (operation !== "replace" && operation !== "add" && operation !== "append") {
      this.unresolved += 1;
      return;
    }
    // Text, citations, tool arguments and arbitrary keys are never retained.
    // Value-only deltas inherit only an explicitly observed path and operation.
    if (["/message/author/role", "/message/channel", "/message/status", "/message/end_turn"].includes(path)) {
      if (operation === "append") { this.unresolved += 1; return; }
      this.field(path, event.v);
    }
  }

  private field(path: string, value: unknown): void {
    if (value === undefined || value === null) return;
    if (!this.current) { this.unresolved += 1; return; }
    if (path === "/message/end_turn") {
      if (typeof value === "boolean") this.current.endTurn = value;
      else this.unresolved += 1;
      return;
    }
    const [key, allowed] = path === "/message/author/role" ? ["role", ROLES] as const
      : path === "/message/channel" ? ["channel", CHANNELS] as const : ["status", STATUSES] as const;
    if (typeof value === "string" && allowed.has(value)) this.current[key] = value;
    else this.unresolved += 1;
  }
}

type Capture = {
  request: number; submission: number; projection: ChatGptStreamProjection; status?: number;
  pending: Uint8Array[]; pendingBytes: number; streaming: boolean; unavailable: boolean;
  enabling?: Promise<void>; terminal?: "finished" | "aborted" | "failed" | "detached";
  networkError?: string;
};

/** Passive CDP observation of only the owned page's submissions after Send. */
export class ChatGptStreamDiagnostics {
  private session?: CDPSession;
  private readonly captures = new Map<string, Capture>();
  private submission = 0;
  private sequence = 0;
  private generation = 0;

  constructor(private readonly report: (state: Record<string, unknown>) => void) {}

  begin(): void { this.submission += 1; }

  async attach(page: Page): Promise<void> {
    await this.dispose();
    const generation = this.generation;
    let session: CDPSession | undefined;
    try {
      const opening = page.context().newCDPSession(page);
      void opening.then(late => {
        if (generation !== this.generation) void bounded(late.detach()).catch(() => {});
      }, () => {});
      session = await bounded(opening);
      const { frameTree } = await bounded(session.send("Page.getFrameTree"));
      if (generation !== this.generation) { await bounded(session.detach()); return; }
      this.session = session;
      session.on("Network.requestWillBeSent", event => {
        if (generation !== this.generation || !this.submission || event.frameId !== frameTree.frame.id || event.request.method !== "POST"
          || event.request.url !== "https://chatgpt.com/backend-api/f/conversation") return;
        if (this.captures.size >= 12) { this.report({ unavailable: true, reason: "request_limit" }); return; }
        this.captures.set(event.requestId, { request: ++this.sequence, submission: this.submission,
          projection: new ChatGptStreamProjection(), pending: [], pendingBytes: 0, streaming: false, unavailable: false });
      });
      session.on("Network.responseReceived", event => {
        if (generation !== this.generation) return;
        const capture = this.captures.get(event.requestId);
        if (!capture) return;
        capture.status = event.response.status;
        if (event.response.mimeType !== "text/event-stream") return;
        capture.enabling = bounded(session!.send("Network.streamResourceContent", { requestId: event.requestId })).then(result => {
          if (generation !== this.generation) return;
          capture.projection.push(Buffer.from(result.bufferedData, "base64"));
          capture.pending.forEach(bytes => capture.projection.push(bytes));
          capture.streaming = true;
        }).catch(() => { capture.unavailable = true; }).finally(() => {
          capture.pending = [];
          capture.pendingBytes = 0;
        });
      });
      session.on("Network.dataReceived", event => {
        if (generation !== this.generation) return;
        const capture = this.captures.get(event.requestId);
        if (!capture || !event.data) return;
        const bytes = Buffer.from(event.data, "base64");
        if (capture.streaming) capture.projection.push(bytes);
        else if (capture.pendingBytes + bytes.length <= 1_000_000) {
          capture.pending.push(bytes); capture.pendingBytes += bytes.length;
        } else capture.unavailable = true;
      });
      const finish = (id: string, terminal: Capture["terminal"], networkError?: string) => {
        if (generation !== this.generation) return;
        const capture = this.captures.get(id);
        if (!capture) return;
        capture.terminal = terminal;
        capture.networkError = networkError;
        void Promise.resolve(capture.enabling).then(() => {
          if (generation !== this.generation || this.captures.get(id) !== capture) return;
          this.emit(capture); this.captures.delete(id);
        });
      };
      session.on("Network.loadingFinished", event => finish(event.requestId, "finished"));
      session.on("Network.loadingFailed", event => finish(event.requestId, event.canceled ? "aborted" : "failed",
        NETWORK_ERRORS.has(event.errorText) ? event.errorText : "unknown"));
      await bounded(session.send("Network.enable", { maxTotalBufferSize: 1_000_000, maxResourceBufferSize: 512_000, maxPostDataSize: 0 }));
    } catch {
      if (generation === this.generation) this.generation += 1;
      this.report({ unavailable: true, reason: "observer_unavailable" });
      if (session) await bounded(session.detach()).catch(() => {});
      this.session = undefined;
    }
  }

  private emit(capture: Capture): void {
    this.report({ request: capture.request, submission: capture.submission, status: capture.status,
      terminal: capture.terminal, unavailable: capture.unavailable || !capture.streaming,
      ...(capture.networkError ? { networkError: capture.networkError } : {}),
      ...capture.projection.snapshot() });
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    for (const capture of this.captures.values()) {
      capture.terminal ??= "detached";
      this.emit(capture);
    }
    this.captures.clear();
    const session = this.session;
    this.session = undefined;
    if (session) await bounded(session.detach()).catch(() => {});
  }
}
