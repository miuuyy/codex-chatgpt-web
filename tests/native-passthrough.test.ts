import { expect, test } from "bun:test";
import { forwardNativeCodexRequest } from "../src/native-passthrough";

test("forwards native Codex requests verbatim to the official backend", async () => {
  const originalBody = Bun.zstdCompressSync(Buffer.from('{"model":"gpt-5.6-sol","stream":true}'));
  const encoded = new ArrayBuffer(originalBody.byteLength);
  new Uint8Array(encoded).set(originalBody);
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
      host: "127.0.0.1:17841",
      connection: "keep-alive",
    },
    body: encoded,
  });
  let upstreamUrl = "";
  let upstreamRequest: Request | undefined;
  const response = await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamUrl = input.url;
    upstreamRequest = input;
    return new Response("data: native\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream", connection: "keep-alive" },
    });
  });

  expect(upstreamUrl).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(upstreamRequest).toBeDefined();
  expect(upstreamRequest!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  expect(upstreamRequest!.headers.get("host")).toBeNull();
  expect(upstreamRequest!.headers.get("connection")).toBeNull();
  expect(Buffer.from(await upstreamRequest!.arrayBuffer())).toEqual(Buffer.from(originalBody));
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("connection")).toBeNull();
  expect(await response.text()).toBe("data: native\n\n");
});

test("forwards native Codex compaction requests to the official compact endpoint", async () => {
  const originalBody = Bun.zstdCompressSync(Buffer.from('{"model":"gpt-5.6-sol","input":[]}'));
  const encoded = new ArrayBuffer(originalBody.byteLength);
  new Uint8Array(encoded).set(originalBody);
  const request = new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
    body: encoded,
  });
  let upstreamUrl = "";
  let upstreamRequest: Request | undefined;
  const response = await forwardNativeCodexRequest(request, "responses/compact", async input => {
    upstreamUrl = input.url;
    upstreamRequest = input;
    return Response.json({ output: [] }, { status: 200 });
  });

  expect(upstreamUrl).toBe("https://chatgpt.com/backend-api/codex/responses/compact");
  expect(upstreamRequest!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  expect(Buffer.from(await upstreamRequest!.arrayBuffer())).toEqual(Buffer.from(originalBody));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ output: [] });
});

test("forwards standalone Web Search through the authenticated native Codex route", async () => {
  const body = JSON.stringify({ query: "Codex Web Search passthrough" });
  const request = new Request("http://127.0.0.1:17841/v1/alpha/search?locale=en", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      host: "127.0.0.1:17841",
    },
    body,
  });
  let upstreamRequest: Request | undefined;
  const response = await forwardNativeCodexRequest(request, "alpha/search", async input => {
    upstreamRequest = input;
    return Response.json({ results: [{ title: "result" }] });
  });

  expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/alpha/search?locale=en");
  expect(upstreamRequest!.method).toBe("POST");
  expect(upstreamRequest!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  expect(upstreamRequest!.headers.get("host")).toBeNull();
  expect(await upstreamRequest!.text()).toBe(body);
  expect(await response.json()).toEqual({ results: [{ title: "result" }] });
});

test("removes ChatGPT Web item identities before native Codex compaction", async () => {
  const body = {
    model: "gpt-5.6-sol",
    store: false,
    previous_response_id: "resp_local_web_turn",
    input: [
      {
        type: "reasoning",
        id: "rs_2e94d82c29b14b14bb34eae3252fa756",
        summary: [{ type: "summary_text", text: "Pro thinking" }],
        content: null,
        encrypted_content: null,
      },
      {
        type: "reasoning",
        id: "rs_11111111111111111111111111111111",
        summary: [{ type: "summary_text", text: "Bridge envelope reasoning" }],
        encrypted_content: "ocxr1:eyJ0eHQiOiJoaWRkZW4ifQ==",
      },
      {
        type: "message",
        id: "msg_22222222222222222222222222222222",
        role: "assistant",
        content: [{ type: "output_text", text: "Visible answer", annotations: [] }],
      },
      {
        type: "function_call",
        id: "fc_33333333333333333333333333333333",
        call_id: "call_keep_linkage",
        name: "exec_command",
        arguments: "{}",
      },
      { type: "compaction_trigger" },
    ],
  };
  const originalBody = Bun.zstdCompressSync(Buffer.from(JSON.stringify(body)));
  const encoded = new ArrayBuffer(originalBody.byteLength);
  new Uint8Array(encoded).set(originalBody);
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
    body: encoded,
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response("data: native\n\n", { headers: { "content-type": "text/event-stream" } });
  }, body);

  expect(upstreamRequest!.headers.get("content-encoding")).toBeNull();
  const forwarded = await upstreamRequest!.json() as typeof body;
  expect(forwarded).not.toHaveProperty("previous_response_id");
  expect(forwarded.input.every(item => !("id" in item))).toBe(true);
  expect(forwarded.input.some(item => "encrypted_content" in item
    && typeof item.encrypted_content === "string"
    && item.encrypted_content.startsWith("ocxr1:"))).toBe(false);
  expect(forwarded.input[0]).toMatchObject({
    type: "reasoning",
    summary: [{ type: "summary_text", text: "Pro thinking" }],
  });
  expect(forwarded.input[2]).toMatchObject({
    type: "message",
    role: "assistant",
  });
  expect(forwarded.input[3]).toMatchObject({
    type: "function_call",
    call_id: "call_keep_linkage",
  });
  expect(forwarded.input.at(-1)).toEqual({ type: "compaction_trigger" });
});

