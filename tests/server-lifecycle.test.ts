import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatGptWebExecutionNamespace, chatGptWebTraceId } from "../src/adapters/chatgpt-web";
import { runStructuredCompactionOnce } from "../src/adapters/chatgpt-web/compaction-handoff";
import { ChatGptTextFeed, ChatGptTraceFeed, chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import { callTurnBroker, closeTurnBrokers, RemoteTurnBroker, TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, defaultConfig, providerConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { compactRequest, HttpTurnCounter, responseRequest, routeChatGptWebRequest, startServer } from "../src/server";

test("DEV harness configuration cannot bind a Responses listener", () => {
  const config = { ...defaultConfig("browser-only"), purpose: "dev-harness" as const, port: 0 };
  expect(() => startServer(config)).toThrow("cannot start a Responses listener");
});

test("Responses and compact requests each freeze one live Pro model preference snapshot", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0, proAvailable: true };
  const selected = ["5.6", "5.5"] as const;
  let reads = 0;
  const observed: Array<string | undefined> = [];
  const server = startServer(config, {
    readProModelVersion: () => selected[reads++],
    adapterFactory: provider => {
      observed.push(provider.chatgptWeb?.proModelVersion);
      return {
        name: "pro-model-snapshot-test",
        async runTurn(parsed, _incoming, emit) {
          emit({
            type: "text_delta",
            text: parsed._compactionRequest ? "Frozen compact summary" : "Frozen response",
            phase: "final_answer",
          });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        },
      };
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/pro",
        stream: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Respond" }] }],
      }),
    });
    expect(response.status).toBe(200);

    const compact = await fetch(`${endpoint}/v1/responses/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/pro",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Compact" }] }],
      }),
    });
    expect(compact.status).toBe(200);
    expect(reads).toBe(2);
    expect(observed).toEqual(["5.6", "5.5"]);
    expect(config.proModelVersion).toBeUndefined();
  } finally {
    await server.stop(true);
  }
});

test("native response and compact passthrough never read the live Pro preference", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0, proAvailable: true };
  let reads = 0;
  const server = startServer(config, {
    readProModelVersion: () => {
      reads += 1;
      throw new Error("native passthrough must not depend on live Web GPT configuration");
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
    });
    expect(response.status).toBe(502);

    const compact = await fetch(`${endpoint}/v1/responses/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
    });
    expect(compact.status).toBe(502);
    expect(reads).toBe(0);
  } finally {
    await server.stop(true);
  }
});

test("a Pro pin isolates Pro execution without changing non-Pro execution namespaces", async () => {
  const captureProvider = async (model: string, proModelVersion: "5.6" | "6") => {
    let observed: ReturnType<typeof providerConfig> | undefined;
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `${model} ${proModelVersion}` }] }],
      }),
    }), { ...defaultConfig("browser-only"), proAvailable: true, proModelVersion }, provider => {
      observed = provider;
      return {
        name: "execution-namespace-test",
        async runTurn(_parsed, _incoming, emit) {
          emit({ type: "text_delta", text: "done", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        },
      };
    });
    expect(response.status).toBe(200);
    expect(observed).toBeDefined();
    return observed!;
  };

  const high56 = await captureProvider("chatgpt-web/high", "5.6");
  const high6 = await captureProvider("chatgpt-web/high", "6");
  expect(high56.chatgptWeb).not.toHaveProperty("proModelVersion");
  expect(high6.chatgptWeb).not.toHaveProperty("proModelVersion");
  expect(chatGptWebExecutionNamespace(high56)).toBe(chatGptWebExecutionNamespace(high6));

  const pro56 = await captureProvider("chatgpt-web/pro", "5.6");
  const pro6 = await captureProvider("chatgpt-web/pro", "6");
  expect(pro56.chatgptWeb?.proModelVersion).toBe("5.6");
  expect(pro6.chatgptWeb?.proModelVersion).toBe("6");
  expect(chatGptWebExecutionNamespace(pro56)).not.toBe(chatGptWebExecutionNamespace(pro6));
});

