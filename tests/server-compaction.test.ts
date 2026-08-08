import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { COMPACT_PROMPT, SUMMARY_PREFIX, decodeCompactionSummary } from "../src/responses/compaction";
import { compactRequest, responseRequest } from "../src/server";
import type { CodexProviderConfig } from "../src/types";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { chatGptCompactionSourceExecutionKey, chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";

const model = "chatgpt-web/high";
const summary = "The repository was inspected. Continue by implementing the bounded Web context contract.";

function compactionAdapterFactory(seenProviders: CodexProviderConfig[] = []) {
  return (provider: CodexProviderConfig): ProviderAdapter => {
    seenProviders.push(structuredClone(provider));
    return {
      name: "test-web-compactor",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed._compactionRequest).toBe(true);
        expect(parsed.context.tools).toBeUndefined();
        expect(parsed.options.toolChoice).toBeUndefined();
        expect(parsed.options.parallelToolCalls).toBeUndefined();
        expect(parsed.context.messages.at(-1)).toMatchObject({ role: "user", content: COMPACT_PROMPT });
        emit({ type: "text_delta", text: summary, phase: "final_answer" });
        emit({
          type: "done",
          stopReason: "stop",
          endTurn: true,
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, estimated: true },
        });
      },
    };
  };
}

test("compacts ChatGPT Web v1 through a dedicated read-only browser summarization turn", async () => {
  const providers: CodexProviderConfig[] = [];
  const config = defaultConfig("full");
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "First request" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "First answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Latest request" }] },
      ],
    }),
  }), config, compactionAdapterFactory(providers));

  expect(response.status).toBe(200);
  expect(providers).toHaveLength(1);
  expect(providers[0]!.chatgptWeb?.localToolsEnabled).toBe(true);
  const body = await response.json() as { output: Array<{ role: string; content: Array<{ text: string }> }> };
  expect(body.output.map(item => item.content[0]!.text)).toEqual([
    "First request",
    "Latest request",
    `${SUMMARY_PREFIX}\n${summary}`,
  ]);
});

test("preserves canonical Codex turn metadata from the compact endpoint header", async () => {
  const turnMetadata = { thread_id: "thread_compact", turn_id: "turn_compact" };
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify(turnMetadata),
    },
    body: JSON.stringify({
      model,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the project" }],
        internal_chat_message_metadata_passthrough: { turn_id: turnMetadata.turn_id },
      }],
    }),
  }), defaultConfig("full"), () => ({
    name: "metadata-check",
    async runTurn(parsed, _incoming, emit) {
      expect(extractChatGptTurnIdentity(parsed)).toMatchObject({
        threadId: turnMetadata.thread_id,
        turnId: turnMetadata.turn_id,
      });
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  expect(response.status).toBe(200);
});

test("compaction identity accepts a historical source message from the pre-compaction turn", async () => {
  const turnMetadata = { thread_id: "thread_compact", turn_id: "turn_compact" };
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify(turnMetadata),
    },
    body: JSON.stringify({
      model,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue the existing task" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn_before_compaction" },
      }],
    }),
  }), defaultConfig("full"), () => ({
    name: "compaction-identity-check",
    async runTurn(parsed, _incoming, emit) {
      expect(() => chatGptTurnExecutionKey(parsed)).not.toThrow();
      expect(() => chatGptCompactionSourceExecutionKey(parsed)).not.toThrow();
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  expect(response.status).toBe(200);
});

test("returns exactly one native compaction item for a ChatGPT Web v2 request", async () => {
  const providers: CodexProviderConfig[] = [];
  const config = defaultConfig("full");
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      tool_choice: "auto",
      parallel_tool_calls: true,
      tools: [{ type: "function", name: "codex_exec", description: "Run", parameters: { type: "object" } }],
      input: [{ type: "compaction_trigger" }],
    }),
  }), config, compactionAdapterFactory(providers));

  expect(response.status).toBe(200);
  expect(providers).toHaveLength(1);
  expect(providers[0]!.chatgptWeb?.localToolsEnabled).toBe(true);
  const body = await response.json() as {
    status: string;
    output: Array<{ type: string; encrypted_content?: string }>;
  };
  expect(body.status).toBe("completed");
  expect(body.output).toHaveLength(1);
  expect(body.output[0]!.type).toBe("compaction");
  expect(decodeCompactionSummary(body.output[0]!.encrypted_content ?? "")).toBe(summary);
});

test("streams one compaction item without leaking the summary as a normal assistant message", async () => {
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, input: [{ type: "compaction_trigger" }] }),
  }), defaultConfig("full"), compactionAdapterFactory());

  expect(response.status).toBe(200);
  const sse = await response.text();
  expect(sse).toContain('"type":"compaction"');
  expect(sse).not.toContain("response.output_text.delta");
  expect(sse.match(/\"type\":\"compaction\"/g)).toHaveLength(2);
});

test("rejects an unknown routed compact model instead of treating it as ChatGPT Web", async () => {
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/not-enabled", input: [] }),
  }), defaultConfig("browser-only"));

  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("model is not enabled");
});

test("Luna rejects separate native compaction instead of opening another browser turn", async () => {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  let adapterStarted = false;
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "chatgpt-web/luna", input: [] }),
  }), config, () => {
    adapterStarted = true;
    return {
      name: "must-not-start",
      async runTurn() {
        throw new Error("Luna compaction adapter must not start");
      },
    };
  });

  expect(response.status).toBe(409);
  expect(adapterStarted).toBeFalse();
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("rolling checkpoint");
  expect(body.error.message).toContain("separate Codex compaction is disabled");
});

test("Luna rejects a remote-v2 compaction trigger before opening another browser turn", async () => {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  let adapterStarted = false;
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/luna",
      stream: false,
      input: [{ type: "compaction_trigger" }],
    }),
  }), config, () => {
    adapterStarted = true;
    return {
      name: "must-not-start-v2",
      async runTurn() {
        throw new Error("Luna v2 compaction adapter must not start");
      },
    };
  });

  expect(response.status).toBe(409);
  expect(adapterStarted).toBeFalse();
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("rolling checkpoint");
});

test("rejects Pro-only routed models before opening a browser when the account has no Pro access", async () => {
  for (const [routedModel, label] of [
    ["chatgpt-web/extra-high", "Extra High"],
    ["chatgpt-web/pro", "Pro"],
  ] as const) {
    const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: routedModel, input: "test", stream: false }),
    }), defaultConfig("browser-only"));

    expect(response.status).toBe(400);
    const body = await response.json() as { error: { message: string } };
    expect(body.error.message).toContain(`${label} is not available for this account`);
  }
});

test("preserves a structured browser preflight failure through the v1 compaction endpoint", async () => {
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: [] }),
  }), defaultConfig("browser-only"), () => ({
    name: "preflight-error",
    async runTurn(_parsed, _incoming, emit) {
      emit({
        type: "error",
        message: "This task exceeds the ChatGPT Web context window.",
        status: 400,
        errorType: "invalid_request_error",
        code: "context_length_exceeded",
        retryable: false,
      });
    },
  }));

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: {
      message: "This task exceeds the ChatGPT Web context window.",
      type: "invalid_request_error",
      code: "context_length_exceeded",
    },
  });
});

test("refuses a ChatGPT Web continuation when local previous-response state is unavailable", async () => {
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      previous_response_id: "resp_missing_after_restart",
      input: "continue",
      stream: false,
    }),
  }), defaultConfig("browser-only"));

  expect(response.status).toBe(409);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("partial Codex context");
});