test("keeps native encrypted reasoning requests byte-for-byte intact", async () => {
  const body = JSON.stringify({
    model: "gpt-5.6-sol",
    input: [{
      type: "reasoning",
      id: "rs_44444444444444444444444444444444",
      summary: [],
      encrypted_content: "gAAAAABnative-opaque-reasoning",
    }],
  });
  const originalBody = Bun.zstdCompressSync(Buffer.from(body));
  const encoded = new ArrayBuffer(originalBody.byteLength);
  new Uint8Array(encoded).set(originalBody);
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
    body: encoded,
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response("data: native\n\n", { headers: { "content-type": "text/event-stream" } });
  });

  expect(upstreamRequest!.headers.get("content-encoding")).toBe("zstd");
  expect(Buffer.from(await upstreamRequest!.arrayBuffer())).toEqual(Buffer.from(originalBody));
});

test("native passthrough fails closed without Codex bearer authentication", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  await expect(forwardNativeCodexRequest(request, "responses")).rejects.toThrow(
    "Native Codex passthrough requires the incoming Bearer authorization",
  );
});

test("forwards native model discovery as GET and preserves the client version query", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models?client_version=0.99.0", {
    headers: { authorization: "Bearer codex-oauth-token", "if-none-match": "old-etag" },
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "models", async input => {
    upstreamRequest = input;
    return Response.json({ models: [] });
  });
  expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.99.0");
  expect(upstreamRequest!.method).toBe("GET");
  expect(upstreamRequest!.headers.get("if-none-match")).toBeNull();
});

/**
 * ChatGPT's backend resets the native Codex connection instead of closing it, which Codex reports as
 * "Transport error: network error: error decoding response body". Whether that is recoverable turns
 * entirely on whether the turn had already finished when the socket died.
 */
function nativeRequest(): Request {
  return new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: '{"model":"gpt-5.6-sol","stream":true}',
  });
}

function resettingEventStream(prefix: string[]): Response {
  // A real socket delivers its frames and only then dies, so the chunks must be pulled out before
  // the error lands; erroring in start() would discard them and test nothing.
  const encoder = new TextEncoder();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < prefix.length) {
        controller.enqueue(encoder.encode(prefix[sent]!));
        sent += 1;
        return;
      }
      const reset = new Error("The socket connection was closed unexpectedly");
      (reset as Error & { code?: string }).code = "ECONNRESET";
      controller.error(reset);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("an upstream reset after the turn completed closes the client stream normally", async () => {
  const response = await forwardNativeCodexRequest(
    nativeRequest(),
    "responses",
    async () => resettingEventStream([
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      "data: [DONE]\n\n",
    ]),
  );

  // Every byte the Responses protocol defines was forwarded, so the reset is an unclean TCP close on
  // a finished turn. Failing here is what produced the decode error Codex reported.
  const body = await response.text();
  expect(body).toContain("response.completed");
  expect(body).toEndWith("data: [DONE]\n\n");
});

test("an upstream reset that truncated the turn is still surfaced as a failure", async () => {
  const response = await forwardNativeCodexRequest(
    nativeRequest(),
    "responses",
    async () => resettingEventStream(['event: response.output_text.delta\ndata: {"delta":"half"}\n\n']),
  );

  // Nothing may invent a terminal event here: the turn really was cut short, and telling Codex it
  // ended would silently truncate the answer instead of letting Codex retry.
  await expect(response.text()).rejects.toThrow();
});

test("a non-event-stream body is passed through untouched", async () => {
  const response = await forwardNativeCodexRequest(
    nativeRequest(),
    "responses",
    async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }),
  );

  expect(await response.text()).toBe('{"ok":true}');
});
