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

test("Native V2 removes encryption from collaboration message schemas", async () => {
  const body = {
    model: "gpt-5.6-sol",
    stream: true,
    tools: [{
      type: "namespace",
      name: "collaboration",
      description: "Subagent tools",
      tools: [
        {
          type: "function",
          name: "spawn_agent",
          parameters: {
            type: "object",
            properties: {
              task_name: { type: "string" },
              message: { type: "string", encrypted: true },
            },
          },
        },
        {
          type: "function",
          name: "send_message",
          parameters: {
            type: "object",
            properties: { message: { type: "string", encrypted: true } },
          },
        },
        {
          type: "function",
          name: "followup_task",
          parameters: {
            type: "object",
            properties: { message: { type: "string", encrypted: true } },
          },
        },
        {
          type: "function",
          name: "wait_agent",
          parameters: {
            type: "object",
            properties: { timeout_ms: { type: "integer", encrypted: true } },
          },
        },
      ],
    }],
  };
  const compressedBody = Uint8Array.from(
    Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify(body))),
  );
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
    body: compressedBody,
  });
  let upstreamRequest: Request | undefined;

  await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  }, body, { plaintextMultiAgentV2Messages: true });

  expect(upstreamRequest!.headers.get("content-encoding")).toBeNull();
  const forwarded = await upstreamRequest!.json() as {
    tools: Array<{ tools: Array<{ name: string; parameters: { properties: Record<string, Record<string, unknown>> } }> }>;
  };
  const tools = forwarded.tools[0]!.tools;
  for (const name of ["spawn_agent", "send_message", "followup_task"]) {
    expect(tools.find(tool => tool.name === name)!.parameters.properties.message)
      .not.toHaveProperty("encrypted");
  }
  expect(tools.find(tool => tool.name === "wait_agent")!.parameters.properties.timeout_ms)
    .toHaveProperty("encrypted", true);
});

test("Native V2 marks plaintext collaboration calls for Codex delivery", async () => {
  const body = {
    model: "gpt-5.6-sol",
    stream: true,
    tools: [{
      type: "namespace",
      name: "collaboration",
      tools: [{
        type: "function",
        name: "spawn_agent",
        parameters: {
          type: "object",
          properties: { message: { type: "string", encrypted: true } },
        },
      }],
    }],
  };
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const event = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "spawn_agent",
      namespace: "collaboration",
      call_id: "call_plaintext_spawn",
      arguments: JSON.stringify({ task_name: "inspect", message: "Inspect the repository" }),
    },
  };

  const response = await forwardNativeCodexRequest(request, "responses", async () => new Response(
    `event: response.output_item.done\ndata: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  ), body, { plaintextMultiAgentV2Messages: true });

  const data = (await response.text())
    .split("\n")
    .find(line => line.startsWith("data: {") && line.includes("function_call"));
  expect(JSON.parse(data!.slice(6))).toMatchObject({
    item: {
      type: "function_call",
      name: "spawn_agent",
      namespace: "collaboration",
      encrypted_function_args: [],
    },
  });
});

test("Native V2 preserves encrypted and unrelated collaboration calls", async () => {
  const body = {
    model: "gpt-5.6-sol",
    stream: true,
    tools: [{
      type: "namespace",
      name: "collaboration",
      tools: [{
        type: "function",
        name: "spawn_agent",
        parameters: {
          type: "object",
          properties: { message: { type: "string", encrypted: true } },
        },
      }],
    }],
  };
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const encryptedCall = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "spawn_agent",
      namespace: "collaboration",
      call_id: "call_encrypted_spawn",
      arguments: "opaque",
      encrypted_function_args: ["ciphertext"],
    },
  };
  const unrelatedCall = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "wait_agent",
      namespace: "collaboration",
      call_id: "call_wait",
      arguments: JSON.stringify({ timeout_ms: 500 }),
    },
  };

  const response = await forwardNativeCodexRequest(request, "responses", async () => new Response(
    `data: ${JSON.stringify(encryptedCall)}\n\ndata: ${JSON.stringify(unrelatedCall)}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  ), body, { plaintextMultiAgentV2Messages: true });

  const events = (await response.text())
    .split("\n")
    .filter(line => line.startsWith("data: {") && line.includes("function_call"))
    .map(line => JSON.parse(line.slice(6)) as { item: Record<string, unknown> });
  expect(events[0]!.item.encrypted_function_args).toEqual(["ciphertext"]);
  expect(events[1]!.item).not.toHaveProperty("encrypted_function_args");
});

