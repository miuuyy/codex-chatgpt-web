import { expect, test } from "bun:test";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig } from "../src/config";
import { HttpTurnCounter, startServer } from "../src/server";

test("HTTP turn tracking follows the response stream instead of Bun's global request count", async () => {
  const turns = new HttpTurnCounter();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await turns.track(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
  })));
  const reader = response.body!.getReader();

  expect(turns.count()).toBe(1);
  source.enqueue(new TextEncoder().encode("data"));
  expect((await reader.read()).done).toBe(false);
  expect(turns.count()).toBe(1);
  source.close();
  expect((await reader.read()).done).toBe(true);
  expect(turns.count()).toBe(0);
});

test("HTTP turn tracking releases a cancelled response stream", async () => {
  const turns = new HttpTurnCounter();
  const response = await turns.track(async () => new Response(new ReadableStream<Uint8Array>()));

  expect(turns.count()).toBe(1);
  await response.body!.cancel();
  expect(turns.count()).toBe(0);
});

test("authenticated lifecycle control cancels orphaned browser turns", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  let cancelled = 0;
  chatGptTurnSessions.clear();
  chatGptTurnSessions.getOrCreate("orphan", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  try {
    const unauthorized = await fetch(`http://localhost:${server.port}/admin/cancel-browser-turns`, {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
    });
    expect(unauthorized.status).toBe(401);
    expect(chatGptTurnSessions.activeCount()).toBe(1);

    const response = await fetch(`http://localhost:${server.port}/admin/cancel-browser-turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      cancelled_browser_turns: 1,
      active_http_turns: 0,
      active_browser_turns: 0,
    });
    expect(cancelled).toBe(1);
    expect(chatGptTurnSessions.activeCount()).toBe(0);
  } finally {
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});
