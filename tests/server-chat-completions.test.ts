import { expect, test } from "bun:test";
import { chatCompletionsRequest } from "../src/server";
import { defaultConfig } from "../src/config";
import type { ProviderAdapter } from "../src/adapters/base";
import type { AdapterEvent } from "../src/types";

function mockAdapter(answer = "Hello from mock ChatGPT Web!"): ProviderAdapter {
  return {
    name: "mock",
    async runTurn(_parsed, _options, emit) {
      emit({ type: "text_delta", text: answer });
      emit({ type: "done" });
    },
  };
}

test("chatCompletionsRequest converts messages to standard OpenAI response", async () => {
  const config = defaultConfig("browser-only");
  const req = new Request("http://127.0.0.1:8765/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-6-sol",
      messages: [
        { role: "system", content: "You are a helpful coding assistant" },
        { role: "user", content: "Explain quicksort in 1 sentence" },
      ],
      stream: false,
    }),
  });

  const response = await chatCompletionsRequest(req, config, () => mockAdapter("Quicksort partitions an array around a pivot."));
  expect(response.status).toBe(200);

  const json = await response.json() as Record<string, any>;
  expect(json.object).toBe("chat.completion");
  expect(json.choices).toHaveLength(1);
  expect(json.choices[0].message.role).toBe("assistant");
  expect(json.choices[0].message.content).toBe("Quicksort partitions an array around a pivot.");
  expect(json.choices[0].finish_reason).toBe("stop");
});

test("chatCompletionsRequest supports streaming with chat.completion.chunk", async () => {
  const config = defaultConfig("browser-only");
  const req = new Request("http://127.0.0.1:8765/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-6-sol",
      messages: [{ role: "user", content: "stream me a reply" }],
      stream: true,
    }),
  });

  const response = await chatCompletionsRequest(req, config, () => mockAdapter("streaming chunk"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }

  expect(text).toContain("chat.completion.chunk");
  expect(text).toContain("streaming chunk");
  expect(text).toContain("data: [DONE]");
});

test("chatCompletionsRequest rejects empty or missing messages", async () => {
  const config = defaultConfig("browser-only");
  const req = new Request("http://127.0.0.1:8765/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-6-sol",
      messages: [],
    }),
  });

  const response = await chatCompletionsRequest(req, config, () => mockAdapter());
  expect(response.status).toBe(400);
  const json = await response.json() as Record<string, any>;
  expect(json.error.message).toContain("messages must be a non-empty array");
});
