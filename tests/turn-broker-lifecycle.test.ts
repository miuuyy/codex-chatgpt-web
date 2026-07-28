import { expect, test } from "bun:test";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

test("explicit browser-turn cancellation aborts and removes every registered session", () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  sessions.getOrCreate("turn-a", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));
  sessions.getOrCreate("turn-b", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  expect(sessions.activeCount()).toBe(2);
  expect(sessions.clear()).toBe(2);
  expect(cancelled).toBe(2);
  expect(sessions.activeCount()).toBe(0);
});

test("turn broker creates its private runtime directory on a cold start", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\cgw-broker-${process.pid}-${Date.now()}`
    : join(root, "runtime", "turn-broker.sock");
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 10_000);
    const claim = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    expect(claim.bindingId).toStartWith("binding_");
    if (process.platform !== "win32") {
      expect(existsSync(socketPath)).toBe(true);
      expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
    }
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("prompt relay queues Codex tool calls and resumes with their real results", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-prompt-broker-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\cgw-prompt-broker-${process.pid}-${Date.now()}`
    : join(root, "runtime", "turn-broker.sock");
  const broker = TurnBroker.forSocket(socketPath);
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    }, 10_000);
    const invocation = broker.invokeFromPrompt(token, [{
      wireName: "exec",
      freeform: false,
      arguments: { command: "pwd" },
    }]);
    const batch = await broker.nextToolBatch(token);
    expect(batch).toEqual(invocation.requests);
    broker.completeTool(token, batch[0]!.callId, { content: [{ type: "text", text: root }] });
    expect(await invocation.results).toEqual([{ content: [{ type: "text", text: root }] }]);
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});