test("a static server keeps the Pro model preference configured at startup", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0, proAvailable: true, proModelVersion: "6" as const };
  let observed: string | undefined;
  const server = startServer(config, {
    adapterFactory: provider => ({
      name: "static-pro-model-snapshot-test",
      async runTurn(_parsed, _incoming, emit) {
        observed = provider.chatgptWeb?.proModelVersion;
        emit({ type: "text_delta", text: "Static response", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    }),
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "chatgpt-web/pro",
        stream: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Respond" }] }],
      }),
    });
    expect(response.status).toBe(200);
    expect(observed).toBe("6");
  } finally {
    await server.stop(true);
  }
});

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
  const failures: unknown[] = [];
  const turns = new HttpTurnCounter(failure => failures.push(failure));
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
  expect(failures).toEqual([]);
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

test("HTTP turn tracking records privacy-safe client stream failure evidence", async () => {
  const failures: unknown[] = [];
  const turns = new HttpTurnCounter(failure => failures.push(failure));
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await turns.track(
    async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    })),
    undefined,
    "darwin",
    "responses",
  );
  const reader = response.body!.getReader();

  source.enqueue(new TextEncoder().encode("safe"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("safe");
  source.error(Object.assign(new TypeError("private upstream response fragment"), { code: "ECONNRESET" }));
  await expect(reader.read()).rejects.toThrow("private upstream response fragment");
  await waitForTurnCount(turns, 0);

  expect(failures).toEqual([{
    httpTurnId: 1,
    endpoint: "responses",
    reader: "client",
    platform: "darwin",
    chunks: 1,
    bytes: 4,
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  }]);
  expect(JSON.stringify(failures)).not.toContain("private upstream response fragment");
});

test("HTTP turn tracking records privacy-safe Windows lifecycle failure evidence", async () => {
  const failures: unknown[] = [];
  const turns = new HttpTurnCounter(failure => failures.push(failure));
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await turns.track(
    async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    })),
    undefined,
    "win32",
    "responses",
  );
  const reader = response.body!.getReader();

  source.enqueue(new TextEncoder().encode("event"));
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("event");
  source.error(Object.assign(new TypeError("sensitive socket detail"), { code: "ECONNRESET" }));
  await expect(reader.read()).rejects.toThrow("sensitive socket detail");
  await waitForTurnCount(turns, 0);

  expect(failures).toEqual([{
    httpTurnId: 1,
    endpoint: "responses",
    reader: "windows_lifecycle",
    platform: "win32",
    chunks: 1,
    bytes: 5,
    errorName: "TypeError",
    errorCode: "ECONNRESET",
  }]);
  expect(JSON.stringify(failures)).not.toContain("sensitive socket detail");
});

test("HTTP stream diagnostics cannot replace the source failure or retain turn ownership", async () => {
  const turns = new HttpTurnCounter(() => { throw new Error("diagnostic sink failed"); });
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = await turns.track(
    async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller; },
    })),
    undefined,
    "darwin",
    "responses",
  );
  const reader = response.body!.getReader();

  source.error(new TypeError("source connection reset"));
  await expect(reader.read()).rejects.toThrow("source connection reset");
  await waitForTurnCount(turns, 0);
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
  const response = await turns.track(async () => new Response(new ReadableStream<Uint8Array>()), client.signal);

  expect(turns.count()).toBe(0);
  expect(response.status).toBe(499);
  expect(response.body).toBeNull();
});