test("Native V2 rewrites Responses Lite additional collaboration tools", async () => {
  const body = {
    model: "gpt-5.6-sol",
    stream: true,
    input: [{
      type: "additional_tools",
      role: "developer",
      tools: [{
        type: "namespace",
        name: "collaboration",
        tools: [{
          type: "function",
          name: "followup_task",
          parameters: {
            type: "object",
            properties: { message: { type: "string", encrypted: true } },
          },
        }],
      }],
    }],
  };
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let upstreamRequest: Request | undefined;

  await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response("data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  }, body, { plaintextMultiAgentV2Messages: true });

  const forwarded = await upstreamRequest!.json() as {
    input: Array<{ tools: Array<{ tools: Array<{ parameters: { properties: { message: Record<string, unknown> } } }> }> }>;
  };
  expect(forwarded.input[0]!.tools[0]!.tools[0]!.parameters.properties.message)
    .not.toHaveProperty("encrypted");
});

test("Native V2 recognizes a configured collaboration namespace by its tool set", async () => {
  const messageTool = (name: string) => ({
    type: "function",
    name,
    parameters: {
      type: "object",
      properties: { message: { type: "string", encrypted: true } },
    },
  });
  const body = {
    model: "gpt-5.6-sol",
    stream: true,
    tools: [{
      type: "namespace",
      name: "agents",
      tools: [
        messageTool("spawn_agent"),
        messageTool("send_message"),
        messageTool("followup_task"),
      ],
    }],
  };
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let upstreamRequest: Request | undefined;
  const event = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "spawn_agent",
      namespace: "agents",
      call_id: "call_custom_namespace",
      arguments: JSON.stringify({ task_name: "inspect", message: "Inspect the repository" }),
    },
  };

  const response = await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response(
      `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }, body, { plaintextMultiAgentV2Messages: true });

  const forwarded = await upstreamRequest!.json() as {
    tools: Array<{ tools: Array<{ parameters: { properties: { message: Record<string, unknown> } } }> }>;
  };
  expect(forwarded.tools[0]!.tools.every(tool => !("encrypted" in tool.parameters.properties.message)))
    .toBe(true);
  const callData = (await response.text()).split("\n").find(line => line.includes("function_call"));
  expect(JSON.parse(callData!.slice(6)).item.encrypted_function_args).toEqual([]);
});

test("Native V2 recognizes an unnamespaced collaboration surface", async () => {
  const messageTool = (name: string) => ({
    type: "function",
    name,
    parameters: {
      type: "object",
      properties: { message: { type: "string", encrypted: true } },
    },
  });
  const body = {
    model: "gpt-5.6-sol",
    stream: true,
    tools: [
      messageTool("spawn_agent"),
      messageTool("send_message"),
      messageTool("followup_task"),
    ],
  };
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let upstreamRequest: Request | undefined;
  const event = {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      name: "followup_task",
      call_id: "call_unnamespaced",
      arguments: JSON.stringify({ target: "/root/inspect", message: "Continue" }),
    },
  };

  const response = await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response(
      `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }, body, { plaintextMultiAgentV2Messages: true });

  const forwarded = await upstreamRequest!.json() as {
    tools: Array<{ parameters: { properties: { message: Record<string, unknown> } } }>;
  };
  expect(forwarded.tools.every(tool => !("encrypted" in tool.parameters.properties.message)))
    .toBe(true);
  const callData = (await response.text()).split("\n").find(line => line.includes("function_call"));
  expect(JSON.parse(callData!.slice(6)).item.encrypted_function_args).toEqual([]);
});

