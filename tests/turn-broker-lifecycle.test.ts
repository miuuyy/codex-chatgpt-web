import { expect, test } from "bun:test";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callTurnBroker, TurnBroker, type BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, isWindowsPipeEndpoint } from "../src/config";

test("explicit browser-turn cancellation aborts and removes every registered session", async () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  const replayable = sessions.getOrCreate("turn-a", () => ({
    mode: "read-only",
    browser: Promise.resolve("done"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));
  await replayable.browserOutcome;
  sessions.getOrCreate("turn-b", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  expect(sessions.activeCount()).toBe(1);
  expect(sessions.clear()).toBe(2);
  expect(cancelled).toBe(2);
  expect(sessions.activeCount()).toBe(0);
});

test("targeted tab cancellation settles one trace and keeps a terminal replay tombstone", async () => {
  const sessions = new ChatGptTurnSessions();
  let rejectTarget!: (error: Error) => void;
  let targetCancelled = 0;
  let otherCancelled = 0;
  const target = sessions.getOrCreate("target", () => ({
    mode: "read-only",
    browser: new Promise<string>((_resolve, reject) => { rejectTarget = reject; }),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {
      targetCancelled += 1;
      rejectTarget(new Error("browser tab closed by user"));
    },
  }), "trace_target");
  sessions.getOrCreate("other", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { otherCancelled += 1; },
  }), "trace_other");

  expect(await sessions.cancelTrace("trace_target")).toBe(1);
  expect(targetCancelled).toBe(1);
  expect(otherCancelled).toBe(0);
  expect(target.settledOutcome()).toMatchObject({ type: "error" });
  expect(sessions.activeCount()).toBe(1);
  expect(sessions.getOrCreate("target", () => {
    throw new Error("a cancelled continuation must not open a new browser tab");
  }, "trace_target")).toBe(target);
  expect(await sessions.cancelTrace("trace_target")).toBe(0);
  sessions.clear();
});

test("session cache expiry never cancels a still-active long browser turn", async () => {
  const sessions = new ChatGptTurnSessions(1);
  let cancelled = 0;
  const active = sessions.getOrCreate("long-turn", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  await Bun.sleep(5);
  expect(sessions.activeCount()).toBe(1);
  expect(sessions.getOrCreate("long-turn", () => {
    throw new Error("active session must be reused");
  })).toBe(active);
  expect(cancelled).toBe(0);
  sessions.clear();
});

test("a settled browser session remains active until every delivered native result is recorded", async () => {
  const sessions = new ChatGptTurnSessions();
  const session = sessions.getOrCreate("settled-with-native-work", () => ({
    mode: "tools",
    token: Promise.resolve("turn-test-active-drain"),
    browser: Promise.resolve("done"),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  }));
  session.setOutstanding([{
    callId: "call-active-drain",
    wireName: "exec_command",
    freeform: false,
    arguments: { cmd: "pwd" },
  }]);
  await session.browserOutcome;

  expect(sessions.activeCount()).toBe(1);
  session.markResultDelivered("call-active-drain");
  expect(sessions.activeCount()).toBe(0);
});

test("five active turns coexist and a sixth fails closed", () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  const runtime = () => ({
    mode: "read-only" as const,
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  });

  const active = Array.from({ length: 5 }, (_unused, index) => (
    sessions.getOrCreate(`turn-${index + 1}`, runtime)
  ));
  expect(sessions.activeCount()).toBe(5);
  expect(cancelled).toBe(0);
  expect(() => sessions.getOrCreate("turn-6", runtime)).toThrow("at most 5 simultaneous browser turns");

  expect(sessions.getOrCreate("turn-3", () => {
    throw new Error("an in-flight turn must be reused");
  })).toBe(active[2]);
  expect(cancelled).toBe(0);
  sessions.clear();
  expect(cancelled).toBe(5);
});

test("settled replay sessions expire from their last use instead of their creation time", async () => {
  const sessions = new ChatGptTurnSessions(50);
  let starts = 0;
  const start = () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: Promise.resolve("done"),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {},
    };
  };
  const first = sessions.getOrCreate("replay", start);
  await first.browserOutcome;
  await Bun.sleep(10);
  expect(sessions.getOrCreate("replay", start)).toBe(first);
  await Bun.sleep(70);
  expect(sessions.getOrCreate("replay", start)).not.toBe(first);
  expect(starts).toBe(2);
  sessions.clear();
});

