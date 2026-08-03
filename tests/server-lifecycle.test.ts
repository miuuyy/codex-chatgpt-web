import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, closeTurnBrokers } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, defaultConfig } from "../src/config";
import { HttpTurnCounter, startServer } from "../src/server";

async function waitForTurnCount(turns: HttpTurnCounter, expected: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (turns.count() !== expected && Date.now() < deadline) await Bun.sleep(5);
  expect(turns.count()).toBe(expected);
}

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
  await waitForTurnCount(turns, 0);
});

test("HTTP turn tracking releases a cancelled response stream", async () => {
  const turns = new HttpTurnCounter();
  const request = new AbortController();
  const response = await turns.track(
    async () => new Response(new ReadableStream<Uint8Array>()),
    request.signal,
  );

  expect(turns.count()).toBe(1);
  const cancelled = response.body!.cancel();
  request.abort("client disconnected");
  await cancelled;
  await waitForTurnCount(turns, 0);
});

test("HTTP turn tracking uses a tee branch on Windows", async () => {
  const turns = new HttpTurnCounter();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const original = new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
  });
  const response = await turns.track(async () => new Response(original), undefined, "win32");
  const reader = response.body!.getReader();

  source.enqueue(new TextEncoder().encode("safe"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("safe");
  source.close();
  expect((await reader.read()).done).toBe(true);
  await waitForTurnCount(turns, 0);
});

test("HTTP turn tracking uses direct pull and cancellation outside Windows", async () => {
  const turns = new HttpTurnCounter();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCancelled = false;
  const original = new ReadableStream<Uint8Array>({
    start(controller) { source = controller; },
    cancel() { sourceCancelled = true; },
  });
  const response = await turns.track(async () => new Response(original), undefined, "darwin");
  const reader = response.body!.getReader();

  source.enqueue(new TextEncoder().encode("native-pull"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("native-pull");
  await reader.cancel("client disconnected");
  await waitForTurnCount(turns, 0);
  expect(sourceCancelled).toBe(true);
});

test("HTTP turn tracking releases a stream whose client disconnected without cancelling", async () => {
  const turns = new HttpTurnCounter();
  const client = new AbortController();
  let cancelled = false;
  const response = await turns.track(
    async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    })),
    client.signal,
  );

  expect(turns.count()).toBe(1);
  client.abort();
  await Bun.sleep(0);
  expect(turns.count()).toBe(0);
  expect(cancelled).toBe(true);
  expect(response.body).not.toBeNull();
});

test("HTTP turn tracking releases a stream requested by an already disconnected client", async () => {
  const turns = new HttpTurnCounter();
  const client = new AbortController();
  client.abort();
  await turns.track(async () => new Response(new ReadableStream<Uint8Array>()), client.signal);

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
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-browser-turns`, {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
    });
    expect(unauthorized.status).toBe(401);
    expect(chatGptTurnSessions.activeCount()).toBe(1);

    const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-browser-turns`, {
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

test("a full-mode runtime exposes its broker endpoint before any turn registers", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-serve-"));
  // The endpoint is a Unix socket on POSIX and a named pipe on Windows, so liveness is proven by
  // the broker answering its own protocol, never by a path existing.
  const config = { ...defaultConfig("full"), port: 0, brokerSocketPath: defaultBrokerEndpoint(root) };
  const server = startServer(config);
  try {
    const deadline = Date.now() + 5_000;
    let message = "";
    for (;;) {
      try {
        await callTurnBroker(config.brokerSocketPath, { method: "claim", token: "not-a-registered-turn" });
        message = "";
        break;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      // An in-flight ChatGPT turn calls the bridge from a separate process; it must reach the
      // broker itself rather than an endpoint that no longer exists.
      if (!message.includes("unavailable") || Date.now() >= deadline) break;
      await Bun.sleep(20);
    }
    expect(message).toContain("turn token is invalid");
  } finally {
    await server.stop(true);
    await closeTurnBrokers();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a drained runtime rejects new model-catalog work before shutdown", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const authorization = { authorization: `Bearer ${config.controlToken}` };
  try {
    const drain = await fetch(`${endpoint}/admin/drain`, {
      method: "POST",
      headers: authorization,
    });
    expect(drain.status).toBe(200);

    const models = await fetch(`${endpoint}/v1/models`);
    expect(models.status).toBe(503);
    expect(await models.json()).toMatchObject({
      error: {
        type: "server_error",
        message: "codex-chatgpt-web is draining for a requested service operation",
      },
    });

    const resume = await fetch(`${endpoint}/admin/resume`, {
      method: "POST",
      headers: authorization,
    });
    expect(resume.status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

test("health proves that Codex received a successful augmented model catalog", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config, {
    fetchUpstream: async () => Response.json({
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [],
        tool_mode: "code_mode_only",
      }],
    }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    expect(await (await fetch(`${endpoint}/healthz`)).json()).toMatchObject({
      successful_model_catalog_requests: 0,
      last_successful_model_catalog_request_at: null,
    });

    const models = await fetch(`${endpoint}/v1/models`, {
      headers: { authorization: "Bearer test-codex-session" },
    });
    expect(models.status).toBe(200);

    const health = await (await fetch(`${endpoint}/healthz`)).json() as Record<string, unknown>;
    expect(health.successful_model_catalog_requests).toBe(1);
    expect(typeof health.last_successful_model_catalog_request_at).toBe("string");
  } finally {
    await server.stop(true);
  }
});

test("server exposes authenticated standalone Web Search on the routed v1 base URL", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let upstreamRequest: Request | undefined;
  const server = startServer(config, {
    fetchUpstream: async request => {
      upstreamRequest = request;
      return Response.json({ results: ["native-search-result"] });
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(`${endpoint}/v1/alpha/search`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-codex-session",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "bridge route" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: ["native-search-result"] });
    expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search");
    expect(upstreamRequest!.headers.get("authorization")).toBe("Bearer test-codex-session");
    expect(await upstreamRequest!.json()).toEqual({ query: "bridge route" });
  } finally {
    await server.stop(true);
  }
});

test("authenticated shutdown requires a verified idle drain", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const authorization = { authorization: `Bearer ${config.controlToken}` };

  try {
    const unauthorized = await fetch(`${endpoint}/admin/shutdown`, {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
    });
    expect(unauthorized.status).toBe(401);

    const undrained = await fetch(`${endpoint}/admin/shutdown`, {
      method: "POST",
      headers: authorization,
    });
    expect(undrained.status).toBe(409);

    const drain = await fetch(`${endpoint}/admin/drain`, {
      method: "POST",
      headers: authorization,
    });
    expect(drain.status).toBe(200);

    const shutdown = await fetch(`${endpoint}/admin/shutdown`, {
      method: "POST",
      headers: authorization,
    });
    expect(shutdown.status).toBe(200);
    expect(await shutdown.json()).toMatchObject({
      status: "ok",
      accepting_turns: false,
      active_http_turns: 0,
      active_browser_turns: 0,
    });

    const deadline = Date.now() + 2_000;
    let stopped = false;
    while (Date.now() < deadline && !stopped) {
      await Bun.sleep(20);
      try {
        await fetch(`${endpoint}/healthz`);
      } catch {
        stopped = true;
      }
    }
    expect(stopped).toBe(true);
  } finally {
    await server.stop(true);
  }
});
