import { afterEach, describe, expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultCopilotConfig } from "../src/copilot/config";
import { startCopilotServer } from "../src/copilot/server";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

function fakeAdapter(events: (parsed: CodexParsedRequest) => AdapterEvent[]): ProviderAdapter {
  return {
    name: "fake-copilot",
    async runTurn(parsed, _incoming, emit) {
      for (const event of events(parsed)) emit(event);
    },
  };
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];

function config(overrides: Partial<ReturnType<typeof defaultCopilotConfig>> = {}) {
  return { ...defaultCopilotConfig(), port: 0, ...overrides };
}

function start(adapter: ProviderAdapter, overrides: Partial<ReturnType<typeof defaultCopilotConfig>> = {}) {
  const server = startCopilotServer(config(overrides), { adapterFactory: () => adapter });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
});

describe("codex-copilot-web server", () => {
  test("serves the static model catalog", async () => {
    const endpoint = start(fakeAdapter(() => []));
    const response = await fetch(`${endpoint}/v1/models`);
    expect(response.status).toBe(200);
    const body = await response.json() as { models: Array<{ slug: string }> };
    expect(body.models.map(model => model.slug)).toContain("copilot-web/auto");
  });

  test("returns a non-streaming Responses turn", async () => {
    const endpoint = start(fakeAdapter(() => [
      { type: "text_delta", text: "hello from Copilot", phase: "final_answer" },
      { type: "done", stopReason: "stop", endTurn: true },
    ]));
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "copilot-web/auto", input: "say hello", stream: false }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      status: string;
      output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
    };
    expect(body.status).toBe("completed");
    expect(body.output).toContainEqual(expect.objectContaining({
      type: "message",
      content: [expect.objectContaining({ type: "output_text", text: "hello from Copilot" })],
    }));
  });

  test("streams Responses SSE text", async () => {
    const endpoint = start(fakeAdapter(() => [
      { type: "text_delta", text: "streamed", phase: "final_answer" },
      { type: "done", stopReason: "stop", endTurn: true },
    ]));
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "copilot-web/auto", input: "stream", stream: true }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain('"delta":"streamed"');
    expect(text).toContain("event: response.completed");
    expect(text).toContain("data: [DONE]");
  });

  test("relays text-protocol tool calls as Responses function calls", async () => {
    const endpoint = start(fakeAdapter(() => [
      { type: "tool_call_start", id: "call_1", name: "shell" },
      { type: "tool_call_delta", arguments: '{"command":["pwd"]}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ]));
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "copilot-web/auto", input: "where am I", stream: true }),
    });
    const text = await response.text();
    expect(text).toContain('"type":"function_call"');
    expect(text).toContain('"name":"shell"');
    expect(text).toContain('"call_id":"call_1"');
    expect(text).toContain("response.function_call_arguments.delta");
    expect(text).toContain('"end_turn":false');
  });

  test("supports the dedicated compaction endpoint", async () => {
    const endpoint = start(fakeAdapter(parsed => [
      { type: "text_delta", text: parsed._compactionRequest ? "checkpoint summary" : "normal" },
      { type: "done", stopReason: "stop", endTurn: true },
    ]));
    const response = await fetch(`${endpoint}/v1/responses/compact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "copilot-web/auto",
        input: [{ type: "message", role: "user", content: "do the task" }],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { output: Array<Record<string, unknown>> };
    expect(body.output.length).toBeGreaterThan(0);
    expect(JSON.stringify(body.output)).toContain("checkpoint summary");
  });

  test("rejects unknown models with a clear error", async () => {
    const endpoint = start(fakeAdapter(() => []));
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hi", stream: false }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain("Unknown Copilot model");
  });

  test("enforces an optional control token", async () => {
    const endpoint = start(fakeAdapter(() => []), { controlToken: "secret" });
    expect((await fetch(`${endpoint}/v1/models`)).status).toBe(401);
    expect((await fetch(`${endpoint}/v1/models`, {
      headers: { authorization: "Bearer secret" },
    })).status).toBe(200);
    expect((await fetch(`${endpoint}/healthz`)).status).toBe(200);
  });

  test("rejects browser-originated POST requests", async () => {
    const endpoint = start(fakeAdapter(() => []));
    const response = await fetch(`${endpoint}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({ model: "copilot-web/auto", input: "hi", stream: false }),
    });
    expect(response.status).toBe(403);
  });
});
