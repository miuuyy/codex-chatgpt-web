import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isWindowsPipeEndpoint } from "../../config";
import type { ChatGptTurnEnvironment } from "./environment";

interface PendingTurn extends ChatGptTurnEnvironment {
  expiresAt?: number;
}

export interface BrokerToolRequest {
  callId: string;
  wireName: string;
  freeform: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
}

export interface BrokerToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

interface PendingInvocation {
  request: BrokerToolRequest;
  invocationKey: string;
  fingerprint: string;
  promise: Promise<BrokerToolResult>;
  resolve: (result: BrokerToolResult) => void;
  reject: (error: Error) => void;
  operationKey?: string;
  operationRequestKey?: string;
  continuationToken?: string;
}

interface OperationContinuation {
  currentToken: string;
  uses: Map<string, { invocationKey: string; nextToken?: string }>;
}

interface ToolWaiter {
  resolve: (requests: BrokerToolRequest[]) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface TurnChannel {
  traceId: string;
  externalOwner: boolean;
  environment: PendingTurn;
  retiring: boolean;
  bindingId?: string;
  queuedCallIds: string[];
  invocations: Map<string, PendingInvocation>;
  invocationsByKey: Map<string, PendingInvocation>;
  replayCacheChars: number;
  replayCacheExhausted: boolean;
  activeOperations: Map<string, string>;
  operationContinuations: Map<string, OperationContinuation>;
  terminalizedOperationRequests: Set<string>;
  terminalizedOperationFingerprints: Map<string, Set<string>>;
  waiters: Set<ToolWaiter>;
  batchTimer?: ReturnType<typeof setTimeout>;
}

interface BrokerRequest {
  id: string;
  method:
    | "claim"
    | "resolve"
    | "release"
    | "invoke"
    | "terminalize"
    | "operation_status"
    | "continuation"
    | "advance_continuation"
    | "owner_status"
    | "owner_register"
    | "owner_update"
    | "owner_next"
    | "owner_complete"
    | "owner_revoke";
  token?: string;
  bindingId?: string;
  wireName?: string;
  freeform?: boolean;
  arguments?: Record<string, unknown>;
  input?: string;
  environment?: ChatGptTurnEnvironment;
  ttlMs?: number;
  traceId?: string;
  callId?: string;
  toolResult?: BrokerToolResult;
  invocationKey?: string;
  operationKey?: string;
  operationRequestKey?: string;
  continuationToken?: string;
}

interface BrokerResponse {
  id: string;
  result?: unknown;
  error?: string;
}

const brokers = new Map<string, TurnBroker>();
const MAX_BROKER_LINE_CHARS = 67_108_864;
const MAX_REPLAY_CACHE_ENTRIES = 512;
const MAX_REPLAY_CACHE_CHARS = 16_777_216;
const MAX_REPLAY_RESULT_CHARS = 8_388_608;
const MAX_RETIRED_TURN_HANDLES = 64;

const REPLAY_CACHE_EXHAUSTED_RESULT: BrokerToolResult = {
  content: [{
    type: "text",
    text: "UNRESOLVED_BROKER_RESULT_TOO_LARGE: the native result exceeded the bounded replay cache; redispatch is forbidden",
  }],
  isError: true,
};

export async function closeTurnBrokers(): Promise<void> {
  const active = [...brokers.values()];
  const results = await Promise.allSettled(active.map(broker => broker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT turn broker(s) failed to close`);
  }
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function handleFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function opaqueLogId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function retiredTurnLabel(traceId: string): string {
  return traceId && traceId !== "unknown" ? `Codex turn ${traceId}` : "a Codex turn";
}

function environmentIdentity(environment: ChatGptTurnEnvironment): string {
  return JSON.stringify({
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
  });
}

function ownerEnvironment(value: unknown): ChatGptTurnEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("turn owner environment is invalid");
  const environment = value as Partial<ChatGptTurnEnvironment>;
  const paths = (candidate: unknown): candidate is string[] => Array.isArray(candidate)
    && candidate.length > 0
    && candidate.every(path => typeof path === "string" && isAbsolute(path));
  if (typeof environment.cwd !== "string" || !isAbsolute(environment.cwd)
    || !paths(environment.roots) || !Array.isArray(environment.writableRoots)
    || environment.writableRoots.some(path => typeof path !== "string" || !isAbsolute(path))
    || !environment.roots.some(root => {
      const nested = relative(resolve(root), resolve(environment.cwd!));
      return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
    })
    || !environment.sandboxPolicy || !["dangerFullAccess", "workspaceWrite", "readOnly"].includes(environment.sandboxPolicy.type)
    || !Array.isArray(environment.tools)
    || environment.tools.some(tool => !tool || typeof tool.name !== "string" || typeof tool.description !== "string"
      || !tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters))) {
    throw new Error("turn owner environment is invalid");
  }
  return structuredClone(environment as ChatGptTurnEnvironment);
}

export interface TurnBrokerOwner {
  register(environment: ChatGptTurnEnvironment, ttlMs?: number, traceId?: string): Promise<string>;
  updateEnvironment(token: string, environment: ChatGptTurnEnvironment): void | Promise<void>;
  nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]>;
  completeTool(token: string, callId: string, result: BrokerToolResult): void | Promise<void>;
  revoke(token: string, reason?: Error): void | Promise<void>;
}

export class TurnBroker implements TurnBrokerOwner {
  static forSocket(path: string): TurnBroker {
    let broker = brokers.get(path);
    if (!broker) {
      broker = new TurnBroker(path);
      brokers.set(path, broker);
    }
    return broker;
  }

  private readonly channels = new Map<string, TurnChannel>();
  private readonly pending = new Map<string, TurnChannel>();
  private readonly bindings = new Map<string, { token: string; channel: TurnChannel }>();
  // The Codex context replayed into ChatGPT still carries the handles of finished turns, so a model
  // can present one. Remembering which turn retired a handle is what separates "you are holding a
  // previous turn's handle" from "this handle never existed".
  private readonly retiredBindings = new Map<string, string>();
  private readonly retiredTokens = new Map<string, string>();
  private acceptingExternalOwners = true;
  private protectedOperation?: {
    token: string;
    channel: TurnChannel;
    operationKey: string;
    operationRequestKey: string;
    delivered: boolean;
  };
  private readonly commandQuarantinePath: string;
  private orphanedCommandQuarantine: boolean;
  private server?: Server;
  private startPromise?: Promise<void>;

  private constructor(readonly socketPath: string) {
    this.commandQuarantinePath = isWindowsPipeEndpoint(socketPath)
      ? join(tmpdir(), `codex-chatgpt-web-command-${opaqueLogId(socketPath)}.lock`)
      : `${socketPath}.command-quarantine`;
    this.orphanedCommandQuarantine = existsSync(this.commandQuarantinePath);
  }

  /**
   * A ChatGPT turn outlives the request that started it, and its Codex Native calls arrive from a
   * separate MCP process. Creating the socket only once a turn registers leaves that process
   * connecting to a path that does not exist yet, so an in-flight turn reports a filesystem error
   * instead of the broker's own answer. The endpoint belongs to the runtime's lifetime.
   */
  async listen(): Promise<void> {
    await this.start();
  }

  async register(
    environment: ChatGptTurnEnvironment,
    ttlMs?: number,
    traceId = "unknown",
    externalOwner = false,
  ): Promise<string> {
    await this.start();
    this.prune();
    if (externalOwner && !this.acceptingExternalOwners) {
      throw new Error("turn broker is draining and does not accept new external owners");
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error("ChatGPT web turn broker TTL must be a positive finite number");
    }
    const token = opaqueId("turn");
    const channel: TurnChannel = {
      traceId,
      externalOwner,
      environment: {
        ...environment,
        ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      },
      retiring: false,
      queuedCallIds: [],
      invocations: new Map(),
      invocationsByKey: new Map(),
      replayCacheChars: 0,
      replayCacheExhausted: false,
      activeOperations: new Map(),
      operationContinuations: new Map(),
      terminalizedOperationRequests: new Set(),
      terminalizedOperationFingerprints: new Map(),
      waiters: new Set(),
    };
    this.channels.set(token, channel);
    this.pending.set(token, channel);
    console.info(`[chatgpt-web] broker trace=${traceId} registered tokenHash=${handleFingerprint(token)}`);
    return token;
  }

  updateEnvironment(token: string, environment: ChatGptTurnEnvironment): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (environmentIdentity(channel.environment) !== environmentIdentity(environment)) {
      throw new Error("Codex turn environment changed during an active ChatGPT tool loop");
    }
    channel.environment = {
      ...environment,
      ...(channel.environment.expiresAt !== undefined
        ? { expiresAt: channel.environment.expiresAt }
        : {}),
    };
  }

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    const ready = this.takeQueued(channel);
    if (ready.length > 0) return ready;
    if (signal?.aborted) throw new DOMException("tool wait aborted", "AbortError");
    return new Promise<BrokerToolRequest[]>((resolveWait, rejectWait) => {
      const waiter: ToolWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          channel.waiters.delete(waiter);
          rejectWait(new DOMException("tool wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      channel.waiters.add(waiter);
    });
  }

  completeTool(token: string, callId: string, result: BrokerToolResult): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    const invocation = channel.invocations.get(callId);
    if (!invocation) throw new Error(`tool call is not pending: ${opaqueLogId(callId)}`);
    if (channel.queuedCallIds.includes(callId)) {
      throw new Error(`tool call was completed before it was delivered: ${opaqueLogId(callId)}`);
    }
    channel.invocations.delete(callId);
    // Keep the resolved promise addressable by invocationKey until the turn is revoked. A retry
    // after transport loss must observe the original terminal result, never enqueue the tool again.
    let replayResult = result;
    let resultChars = 0;
    try {
      resultChars = JSON.stringify(result).length;
    } catch {
      channel.replayCacheExhausted = true;
      replayResult = REPLAY_CACHE_EXHAUSTED_RESULT;
      resultChars = JSON.stringify(replayResult).length;
    }
    if (resultChars > MAX_REPLAY_RESULT_CHARS
      || channel.replayCacheChars + resultChars > MAX_REPLAY_CACHE_CHARS) {
      channel.replayCacheExhausted = true;
      replayResult = REPLAY_CACHE_EXHAUSTED_RESULT;
      resultChars = JSON.stringify(replayResult).length;
    }
    channel.replayCacheChars += resultChars;
    console.info(`[chatgpt-web] broker trace=${channel.traceId} completed callHash=${opaqueLogId(callId)} pending=${channel.invocations.size}`);
    invocation.resolve(replayResult);
  }

  revoke(token: string, reason = new Error("Codex turn binding was revoked")): void {
    const channel = this.channels.get(token);
    if (!channel) return;
    const protectedOperation = this.protectedOperation;
    if (protectedOperation?.channel === channel && protectedOperation.delivered) {
      channel.retiring = true;
      this.pending.delete(token);
      return;
    }
    if (protectedOperation?.channel === channel) this.releaseCommandQuarantine();
    this.retireChannel(token, channel, reason);
  }

  private retireChannel(
    token: string,
    channel: TurnChannel,
    reason = new Error("Codex turn binding was revoked"),
  ): void {
    this.channels.delete(token);
    this.pending.delete(token);
    if (channel.bindingId) {
      this.bindings.delete(channel.bindingId);
      this.retire(this.retiredBindings, channel.bindingId, channel.traceId);
    }
    this.retire(this.retiredTokens, token, channel.traceId);
    this.rejectChannel(channel, reason);
  }

  externalOwnerActiveCount(): number {
    this.prune();
    return [...this.channels.values()].filter(channel => channel.externalOwner).length;
  }

  revokeExternalOwners(): number {
    const tokens = [...this.channels]
      .filter(([, channel]) => channel.externalOwner)
      .map(([token]) => token);
    for (const token of tokens) this.revoke(token);
    return tokens.length;
  }

  revokeTrace(traceId: string, reason = new Error("Codex turn binding was revoked")): number {
    const tokens = [...this.channels]
      .filter(([, channel]) => channel.traceId === traceId)
      .map(([token]) => token);
    for (const token of tokens) this.revoke(token, reason);
    return tokens.length;
  }

  setExternalOwnersAccepted(accepted: boolean): void {
    this.acceptingExternalOwners = accepted;
  }

  private retire(history: Map<string, string>, handle: string, traceId: string): void {
    history.delete(handle);
    history.set(handle, traceId);
    while (history.size > MAX_RETIRED_TURN_HANDLES) {
      const oldest = history.keys().next();
      if (oldest.done) return;
      history.delete(oldest.value);
    }
  }

  private acquireCommandQuarantine(): void {
    if (this.orphanedCommandQuarantine || existsSync(this.commandQuarantinePath)) {
      this.orphanedCommandQuarantine = true;
      throw new Error("an unresolved command quarantine is already active");
    }
    mkdirSync(dirname(this.commandQuarantinePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.commandQuarantinePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeFileSync(temporaryPath, "unresolved-command\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporaryPath, this.commandQuarantinePath);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* best effort for an unpublished temporary file */ }
      throw error;
    }
  }

  private releaseCommandQuarantine(): void {
    if (!existsSync(this.commandQuarantinePath)) {
      this.orphanedCommandQuarantine = true;
      throw new Error("command quarantine marker disappeared before terminal evidence was committed");
    }
    unlinkSync(this.commandQuarantinePath);
    this.orphanedCommandQuarantine = false;
    this.protectedOperation = undefined;
  }

  async close(): Promise<void> {
    for (const token of [...this.channels.keys()]) this.revoke(token);
    const server = this.server;
    this.server = undefined;
    this.startPromise = undefined;
    brokers.delete(this.socketPath);
    if (server?.listening) {
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => {
        if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolveClose();
        else rejectClose(error);
      }));
    }
    if (!isWindowsPipeEndpoint(this.socketPath)
      && existsSync(this.socketPath)
      && lstatSync(this.socketPath).isSocket()) unlinkSync(this.socketPath);
  }

  private start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<void>((resolveStart, rejectStart) => {
      const windowsPipe = isWindowsPipeEndpoint(this.socketPath);
      if (!windowsPipe) mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
      const listen = () => {
        const server = createServer(socket => this.handleSocket(socket));
        this.server = server;
        server.once("error", rejectStart);
        server.on("error", error => {
          console.error(
            `[chatgpt-web] turn broker server error at ${this.socketPath}: ${errorOf(error).message}`,
          );
        });
        server.listen(this.socketPath, () => {
          server.off("error", rejectStart);
          if (!windowsPipe) chmodSync(this.socketPath, 0o600);
          resolveStart();
        });
      };

      if (windowsPipe) {
        listen();
        return;
      }
      if (!existsSync(this.socketPath)) {
        listen();
        return;
      }
      if (!lstatSync(this.socketPath).isSocket()) {
        rejectStart(new Error(`ChatGPT web broker path exists and is not a socket: ${this.socketPath}`));
        return;
      }
      const socketStat = lstatSync(this.socketPath);
      const getuid = process.getuid;
      if (typeof getuid === "function" && socketStat.uid !== getuid()) {
        rejectStart(new Error(`ChatGPT web broker socket is not owned by the current user: ${this.socketPath}`));
        return;
      }
      if ((socketStat.mode & 0o077) !== 0) {
        rejectStart(new Error(`ChatGPT web broker socket has unsafe permissions: ${this.socketPath}`));
        return;
      }
      const probe = createConnection(this.socketPath);
      let probeSettled = false;
      const finishProbe = (action: () => void) => {
        if (probeSettled) return;
        probeSettled = true;
        probe.destroy();
        action();
      };
      probe.setTimeout(2_000, () => finishProbe(() => {
        rejectStart(new Error(`Timed out while checking existing ChatGPT web broker socket: ${this.socketPath}`));
      }));
      probe.once("connect", () => {
        finishProbe(() => {
          rejectStart(new Error(`ChatGPT web broker socket is already owned by another process: ${this.socketPath}`));
        });
      });
      probe.once("error", error => {
        finishProbe(() => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ECONNREFUSED" && code !== "ENOENT") {
            rejectStart(new Error(
              `Could not verify existing ChatGPT web broker socket ${this.socketPath}: ${error.message}`,
            ));
            return;
          }
          try {
            if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
            listen();
          } catch (cleanupError) {
            rejectStart(errorOf(cleanupError));
          }
        });
      });
    });
    return this.startPromise;
  }

  private handleSocket(socket: Socket): void {
    let buffered = "";
    let handled = false;
    const abort = new AbortController();
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.once("close", () => abort.abort());
    socket.on("data", chunk => {
      if (handled) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS && !buffered.slice(0, MAX_BROKER_LINE_CHARS + 1).includes("\n")) {
        handled = true;
        this.writeSocketResponse(socket, { id: "unknown", error: "turn broker request exceeds size limit" });
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      const line = buffered.slice(0, newline);
      let request: BrokerRequest | undefined;
      try {
        if (line.length > MAX_BROKER_LINE_CHARS) throw new Error("turn broker request exceeds size limit");
        request = JSON.parse(line) as BrokerRequest;
        this.validateRequest(request);
      } catch (error) {
        this.writeSocketResponse(socket, { id: request?.id ?? "unknown", error: errorOf(error).message });
        return;
      }
      void Promise.resolve().then(() => this.dispatch(request!, abort.signal)).then(
        result => this.writeSocketResponse(socket, { id: request!.id, result }),
        error => this.writeSocketResponse(socket, { id: request!.id, error: errorOf(error).message }),
      );
    });
  }

  private writeSocketResponse(socket: Socket, response: BrokerResponse): void {
    const line = `${JSON.stringify(response)}\n`;
    if (line.length > MAX_BROKER_LINE_CHARS) {
      socket.end(`${JSON.stringify({ id: response.id, error: "turn broker response exceeds size limit" } satisfies BrokerResponse)}\n`);
      return;
    }
    socket.end(line);
  }

  private validateRequest(request: BrokerRequest): void {
    if (!request || typeof request !== "object" || typeof request.id !== "string" || request.id.length === 0 || request.id.length > 256) {
      throw new Error("turn broker request id is invalid");
    }
    if (!["claim", "resolve", "release", "invoke", "terminalize", "operation_status", "continuation", "advance_continuation", "owner_status", "owner_register", "owner_update", "owner_next", "owner_complete", "owner_revoke"].includes(request.method)) {
      throw new Error("turn broker method is invalid");
    }
  }

  private dispatch(request: BrokerRequest, signal?: AbortSignal): unknown | Promise<unknown> {
    this.prune();
    if (request.method === "owner_status") {
      return { protocolVersion: 1, acceptingExternalOwners: this.acceptingExternalOwners };
    }
    if (request.method === "owner_register") {
      const environment = ownerEnvironment(request.environment);
      if (request.traceId !== undefined && !/^[A-Za-z0-9_-]{6,128}$/.test(request.traceId)) {
        throw new Error("turn owner trace id is invalid");
      }
      return this.register(environment, request.ttlMs, request.traceId, true).then(token => ({ token }));
    }
    if (request.method === "owner_update") {
      if (!request.token) throw new Error("turn owner token is required");
      this.updateEnvironment(request.token, ownerEnvironment(request.environment));
      return { updated: true };
    }
    if (request.method === "owner_next") {
      if (!request.token) throw new Error("turn owner token is required");
      return this.nextToolBatch(request.token, signal).then(requests => ({ requests }));
    }
    if (request.method === "owner_complete") {
      if (!request.token) throw new Error("turn owner token is required");
      if (!request.callId) throw new Error("turn owner call id is required");
      if (!request.toolResult || !Array.isArray(request.toolResult.content)) {
        throw new Error("turn owner tool result is invalid");
      }
      this.completeTool(request.token, request.callId, request.toolResult);
      return { completed: true };
    }
    if (request.method === "owner_revoke") {
      if (!request.token) throw new Error("turn owner token is required");
      this.revoke(request.token);
      return { revoked: true };
    }
    if (request.method === "claim") {
      const token = request.token;
      if (typeof token !== "string" || token.length === 0) throw new Error("turn token is required");
      const channel = this.channels.get(token);
      const retiredTurn = channel ? undefined : this.retiredTokens.get(token);
      console.error(
        `[chatgpt-web] broker claim received (tokenChars=${token.length}, tokenHash=${handleFingerprint(token)}, valid=${Boolean(channel)}`
        + `${channel ? "" : `, retiredTurn=${retiredTurn ?? "unknown"}`})`,
      );
      if (!channel) {
        throw new Error(retiredTurn !== undefined
          ? `This turn_token was issued for ${retiredTurnLabel(retiredTurn)}, which has already finished.`
          + " This Codex Native action can no longer run."
          : "turn token is invalid, expired, or revoked");
      }
      if (channel.bindingId) {
        const existing = this.bindings.get(channel.bindingId);
        if (!existing || existing.token !== token || existing.channel !== channel) {
          throw new Error("turn token binding state is inconsistent");
        }
        return { bindingId: channel.bindingId, environment: channel.environment };
      }
      this.pending.delete(token);
      const bindingId = opaqueId("binding");
      channel.bindingId = bindingId;
      this.bindings.set(bindingId, { token, channel });
      return { bindingId, environment: channel.environment };
    }

    const bindingId = request.bindingId;
    if (typeof bindingId !== "string" || bindingId.length === 0) throw new Error("binding id is required");
    const binding = this.bindings.get(bindingId);
    if (!binding) {
      const retiredTurn = this.retiredBindings.get(bindingId);
      console.error(
        `[chatgpt-web] broker rejected ${request.method} (bindingHash=${opaqueLogId(bindingId)},`
        + ` retiredTurn=${retiredTurn ?? "unknown"})`,
      );
      throw new Error(retiredTurn !== undefined
        ? `${retiredTurnLabel(retiredTurn)} has already finished; this Codex Native action can no longer run.`
        : "internal Codex turn binding is invalid or expired");
    }
    if (request.method === "release") {
      this.revoke(binding.token);
      return { released: true };
    }
    if (request.method === "resolve") return { environment: binding.channel.environment };
    if (request.method === "operation_status") {
      const operationKey = request.operationKey;
      const operationRequestKey = request.operationRequestKey;
      this.validateOperationIdentity(operationKey, operationRequestKey);
      if (!operationKey || !operationRequestKey) throw new Error("broker operation identity is incomplete");
      const identityKey = this.operationIdentityKey(operationKey, operationRequestKey);
      return {
        terminalized: binding.channel.terminalizedOperationRequests.has(identityKey),
        active: binding.channel.activeOperations.get(operationKey) === operationRequestKey,
      };
    }
    if (this.orphanedCommandQuarantine) {
      throw new Error("an unresolved command quarantine from an earlier broker process is active");
    }
    if (request.method === "continuation" || request.method === "advance_continuation") {
      const operationKey = request.operationKey;
      const operationRequestKey = request.operationRequestKey;
      this.validateOperationIdentity(operationKey, operationRequestKey);
      if (!operationKey || !operationRequestKey) throw new Error("broker operation identity is incomplete");
      const identityKey = this.operationIdentityKey(operationKey, operationRequestKey);
      const owner = binding.channel.activeOperations.get(operationKey);
      const protectedOperation = this.protectedOperation;
      if (owner !== operationRequestKey
        || !protectedOperation
        || protectedOperation.channel !== binding.channel
        || protectedOperation.operationKey !== operationKey
        || protectedOperation.operationRequestKey !== operationRequestKey) {
        throw new Error("broker protected operation identity does not match the active command");
      }
      let continuation = binding.channel.operationContinuations.get(identityKey);
      if (request.method === "continuation") {
        if (!continuation) {
          continuation = { currentToken: opaqueId("continuation"), uses: new Map() };
          binding.channel.operationContinuations.set(identityKey, continuation);
        }
        return { continuationToken: continuation.currentToken };
      }
      const continuationToken = request.continuationToken;
      const invocationKey = request.invocationKey;
      if (!continuation
        || !continuationToken
        || !/^[A-Za-z0-9_-]{20,256}$/.test(continuationToken)
        || !invocationKey
        || !/^[A-Za-z0-9_-]{1,256}$/.test(invocationKey)) {
        throw new Error("broker continuation identity is incomplete");
      }
      const use = continuation.uses.get(continuationToken);
      if (!use || use.invocationKey !== invocationKey) {
        throw new Error("broker continuation token does not identify the completed invocation");
      }
      if (use.nextToken) return { continuationToken: use.nextToken };
      if (continuation.currentToken !== continuationToken) {
        throw new Error("broker continuation token is no longer current");
      }
      const invocationStillPending = [...binding.channel.invocations.values()]
        .some(invocation => invocation.invocationKey === invocationKey);
      if (invocationStillPending) throw new Error("broker continuation invocation is still pending");
      const nextToken = opaqueId("continuation");
      use.nextToken = nextToken;
      continuation.currentToken = nextToken;
      return { continuationToken: nextToken };
    }
    if (request.method === "terminalize") {
      const operationKey = request.operationKey;
      const operationRequestKey = request.operationRequestKey;
      this.validateOperationIdentity(operationKey, operationRequestKey);
      if (!operationKey || !operationRequestKey) throw new Error("broker operation identity is incomplete");
      const identityKey = this.operationIdentityKey(operationKey, operationRequestKey);
      if (binding.channel.terminalizedOperationRequests.has(identityKey)) {
        return { terminalized: true, pending: false };
      }
      const protectedOperation = this.protectedOperation;
      if (!protectedOperation
        || protectedOperation.channel !== binding.channel
        || protectedOperation.operationKey !== operationKey
        || protectedOperation.operationRequestKey !== operationRequestKey) {
        throw new Error("broker protected operation identity does not match the active command");
      }
      const owner = binding.channel.activeOperations.get(operationKey);
      if (owner !== operationRequestKey) {
        throw new Error(owner === undefined
          ? "broker operation is not active"
          : "broker operation is already active under a different request identity");
      }
      const invocationStillPending = [...binding.channel.invocations.values()].some(invocation => (
        invocation.operationKey === operationKey && invocation.operationRequestKey === operationRequestKey
      ));
      if (invocationStillPending) return { terminalized: false, pending: true };
      const fingerprints = binding.channel.terminalizedOperationFingerprints.get(operationKey) ?? new Set<string>();
      for (const invocation of binding.channel.invocationsByKey.values()) {
        if (invocation.operationKey === operationKey && invocation.operationRequestKey === operationRequestKey) {
          fingerprints.add(invocation.fingerprint);
        }
      }
      binding.channel.terminalizedOperationFingerprints.set(operationKey, fingerprints);
      binding.channel.activeOperations.delete(operationKey);
      binding.channel.operationContinuations.delete(identityKey);
      binding.channel.terminalizedOperationRequests.add(identityKey);
      this.releaseCommandQuarantine();
      if (binding.channel.retiring) this.retireChannel(binding.token, binding.channel);
      return { terminalized: true, pending: false };
    }
    const wireName = request.wireName;
    if (typeof wireName !== "string" || wireName.length === 0) {
      throw new Error("wire tool name is required");
    }
    if (wireName.trim() !== wireName || /[\x00-\x1f\x7f]/.test(wireName)) {
      throw new Error("wire tool name must be canonical");
    }
    const invocationKey = request.invocationKey ?? request.id;
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(invocationKey)) throw new Error("broker invocation key is invalid");
    const fingerprint = createHash("sha256").update(JSON.stringify({
      wireName,
      freeform: request.freeform === true,
      ...(request.freeform === true ? { input: request.input ?? "" } : { arguments: request.arguments ?? {} }),
    })).digest("hex");
    const operationKey = request.operationKey;
    const operationRequestKey = request.operationRequestKey;
    this.validateOperationIdentity(operationKey, operationRequestKey, true);
    const continuationToken = request.continuationToken;
    if (continuationToken !== undefined) {
      if (!operationKey || !operationRequestKey || !/^[A-Za-z0-9_-]{20,256}$/.test(continuationToken)) {
        throw new Error("broker continuation identity is invalid");
      }
    }
    const protectedOperation = this.protectedOperation;
    const matchesProtectedOperation = Boolean(
      protectedOperation
      && operationKey
      && operationRequestKey
      && protectedOperation.channel === binding.channel
      && protectedOperation.operationKey === operationKey
      && protectedOperation.operationRequestKey === operationRequestKey
    );
    if (protectedOperation && !matchesProtectedOperation) {
      if (protectedOperation.channel === binding.channel
        && protectedOperation.operationKey === operationKey) {
        throw new Error("broker operation is already active under a different request identity");
      }
      throw new Error("a protected broker operation is already active");
    }
    if (binding.channel.retiring && !matchesProtectedOperation) {
      throw new Error("Codex turn binding is retiring with an unresolved protected operation");
    }
    const replay = binding.channel.invocationsByKey.get(invocationKey);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new Error("broker invocation key was reused with a different request");
      if (replay.continuationToken !== continuationToken) {
        throw new Error("broker invocation continuation identity changed during replay");
      }
      if (request.operationKey !== replay.operationKey || request.operationRequestKey !== replay.operationRequestKey) {
        throw new Error("broker invocation operation identity changed during replay");
      }
      if (replay.operationKey && replay.operationRequestKey
        && !binding.channel.terminalizedOperationRequests.has(
          this.operationIdentityKey(replay.operationKey, replay.operationRequestKey),
        )) {
        const owner = binding.channel.activeOperations.get(replay.operationKey);
        if (owner !== undefined && owner !== replay.operationRequestKey) {
          throw new Error("broker operation is already active under a different request identity");
        }
        binding.channel.activeOperations.set(replay.operationKey, replay.operationRequestKey);
      }
      return replay.promise;
    }
    if (binding.channel.replayCacheExhausted
      || binding.channel.invocationsByKey.size >= MAX_REPLAY_CACHE_ENTRIES) {
      throw new Error("broker replay cache is exhausted; new native dispatch is forbidden");
    }
    if (operationKey && binding.channel.terminalizedOperationFingerprints.get(operationKey)?.has(fingerprint)) {
      throw new Error("broker operation invocation has already been terminalized");
    }
    if (operationKey === undefined && binding.channel.activeOperations.size > 0) {
      throw new Error("a protected broker operation is already active");
    }
    let continuation: OperationContinuation | undefined;
    let continuationUseClaimed = false;
    if (continuationToken && operationKey && operationRequestKey) {
      continuation = binding.channel.operationContinuations.get(
        this.operationIdentityKey(operationKey, operationRequestKey),
      );
      if (!continuation || continuation.currentToken !== continuationToken) {
        throw new Error("broker continuation token is invalid or no longer current");
      }
      const priorUse = continuation.uses.get(continuationToken);
      if (priorUse && priorUse.invocationKey !== invocationKey) {
        throw new Error("broker continuation token was already used by another invocation");
      }
      if (priorUse) {
        throw new Error("broker continuation invocation is unresolved and cannot be redispatched");
      }
    }
    let claimedOperation = false;
    let claimedProtectedOperation = false;
    if (operationKey && operationRequestKey) {
      if (binding.channel.terminalizedOperationRequests.has(
        this.operationIdentityKey(operationKey, operationRequestKey),
      )) {
        throw new Error("broker operation request has already been terminalized");
      }
      const owner = binding.channel.activeOperations.get(operationKey);
      if (owner !== undefined && owner !== operationRequestKey) {
        throw new Error("broker operation is already active under a different request identity");
      }
      if (owner === undefined) {
        binding.channel.activeOperations.set(operationKey, operationRequestKey);
        claimedOperation = true;
      }
      if (!this.protectedOperation) {
        this.acquireCommandQuarantine();
        this.protectedOperation = {
          token: binding.token,
          channel: binding.channel,
          operationKey,
          operationRequestKey,
          delivered: false,
        };
        claimedProtectedOperation = true;
      }
    }
    const equivalentInFlight = [...binding.channel.invocations.values()]
      .some(invocation => invocation.fingerprint === fingerprint);
    if (equivalentInFlight) {
      if (claimedOperation && operationKey) binding.channel.activeOperations.delete(operationKey);
      if (claimedProtectedOperation) this.releaseCommandQuarantine();
      throw new Error("an equivalent broker invocation is already executing under a different request identity");
    }
    if (continuation && continuationToken) {
      continuation.uses.set(continuationToken, { invocationKey });
      continuationUseClaimed = true;
    }
    const callId = opaqueId("call");
    const toolRequest: BrokerToolRequest = {
      callId,
      wireName,
      freeform: request.freeform === true,
      ...(request.freeform === true ? { input: request.input ?? "" } : { arguments: request.arguments ?? {} }),
    };
    if (signal?.aborted) {
      if (continuationUseClaimed && continuationToken) continuation?.uses.delete(continuationToken);
      if (claimedOperation && operationKey) binding.channel.activeOperations.delete(operationKey);
      if (claimedProtectedOperation) this.releaseCommandQuarantine();
      throw new DOMException("broker invocation aborted", "AbortError");
    }
    let resolveInvoke!: (result: BrokerToolResult) => void;
    let rejectInvoke!: (error: Error) => void;
    const promise = new Promise<BrokerToolResult>((resolve, reject) => {
      resolveInvoke = resolve;
      rejectInvoke = reject;
    });
    const invocation: PendingInvocation = {
      request: toolRequest,
      invocationKey,
      fingerprint,
      promise,
      resolve: value => finish(() => resolveInvoke(value)),
      reject: error => finish(() => rejectInvoke(error)),
      ...(operationKey && operationRequestKey ? { operationKey, operationRequestKey } : {}),
      ...(continuationToken ? { continuationToken } : {}),
    };
    const finish = (callback: () => void) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      if (binding.channel.queuedCallIds.includes(callId)) {
        binding.channel.invocations.delete(callId);
        binding.channel.invocationsByKey.delete(invocationKey);
        binding.channel.queuedCallIds = binding.channel.queuedCallIds.filter(id => id !== callId);
        if (continuationUseClaimed && continuationToken) continuation?.uses.delete(continuationToken);
        if (claimedOperation && operationKey
          && binding.channel.activeOperations.get(operationKey) === operationRequestKey) {
          binding.channel.activeOperations.delete(operationKey);
        }
        if (claimedProtectedOperation && this.protectedOperation?.delivered === false) {
          this.releaseCommandQuarantine();
        }
        finish(() => rejectInvoke(new DOMException("broker invocation aborted", "AbortError")));
        return;
      }
      // Delivery transfers execution ownership to the adapter. Keep the invocation until the
      // adapter reports its terminal result so a disconnected caller cannot orphan an already
      // executing command and make a later retry appear safe.
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    binding.channel.invocations.set(callId, invocation);
    binding.channel.invocationsByKey.set(invocationKey, invocation);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    binding.channel.queuedCallIds.push(callId);
    console.info(
      `[chatgpt-web] broker trace=${binding.channel.traceId} queued callHash=${opaqueLogId(callId)} tool=${wireName} waiters=${binding.channel.waiters.size}`,
    );
    this.scheduleToolWaiters(binding.channel);
    return promise;
  }

  private takeQueued(channel: TurnChannel): BrokerToolRequest[] {
    const ids = channel.queuedCallIds.splice(0);
    if (this.protectedOperation?.channel === channel) {
      const deliveredProtectedCall = ids.some(id => {
        const invocation = channel.invocations.get(id);
        return invocation?.operationKey === this.protectedOperation?.operationKey
          && invocation?.operationRequestKey === this.protectedOperation?.operationRequestKey;
      });
      if (deliveredProtectedCall) this.protectedOperation.delivered = true;
    }
    return ids.map(id => channel.invocations.get(id)?.request).filter((request): request is BrokerToolRequest => Boolean(request));
  }

  private scheduleToolWaiters(channel: TurnChannel): void {
    if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
    if (channel.batchTimer) return;
    channel.batchTimer = setTimeout(() => {
      channel.batchTimer = undefined;
      this.wakeToolWaiters(channel);
    }, 15);
  }

  private wakeToolWaiters(channel: TurnChannel): void {
    if (channel.queuedCallIds.length === 0 || channel.waiters.size === 0) return;
    const batch = this.takeQueued(channel);
    console.info(
      `[chatgpt-web] broker trace=${channel.traceId} delivered calls=${batch.length} tools=${batch.map(request => request.wireName).join(",")}`,
    );
    const waiters = [...channel.waiters];
    channel.waiters.clear();
    const first = waiters.shift();
    if (first) {
      if (first.signal && first.onAbort) first.signal.removeEventListener("abort", first.onAbort);
      first.resolve(batch);
    }
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("another adapter waiter already claimed the queued tool batch"));
    }
  }

  private rejectChannel(channel: TurnChannel, error: Error): void {
    if (channel.batchTimer) clearTimeout(channel.batchTimer);
    channel.batchTimer = undefined;
    for (const waiter of channel.waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    channel.waiters.clear();
    for (const invocation of channel.invocations.values()) invocation.reject(error);
    channel.invocations.clear();
    channel.invocationsByKey.clear();
    channel.replayCacheChars = 0;
    channel.replayCacheExhausted = false;
    channel.activeOperations.clear();
    channel.operationContinuations.clear();
    channel.terminalizedOperationRequests.clear();
    channel.terminalizedOperationFingerprints.clear();
    channel.queuedCallIds = [];
  }

  private operationIdentityKey(operationKey: string, operationRequestKey: string): string {
    return `${operationKey}\0${operationRequestKey}`;
  }

  private validateOperationIdentity(
    operationKey: string | undefined,
    operationRequestKey: string | undefined,
    optional = false,
  ): asserts operationKey is string {
    if (optional && operationKey === undefined && operationRequestKey === undefined) return;
    if (operationKey === undefined || operationRequestKey === undefined) {
      throw new Error("broker operation identity is incomplete");
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(operationKey)) {
      throw new Error("broker operation key is invalid");
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(operationRequestKey)) {
      throw new Error("broker operation request key is invalid");
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, channel] of this.channels) {
      if (channel.environment.expiresAt === undefined || channel.environment.expiresAt > now) continue;
      this.revoke(token);
    }
  }
}

/**
 * A turn registered without a TTL has no deadline to bound its tool calls against, so a null
 * timeout waits for as long as the turn itself lives. Undefined keeps the bounded default, because
 * a caller that cannot compute a deadline must not silently inherit an unbounded wait. An
 * unbounded call still ends when the turn is revoked or the broker drops the connection.
 */
export async function callTurnBroker<T>(
  socketPath: string,
  request: Omit<BrokerRequest, "id">,
  timeoutMs: number | null = 5_000,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new DOMException("broker call aborted", "AbortError");
  const id = opaqueId("request");
  return new Promise<T>((resolveCall, rejectCall) => {
    const socket = createConnection(socketPath);
    let buffered = "";
    let settled = false;
    const onAbort = () => finishError(new DOMException("ChatGPT web turn broker call aborted", "AbortError"));
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      socket.destroy();
      rejectCall(error);
    };
    const timer = timeoutMs === null
      ? undefined
      : setTimeout(() => finishError(new Error("ChatGPT web turn broker timed out")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      finishError(new DOMException("ChatGPT web turn broker call aborted", "AbortError"));
      return;
    }
    socket.setEncoding("utf8");
    socket.once("error", error => finishError(new Error(`ChatGPT web turn broker unavailable: ${error.message}`)));
    socket.once("close", () => finishError(new Error("ChatGPT web turn broker closed the connection")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, ...request })}\n`));
    socket.on("data", chunk => {
      if (settled) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS) {
        finishError(new Error("ChatGPT web turn broker response exceeds size limit"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      let response: BrokerResponse;
      try {
        response = JSON.parse(buffered.slice(0, newline)) as BrokerResponse;
      } catch (error) {
        finishError(new Error(`ChatGPT web turn broker returned invalid JSON: ${errorOf(error).message}`));
        return;
      }
      if (response.id !== id) {
        finishError(new Error("ChatGPT web turn broker response id mismatch"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      socket.end();
      if (response.error) rejectCall(new Error(response.error));
      else resolveCall(response.result as T);
    });
  });
}

/**
 * Outer-harness client for a broker already owned by the live launcher runtime. It lets a
 * working-tree DEV driver exercise the production adapter and MCP connector without binding a
 * Responses port or replacing the active Codex route.
 */
export class RemoteTurnBroker implements TurnBrokerOwner {
  constructor(readonly socketPath: string) {}

  async assertCompatible(): Promise<void> {
    let status: { protocolVersion?: unknown; acceptingExternalOwners?: unknown };
    try {
      status = await callTurnBroker(this.socketPath, { method: "owner_status" });
    } catch (error) {
      throw new Error(
        "The running launcher runtime does not expose the DEV turn-owner protocol; update and restart Codex Web GPT once before using the working-tree DEV chat"
        + ` (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (status.protocolVersion !== 1) {
      throw new Error(`Unsupported DEV turn-owner protocol version: ${String(status.protocolVersion)}`);
    }
    if (status.acceptingExternalOwners !== true) {
      throw new Error("The running launcher runtime is draining and is not accepting DEV chat turns");
    }
  }

  async register(environment: ChatGptTurnEnvironment, ttlMs?: number, traceId = "unknown"): Promise<string> {
    const response = await callTurnBroker<{ token?: unknown }>(this.socketPath, {
      method: "owner_register",
      environment,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(traceId !== "unknown" ? { traceId } : {}),
    });
    if (typeof response.token !== "string" || !response.token.startsWith("turn_")) {
      throw new Error("DEV turn owner received an invalid broker token");
    }
    return response.token;
  }

  async updateEnvironment(token: string, environment: ChatGptTurnEnvironment): Promise<void> {
    await callTurnBroker(this.socketPath, { method: "owner_update", token, environment });
  }

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    const response = await callTurnBroker<{ requests?: unknown }>(
      this.socketPath,
      { method: "owner_next", token },
      null,
      signal,
    );
    if (!Array.isArray(response.requests) || response.requests.some(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return true;
      const request = value as Partial<BrokerToolRequest>;
      return typeof request.callId !== "string" || typeof request.wireName !== "string"
        || typeof request.freeform !== "boolean"
        || (request.freeform
          ? typeof request.input !== "string"
          : !request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments));
    })) throw new Error("DEV turn owner received an invalid tool batch");
    return response.requests as BrokerToolRequest[];
  }

  async completeTool(token: string, callId: string, result: BrokerToolResult): Promise<void> {
    await callTurnBroker(this.socketPath, {
      method: "owner_complete",
      token,
      callId,
      toolResult: result,
    }, null);
  }

  async revoke(token: string, _reason?: Error): Promise<void> {
    await callTurnBroker(this.socketPath, { method: "owner_revoke", token });
  }
}