test("Native V2 marks plaintext collaboration calls in JSON responses", async () => {
  const body = {
    model: "gpt-5.6-sol",
    stream: false,
    tools: [{
      type: "namespace",
      name: "collaboration",
      tools: [{
        type: "function",
        name: "send_message",
        parameters: {
          type: "object",
          properties: { message: { type: "string", encrypted: true } },
        },
      }],
    }],
  };
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const response = await forwardNativeCodexRequest(request, "responses", async () => Response.json({
    id: "resp_native_v2_json",
    output: [{
      type: "function_call",
      name: "send_message",
      namespace: "collaboration",
      call_id: "call_json_message",
      arguments: JSON.stringify({ target: "/root/inspect", message: "Status?" }),
    }],
  }), body, { plaintextMultiAgentV2Messages: true });

  expect(await response.json()).toMatchObject({
    output: [{ encrypted_function_args: [] }],
  });
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
  const forwarded = await upstreamRequest!.json() as {
    previous_response_id?: string;
    input: Array<Record<string, unknown>>;
  };
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

test("converts ChatGPT Web compaction checkpoints before switching back to native Codex", async () => {
  const summary = "Keep the verified repository state and continue from the failing test.";
  const body = {
    model: "gpt-5.6-sol",
    previous_response_id: "resp_local_web_compaction",
    input: [
      {
        type: "compaction",
        id: "cmp_11111111111111111111111111111111",
        encrypted_content: `ocx1:${Buffer.from(summary, "utf8").toString("base64")}`,
      },
      {
        type: "compaction",
        id: "cmp_22222222222222222222222222222222",
        encrypted_content: "gAAAAABnative-opaque-compaction",
      },
      {
        type: "message",
        id: "msg_33333333333333333333333333333333",
        role: "user",
        content: [{ type: "input_text", text: "Continue with native Sol." }],
      },
    ],
  };
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "responses", async input => {
    upstreamRequest = input;
    return new Response("data: native\n\n", { headers: { "content-type": "text/event-stream" } });
  }, body);

  const forwarded = await upstreamRequest!.json() as {
    previous_response_id?: string;
    input: Array<Record<string, unknown>>;
  };
  expect(forwarded).not.toHaveProperty("previous_response_id");
  expect(forwarded.input.every(item => !("id" in item))).toBe(true);
  expect(forwarded.input[0]).toMatchObject({
    type: "message",
    role: "user",
    content: [{
      type: "input_text",
      text: expect.stringContaining(summary),
    }],
  });
  expect(forwarded.input[1]).toEqual({
    type: "compaction",
    encrypted_content: "gAAAAABnative-opaque-compaction",
  });
  expect(JSON.stringify(forwarded)).not.toContain("ocx1:");
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

test("repairs a missing models client_version from an exact first-party Codex user agent", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models", {
    headers: {
      authorization: "Bearer codex-oauth-token",
      "user-agent": "codex_chatgpt_desktop/0.151.0-alpha.7.2 (Mac OS 15.6; arm64) Codex",
    },
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "models", async input => {
    upstreamRequest = input;
    return Response.json({ models: [] });
  });
  expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.151.0");
});

test("does not invent a models client version from an unrelated user agent", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models", {
    headers: {
      authorization: "Bearer codex-oauth-token",
      "user-agent": "Mozilla/5.0 Codex/999.999.999",
    },
  });
  let upstreamRequest: Request | undefined;
  await forwardNativeCodexRequest(request, "models", async input => {
    upstreamRequest = input;
    return Response.json({ models: [] });
  });
  expect(upstreamRequest!.url).toBe("https://chatgpt.com/backend-api/codex/models");
});

/** A reset after `data: [DONE]` is a completed stream, while a reset before it is a truncation. */
function nativeRequest(): Request {
  return new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { authorization: "Bearer codex-oauth-token", "content-type": "application/json" },
    body: '{"model":"gpt-5.6-sol","stream":true}',
  });
}

function resettingEventStream(
  prefix: string[],
  contentType = "text/event-stream",
): Response {
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
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
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

  const body = await response.text();
  expect(body).toContain("response.completed");
  expect(body).toEndWith("data: [DONE]\n\n");
});

test("event-stream media type matching is case-insensitive", async () => {
  const response = await forwardNativeCodexRequest(
    nativeRequest(),
    "responses",
    async () => resettingEventStream(
      ["data: [DONE]\n\n"],
      "Text/Event-Stream; Charset=UTF-8",
    ),
  );

  expect(await response.text()).toBe("data: [DONE]\n\n");
});

test("an upstream reset is not hidden by a [DONE] string inside JSON content", async () => {
  const response = await forwardNativeCodexRequest(
    nativeRequest(),
    "responses",
    async () => resettingEventStream([
      'event: response.output_text.delta\ndata: {"delta":"literal data: [DONE] text"}\n\n',
    ]),
  );

  // The marker is part of the JSON string, not an SSE data line. The upstream reset therefore
  // truncated the turn and must remain visible to the native client.
  await expect(response.text()).rejects.toThrow();
});

test("an upstream reset that truncated the turn is still surfaced as a failure", async () => {
  const response = await forwardNativeCodexRequest(
    nativeRequest(),
    "responses",
    async () => resettingEventStream(['event: response.output_text.delta\ndata: {"delta":"half"}\n\n']),
  );

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