test("a real HTTP peer disconnect releases a streaming turn", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let sourceCancelled = false;
  let markSourceReady!: () => void;
  const sourceReady = new Promise<void>(resolve => { markSourceReady = resolve; });
  const server = startServer(config, {
    fetchUpstream: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        markSourceReady();
      },
      cancel() {
        sourceCancelled = true;
      },
    })),
  });
  const port = server.port;
  if (port === undefined) throw new Error("test server did not bind a TCP port");
  const endpoint = `http://127.0.0.1:${port}`;
  const socket = createConnection({ host: "127.0.0.1", port });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const body = JSON.stringify({ query: "disconnect lifecycle proof" });
    socket.write([
      "POST /v1/alpha/search HTTP/1.1",
      "Host: 127.0.0.1",
      "Authorization: Bearer test-codex-session",
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "Connection: keep-alive",
      "",
      body,
    ].join("\r\n"));
    await sourceReady;
    source.enqueue(new TextEncoder().encode("stream-open"));
    await new Promise<void>((resolve, reject) => {
      socket.once("data", () => resolve());
      socket.once("error", reject);
    });

    expect(await (await fetch(`${endpoint}/healthz`)).json()).toMatchObject({ active_http_turns: 1 });
    socket.destroy();

    const deadline = Date.now() + 1_000;
    let activeHttpTurns = 1;
    while (Date.now() < deadline && activeHttpTurns !== 0) {
      const health = await (await fetch(`${endpoint}/healthz`)).json() as { active_http_turns: number };
      activeHttpTurns = health.active_http_turns;
      if (activeHttpTurns !== 0) await Bun.sleep(10);
    }
    expect(activeHttpTurns).toBe(0);
    expect(sourceCancelled).toBe(true);
  } finally {
    socket.destroy();
    await server.stop(true);
  }
});

test("HTTP turn cancellation aborts the tracked request and waits for lifecycle release", async () => {
  const turns = new HttpTurnCounter();
  let observedAbort = false;
  const tracked = turns.track(signal => new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      observedAbort = true;
      reject(signal.reason);
    }, { once: true });
  }));

  await waitForTurnCount(turns, 1);
  expect(await turns.cancelAll("launcher quit")).toBe(1);
  await expect(tracked).rejects.toBe("launcher quit");
  expect(observedAbort).toBe(true);
  expect(turns.count()).toBe(0);
});

test("native Codex interrupt cancels only HTTP streams owned by the exact thread and turn", async () => {
  const turns = new HttpTurnCounter();
  const started: Promise<Response>[] = [];
  const aborted: string[] = [];
  for (const identity of [
    { threadId: "thread_exact", turnId: "turn_exact" },
    { threadId: "thread_other", turnId: "turn_other" },
  ]) {
    started.push(turns.track((signal, bindIdentity) => {
      bindIdentity(identity);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted.push(identity.turnId);
          reject(signal.reason);
        }, { once: true });
      });
    }));
  }
  await waitForTurnCount(turns, 2);

  expect(await turns.cancelTurn({ threadId: "thread_exact", turnId: "turn_exact" })).toBe(1);
  expect(aborted).toEqual(["turn_exact"]);
  expect(turns.count()).toBe(1);
  await expect(started[0]!).rejects.toHaveProperty("name", "AbortError");

  expect(await turns.cancelAll()).toBe(1);
  await expect(started[1]!).rejects.toThrow("Active HTTP turns cancelled");
});

test("native Codex interrupt remains authoritative when it arrives before HTTP identity binding", async () => {
  const turns = new HttpTurnCounter();
  const identity = { threadId: "thread_interrupt_race", turnId: "turn_interrupt_race" };
  let bind!: () => void;
  const mayBind = new Promise<void>(resolve => { bind = resolve; });
  let observedAbort = false;
  const response = turns.track(async (signal, bindIdentity) => {
    await mayBind;
    bindIdentity(identity);
    observedAbort = signal.aborted;
    return new Response(new ReadableStream<Uint8Array>());
  });
  await waitForTurnCount(turns, 1);

  expect(await turns.cancelTurn(identity)).toBe(0);
  bind();
  expect((await response).status).toBe(499);
  expect(observedAbort).toBeTrue();
  await waitForTurnCount(turns, 0);
});

test("native passthrough response and compaction requests expose their exact interrupt identity", async () => {
  const config = defaultConfig("browser-only");
  const responseIdentity = { threadId: "thread_native_response", turnId: "turn_native_response" };
  let boundResponseIdentity: typeof responseIdentity | undefined;
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: responseIdentity.threadId,
          turn_id: responseIdentity.turnId,
        }),
      },
      input: [],
    }),
  }), config, undefined, {
    onTurnIdentity: identity => { boundResponseIdentity = identity; },
  });
  expect(boundResponseIdentity).toEqual(responseIdentity);
  expect(response.status).toBe(502);

  const compactIdentity = { threadId: "thread_native_compact", turnId: "turn_native_compact" };
  let boundCompactIdentity: typeof compactIdentity | undefined;
  const compact = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: compactIdentity.threadId,
        turn_id: compactIdentity.turnId,
      }),
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
  }), config, undefined, {
    onTurnIdentity: identity => { boundCompactIdentity = identity; },
  });
  expect(boundCompactIdentity).toEqual(compactIdentity);
  expect(compact.status).toBe(502);
});

