import { expect, test } from "bun:test";
import { assertExternalApiConfig, defaultConfig } from "../src/config";
import { externalApiRequest } from "../src/external-api";
import { responseRequest, type ChatGptWebAdapterFactory } from "../src/server";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import type { CodexProviderConfig } from "../src/types";

const TOKEN = "external_api_token_abcdefghijklmnopqrstuvwxyz_1234567890";

function externalConfig() {
  const config = defaultConfig("full");
  config.proAvailable = true;
  config.externalApi = { enabled: true, host: "127.0.0.1", port: 17842, token: TOKEN };
  return config;
}

function request(path: string, body?: unknown, token = TOKEN) {
  return new Request(`http://127.0.0.1:17842${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function handle(request: Request, config = externalConfig(), adapterFactory?: ChatGptWebAdapterFactory) {
  return externalApiRequest(request, config, (internal, scopedConfig, options) => {
    if (!adapterFactory) throw new Error("response delegate must not be called");
    return responseRequest(internal, scopedConfig, adapterFactory, options);
  });
}

test("external API requires its own bearer token and exposes only external routes", async () => {
  const config = externalConfig();
  expect((await handle(new Request("http://127.0.0.1:17842/v1/models"), config)).status).toBe(401);
  expect((await handle(request("/admin/shutdown", {}), config)).status).toBe(404);

  const models = await handle(request("/v1/models"), config);
  expect(models.status).toBe(200);
  const catalog = await models.json() as { object: string; data: Array<{ id: string }> };
  expect(catalog.object).toBe("list");
  expect(catalog.data.map(model => model.id)).toEqual([
    "chatgpt-web/light", "chatgpt-web/medium", "chatgpt-web/high", "chatgpt-web/extra-high", "chatgpt-web/pro",
  ]);
});

test("external API rejects native models before the internal passthrough branch", async () => {
  const response = await handle(request("/v1/responses", {
    model: "gpt-5.6-sol",
    input: "hello",
  }), externalConfig());

  expect(response.status).toBe(400);
  expect(await response.text()).toContain("chatgpt-web/");
});

test("external API rejects native input items before continuation replay", async () => {
  for (const type of ["additional_tools", "compaction_trigger", "custom_tool_call_output"]) {
    const response = await handle(request("/v1/responses", {
      model: "chatgpt-web/high",
      previous_response_id: `resp_ext_${"a".repeat(32)}_${"b".repeat(32)}_${"c".repeat(16)}`,
      input: [{ type }],
    }), externalConfig());
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("supports only messages");
  }
});

test("external Responses requests receive safe canonical turn metadata", async () => {
  const config = externalConfig();
  let identity: ReturnType<typeof extractChatGptTurnIdentity> | undefined;
  const response = await handle(request("/v1/responses", {
    model: "chatgpt-web/high",
    input: "Explain this API in one sentence.",
  }), config, provider => {
    expect(provider.chatgptWeb?.localToolsEnabled).toBe(false);
    return {
      name: "external-api-test",
      async runTurn(parsed, _incoming, emit) {
        identity = extractChatGptTurnIdentity(parsed);
        expect(identity.turnId).toMatch(/^ext_turn_/);
        expect(identity.threadId).toMatch(/^ext_thread_/);
        emit({ type: "text_delta", text: "External API works." });
        emit({ type: "done", endTurn: true });
      },
    };
  });

  expect(response.status).toBe(200);
  const body = await response.json() as { id: string; model: string; output: unknown[] };
  expect(body.id).toMatch(/^resp_ext_/);
  expect(body.model).toBe("chatgpt-web/high");
  expect(body.output).not.toHaveLength(0);
  expect(identity?.turnId).toBeTruthy();
});

test("external tools use a synthetic read-only environment and keep the same turn across tool output", async () => {
  const config = externalConfig();
  const identities: Array<ReturnType<typeof extractChatGptTurnIdentity>> = [];
  let calls = 0;
  const adapterFactory = (provider: CodexProviderConfig) => {
    expect(provider.chatgptWeb?.localToolsEnabled).toBe(true);
    return {
      name: "external-api-tools-test",
      async runTurn(parsed: any, _incoming: any, emit: any) {
        identities.push(extractChatGptTurnIdentity(parsed));
        expect(extractChatGptTurnEnvironment(parsed).sandboxPolicy.type).toBe("readOnly");
        calls += 1;
        if (calls === 1) {
          emit({ type: "tool_call_start", id: "call_weather", name: "weather" });
          emit({ type: "tool_call_delta", arguments: JSON.stringify({ city: "Toronto" }) });
          emit({ type: "tool_call_end" });
          emit({ type: "done", endTurn: false });
        } else {
          emit({ type: "text_delta", text: "It is sunny." });
          emit({ type: "done", endTurn: true });
        }
      },
    };
  };
  const tools = [{
    type: "function",
    name: "weather",
    description: "Get weather",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  }];

  const first = await handle(request("/v1/responses", {
    model: "chatgpt-web/high", input: "What is the weather?", tools,
  }), config, adapterFactory);
  const firstBody = await first.json() as { id: string; output: Array<Record<string, unknown>> };
  expect(first.status).toBe(200);
  expect(firstBody.output).toContainEqual(expect.objectContaining({
    type: "function_call", call_id: "call_weather", name: "weather",
  }));

  const second = await handle(request("/v1/responses", {
    model: "chatgpt-web/high",
    previous_response_id: firstBody.id,
    input: [{ type: "function_call_output", call_id: "call_weather", output: "sunny" }],
    tools,
  }), config, adapterFactory);
  expect(second.status).toBe(200);
  expect(identities).toHaveLength(2);
  expect(identities[1]!.threadId).toBe(identities[0]!.threadId);
  expect(identities[1]!.turnId).toBe(identities[0]!.turnId);
});

test("external function tools fail closed without the Full harness", async () => {
  const config = externalConfig();
  config.mode = "browser-only";
  const response = await handle(request("/v1/responses", {
    model: "chatgpt-web/high",
    input: "Use the weather tool.",
    tools: [{ type: "function", name: "weather", parameters: { type: "object" } }],
  }), config);

  expect(response.status).toBe(400);
  expect(await response.text()).toContain("Full harness");
});

test("external continuations keep the thread but start a new logical turn for new user input", async () => {
  const identities: Array<ReturnType<typeof extractChatGptTurnIdentity>> = [];
  const adapterFactory: ChatGptWebAdapterFactory = () => ({
    name: "external-api-continuation-test",
    async runTurn(parsed, _incoming, emit) {
      identities.push(extractChatGptTurnIdentity(parsed));
      expect(extractChatGptTurnEnvironment(parsed).cwd).toContain("codex-chatgpt-web-external");
      emit({ type: "text_delta", text: "ok" });
      emit({ type: "done", endTurn: true });
    },
  });
  const first = await handle(request("/v1/responses", {
    model: "chatgpt-web/high",
    input: "First question",
    client_metadata: { "x-codex-turn-metadata": { thread_id: "attacker", turn_id: "attacker" } },
  }), externalConfig(), adapterFactory);
  const firstBody = await first.json() as { id: string };
  const second = await handle(request("/v1/responses", {
    model: "chatgpt-web/high",
    previous_response_id: firstBody.id,
    input: "Second question",
  }), externalConfig(), adapterFactory);

  expect(second.status).toBe(200);
  expect(identities[1]!.threadId).toBe(identities[0]!.threadId);
  expect(identities[1]!.turnId).not.toBe(identities[0]!.turnId);
  expect(identities[0]).not.toMatchObject({ threadId: "attacker", turnId: "attacker" });
});

test("external streaming responses use the external continuation id", async () => {
  const response = await handle(request("/v1/responses", {
    model: "chatgpt-web/high",
    input: "Stream this",
    stream: true,
  }), externalConfig(), () => ({
    name: "external-api-stream-test",
    async runTurn(_parsed, _incoming, emit) {
      emit({ type: "text_delta", text: "streamed" });
      emit({ type: "done", endTurn: true });
    },
  }));
  const body = await response.text();

  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(body).toContain('"id":"resp_ext_');
  expect(body).toContain("response.completed");
});

test("external listener configuration rejects shared ports and control tokens", () => {
  const config = externalConfig();
  expect(() => assertExternalApiConfig(config)).not.toThrow();
  config.externalApi!.port = config.port;
  expect(() => assertExternalApiConfig(config)).toThrow("must differ from the Responses port");
  config.externalApi!.port += 1;
  config.externalApi!.token = config.controlToken;
  expect(() => assertExternalApiConfig(config)).toThrow("must differ from controlToken");
});

test("startServer owns the external listener lifecycle", async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  const config = externalConfig();
  config.mode = "browser-only";
  config.port = 0;
  config.externalApi!.port = port;
  const server = (await import("../src/server")).startServer(config);
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/models`);
    expect(unauthorized.status).toBe(401);
    const models = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(models.status).toBe(200);
  } finally {
    await server.stop(true);
  }
  expect(fetch(`http://127.0.0.1:${port}/v1/models`)).rejects.toThrow();
});