test("turn broker creates its private runtime directory on a cold start", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 10_000);
    if (process.platform === "win32") {
      expect(isWindowsPipeEndpoint(socketPath)).toBe(true);
    } else {
      expect(existsSync(socketPath)).toBe(true);
      expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
    }
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker tokens do not expire while their browser turn is still alive", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-unbounded-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
    await Bun.sleep(5);
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token }))
      .resolves.toMatchObject({ bindingId: expect.any(String) });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker revokes only channels owned by the closed browser trace", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-targeted-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };
    const target = await broker.register(environment, 60_000, "trace_target");
    const other = await broker.register(environment, 60_000, "trace_other");
    expect(broker.revokeTrace("trace_target")).toBe(1);
    await expect(callTurnBroker(socketPath, { method: "claim", token: target }))
      .rejects.toThrow("already finished");
    await expect(callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token: other }))
      .resolves.toMatchObject({ bindingId: expect.any(String) });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function unansweredBrokerEndpoint(name: string, onConnection: (socket: Socket) => void) {
  const root = mkdtempSync(join(tmpdir(), name));
  const socketPath = defaultBrokerEndpoint(root);
  if (!isWindowsPipeEndpoint(socketPath)) mkdirSync(dirname(socketPath), { recursive: true });
  const server = createServer(onConnection);
  return {
    socketPath,
    listen: () => new Promise<void>(ready => server.listen(socketPath, ready)),
    close: async () => {
      await new Promise<void>(done => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("an unbounded broker call fails when the broker closes without answering", async () => {
  const broker = unansweredBrokerEndpoint("cgw-broker-closed-", socket => socket.on("data", () => socket.end()));
  await broker.listen();
  try {
    await expect(callTurnBroker(broker.socketPath, { method: "claim", token: "turn_closed" }, null))
      .rejects.toThrow("closed the connection");
  } finally {
    await broker.close();
  }
}, 10_000);

test("an unbounded broker call outlives the bounded default timeout", async () => {
  const accepted: Socket[] = [];
  const broker = unansweredBrokerEndpoint("cgw-broker-slow-", socket => { accepted.push(socket); });
  await broker.listen();
  try {
    const call = callTurnBroker(broker.socketPath, { method: "claim", token: "turn_unbounded" }, null);
    const outcome = await Promise.race([
      call.then(() => "settled", () => "settled"),
      Bun.sleep(5_300).then(() => "pending"),
    ]);
    expect(outcome).toBe("pending");
  } finally {
    for (const socket of accepted) socket.destroy();
    await broker.close();
  }
}, 15_000);

test("turn broker names the finished turn that owns a replayed handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 60_000, "turn-alpha");
    await expect(callTurnBroker(socketPath, { method: "claim", token: ` ${token}` }))
      .rejects.toThrow("turn token is invalid, expired, or revoked");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    broker.revoke(token);

    const rejection = async (request: Parameters<typeof callTurnBroker>[1]): Promise<string> => {
      try {
        await callTurnBroker(socketPath, request);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("turn broker accepted a handle it should have rejected");
    };

    const replayedBinding = await rejection({
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
    });
    expect(replayedBinding).toContain("turn-alpha");
    expect(replayedBinding).toContain("has already finished");
    expect(replayedBinding).not.toContain("codex_bind_turn");

    const replayedToken = await rejection({ method: "claim", token });
    expect(replayedToken).toContain("turn-alpha");
    expect(replayedToken).toContain("can no longer run");
    expect(replayedToken).not.toContain("current task context");

    const unknownBinding = await rejection({
      method: "invoke",
      bindingId: "binding_never-issued",
      wireName: "exec_command",
    });
    expect(unknownBinding).toBe("internal Codex turn binding is invalid or expired");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("aborting a broker client removes invocation work before the adapter can claim it", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-abort-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
    }, 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const abort = new AbortController();
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000, abort.signal);
    await Bun.sleep(25);
    abort.abort();
    await expect(invocation).rejects.toThrow("aborted");
    await Bun.sleep(25);

    const noWork = new AbortController();
    const pending = broker.nextToolBatch(token, noWork.signal);
    setTimeout(() => noWork.abort(), 25);
    await expect(pending).rejects.toThrow("aborted");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disconnecting a broker socket removes queued executable work", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-disconnect-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
    }, 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const socket = createConnection(socketPath);
    await new Promise<void>((resolveConnected, rejectConnected) => {
      socket.once("connect", resolveConnected);
      socket.once("error", rejectConnected);
    });
    socket.write(`${JSON.stringify({
      id: "disconnect-request",
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    })}\n`);
    await Bun.sleep(25);
    socket.destroy();
    await Bun.sleep(25);

    const noWork = new AbortController();
    const pending = broker.nextToolBatch(token, noWork.signal);
    setTimeout(() => noWork.abort(), 25);
    await expect(pending).rejects.toThrow("aborted");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disconnecting an external owner wait cannot consume a later tool batch", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-owner-disconnect-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
    }, 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const abandonedOwner = createConnection(socketPath);
    await new Promise<void>((resolveConnected, rejectConnected) => {
      abandonedOwner.once("connect", resolveConnected);
      abandonedOwner.once("error", rejectConnected);
    });
    abandonedOwner.write(`${JSON.stringify({
      id: "abandoned-owner-next",
      method: "owner_next",
      token,
    })}\n`);
    await Bun.sleep(25);
    abandonedOwner.destroy();
    await Bun.sleep(25);

    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000);
    const next = new AbortController();
    const timer = setTimeout(() => next.abort(), 1_000);
    const [request] = await broker.nextToolBatch(token, next.signal);
    clearTimeout(timer);
    expect(request?.wireName).toBe("exec_command");
    broker.completeTool(token, request!.callId, {
      content: [{ type: "text", text: "completed" }],
    });
    expect(await invocation).toMatchObject({ content: [{ type: "text", text: "completed" }] });
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("disconnecting after delivery preserves the invocation until its terminal result", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-delivered-disconnect-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
    }, 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const socket = createConnection(socketPath);
    await new Promise<void>((resolveConnected, rejectConnected) => {
      socket.once("connect", resolveConnected);
      socket.once("error", rejectConnected);
    });
    socket.write(`${JSON.stringify({
      id: "delivered-disconnect-request",
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "same-delivered-command",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    })}\n`);
    const [request] = await broker.nextToolBatch(token);
    expect(request?.wireName).toBe("exec_command");

    socket.destroy();
    await Bun.sleep(25);

    const replay = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "same-delivered-command",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000);
    const ambiguousRetry = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "different-request-same-command",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000);
    await expect(ambiguousRetry).rejects.toThrow("equivalent broker invocation is already executing");

    const noWork = new AbortController();
    const pending = broker.nextToolBatch(token, noWork.signal);
    setTimeout(() => noWork.abort(), 25);
    await expect(pending).rejects.toThrow("aborted");

    const terminal = { content: [{ type: "text", text: "done" }] };
    expect(() => broker.completeTool(token, request.callId, terminal)).not.toThrow();
    expect(await replay).toEqual(terminal);

    const deliberateSecondCall = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "new-logical-request-after-terminal",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000);
    const [secondRequest] = await broker.nextToolBatch(token);
    expect(secondRequest.callId).not.toBe(request.callId);
    broker.completeTool(token, secondRequest.callId, terminal);
    expect(await deliberateSecondCall).toEqual(terminal);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("broker operation identity survives caller restart and a queued continuation abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-operation-identity-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
    }, 10_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const operationKey = "semantic-pwd-operation";
    const firstRequestKey = "logical-request-one";
    const first = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "logical-request-one-invocation",
      operationKey,
      operationRequestKey: firstRequestKey,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000);
    const [request] = await broker.nextToolBatch(token);
    const pending: BrokerToolResult = {
      content: [{ type: "text", text: "Script running with cell ID operation-cell\nWall time 0.1 seconds\nOutput:\n" }],
    };
    broker.completeTool(token, request!.callId, pending);
    expect(await first).toEqual(pending);

    const restartedReplay = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "logical-request-one-invocation",
      operationKey,
      operationRequestKey: firstRequestKey,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000);
    expect(await restartedReplay).toEqual(pending);

    await expect(callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "logical-request-two-invocation",
      operationKey,
      operationRequestKey: "logical-request-two",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000)).rejects.toThrow("operation is already active under a different request identity");

    const continuationAbort = new AbortController();
    const abortedContinuation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "aborted-pending-continuation",
      operationKey,
      operationRequestKey: firstRequestKey,
      wireName: "wait",
      freeform: false,
      arguments: { cell_id: "operation-cell" },
    }, 10_000, continuationAbort.signal);
    await Bun.sleep(25);
    continuationAbort.abort();
    await expect(abortedContinuation).rejects.toThrow("aborted");

    await expect(callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "logical-request-two-invocation",
      operationKey,
      operationRequestKey: "logical-request-two",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000)).rejects.toThrow("operation is already active under a different request identity");

    const terminalContinuation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "terminal-pending-continuation",
      operationKey,
      operationRequestKey: firstRequestKey,
      wireName: "wait",
      freeform: false,
      arguments: { cell_id: "operation-cell" },
    }, 10_000);
    const [continuationRequest] = await broker.nextToolBatch(token);
    expect(continuationRequest).toMatchObject({ wireName: "wait", arguments: { cell_id: "operation-cell" } });
    const terminal: BrokerToolResult = { content: [{ type: "text", text: "done" }] };
    broker.completeTool(token, continuationRequest!.callId, terminal);
    expect(await terminalContinuation).toEqual(terminal);

    expect(await callTurnBroker<{ terminalized: boolean; pending: boolean }>(socketPath, {
      method: "terminalize",
      bindingId: claimed.bindingId,
      operationKey,
      operationRequestKey: firstRequestKey,
    }, 10_000)).toEqual({ terminalized: true, pending: false });

    await expect(callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "same-command-after-terminal",
      operationKey,
      operationRequestKey: "logical-request-after-terminal",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000)).rejects.toThrow("operation invocation has already been terminalized");

    const unrelated = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "logical-request-after-terminal",
      operationKey,
      operationRequestKey: "logical-request-after-terminal",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "git status --short" },
    }, 10_000);
    const [unrelatedRequest] = await broker.nextToolBatch(token);
    broker.completeTool(token, unrelatedRequest!.callId, terminal);
    expect(await unrelated).toEqual(terminal);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("delivered command quarantine survives expiry, revoke, cross-channel calls, and broker restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-command-quarantine-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  let restarted: TurnBroker | undefined;
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite" as const, writableRoots: [root], networkAccess: false },
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
    };
    const firstToken = await broker.register(environment, 40, "quarantined-turn");
    const secondToken = await broker.register(environment, 60_000, "unrelated-turn");
    const firstBinding = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token: firstToken });
    const secondBinding = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token: secondToken });
    const operationKey = "global-command-operation";
    const operationRequestKey = "first-command-request";
    const first = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: firstBinding.bindingId,
      invocationKey: "first-command-invocation",
      operationKey,
      operationRequestKey,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000);
    const [request] = await broker.nextToolBatch(firstToken);
    const pending: BrokerToolResult = {
      content: [{ type: "text", text: "Script running with cell ID quarantined-cell\nWall time 0.1 seconds\nOutput:\n" }],
    };
    broker.completeTool(firstToken, request!.callId, pending);
    expect(await first).toEqual(pending);

    await Bun.sleep(50);
    await expect(callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: secondBinding.bindingId,
      invocationKey: "second-command-invocation",
      operationKey,
      operationRequestKey: "second-command-request",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "git status --short" },
    }, 10_000)).rejects.toThrow("protected broker operation is already active");
    await expect(callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: secondBinding.bindingId,
      invocationKey: "generic-bypass-invocation",
      wireName: "view_image",
      freeform: false,
      arguments: { path: "/tmp/nonexistent.png" },
    }, 10_000)).rejects.toThrow("protected broker operation is already active");

    broker.revoke(firstToken);
    expect(await callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: firstBinding.bindingId,
      invocationKey: "first-command-invocation",
      operationKey,
      operationRequestKey,
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000)).toEqual(pending);

    await broker.close();
    restarted = TurnBroker.forSocket(socketPath);
    const restartedToken = await restarted.register(environment, 60_000, "restarted-turn");
    const restartedBinding = await callTurnBroker<{ bindingId: string }>(socketPath, {
      method: "claim",
      token: restartedToken,
    });
    await expect(callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: restartedBinding.bindingId,
      invocationKey: "post-restart-command",
      operationKey,
      operationRequestKey: "post-restart-request",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000)).rejects.toThrow("unresolved command quarantine");
  } finally {
    await restarted?.close().catch(() => {});
    await broker.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("an undelivered protected command abort releases quarantine before any execution can start", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-undelivered-command-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
    }, 60_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const abort = new AbortController();
    const abandoned = callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "undelivered-command",
      operationKey: "global-command-operation",
      operationRequestKey: "undelivered-request",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "pwd" },
    }, 10_000, abort.signal);
    await Bun.sleep(25);
    abort.abort();
    await expect(abandoned).rejects.toThrow("aborted");
    await Bun.sleep(50);

    const next = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "safe-next-command",
      operationKey: "global-command-operation",
      operationRequestKey: "safe-next-request",
      wireName: "exec_command",
      freeform: false,
      arguments: { cmd: "git status --short" },
    }, 10_000);
    const [request] = await broker.nextToolBatch(token);
    const terminal: BrokerToolResult = { content: [{ type: "text", text: "done" }] };
    broker.completeTool(token, request!.callId, terminal);
    expect(await next).toEqual(terminal);
    expect(await callTurnBroker<{ terminalized: boolean; pending: boolean }>(socketPath, {
      method: "terminalize",
      bindingId: claimed.bindingId,
      operationKey: "global-command-operation",
      operationRequestKey: "safe-next-request",
    }, 10_000)).toEqual({ terminalized: true, pending: false });
  } finally {
    await broker.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test("broker replay cache fails closed on an oversized result without permitting redispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-replay-cap-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      tools: [{ name: "view_image", description: "Read an image", parameters: { type: "object" } }],
    }, 60_000);
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const oversized = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "oversized-replay-result",
      wireName: "view_image",
      freeform: false,
      arguments: { path: "/tmp/oversized.png" },
    }, 30_000);
    const [request] = await broker.nextToolBatch(token);
    broker.completeTool(token, request!.callId, {
      content: [{ type: "text", text: "x".repeat(8_400_000) }],
    });
    const bounded = await oversized;
    expect(bounded.isError).toBe(true);
    expect(JSON.stringify(bounded.content)).toContain("UNRESOLVED_BROKER_RESULT_TOO_LARGE");

    expect(await callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "oversized-replay-result",
      wireName: "view_image",
      freeform: false,
      arguments: { path: "/tmp/oversized.png" },
    }, 10_000)).toEqual(bounded);
    await expect(callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      invocationKey: "new-dispatch-after-replay-cap",
      wireName: "view_image",
      freeform: false,
      arguments: { path: "/tmp/new.png" },
    }, 10_000)).rejects.toThrow("replay cache is exhausted");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("broker logs use digests instead of raw capability and call handles", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-log-redaction-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const messages: string[] = [];
  const originalInfo = console.info;
  const originalError = console.error;
  console.info = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { messages.push(values.map(String).join(" ")); };
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      tools: [{ name: "exec_command", description: "Run command", parameters: { type: "object" } }],
    }, 10_000, "trace-redaction");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "pwd" },
    }, 10_000);
    const [request] = await broker.nextToolBatch(token);
    broker.completeTool(token, request!.callId, { content: [{ type: "text", text: "ok" }] });
    await invocation;
    broker.revoke(token);
    await callTurnBroker(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
    }).catch(() => {});

    const joined = messages.join("\n");
    expect(joined).not.toContain(token);
    expect(joined).not.toContain(claimed.bindingId);
    expect(joined).not.toContain(request!.callId);
    expect(joined).toContain("callHash=");
    expect(joined).toContain("bindingHash=");
  } finally {
    console.info = originalInfo;
    console.error = originalError;
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