test("authenticated Interrupt hook endpoint releases the exact routed Web turn", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const threadId = "thread_interrupt_hook";
  const turnId = "turn_interrupt_hook";
  let adapterAborted = false;
  let browserAborted = false;
  let rejectBrowser!: (error: Error) => void;
  const browser = new Promise<string>((_resolve, reject) => { rejectBrowser = reject; });
  chatGptTurnSessions.clear();
  chatGptTurnSessions.getOrCreate("interrupt-hook-browser", () => ({
    mode: "read-only",
    browser,
    physicalSettlement: browser.then(() => undefined, () => undefined),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: reason => {
      browserAborted = true;
      rejectBrowser(reason ?? new Error("native turn interrupted"));
    },
  }), "interrupt-hook-trace", "interrupt-hook-owner", turnId, threadId);
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "interrupt-test",
      runTurn: (_parsed, incoming) => new Promise<void>((_resolve, reject) => {
        incoming.abortSignal!.addEventListener("abort", () => {
          adapterAborted = true;
          reject(incoming.abortSignal!.reason);
        }, { once: true });
      }),
    }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const response = fetch(`${endpoint}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      stream: true,
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "wait until interrupted" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      }],
    }),
  });

  try {
    const deadline = Date.now() + 1_000;
    let activeHttpTurns = 0;
    while (Date.now() < deadline && activeHttpTurns !== 1) {
      activeHttpTurns = (await (await fetch(`${endpoint}/healthz`)).json() as { active_http_turns: number }).active_http_turns;
      if (activeHttpTurns !== 1) await Bun.sleep(5);
    }
    expect(activeHttpTurns).toBe(1);

    const interrupted = await fetch(`${endpoint}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ threadId, turnId }),
    });
    expect(interrupted.status).toBe(200);
    expect(await interrupted.json()).toMatchObject({
      status: "ok",
      cancelled_http_turns: 1,
      cancelled_browser_turns: 1,
    });
    expect(adapterAborted).toBeTrue();
    expect(browserAborted).toBeTrue();
    await response;
  } finally {
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});

