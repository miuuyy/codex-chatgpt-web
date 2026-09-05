import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isWindowsPipeEndpoint } from "../../config";
import {
  CompactionTransactionStore,
  type CompactionTransactionHandle,
} from "./compaction-transaction";
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
  resolve: (result: BrokerToolResult) => void;
  reject: (error: Error) => void;
}

interface ToolWaiter {
  resolve: (requests: BrokerToolRequest[]) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export type SafeTurnState = "awaiting_start" | "running" | "completed" | "revoked";

interface SafeWaiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface SafeTurnControl {
  state: SafeTurnState;
  surfaceNonce: string;
  launcherSent: boolean;
  connectorStarted: boolean;
  finalAnswer?: string;
  sentWaiters: Set<SafeWaiter<void>>;
  startWaiters: Set<SafeWaiter<void>>;
  completionWaiters: Set<SafeWaiter<string>>;
}

interface TurnChannel {
  traceId: string;
  externalOwner: boolean;
  environment: PendingTurn;
  bindingId?: string;
  queuedCallIds: string[];
  deliveredCallIds: Set<string>;
  invocations: Map<string, PendingInvocation>;
  waiters: Set<ToolWaiter>;
  compactionRequested: boolean;
  compactionResult?: BrokerToolResult;
  compactionDeliveryCount: number;
  safe?: SafeTurnControl;
  /** Every MCP request owns a lease from token claim until its handler has settled. */
  activities: Set<string>;
  /** Prevents a lost/retried or delayed claim from resurrecting activity after cleanup. */
  completedActivities: Set<string>;
  /** Monotonic across activity start/end so a completed request cannot disappear across a fence. */
  activityRevision: number;
  completionCommitted: boolean;
  completionRevision?: number;
  retirementWaiters: Set<SafeWaiter<void>>;
  batchTimer?: ReturnType<typeof setTimeout>;
}

interface BrokerRequest {
  id: string;
  method:
    | "claim"
    | "resolve"
    | "release"
    | "invoke"
    | "owner_status"
    | "owner_register"
    | "owner_register_safe"
    | "owner_update"
    | "owner_safe_sent"
    | "owner_next"
    | "owner_complete"
    | "owner_completion_fence_begin"
    | "owner_completion_fence_commit"
    | "owner_wait_retirement"
    | "owner_revoke"
    | "owner_safe_wait_start"
    | "owner_safe_wait_completion"
    | "owner_request_compaction"
    | "owner_compaction_delivery_count"
    | "safe_start"
    | "safe_complete"
    | "activity_complete"
    | "submit_compaction_handoff";
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
  activityId?: string;
  revision?: number;
  toolResult?: BrokerToolResult;
  handoffId?: string;
  summary?: string;
  surfaceNonce?: string;
  finalAnswer?: string;
  contract?: "native" | "safe";
}

interface BrokerResponse {
  id: string;
  result?: unknown;
  error?: string;
}

const brokers = new Map<string, TurnBroker>();
const MAX_BROKER_LINE_CHARS = 67_108_864;
const MAX_RETIRED_TURN_HANDLES = 64;

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

function assertSurfaceNonce(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{20,256}$/.test(value)) {
    throw new Error("Zero Risk local browser binding is invalid");
  }
}

export interface TurnBrokerOwner {
  register(environment: ChatGptTurnEnvironment, ttlMs?: number, traceId?: string): Promise<string>;
  registerSafe(
    environment: ChatGptTurnEnvironment,
    surfaceNonce: string,
    ttlMs?: number,
    traceId?: string,
  ): Promise<string>;
  updateEnvironment(token: string, environment: ChatGptTurnEnvironment): void | Promise<void>;
  confirmSafeTurnSent(
    token: string,
    surfaceNonce: string,
  ): { confirmed: true; duplicate: boolean } | Promise<{ confirmed: true; duplicate: boolean }>;
  nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]>;
  completeTool(token: string, callId: string, result: BrokerToolResult): void | Promise<void>;
  waitForSafeStart(token: string, signal?: AbortSignal): Promise<void>;
  waitForSafeCompletion(token: string, signal?: AbortSignal): Promise<string>;
  requestCompaction(token: string, queuedResult: BrokerToolResult): number | Promise<number>;
  compactionDeliveryCount(token: string): number | Promise<number>;
  beginCompletionFence(token: string): number | undefined | Promise<number | undefined>;
  commitCompletionFence(token: string, revision: number): boolean | Promise<boolean>;
  waitForRetirement(token: string, signal?: AbortSignal): Promise<void>;
  revoke(token: string, reason?: Error): void | Promise<void>;
}

