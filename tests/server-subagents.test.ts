import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";

test("rejects encrypted cross-backend delegation before constructing the browser adapter", async () => {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  config.proAvailable = false;
  let adapterConstructions = 0;
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: true,
      input: [{
        type: "agent_message",
        author: "parent",
        recipient: "child",
        content: [{ type: "encrypted_content", encrypted_content: "gAAAAABopaque-native-v2-payload" }],
      }],
    }),
  }), config, () => {
    adapterConstructions += 1;
    throw new Error("browser adapter must not be constructed");
  });

  expect(response.status).toBe(400);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({
    error: {
      type: "invalid_request_error",
      message: expect.stringContaining("encrypted cross-backend subagent payload"),
    },
  });
  expect(adapterConstructions).toBe(0);
});

test("subagent protocol selection controls plaintext MultiAgent V2 passthrough", async () => {
  const config = defaultConfig("browser-only");
  config.subagentProtocol = "native";
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
  let upstreamRequest: Request | undefined;

  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }), config, () => {
    throw new Error("native passthrough must not construct the browser adapter");
  }, {
    fetchUpstream: async input => {
      upstreamRequest = input;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  expect(response.status).toBe(200);
  const forwarded = await upstreamRequest!.json() as {
    tools: Array<{ tools: Array<{ parameters: { properties: { message: Record<string, unknown> } } }> }>;
  };
  expect(forwarded.tools[0]!.tools[0]!.parameters.properties.message)
    .not.toHaveProperty("encrypted");

  config.subagentProtocol = "compatibility-v1";
  let compatibilityRequest: Request | undefined;
  const compatibilityResponse = await responseRequest(new Request(
    "http://127.0.0.1:17841/v1/responses",
    {
      method: "POST",
      headers: {
        authorization: "Bearer codex-oauth-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  ), config, () => {
    throw new Error("native passthrough must not construct the browser adapter");
  }, {
    fetchUpstream: async input => {
      compatibilityRequest = input;
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  expect(compatibilityResponse.status).toBe(200);
  const compatibilityBody = await compatibilityRequest!.json() as typeof forwarded;
  expect(compatibilityBody.tools[0]!.tools[0]!.parameters.properties.message)
    .toHaveProperty("encrypted", true);
});