test("authenticated Interrupt hook endpoint also releases the exact native compaction request", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const threadId = "thread_interrupt_compact";
  const turnId = "turn_interrupt_compact";
  let adapterAborted = false;
  const server = startServer(config, {
    adapterFactory: () => ({
      name: "interrupt-compact-test",
      runTurn: (_parsed, incoming) => new Promise<void>((_resolve, reject) => {
        incoming.abortSignal!.addEventListener("abort", () => {
          adapterAborted = true;
          reject(incoming.abortSignal!.reason);
        }, { once: true });
      }),
    }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const compactResponse = fetch(`${endpoint}/v1/responses/compact`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "compact me" }] }],
    }),
  });

  try {
    const deadline = Date.now() + 1_000;
    let activeHttpTurns = 0;
    while (Date.now() < deadline && activeHttpTurns !== 1) {
      activeHttpTurns = (await (await fetch(`${endpoint}/healthz`)).json() as { active_http_turns: number }).active_http_turns;
      if (activeHttpTurns !== 1) await Bun.sleep(5);
    }
    expect(activeHttpTurns).toBe(1);

    const interrupted = await fetch(`${endpoint}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ threadId, turnId }),
    });
    expect(interrupted.status).toBe(200);
    expect(await interrupted.json()).toMatchObject({
      status: "ok",
      cancelled_http_turns: 1,
      cancelled_browser_turns: 0,
    });
    expect(adapterAborted).toBeTrue();
    await compactResponse;
  } finally {
    await server.stop(true);
  }
});

test("Interrupt acknowledges after exact browser cancellation starts without waiting for helper teardown", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const threadId = "thread_interrupt_slow_cleanup";
  const turnId = "turn_interrupt_slow_cleanup";
  let resolvePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { resolvePhysical = resolve; });
  let cancelled = false;
  let replacementStarted = false;
  chatGptTurnSessions.clear();
  chatGptTurnSessions.getOrCreate("slow-cleanup", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled = true; },
  }), "slow-cleanup-trace", "slow-cleanup-owner", turnId, threadId);
  const server = startServer(config);

  try {
    const interrupted = await Promise.race([
      fetch(`http://127.0.0.1:${server.port}/admin/interrupt-turn`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.controlToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadId, turnId }),
      }),
      Bun.sleep(250).then(() => undefined),
    ]);
    expect(interrupted).toBeInstanceOf(Response);
    expect(await interrupted!.json()).toMatchObject({
      status: "ok",
      cancelled_browser_turns: 1,
    });
    expect(cancelled).toBeTrue();

    const replacement = chatGptTurnSessions.getOrCreateAfterOwnerRetirement(
      "slow-cleanup-replacement",
      "slow-cleanup-owner",
      () => {
        replacementStarted = true;
        return {
          mode: "read-only",
          browser: Promise.resolve("replacement"),
          physicalSettlement: Promise.resolve(),
          trace: new ChatGptTraceFeed(),
          text: new ChatGptTextFeed(),
          cancel: () => {},
        };
      },
    );
    await Bun.sleep(10);
    expect(replacementStarted).toBeFalse();
    resolvePhysical();
    await replacement;
    expect(replacementStarted).toBeTrue();
  } finally {
    resolvePhysical();
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});

test("Interrupt retires a logically complete browser turn whose helper is still physically stuck", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const threadId = "thread_interrupt_logical_complete";
  const turnId = "turn_interrupt_logical_complete";
  let resolvePhysical!: () => void;
  const physicalSettlement = new Promise<void>(resolve => { resolvePhysical = resolve; });
  let cancelled = false;
  chatGptTurnSessions.clear();
  const session = chatGptTurnSessions.getOrCreate("logical-complete", () => ({
    mode: "read-only",
    browser: Promise.resolve("complete"),
    physicalSettlement,
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled = true; },
  }), "logical-complete-trace", "logical-complete-owner", turnId, threadId);
  await session.browserOutcome;
  expect(session.isActive()).toBeFalse();
  expect(session.isPhysicallySettled()).toBeFalse();
  const server = startServer(config);

  try {
    const interrupted = await fetch(`http://127.0.0.1:${server.port}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ threadId, turnId }),
    });
    expect(await interrupted.json()).toMatchObject({
      status: "ok",
      cancelled_browser_turns: 1,
    });
    expect(cancelled).toBeTrue();
    expect(chatGptTurnSessions.find("logical-complete")).toBeUndefined();
  } finally {
    resolvePhysical();
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});

test("Interrupt cancels a detached structured compaction by exact native turn identity", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const threadId = "thread_interrupt_structured";
  const turnId = "turn_interrupt_structured";
  let aborted = false;
  const run = runStructuredCompactionOnce(
    `interrupt-structured-${Date.now()}-${Math.random()}`,
    {
      ownerKey: "interrupt-structured-owner",
      traceIds: ["interrupt-structured-trace"],
      nativeThreadId: threadId,
      nativeTurnId: turnId,
    },
    signal => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  );
  const server = startServer(config);

  try {
    await Bun.sleep(0);
    const interrupted = await fetch(`http://127.0.0.1:${server.port}/admin/interrupt-turn`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.controlToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ threadId, turnId }),
    });
    expect(await interrupted.json()).toMatchObject({
      status: "ok",
      cancelled_compaction_runs: 1,
    });
    await expect(run).rejects.toThrow("Codex turn interrupted");
    expect(aborted).toBeTrue();
  } finally {
    await server.stop(true);
  }
});