/**
 * Bytes available for a Unix socket path. Linux allows 108, macOS and the BSDs expose a 104-byte
 * sun_path including its terminating NUL; the smaller usable bound is used everywhere so a path
 * that works on one developer's machine is not silently unbindable on another's.
 */
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

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
  private readonly compactionTransactions = new CompactionTransactionStore();
  private readonly bindings = new Map<string, { token: string; channel: TurnChannel }>();
  // The Codex context replayed into ChatGPT still carries the handles of finished turns, so a model
  // can present one. Remembering which turn retired a handle is what separates "you are holding a
  // previous turn's handle" from "this handle never existed".
  private readonly retiredBindings = new Map<string, string>();
  private readonly retiredTokens = new Map<string, string>();
  private acceptingExternalOwners = true;
  private server?: Server;
  private startPromise?: Promise<void>;

  private constructor(readonly socketPath: string) {}

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
    handlePrefix = "turn",
  ): Promise<string> {
    await this.start();
    this.prune();
    if (externalOwner && !this.acceptingExternalOwners) {
      throw new Error("turn broker is draining and does not accept new external owners");
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error("ChatGPT web turn broker TTL must be a positive finite number");
    }
    const token = opaqueId(handlePrefix);
    const channel: TurnChannel = {
      traceId,
      externalOwner,
      environment: {
        ...environment,
        ...(ttlMs !== undefined ? { expiresAt: Date.now() + ttlMs } : {}),
      },
      queuedCallIds: [],
      deliveredCallIds: new Set(),
      invocations: new Map(),
      waiters: new Set(),
      compactionRequested: false,
      compactionDeliveryCount: 0,
      activities: new Set(),
      completedActivities: new Set(),
      activityRevision: 0,
      completionCommitted: false,
      retirementWaiters: new Set(),
    };
    this.channels.set(token, channel);
    this.pending.set(token, channel);
    console.info(`[chatgpt-web] broker trace=${traceId} registered tokenHash=${handleFingerprint(token)}`);
    return token;
  }

  async registerSafe(
    environment: ChatGptTurnEnvironment,
    surfaceNonce: string,
    ttlMs?: number,
    traceId = "unknown",
    externalOwner = false,
  ): Promise<string> {
    assertSurfaceNonce(surfaceNonce);
    const token = await this.register(environment, ttlMs, traceId, externalOwner, "request");
    const channel = this.channels.get(token);
    if (!channel) throw new Error("Zero Risk turn registration was revoked before initialization");
    channel.safe = {
      state: "awaiting_start",
      surfaceNonce,
      launcherSent: false,
      connectorStarted: false,
      sentWaiters: new Set(),
      startWaiters: new Set(),
      completionWaiters: new Set(),
    };
    return token;
  }

  async beginCompactionTransaction(
    traceId: string,
    ttlMs = 120_000,
  ): Promise<CompactionTransactionHandle> {
    await this.start();
    return this.compactionTransactions.begin(traceId, ttlMs);
  }

  waitForCompactionHandoff(token: string, signal?: AbortSignal): Promise<string> {
    return this.compactionTransactions.wait(token, signal);
  }

  abortCompactionTransaction(token: string): void {
    this.compactionTransactions.abort(token);
  }

  revokeCompactionTransactions(traceId: string): void {
    this.compactionTransactions.abortTrace(traceId);
  }

  updateEnvironment(token: string, environment: ChatGptTurnEnvironment): void {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (environmentIdentity(channel.environment) !== environmentIdentity(environment)) {
      throw new Error("Codex turn environment changed during an active ChatGPT tool loop");
    }
    if (channel.safe?.state === "revoked") throw new Error("Zero Risk turn is already terminal");
    // A no-tool Zero Risk answer can complete before its outer Responses observer reaches this owner
    // readback. The environment is already proven identical, so completion makes this a no-op.
    if (channel.safe?.state === "completed") return;
    channel.environment = {
      ...environment,
      ...(channel.environment.expiresAt !== undefined
        ? { expiresAt: channel.environment.expiresAt }
        : {}),
    };
  }

  async nextToolBatch(token: string, signal?: AbortSignal): Promise<BrokerToolRequest[]> {
    this.prune();
    let channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (channel.safe?.state === "awaiting_start") {
      // The outer Codex adapter owns this wait. It crosses the start boundary only after the user
      // confirms in the Launcher that the copied prompt was sent in the visible ChatGPT tab.
      await this.waitForSafeStart(token, signal);
      this.prune();
      channel = this.channels.get(token);
      if (!channel) throw new Error("turn token is invalid or expired");
    }
    // This owner-only empty batch tells the adapter to consume the already accepted completion.
    // Public Zero Risk MCP calls remain fail-closed after the turn reaches its terminal state.
    if (channel.safe?.state === "completed") return [];
    this.assertSafeHarnessRunning(channel);
    if (channel.compactionRequested) {
      throw new Error("Codex context compaction superseded ordinary MCP tool delivery");
    }
    // Delivery is at-least-once until Codex returns the corresponding tool result. If the HTTP
    // observer disconnects after the broker handed off a batch but before the adapter journaled
    // it, the exact reconnect receives the same call ids instead of losing the model's invocation.
    const delivered = [...channel.deliveredCallIds]
      .map(id => channel.invocations.get(id)?.request)
      .filter((request): request is BrokerToolRequest => Boolean(request));
    if (delivered.length > 0) return delivered;
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
    this.assertSafeHarnessRunning(channel, true);
    const invocation = channel.invocations.get(callId);
    if (!invocation) throw new Error(`tool call is not pending: ${callId}`);
    if (!channel.deliveredCallIds.delete(callId)) {
      throw new Error(`tool call was completed before it was delivered: ${callId}`);
    }
    channel.invocations.delete(callId);
    console.info(`[chatgpt-web] broker trace=${channel.traceId} completed call=${callId.slice(0, 17)} pending=${channel.invocations.size}`);
    invocation.resolve(result);
  }

  beginCompletionFence(token: string): number | undefined {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (channel.completionCommitted) return channel.completionRevision;
    if (channel.activities.size > 0 || channel.invocations.size > 0) return undefined;
    return channel.activityRevision;
  }

  commitCompletionFence(token: string, revision: number): boolean {
    this.prune();
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("turn completion fence revision is invalid");
    }
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    if (channel.completionCommitted) return channel.completionRevision === revision;
    if (channel.activityRevision !== revision
      || channel.activities.size > 0
      || channel.invocations.size > 0) return false;
    channel.completionCommitted = true;
    channel.completionRevision = revision;
    console.info(
      `[chatgpt-web] broker trace=${channel.traceId} committed browser completion revision=${revision}`,
    );
    return true;
  }

  waitForRetirement(token: string, signal?: AbortSignal): Promise<void> {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) return Promise.resolve();
    return this.waitForSafeState(channel.retirementWaiters, signal, "turn retirement wait aborted");
  }

  requestCompaction(token: string, queuedResult: BrokerToolResult): number {
    this.prune();
    const channel = this.channels.get(token);
    if (!channel) throw new Error("turn token is invalid or expired");
    this.assertSafeHarnessRunning(channel);
    if (channel.compactionRequested) {
      throw new Error("Codex context compaction was already requested for this turn");
    }
    channel.compactionRequested = true;
    channel.compactionResult = structuredClone(queuedResult);
    if (channel.batchTimer) {
      clearTimeout(channel.batchTimer);
      channel.batchTimer = undefined;
    }
    const queued = channel.queuedCallIds.splice(0);
    for (const callId of queued) {
      const invocation = channel.invocations.get(callId);
      if (!invocation) continue;
      channel.invocations.delete(callId);
      channel.compactionDeliveryCount += 1;
      invocation.resolve(structuredClone(queuedResult));
    }
    if (queued.length > 0) {
      console.info(
        `[chatgpt-web] broker trace=${channel.traceId} interrupted queued calls=${queued.length} for context compaction`,
      );
    }
    return queued.length;
  }

  compactionDeliveryCount(token: string): number {
    const channel = this.channels.get(token);
    if (!channel) throw new Error("Cannot read compaction delivery after the turn capability retired");
    return channel.compactionDeliveryCount;
  }

  startSafeTurn(requestId: string): { started: true; duplicate: boolean } {
    this.prune();
    const channel = this.channels.get(requestId);
    if (!channel) throw new Error("Zero Risk request_id is invalid, expired, or revoked");
    const safe = channel.safe;
    if (!safe) throw new Error("request_id is not registered for Zero Risk browser interaction");
    if (safe.state === "completed" || safe.state === "revoked") {
      throw new Error("Zero Risk turn is already terminal");
    }
    if (safe.connectorStarted) return { started: true, duplicate: true };
    safe.connectorStarted = true;
    this.activateSafeTurn(channel, safe);
    return { started: true, duplicate: false };
  }

  confirmSafeTurnSent(requestId: string, surfaceNonce: string): { confirmed: true; duplicate: boolean } {
    this.prune();
    assertSurfaceNonce(surfaceNonce);
    const channel = this.channels.get(requestId);
    if (!channel) throw new Error("Zero Risk request_id is invalid, expired, or revoked");
    const safe = channel.safe;
    if (!safe) throw new Error("request_id is not registered for Zero Risk browser interaction");
    this.assertSafeNonce(safe, surfaceNonce);
    if (safe.state === "completed" || safe.state === "revoked") {
      throw new Error("Zero Risk turn is already terminal");
    }
    if (safe.launcherSent) return { confirmed: true, duplicate: true };
    safe.launcherSent = true;
    this.resolveSafeWaiters(safe.sentWaiters, undefined);
    this.activateSafeTurn(channel, safe);
    return { confirmed: true, duplicate: false };
  }

  completeSafeTurn(
    requestId: string,
    finalAnswer: string,
  ): { completed: true; duplicate: boolean } {
    this.prune();
    if (typeof finalAnswer !== "string" || finalAnswer.trim().length === 0) {
      throw new Error("Zero Risk turn final_answer must not be empty");
    }
    const channel = this.channels.get(requestId);
    if (!channel) throw new Error("Zero Risk request_id is invalid, expired, or revoked");
    const safe = channel.safe;
    if (!safe) throw new Error("request_id is not registered for Zero Risk browser interaction");
    if (safe.state === "completed") {
      if (safe.finalAnswer !== finalAnswer) {
        throw new Error("Zero Risk turn completion conflicts with the accepted final_answer");
      }
      return { completed: true, duplicate: true };
    }
    if (safe.state === "revoked") throw new Error("Zero Risk turn is already terminal");
    if (safe.state !== "running") throw new Error("Zero Risk turn has not started");
    if (channel.invocations.size > 0) {
      throw new Error(`Zero Risk turn cannot complete with ${channel.invocations.size} pending Codex tool invocation(s)`);
    }
    if (channel.activities.size > 0) {
      throw new Error(`Zero Risk turn cannot complete with ${channel.activities.size} active Codex MCP request(s)`);
    }
    safe.state = "completed";
    safe.finalAnswer = finalAnswer;
    this.resolveSafeWaiters(safe.completionWaiters, finalAnswer);
    return { completed: true, duplicate: false };
  }

  waitForSafeStart(requestId: string, signal?: AbortSignal): Promise<void> {
    this.prune();
    const channel = this.channels.get(requestId);
    if (!channel) return Promise.reject(new Error("Zero Risk request_id is invalid, expired, or revoked"));
    const safe = channel.safe;
    if (!safe) return Promise.reject(new Error("request_id is not registered for Zero Risk browser interaction"));
    if (safe.state === "running" || safe.state === "completed") return Promise.resolve();
    if (safe.state === "revoked") return Promise.reject(new Error("Zero Risk turn was revoked"));
    return this.waitForSafeState(safe.startWaiters, signal, "Zero Risk turn start wait aborted");
  }

  private waitForSafeSent(requestId: string, signal?: AbortSignal): Promise<void> {
    this.prune();
    const channel = this.channels.get(requestId);
    if (!channel) return Promise.reject(new Error("Zero Risk request_id is invalid, expired, or revoked"));
    const safe = channel.safe;
    if (!safe) return Promise.reject(new Error("request_id is not registered for Zero Risk browser interaction"));
    if (safe.launcherSent) return Promise.resolve();
    if (safe.state === "revoked") return Promise.reject(new Error("Zero Risk turn was revoked"));
    return this.waitForSafeState(safe.sentWaiters, signal, "Zero Risk turn Sent wait aborted");
  }

  waitForSafeCompletion(requestId: string, signal?: AbortSignal): Promise<string> {
    this.prune();
    const channel = this.channels.get(requestId);
    if (!channel) return Promise.reject(new Error("Zero Risk request_id is invalid, expired, or revoked"));
    const safe = channel.safe;
    if (!safe) return Promise.reject(new Error("request_id is not registered for Zero Risk browser interaction"));
    if (safe.state === "completed" && safe.finalAnswer !== undefined) return Promise.resolve(safe.finalAnswer);
    if (safe.state === "revoked") return Promise.reject(new Error("Zero Risk turn was revoked"));
    return this.waitForSafeState(safe.completionWaiters, signal, "Zero Risk turn completion wait aborted");
  }

  revoke(token: string, reason = new Error("Codex turn binding was revoked")): void {
    const channel = this.channels.get(token);
    if (!channel) return;
    this.channels.delete(token);
    this.pending.delete(token);
    if (channel.bindingId) {
      this.bindings.delete(channel.bindingId);
      this.retire(this.retiredBindings, channel.bindingId, channel.traceId);
    }
    if (channel.safe) {
      channel.safe.state = "revoked";
      this.rejectSafeWaiters(channel.safe.sentWaiters, reason);
      this.rejectSafeWaiters(channel.safe.startWaiters, reason);
      this.rejectSafeWaiters(channel.safe.completionWaiters, reason);
    }
    this.retire(this.retiredTokens, token, channel.traceId);
    this.resolveSafeWaiters(channel.retirementWaiters, undefined);
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

  private assertSafeNonce(safe: SafeTurnControl, surfaceNonce: string): void {
    if (safe.surfaceNonce !== surfaceNonce) throw new Error("Zero Risk local browser binding does not match this turn");
  }

  private activateSafeTurn(channel: TurnChannel, safe: SafeTurnControl): void {
    if (safe.state !== "awaiting_start" || !safe.launcherSent || !safe.connectorStarted) return;
    safe.state = "running";
    // The setup window may be bounded, but a turn authorized by the user and bound by the
    // Zero Risk connector remains live until completion, cancellation, or runtime shutdown.
    delete channel.environment.expiresAt;
    this.resolveSafeWaiters(safe.startWaiters, undefined);
  }

  private assertSafeHarnessRunning(channel: TurnChannel, allowCompaction = false): void {
    const safe = channel.safe;
    if (!safe) return;
    if (safe.state === "awaiting_start") {
      if (!safe.launcherSent) throw new Error("Zero Risk turn is waiting for the user's Sent confirmation");
      throw new Error("Zero Risk request is not connected yet. Call codex_turn_start with its request_id first");
    }
    if (safe.state !== "running") throw new Error("Zero Risk turn is already terminal");
    if (channel.compactionRequested && !allowCompaction) {
      throw new Error("Zero Risk turn is awaiting completion for Codex context compaction");
    }
  }

  private waitForSafeState<T>(
    waiters: Set<SafeWaiter<T>>,
    signal: AbortSignal | undefined,
    abortMessage: string,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException(abortMessage, "AbortError"));
    return new Promise<T>((resolveWait, rejectWait) => {
      const waiter: SafeWaiter<T> = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          waiters.delete(waiter);
          rejectWait(new DOMException(abortMessage, "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      waiters.add(waiter);
    });
  }

  private resolveSafeWaiters<T>(waiters: Set<SafeWaiter<T>>, value: T): void {
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(value);
    }
    waiters.clear();
  }

  private rejectSafeWaiters<T>(waiters: Set<SafeWaiter<T>>, error: Error): void {
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    waiters.clear();
  }

  async close(): Promise<void> {
    this.compactionTransactions.close();
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
      if (!windowsPipe) {
        // sun_path is a fixed-size field in the kernel, so an over-long path fails inside listen()
        // with nothing but "Failed to listen" and no hint that the length is the problem. Say so.
        const encodedLength = Buffer.byteLength(this.socketPath);
        if (encodedLength > MAX_UNIX_SOCKET_PATH_BYTES) {
          rejectStart(new Error(
            `ChatGPT web broker socket path is ${encodedLength} bytes, over the`
            + ` ${MAX_UNIX_SOCKET_PATH_BYTES}-byte limit this platform allows for a Unix socket:`
            + ` ${this.socketPath}. Choose a shorter runtime directory.`,
          ));
          return;
        }
        mkdirSync(dirname(this.socketPath), { recursive: true, mode: 0o700 });
      }
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
    const disconnected = new AbortController();
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.once("close", () => disconnected.abort());
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
      void Promise.resolve().then(() => this.dispatch(request!, disconnected.signal)).then(
        result => this.writeSocketResponse(socket, { id: request!.id, result }),
        error => this.writeSocketResponse(socket, { id: request!.id, error: errorOf(error).message }),
      );
    });
  }

  private writeSocketResponse(socket: Socket, response: BrokerResponse): void {
    let line = `${JSON.stringify(response)}\n`;
    let requiresForcedClose = response.error !== undefined;
    if (line.length > MAX_BROKER_LINE_CHARS) {
      line = `${JSON.stringify({ id: response.id, error: "turn broker response exceeds size limit" } satisfies BrokerResponse)}\n`;
      requiresForcedClose = true;
    }
    // Bun on Windows can leave a rejected long-held named pipe half-open after end(), even though
    // the complete error response was flushed. Successful calls retain the normal close barrier;
    // rejected calls get a bounded fallback so cancellation cannot leave both processes occupied.
    const forcedClose = requiresForcedClose ? setTimeout(() => socket.destroy(), 100) : undefined;
    forcedClose?.unref();
    socket.end(line, () => {
      if (forcedClose) clearTimeout(forcedClose);
      socket.destroy();
    });
  }

  private validateRequest(request: BrokerRequest): void {
    if (!request || typeof request !== "object" || typeof request.id !== "string" || request.id.length === 0 || request.id.length > 256) {
      throw new Error("turn broker request id is invalid");
    }
    if (!["claim", "resolve", "release", "invoke", "owner_status", "owner_register", "owner_register_safe", "owner_update", "owner_safe_sent", "owner_next", "owner_complete", "owner_completion_fence_begin", "owner_completion_fence_commit", "owner_wait_retirement", "owner_revoke", "owner_safe_wait_start", "owner_safe_wait_completion", "owner_request_compaction", "owner_compaction_delivery_count", "safe_start", "safe_complete", "activity_complete", "submit_compaction_handoff"].includes(request.method)) {
      throw new Error("turn broker method is invalid");
    }
  }

  private async dispatch(request: BrokerRequest, socketSignal?: AbortSignal): Promise<unknown> {
    this.prune();
    if (request.method === "safe_start") {
      if (!request.token) throw new Error("Zero Risk request_id is required");
      return this.startSafeTurn(request.token);
    }
    if (request.method === "safe_complete") {
      if (!request.token) throw new Error("Zero Risk request_id is required");
      if (typeof request.finalAnswer !== "string") throw new Error("Zero Risk turn final_answer is required");
      let channel = this.channels.get(request.token);
      if (channel?.safe?.state === "awaiting_start" && !channel.safe.launcherSent) {
        await this.waitForSafeSent(request.token, socketSignal);
        this.prune();
        channel = this.channels.get(request.token);
      }
      return this.completeSafeTurn(request.token, request.finalAnswer);
    }
    if (request.method === "submit_compaction_handoff") {
      if (typeof request.token !== "string" || request.token.length === 0) {
        throw new Error("compaction control token is required");
      }
      if (typeof request.handoffId !== "string" || request.handoffId.length === 0) {
        throw new Error("compaction handoff id is required");
      }
      if (typeof request.summary !== "string") {
        throw new Error("compaction handoff summary is required");
      }
      this.compactionTransactions.submit(request.token, request.handoffId, request.summary);
      return { submitted: true };
    }
    if (request.method === "owner_status") {
      return { protocolVersion: 5, acceptingExternalOwners: this.acceptingExternalOwners };
    }
    if (request.method === "owner_register") {
      const environment = ownerEnvironment(request.environment);
      if (request.traceId !== undefined && !/^[A-Za-z0-9_-]{6,128}$/.test(request.traceId)) {
        throw new Error("turn owner trace id is invalid");
      }
      return this.register(environment, request.ttlMs, request.traceId, true).then(token => ({ token }));
    }
    if (request.method === "owner_register_safe") {
      const environment = ownerEnvironment(request.environment);
      assertSurfaceNonce(request.surfaceNonce);
      if (request.traceId !== undefined && !/^[A-Za-z0-9_-]{6,128}$/.test(request.traceId)) {
        throw new Error("turn owner trace id is invalid");
      }
      return this.registerSafe(
        environment,
        request.surfaceNonce,
        request.ttlMs,
        request.traceId,
        true,
      ).then(token => ({ token }));
    }
    if (request.method === "owner_update") {
      if (!request.token) throw new Error("turn owner token is required");
      this.updateEnvironment(request.token, ownerEnvironment(request.environment));
      return { updated: true };
    }
    if (request.method === "owner_safe_sent") {
      if (!request.token) throw new Error("turn owner token is required");
      assertSurfaceNonce(request.surfaceNonce);
      return this.confirmSafeTurnSent(request.token, request.surfaceNonce);
    }
    if (request.method === "owner_next") {
      if (!request.token) throw new Error("turn owner token is required");
      return this.nextToolBatch(request.token, socketSignal).then(requests => ({ requests }));
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
    if (request.method === "owner_completion_fence_begin") {
      if (!request.token) throw new Error("turn owner token is required");
      return { revision: this.beginCompletionFence(request.token) ?? null };
    }
    if (request.method === "owner_completion_fence_commit") {
      if (!request.token) throw new Error("turn owner token is required");
      if (!Number.isSafeInteger(request.revision) || request.revision! < 0) {
        throw new Error("turn completion fence revision is invalid");
      }
      return { committed: this.commitCompletionFence(request.token, request.revision!) };
    }
    if (request.method === "owner_wait_retirement") {
      if (!request.token) throw new Error("turn owner token is required");
      return this.waitForRetirement(request.token, socketSignal).then(() => ({ retired: true }));
    }
    if (request.method === "owner_revoke") {
      if (!request.token) throw new Error("turn owner token is required");
      this.revoke(request.token);
      return { revoked: true };
    }
    if (request.method === "owner_safe_wait_start") {
      if (!request.token) throw new Error("turn owner token is required");
      return this.waitForSafeStart(request.token, socketSignal).then(() => ({ started: true }));
    }
    if (request.method === "owner_safe_wait_completion") {
      if (!request.token) throw new Error("turn owner token is required");
      return this.waitForSafeCompletion(request.token, socketSignal).then(finalAnswer => ({ finalAnswer }));
    }
    if (request.method === "owner_request_compaction") {
      if (!request.token) throw new Error("turn owner token is required");
      if (!request.toolResult || !Array.isArray(request.toolResult.content)) {
        throw new Error("turn owner compaction result is invalid");
      }
      return { interrupted: this.requestCompaction(request.token, request.toolResult) };
    }
    if (request.method === "owner_compaction_delivery_count") {
      if (!request.token) throw new Error("turn owner token is required");
      return { count: this.compactionDeliveryCount(request.token) };
    }
    if (request.method === "claim") {
      const contract = request.contract ?? "native";
      const token = request.token;
      if (typeof token !== "string" || token.length === 0) {
        throw new Error(contract === "safe" ? "request id is required" : "turn token is required");
      }
      const channel = this.channels.get(token);
      let activeChannel = channel && !channel.completionCommitted ? channel : undefined;
      const retiredTurn = channel?.completionCommitted ? channel.traceId : this.retiredTokens.get(token);
      console.error(
        `[chatgpt-web] broker claim received (tokenChars=${token.length}, tokenHash=${handleFingerprint(token)}, valid=${Boolean(activeChannel)}`
        + `${activeChannel ? "" : `, retiredTurn=${retiredTurn ?? "unknown"}`})`,
      );
      if (!activeChannel) {
        throw new Error(retiredTurn !== undefined
          ? `${contract === "safe" ? "This request_id" : "This turn_token"} was issued for ${retiredTurnLabel(retiredTurn)}, which has already finished.`
          + " This Codex Native action can no longer run."
          : `${contract === "safe" ? "request id" : "turn token"} is invalid, expired, or revoked`);
      }
      if (activeChannel.safe) {
        if (contract !== "safe") throw new Error("Zero Risk request id requires the Zero Risk MCP contract");
        if (activeChannel.safe.state === "awaiting_start" && !activeChannel.safe.launcherSent) {
          // ChatGPT can issue its first Harness call in the brief interval between the user sending
          // the copied prompt and confirming Sent in the Launcher. Hold that call behind the local
          // authorization boundary, but still require codex_turn_start before it can run.
          await this.waitForSafeSent(token, socketSignal);
          this.prune();
          activeChannel = this.channels.get(token);
          if (!activeChannel || activeChannel.completionCommitted) {
            throw new Error("turn token is invalid, expired, or revoked");
          }
        }
        this.assertSafeHarnessRunning(activeChannel);
      } else if (contract === "safe") {
        throw new Error("Zero Risk MCP contract requires a Zero Risk request id");
      }
      if (typeof request.activityId !== "string" || !/^activity_[A-Za-z0-9_-]{16,128}$/.test(request.activityId)) {
        throw new Error("turn activity id is invalid");
      }
      const activityId = request.activityId;
      if (activeChannel.completedActivities.has(activityId)) {
        throw new Error("turn activity was already completed before this claim settled");
      }
      if (!activeChannel.activities.has(activityId)) {
        activeChannel.activities.add(activityId);
        activeChannel.activityRevision += 1;
      }
      if (activeChannel.bindingId) {
        const existing = this.bindings.get(activeChannel.bindingId);
        if (!existing || existing.token !== token || existing.channel !== activeChannel) {
          throw new Error("turn token binding state is inconsistent");
        }
        return { bindingId: activeChannel.bindingId, activityId, environment: activeChannel.environment };
      }
      this.pending.delete(token);
      const bindingId = opaqueId("binding");
      activeChannel.bindingId = bindingId;
      this.bindings.set(bindingId, { token, channel: activeChannel });
      return { bindingId, activityId, environment: activeChannel.environment };
    }

    const bindingId = request.bindingId;
    if (request.method === "activity_complete") {
      const token = request.token;
      if (typeof token !== "string" || token.length === 0) throw new Error("turn token is required");
      if (typeof request.activityId !== "string" || !/^activity_[A-Za-z0-9_-]{16,128}$/.test(request.activityId)) {
        throw new Error("turn activity id is invalid");
      }
      const channel = this.channels.get(token);
      if (!channel) {
        return { completed: false, retired: this.retiredTokens.has(token) };
      }
      if (channel.completedActivities.has(request.activityId)) {
        return { completed: false, duplicate: true };
      }
      const wasActive = channel.activities.delete(request.activityId);
      channel.completedActivities.add(request.activityId);
      // A cleanup that overtakes an ambiguously delivered claim is still a causal event. Its
      // tombstone makes the delayed claim fail instead of resurrecting activity after a fence.
      channel.activityRevision += 1;
      return { completed: wasActive };
    }

    if (typeof bindingId !== "string" || bindingId.length === 0) throw new Error("binding id is required");
    const binding = this.bindings.get(bindingId);
    if (!binding) {
      const retiredTurn = this.retiredBindings.get(bindingId);
      if (request.method === "release" && retiredTurn !== undefined) {
        return { released: true, duplicate: true };
      }
      console.error(
        `[chatgpt-web] broker rejected ${request.method} (binding=${bindingId.slice(0, 17)},`
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
    this.assertSafeHarnessRunning(binding.channel);
    if (binding.channel.compactionRequested) {
      const result = binding.channel.compactionResult;
      if (!result) throw new Error("Codex context compaction control result is unavailable");
      binding.channel.compactionDeliveryCount += 1;
      console.info(
        `[chatgpt-web] broker trace=${binding.channel.traceId} intercepted a post-compaction MCP call`,
      );
      return structuredClone(result);
    }

    const wireName = request.wireName?.trim();
    if (!wireName) throw new Error("wire tool name is required");
    const callId = opaqueId("call");
    const toolRequest: BrokerToolRequest = {
      callId,
      wireName,
      freeform: request.freeform === true,
      ...(request.freeform === true ? { input: request.input ?? "" } : { arguments: request.arguments ?? {} }),
    };
    return new Promise<BrokerToolResult>((resolveInvoke, rejectInvoke) => {
      binding.channel.invocations.set(callId, { request: toolRequest, resolve: resolveInvoke, reject: rejectInvoke });
      binding.channel.queuedCallIds.push(callId);
      console.info(
        `[chatgpt-web] broker trace=${binding.channel.traceId} queued call=${callId.slice(0, 17)} tool=${wireName} waiters=${binding.channel.waiters.size}`,
      );
      this.scheduleToolWaiters(binding.channel);
    });
  }

  private takeQueued(channel: TurnChannel): BrokerToolRequest[] {
    const ids = channel.queuedCallIds.splice(0);
    for (const id of ids) {
      if (channel.invocations.has(id)) channel.deliveredCallIds.add(id);
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
    channel.queuedCallIds = [];
    channel.deliveredCallIds.clear();
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
export class TurnBrokerTimeoutError extends Error {
  constructor() {
    super("ChatGPT web turn broker timed out");
    this.name = "TurnBrokerTimeoutError";
  }
}

export async function callTurnBroker<T>(
  socketPath: string,
  request: Omit<BrokerRequest, "id">,
  timeoutMs: number | null = 5_000,
  signal?: AbortSignal,
): Promise<T> {
  const id = opaqueId("request");
  const settleOnResponseFrame = timeoutMs === null;
  // The wire protocol requires a client-owned activity identity. Most callers never need to see
  // it; the MCP server supplies its own so it can retire an ambiguously delivered claim, while
  // lower-level diagnostics receive an equally client-generated identity here.
  const wireRequest = request.method === "claim" && request.activityId === undefined
    ? { ...request, activityId: opaqueId("activity") }
    : request;
  return new Promise<T>((resolveCall, rejectCall) => {
    const socket = createConnection(socketPath);
    let buffered = "";
    let settled = false;
    let response: BrokerResponse | undefined;
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
    const finishResponse = () => {
      if (settled) return;
      if (!response) {
        finishError(new Error("ChatGPT web turn broker closed the connection"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (response.error) rejectCall(new Error(response.error));
      else resolveCall(response.result as T);
    };
    const timer = timeoutMs === null
      ? undefined
      : setTimeout(() => finishError(new TurnBrokerTimeoutError()), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      finishError(new DOMException("ChatGPT web turn broker call aborted", "AbortError"));
      return;
    }
    socket.setEncoding("utf8");
    socket.once("error", error => finishError(new Error(`ChatGPT web turn broker unavailable: ${error.message}`)));
    // The server owns response termination. Waiting for the pipe/socket to close before resolving
    // prevents callers from retiring the broker while Bun still has a named-pipe write in flight.
    socket.once("close", finishResponse);
    // On Windows, Bun can deliver the complete named-pipe response and its EOF without following
    // with a physical close while our writable side remains open. Close our half after that EOF so
    // the existing close barrier can settle instead of leaving a revoked MCP invocation hanging.
    socket.once("end", () => {
      if (!settled && response) socket.destroy();
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, ...wireRequest })}\n`));
    socket.on("data", chunk => {
      if (settled || response) return;
      buffered += chunk;
      if (buffered.length > MAX_BROKER_LINE_CHARS) {
        finishError(new Error("ChatGPT web turn broker response exceeds size limit"));
        return;
      }
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      let parsed: BrokerResponse;
      try {
        parsed = JSON.parse(buffered.slice(0, newline)) as BrokerResponse;
      } catch (error) {
        finishError(new Error(`ChatGPT web turn broker returned invalid JSON: ${errorOf(error).message}`));
        return;
      }
      if (parsed.id !== id) {
        finishError(new Error("ChatGPT web turn broker response id mismatch"));
        return;
      }
      response = parsed;
      if (settleOnResponseFrame) {
        // A long-poll keeps its request half open while the server waits. Its complete response
        // frame is therefore the terminal boundary; ordinary calls still wait for physical close.
        finishResponse();
        socket.destroy();
      }
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
    if (status.protocolVersion !== 5) {
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

  async registerSafe(
    environment: ChatGptTurnEnvironment,
    surfaceNonce: string,
    ttlMs?: number,
    traceId = "unknown",
  ): Promise<string> {
    assertSurfaceNonce(surfaceNonce);
    const response = await callTurnBroker<{ token?: unknown }>(this.socketPath, {
      method: "owner_register_safe",
      environment,
      surfaceNonce,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(traceId !== "unknown" ? { traceId } : {}),
    });
    if (typeof response.token !== "string" || !response.token.startsWith("request_")) {
      throw new Error("DEV Zero Risk turn owner received an invalid broker request id");
    }
    return response.token;
  }

  async updateEnvironment(token: string, environment: ChatGptTurnEnvironment): Promise<void> {
    await callTurnBroker(this.socketPath, { method: "owner_update", token, environment });
  }

  async confirmSafeTurnSent(
    token: string,
    surfaceNonce: string,
  ): Promise<{ confirmed: true; duplicate: boolean }> {
    const response = await callTurnBroker<{ confirmed?: unknown; duplicate?: unknown }>(this.socketPath, {
      method: "owner_safe_sent",
      token,
      surfaceNonce,
    });
    if (response.confirmed !== true || typeof response.duplicate !== "boolean") {
      throw new Error("DEV Zero Risk turn owner received an invalid Sent confirmation result");
    }
    return { confirmed: true, duplicate: response.duplicate };
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

  async waitForSafeStart(token: string, signal?: AbortSignal): Promise<void> {
    const response = await callTurnBroker<{ started?: unknown }>(
      this.socketPath,
      { method: "owner_safe_wait_start", token },
      null,
      signal,
    );
    if (response.started !== true) throw new Error("DEV Zero Risk turn owner received an invalid start result");
  }

  async waitForSafeCompletion(token: string, signal?: AbortSignal): Promise<string> {
    const response = await callTurnBroker<{ finalAnswer?: unknown }>(
      this.socketPath,
      { method: "owner_safe_wait_completion", token },
      null,
      signal,
    );
    if (typeof response.finalAnswer !== "string" || response.finalAnswer.trim().length === 0) {
      throw new Error("DEV Zero Risk turn owner received an invalid completion result");
    }
    return response.finalAnswer;
  }

  async requestCompaction(token: string, queuedResult: BrokerToolResult): Promise<number> {
    const response = await callTurnBroker<{ interrupted?: unknown }>(this.socketPath, {
      method: "owner_request_compaction",
      token,
      toolResult: queuedResult,
    }, null);
    if (!Number.isSafeInteger(response.interrupted) || Number(response.interrupted) < 0) {
      throw new Error("DEV Zero Risk turn owner received an invalid compaction interrupt count");
    }
    return Number(response.interrupted);
  }

  async compactionDeliveryCount(token: string): Promise<number> {
    const response = await callTurnBroker<{ count?: unknown }>(this.socketPath, {
      method: "owner_compaction_delivery_count",
      token,
    });
    if (!Number.isSafeInteger(response.count) || Number(response.count) < 0) {
      throw new Error("DEV Zero Risk turn owner received an invalid compaction delivery count");
    }
    return Number(response.count);
  }

  async beginCompletionFence(token: string): Promise<number | undefined> {
    const response = await callTurnBroker<{ revision?: unknown }>(this.socketPath, {
      method: "owner_completion_fence_begin",
      token,
    });
    if (response.revision === null) return undefined;
    if (!Number.isSafeInteger(response.revision) || (response.revision as number) < 0) {
      throw new Error("DEV turn owner received an invalid completion fence revision");
    }
    return response.revision as number;
  }

  async commitCompletionFence(token: string, revision: number): Promise<boolean> {
    const response = await callTurnBroker<{ committed?: unknown }>(this.socketPath, {
      method: "owner_completion_fence_commit",
      token,
      revision,
    });
    if (typeof response.committed !== "boolean") {
      throw new Error("DEV turn owner received an invalid completion fence result");
    }
    return response.committed;
  }

  async waitForRetirement(token: string, signal?: AbortSignal): Promise<void> {
    const response = await callTurnBroker<{ retired?: unknown }>(
      this.socketPath,
      { method: "owner_wait_retirement", token },
      null,
      signal,
    );
    if (response.retired !== true) throw new Error("DEV turn owner received an invalid retirement result");
  }

  async revoke(token: string, _reason?: Error): Promise<void> {
    await callTurnBroker(this.socketPath, { method: "owner_revoke", token });
  }
}
