import { expect, test } from "bun:test";
import { ChatGptTextFeed, ChatGptTraceFeed, ChatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { callTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
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

test("active browser turns exceed the former replay-retention boundary without a concurrency cap", () => {
  const sessions = new ChatGptTurnSessions();
  let cancelled = 0;
  const runtime = () => ({
    mode: "read-only" as const,
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  });

  const active = Array.from({ length: 300 }, (_unused, index) => (
    sessions.getOrCreate(`turn-${index + 1}`, runtime)
  ));
  expect(sessions.activeCount()).toBe(300);
  expect(cancelled).toBe(0);

  expect(sessions.getOrCreate("turn-213", () => {
    throw new Error("an in-flight turn must be reused");
  })).toBe(active[212]);
  expect(cancelled).toBe(0);
  sessions.clear();
  expect(cancelled).toBe(300);
});

test("settled replay retention stays bounded without limiting active turns", async () => {
  const sessions = new ChatGptTurnSessions(60_000, 2);
  const releases = new Map<string, () => void>();
  let restarts = 0;
  const runtime = (key: string) => ({
    mode: "read-only" as const,
    browser: new Promise<string>(resolve => releases.set(key, () => resolve(key))),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {},
  });

  const active = Array.from({ length: 4 }, (_unused, index) => {
    const key = `turn-${index + 1}`;
    return sessions.getOrCreate(key, () => runtime(key));
  });
  expect(sessions.activeCount()).toBe(4);
  for (const release of releases.values()) release();
  await Promise.all(active.map(session => session.browserOutcome));
  expect(sessions.activeCount()).toBe(0);

  sessions.getOrCreate("turn-1", () => {
    restarts += 1;
    return {
      mode: "read-only",
      browser: Promise.resolve("restarted"),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {},
    };
  });
  sessions.getOrCreate("turn-4", () => {
    throw new Error("the newest settled replay must remain cached");
  });
  expect(restarts).toBe(1);
  sessions.clear();
});

test("detached browser turns reattach during the reconnect grace window", async () => {
  const sessions = new ChatGptTurnSessions(60_000, 256, 50);
  let cancelled = 0;
  let starts = 0;
  const start = () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: new Promise<string>(() => {}),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => { cancelled += 1; },
    };
  };

  const first = sessions.getOrCreate("reattach", start);
  sessions.detach("reattach", first);
  await Bun.sleep(10);

  expect(sessions.getOrCreate("reattach", start)).toBe(first);
  await Bun.sleep(60);
  expect(starts).toBe(1);
  expect(cancelled).toBe(0);
  sessions.clear();
});

test("detached browser turns cancel and evict when nobody reconnects", async () => {
  const sessions = new ChatGptTurnSessions(60_000, 256, 20);
  let cancelled = 0;
  let starts = 0;
  const start = () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: new Promise<string>(() => {}),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => { cancelled += 1; },
    };
  };

  const first = sessions.getOrCreate("orphan", start);
  sessions.detach("orphan", first);
  await Bun.sleep(40);

  expect(cancelled).toBe(1);
  expect(sessions.getOrCreate("orphan", start)).not.toBe(first);
  expect(starts).toBe(2);
  sessions.clear();
});

test("terminal browser errors are evicted instead of poisoning same-turn retries", async () => {
  const sessions = new ChatGptTurnSessions();
  let starts = 0;
  let cancelled = 0;
  let rejectFirst!: (error: Error) => void;
  const first = sessions.getOrCreate("failed-turn", () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: new Promise<string>((_resolve, reject) => { rejectFirst = reject; }),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => { cancelled += 1; },
    };
  });

  rejectFirst(new Error("browser failed"));
  expect(await first.browserOutcome).toMatchObject({ type: "error" });
  await Promise.resolve();

  const second = sessions.getOrCreate("failed-turn", () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: Promise.resolve("restarted"),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => { cancelled += 1; },
    };
  });

  expect(second).not.toBe(first);
  expect(starts).toBe(2);
  expect(cancelled).toBe(1);
  sessions.clear();
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

test("replay TTL starts when a long-running browser turn settles", async () => {
  const sessions = new ChatGptTurnSessions(50);
  let resolveBrowser!: (answer: string) => void;
  let starts = 0;
  const start = () => {
    starts += 1;
    return {
      mode: "read-only" as const,
      browser: new Promise<string>(resolve => { resolveBrowser = resolve; }),
      trace: new ChatGptTraceFeed(),
      text: new ChatGptTextFeed(),
      cancel: () => {},
    };
  };

  const first = sessions.getOrCreate("long-replay", start);
  await Bun.sleep(70);
  resolveBrowser("done");
  await first.browserOutcome;

  expect(sessions.getOrCreate("long-replay", start)).toBe(first);
  expect(starts).toBe(1);
  await Bun.sleep(70);
  expect(sessions.getOrCreate("long-replay", start)).not.toBe(first);
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
    });
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
    }, "turn-alpha");
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
    expect(replayedBinding).toContain("codex_bind_turn");

    const replayedToken = await rejection({ method: "claim", token });
    expect(replayedToken).toContain("turn-alpha");
    expect(replayedToken).toContain("current task context");

    const unknownBinding = await rejection({
      method: "invoke",
      bindingId: "binding_never-issued",
      wireName: "exec_command",
    });
    expect(unknownBinding).toBe("binding id is invalid or revoked");
  } finally {
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("turn broker capabilities do not expire with wall-clock age", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-age-"));
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const originalNow = Date.now;
  try {
    const token = await broker.register({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const startedAt = originalNow();
    Date.now = () => startedAt + 24 * 60 * 60_000;
    const resolved = await callTurnBroker<{ environment: { cwd: string } }>(socketPath, {
      method: "resolve",
      bindingId: claimed.bindingId,
    });
    expect(resolved.environment.cwd).toBe(root);
  } finally {
    Date.now = originalNow;
    await broker.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unlimited broker call rejects when its connection closes without a response", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-broker-eof-"));
  const socketPath = defaultBrokerEndpoint(root);
  const server = createServer(socket => {
    socket.once("data", () => socket.end());
  });
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(socketPath, resolveListen);
    });
    await expect(callTurnBroker(socketPath, { method: "claim", token: "turn_never_returns_1234567890" }, null))
      .rejects.toThrow("closed before returning");
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  }
});