test("authenticated lifecycle control cancels orphaned browser turns", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  let cancelled = 0;
  chatGptTurnSessions.clear();
  chatGptTurnSessions.getOrCreate("orphan", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { cancelled += 1; },
  }));

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turns`, {
      method: "POST",
      headers: { authorization: "Bearer invalid" },
    });
    expect(unauthorized.status).toBe(401);
    expect(chatGptTurnSessions.activeCount()).toBe(1);

    const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      cancelled_http_turns: 0,
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

test("authenticated targeted cancellation terminates one browser trace without reopening it", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  chatGptTurnSessions.clear();
  let rejectTarget!: (error: Error) => void;
  let targetCancelled = 0;
  let otherCancelled = 0;
  const targetBrowser = new Promise<string>((_resolve, reject) => { rejectTarget = reject; });
  const target = chatGptTurnSessions.getOrCreate("target-key", () => ({
    mode: "read-only",
    browser: targetBrowser,
    physicalSettlement: targetBrowser.then(() => undefined, () => undefined),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => {
      targetCancelled += 1;
      rejectTarget(new Error("tab closed"));
    },
  }), "trace_target");
  chatGptTurnSessions.getOrCreate("other-key", () => ({
    mode: "read-only",
    browser: new Promise<string>(() => {}),
    physicalSettlement: Promise.resolve(),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: () => { otherCancelled += 1; },
  }), "trace_other");

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turn`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer invalid" },
      body: JSON.stringify({ traceId: "trace_target" }),
    });
    expect(unauthorized.status).toBe(401);

    const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.controlToken}`,
      },
      body: JSON.stringify({ traceId: "trace_target" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      trace_id: "trace_target",
      cancelled_browser_turns: 1,
      cancelled_broker_turns: 0,
      active_browser_turns: 1,
    });
    expect(targetCancelled).toBe(1);
    expect(otherCancelled).toBe(0);
    expect(target.settledOutcome()).toMatchObject({ type: "error" });
    expect(chatGptTurnSessions.getOrCreate("target-key", () => {
      throw new Error("cancelled trace must remain terminal");
    }, "trace_target")).toBe(target);
  } finally {
    chatGptTurnSessions.clear();
    await server.stop(true);
  }
});

test("authenticated targeted cancellation aborts a shared structured compaction owner", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const handoffTraceId = "a1b2c3d4e5f6";
  const traceId = `${handoffTraceId}_fallback`;
  let aborted = false;
  const run = runStructuredCompactionOnce(
    `structured-${Date.now()}-${Math.random()}`,
    { ownerKey: `owner-${traceId}`, traceIds: [handoffTraceId, traceId] },
    signal => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  );

  try {
    await Bun.sleep(0);
    const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.controlToken}`,
      },
      body: JSON.stringify({ traceId }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      trace_id: traceId,
      cancelled_compaction_runs: 1,
    });
    await expect(run).rejects.toThrow("The ChatGPT browser tab was closed");
    expect(aborted).toBeTrue();
  } finally {
    await server.stop(true);
  }
});

