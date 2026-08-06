import { expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function* completedEvents(chunks = 1): AsyncGenerator<AdapterEvent> {
  for (let index = 0; index < chunks; index++) {
    yield { type: "text_delta", text: `chunk-${index}:` + "x".repeat(2_048) };
  }
  yield { type: "done", endTurn: true };
}

async function* toolUseEvents(): AsyncGenerator<AdapterEvent> {
  yield { type: "tool_call_start", id: "call_1", name: "exec_command" };
  yield { type: "tool_call_delta", arguments: '{"cmd":"pwd"}' };
  yield { type: "tool_call_end" };
  yield { type: "done", stopReason: "tool_use", endTurn: false };
}

async function* pendingEvents(): AsyncGenerator<AdapterEvent> {
  yield { type: "text_delta", text: "still working" };
  await new Promise<void>(() => {});
}

function rejectingOnReturnEvents(): {
  events: AsyncIterable<AdapterEvent>;
  nextStarted: Promise<void>;
  returnCalls: () => number;
} {
  let resolveNextStarted!: () => void;
  let rejectNext: ((reason?: unknown) => void) | undefined;
  let returns = 0;
  const nextStarted = new Promise<void>(resolve => { resolveNextStarted = resolve; });
  const events: AsyncIterable<AdapterEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          resolveNextStarted();
          return new Promise<IteratorResult<AdapterEvent>>((_, reject) => { rejectNext = reject; });
        },
        return() {
          returns += 1;
          rejectNext?.(new Error("iterator closed"));
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  return { events, nextStarted, returnCalls: () => returns };
}

const streamPlatforms = ["win32", "darwin"] as const;

function responseStream(platform: NodeJS.Platform, chunks = 1): ReadableStream<Uint8Array> {
  return bridgeToResponsesSSE(
    completedEvents(chunks),
    "chatgpt-web/test",
    undefined,
    undefined,
    undefined,
    undefined,
    2_000,
    { streamPlatform: platform },
  );
}

test("Responses SSE completes through the Windows push stream", async () => {
  const body = await new Response(responseStream("win32")).text();

  expect(body).toContain("event: response.completed");
  expect(body).toEndWith("data: [DONE]\n\n");
});

test("Responses SSE completes through the Darwin pull stream", async () => {
  const body = await new Response(responseStream("darwin")).text();

  expect(body).toContain("event: response.completed");
  expect(body).toEndWith("data: [DONE]\n\n");
});

for (const platform of streamPlatforms) {
  test(`a successful tool-use response does not cancel the shared upstream turn on ${platform}`, async () => {
    let cancellations = 0;
    const stream = bridgeToResponsesSSE(
      toolUseEvents(),
      "chatgpt-web/test",
      undefined,
      undefined,
      undefined,
      () => { cancellations += 1; },
      2_000,
      { streamPlatform: platform },
    );

    const body = await new Response(stream).text();

    expect(body).toContain("event: response.completed");
    expect(body).toContain('"status":"completed"');
    expect(body).toEndWith("data: [DONE]\n\n");
    expect(cancellations).toBe(0);
  });

  test(`consumer teardown after a terminal response does not cancel the shared upstream turn on ${platform}`, async () => {
    let cancellations = 0;
    const reader = bridgeToResponsesSSE(
      toolUseEvents(),
      "chatgpt-web/test",
      undefined,
      undefined,
      undefined,
      () => { cancellations += 1; },
      2_000,
      { streamPlatform: platform },
    ).getReader();
    const decoder = new TextDecoder();
    let body = "";

    while (!body.includes("event: response.completed")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel("terminal response received");

    expect(body).toContain("event: response.completed");
    expect(cancellations).toBe(0);
  });

  test(`consumer cancellation before a terminal response still cancels upstream once on ${platform}`, async () => {
    let cancellations = 0;
    const reader = bridgeToResponsesSSE(
      pendingEvents(),
      "chatgpt-web/test",
      undefined,
      undefined,
      undefined,
      () => { cancellations += 1; },
      2_000,
      { streamPlatform: platform },
    ).getReader();

    await reader.read();
    await reader.cancel("client disconnected");

    expect(cancellations).toBe(1);
  });

  test(`reentrant terminal teardown does not cancel the shared upstream turn on ${platform}`, async () => {
    let cancellations = 0;
    let resolveTerminal!: () => void;
    const terminalObserved = new Promise<void>(resolve => { resolveTerminal = resolve; });
    let reader!: ReadableStreamDefaultReader<Uint8Array>;
    const stream = bridgeToResponsesSSE(
      toolUseEvents(),
      "chatgpt-web/test",
      undefined,
      undefined,
      undefined,
      () => { cancellations += 1; },
      2_000,
      {
        streamPlatform: platform,
        onTerminal() {
          void reader.cancel("terminal observed");
          resolveTerminal();
        },
      },
    );
    reader = stream.getReader();
    const drain = (async () => {
      try {
        while (!(await reader.read()).done) { /* drain until the callback cancels */ }
      } catch {
        /* cancellation can reject an in-flight read on some runtimes */
      }
    })();

    await terminalObserved;
    await drain;

    expect(cancellations).toBe(0);
  });

  test(`cancellation remains one-shot when iterator shutdown rejects pending next on ${platform}`, async () => {
    let cancellations = 0;
    const controlled = rejectingOnReturnEvents();
    const reader = bridgeToResponsesSSE(
      controlled.events,
      "chatgpt-web/test",
      undefined,
      undefined,
      undefined,
      () => { cancellations += 1; },
      2_000,
      { streamPlatform: platform },
    ).getReader();

    await reader.read();
    const pendingRead = reader.read();
    await controlled.nextStarted;
    await reader.cancel("client disconnected");
    await pendingRead.catch(() => undefined);
    await Promise.resolve();

    expect(cancellations).toBe(1);
    expect(controlled.returnCalls()).toBe(1);
  });
}

test("initial transport failure cancels upstream without starting a heartbeat", async () => {
  const readableStreamDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ReadableStream");
  const setIntervalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setInterval");
  let cancellations = 0;
  let intervals = 0;
  let returns = 0;
  const trackedEvents: AsyncIterable<AdapterEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: false as const, value: { type: "text_delta" as const, text: "never delivered" } };
        },
        async return() {
          returns += 1;
          return { done: true as const, value: undefined };
        },
      };
    },
  };

  class ThrowingReadableStream {
    constructor(source: UnderlyingSource<Uint8Array>) {
      source.start?.({
        desiredSize: 1,
        enqueue() { throw new Error("transport closed"); },
        close() {},
        error() {},
      } as unknown as ReadableStreamDefaultController<Uint8Array>);
    }
  }

  Object.defineProperty(globalThis, "ReadableStream", {
    configurable: true,
    writable: true,
    value: ThrowingReadableStream,
  });
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    writable: true,
    value: () => { intervals += 1; return 0; },
  });

  try {
    bridgeToResponsesSSE(
      trackedEvents,
      "chatgpt-web/test",
      undefined,
      undefined,
      undefined,
      () => { cancellations += 1; },
      2_000,
      { streamPlatform: "win32" },
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(cancellations).toBe(1);
    expect(returns).toBe(1);
    expect(intervals).toBe(0);
  } finally {
    if (readableStreamDescriptor) Object.defineProperty(globalThis, "ReadableStream", readableStreamDescriptor);
    if (setIntervalDescriptor) Object.defineProperty(globalThis, "setInterval", setIntervalDescriptor);
  }
});

test("Darwin SSE remains decodable through Bun.serve under sustained chunking", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(responseStream("darwin", 64), {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(body).toContain("chunk-63:");
    expect(body).toContain("event: response.completed");
    expect(body).toEndWith("data: [DONE]\n\n");
  } finally {
    await server.stop(true);
  }
});