test("authenticated cancel-all aborts fresh structured compaction work", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const server = startServer(config);
  const key = `structured-all-${Date.now()}-${Math.random()}`;
  let aborted = false;
  const run = runStructuredCompactionOnce(
    key,
    { ownerKey: `owner-${key}`, traceIds: [`trace-${key}`] },
    signal => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
  );

  try {
    await Bun.sleep(0);
    const response = await fetch(`http://127.0.0.1:${server.port}/admin/cancel-turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      cancelled_compaction_runs: 1,
    });
    await expect(run).rejects.toThrow("Active turn cancelled by launcher");
    expect(aborted).toBeTrue();
  } finally {
    await server.stop(true);
  }
});

test("a Codex retry after tab cancellation receives terminal HTTP 400 without a new browser", async () => {
  const config = defaultConfig("browser-only");
  const turnId = "turn_cancelled_replay";
  const body = {
    model: "chatgpt-web/high",
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_cancelled_replay",
        turn_id: turnId,
      }),
    },
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Run until the browser tab is closed" }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    }],
  };
  const parsed = parseRequest(body);
  routeChatGptWebRequest(parsed, config);
  const traceId = chatGptWebTraceId(providerConfig(config), parsed);
  let rejectBrowser!: (error: Error) => void;
  chatGptTurnSessions.clear();
  const cancelledBrowser = new Promise<string>((_resolve, reject) => { rejectBrowser = reject; });
  chatGptTurnSessions.getOrCreate("cancelled-replay", () => ({
    mode: "read-only",
    browser: cancelledBrowser,
    physicalSettlement: cancelledBrowser.then(() => undefined, () => undefined),
    trace: new ChatGptTraceFeed(),
    text: new ChatGptTextFeed(),
    cancel: reason => rejectBrowser(reason ?? new Error("cancelled")),
  }), traceId);

  try {
    expect(await chatGptTurnSessions.cancelTrace(traceId)).toBe(1);
    expect(chatGptTurnSessions.cancelledError(traceId)?.message).toContain("Codex turn was cancelled");
    let adapterConstructions = 0;
    const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), config, () => {
      adapterConstructions += 1;
      throw new Error("cancelled turn must not construct a new browser adapter");
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        type: "client_closed_request",
        code: "client_cancelled",
        message: "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
      },
    });
    expect(adapterConstructions).toBe(0);
  } finally {
    chatGptTurnSessions.clear();
  }
});

test("a restart recovery turn without a new user instruction fails terminally instead of replaying the stopped prompt", async () => {
  const config = defaultConfig("browser-only");
  const previousTurnId = "turn_before_codex_restart";
  const recoveryTurnId = "turn_after_codex_restart";
  const body = {
    model: "chatgpt-web/high",
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: "thread_codex_restart",
        turn_id: recoveryTurnId,
      }),
    },
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Run the original task" }],
        internal_chat_message_metadata_passthrough: { turn_id: previousTurnId },
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<skills_instructions>fresh skills</skills_instructions>" }],
        internal_chat_message_metadata_passthrough: { turn_id: recoveryTurnId },
      },
    ],
  };
  let adapterConstructions = 0;

  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), config, () => {
    adapterConstructions += 1;
    throw new Error("a context-only recovery turn must not construct a browser adapter");
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      code: "invalid_request_error",
      type: "invalid_request_error",
      message: "ChatGPT web current user message conflicts with native Codex turn_id metadata",
    },
  });
  expect(adapterConstructions).toBe(0);
});

test.each(["alpha/search", "images/generations"])("authenticated lifecycle control aborts active %s before acknowledging cancellation", async path => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  let upstreamAbortObserved = false;
  const server = startServer(config, {
    fetchUpstream: request => new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => {
        upstreamAbortObserved = true;
        reject(request.signal.reason);
      }, { once: true });
    }),
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const activeRequest = fetch(`${endpoint}/v1/${path}`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-codex-session",
      "content-type": "application/json",
    },
    body: JSON.stringify(path === "alpha/search"
      ? { query: "retained turn" }
      : { model: "gpt-image-1", prompt: "A blue square" }),
  }).catch(() => null);

  try {
    const deadline = Date.now() + 1_000;
    let activeHttpTurns = 0;
    while (Date.now() < deadline && activeHttpTurns !== 1) {
      const health = await (await fetch(`${endpoint}/healthz`)).json() as { active_http_turns: number };
      activeHttpTurns = health.active_http_turns;
      if (activeHttpTurns !== 1) await Bun.sleep(5);
    }
    expect(activeHttpTurns).toBe(1);

    const cancelled = await fetch(`${endpoint}/admin/cancel-turns`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.controlToken}` },
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      status: "ok",
      cancelled_http_turns: 1,
      active_http_turns: 0,
      active_browser_turns: 0,
    });
    expect(upstreamAbortObserved).toBe(true);
    await activeRequest;
  } finally {
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

test("lifecycle drain and cancellation include browser turns owned by the external DEV driver", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-dev-lifecycle-"));
  const config = { ...defaultConfig("full"), port: 0, brokerSocketPath: defaultBrokerEndpoint(root) };
  await TurnBroker.forSocket(config.brokerSocketPath).listen();
  const server = startServer(config);
  const endpoint = `http://127.0.0.1:${server.port}`;
  const authorization = { authorization: `Bearer ${config.controlToken}` };
  const remote = new RemoteTurnBroker(config.brokerSocketPath);
  try {
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [],
    };
    const token = await remote.register(environment, 60_000, "dev-lifecycle");
    const waiting = remote.nextToolBatch(token).then(
      () => "resolved",
      error => error instanceof Error ? error.message : String(error),
    );

    const drain = await fetch(`${endpoint}/admin/drain`, { method: "POST", headers: authorization });
    expect(await drain.json()).toMatchObject({ active_browser_turns: 1, accepting_turns: false });
    await expect(remote.register(environment, 60_000, "dev-after-drain")).rejects.toThrow("draining");

    const cancel = await fetch(`${endpoint}/admin/cancel-turns`, { method: "POST", headers: authorization });
    expect(await cancel.json()).toMatchObject({
      cancelled_http_turns: 0,
      cancelled_browser_turns: 1,
      active_browser_turns: 0,
    });
    expect(await waiting).toContain("revoked");
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

test("standalone native image generation and edits preserve their upstream protocol", async () => {
  const config = { ...defaultConfig("browser-only"), port: 0 };
  const requests: Request[] = [];
  const reply = '{ "created": 1778832973, "data": [{ "b64_json": "native-image-bytes" }] }';
  const denied = '{ "error": { "code": "rate_limit_exceeded", "message": "Image allowance reached" } }';
  const upstreamServer = Bun.serve({
    port: 0,
    fetch: request => {
      const edit = new URL(request.url).pathname.endsWith("/edits");
      return new Response(Bun.gzipSync(edit ? denied : reply), {
        status: edit ? 429 : 200,
        headers: {
          "content-type": "application/json", "content-encoding": "gzip",
          "x-codex-imagegen-request-id": "native-image-request",
        },
      });
    },
  });
  const server = startServer(config, {
    fetchUpstream: async request => {
      requests.push(request);
      const path = new URL(request.url).pathname;
      return fetch(new Request(`http://127.0.0.1:${upstreamServer.port}${path}`, request.clone()));
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    for (const operation of ["generations", "edits"] as const) {
      const body = operation === "generations"
        ? '{ "model": "gpt-image-1", "prompt": "A blue square", "n": 1 }'
        : '{ "model": "gpt-image-1", "prompt": "Make it green", "images": [{ "image_url": "data:image/png;base64,AAAA" }] }';
      const response = await fetch(`${endpoint}/v1/images/${operation}?fixture=1`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-codex-session",
          "content-type": "application/json",
          "chatgpt-account-id": "test-account",
          "x-codex-image-turn-id": "native-image-turn",
        },
        body,
      });
      expect(response.status).toBe(operation === "generations" ? 200 : 429);
      expect(await response.text()).toBe(operation === "generations" ? reply : denied);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("x-codex-imagegen-request-id")).toBe("native-image-request");
      const upstream = requests.at(-1)!;
      expect(upstream.url).toBe(`https://chatgpt.com/backend-api/codex/images/${operation}?fixture=1`);
      expect(upstream.method).toBe("POST");
      expect(upstream.redirect).toBe("manual");
      expect(upstream.headers.get("authorization")).toBe("Bearer test-codex-session");
      expect(upstream.headers.get("chatgpt-account-id")).toBe("test-account");
      expect(upstream.headers.get("x-codex-image-turn-id")).toBe("native-image-turn");
      expect(upstream.headers.get("host")).toBeNull();
      expect(await upstream.text()).toBe(body);
    }
    expect(requests).toHaveLength(2);
    const unauthorized = await fetch(`${endpoint}/v1/images/generations`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);
    expect(requests).toHaveLength(2);
    await fetch(`${endpoint}/admin/drain`, {
      method: "POST", headers: { authorization: `Bearer ${config.controlToken}` },
    });
    const drained = await fetch(`${endpoint}/v1/images/edits`, {
      method: "POST", headers: { authorization: "Bearer test-codex-session" }, body: "{}",
    });
    expect(drained.status).toBe(503);
    expect(requests).toHaveLength(2);
  } finally {
    await server.stop(true);
    await upstreamServer.stop(true);
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
