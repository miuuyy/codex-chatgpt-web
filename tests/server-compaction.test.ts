import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { COMPACT_PROMPT, SUMMARY_PREFIX, decodeCompactionSummary, encodeCompactionSummary } from "../src/responses/compaction";
import { compactRequest, responseRequest as respond } from "../src/server";
import type { CodexProviderConfig } from "../src/types";
import { extractChatGptTurnIdentity, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { chatGptCompactionSourceExecutionKey, chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";

const model = "chatgpt-web/high";
const summary = "The repository was inspected. Continue by implementing the bounded Web context contract.";

// These fixtures test checkpoint authorization, not persisted previous_response_id storage.
const responseRequest: typeof respond = (request, config, factory, options) =>
  respond(request, config, factory, { ...options, rememberState: false });

function compactionAdapterFactory(
  seenProviders: CodexProviderConfig[] = [],
  expectedPreviousSummary?: string,
) {
  return (provider: CodexProviderConfig): ProviderAdapter => {
    seenProviders.push(structuredClone(provider));
    return {
      name: "test-web-compactor",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed._compactionRequest).toBe(true);
        expect(parsed.context.tools).toBeUndefined();
        expect(parsed.options.toolChoice).toBeUndefined();
        expect(parsed.options.parallelToolCalls).toBeUndefined();
        if (expectedPreviousSummary) {
          expect(parsed.context.messages).toContainEqual(expect.objectContaining({
            role: "user",
            content: expectedPreviousSummary,
          }));
        }
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
  const previousSummary = `${SUMMARY_PREFIX}\nPrevious cumulative checkpoint`;
  const config = defaultConfig("full");
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "First request" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "First answer" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: previousSummary }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Latest request" }] },
      ],
    }),
  }), config, compactionAdapterFactory(providers, previousSummary));

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

test("compacts a Pro task with Pro effort", async () => {
  const config = defaultConfig("full");
  config.proAvailable = true;
  const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt-web/pro",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect" }] }],
    }),
  }), config, () => ({
    name: "pro-compaction-effort-check",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed._compactionRequest).toBe(true);
      expect(parsed.options.reasoning).toBe("max");
      emit({ type: "text_delta", text: summary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  expect(response.status).toBe(200);
});

test("an eligible Pro compaction snapshots the live model preference once without changing normal turns", async () => {
  const config = defaultConfig("browser-only");
  config.proAvailable = true;
  config.compactionModel = "5.5-pro";
  let liveModel: "extra-high" | "5.6-pro" = "extra-high";
  let reads = 0;
  const options = {
    rememberState: false,
    readCompactionModel: () => {
      reads += 1;
      return liveModel;
    },
  };
  let compactProvider: CodexProviderConfig | undefined;
  const compact = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST",
    body: JSON.stringify({
      model: "chatgpt-web/pro",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Compact" }] }],
    }),
  }), config, provider => {
    compactProvider = structuredClone(provider);
    liveModel = "5.6-pro";
    return {
      name: "live-compaction-model",
      async runTurn(_parsed, _incoming, emit) {
        expect(provider.chatgptWeb?.compactionModel).toBe("extra-high");
        emit({ type: "text_delta", text: summary, phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    };
  }, options);
  expect(compact.status).toBe(200);
  expect(reads).toBe(1);
  expect(compactProvider?.chatgptWeb?.compactionModel).toBe("extra-high");
  expect(config.compactionModel).toBe("5.5-pro");

  const normal = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "chatgpt-web/pro", input: "Normal turn", stream: false }),
  }), config, provider => ({
    name: "normal-main-model",
    async runTurn(_parsed, _incoming, emit) {
      expect(provider.chatgptWeb?.compactionModel).toBe("5.5-pro");
      emit({ type: "text_delta", text: "Normal response", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }), options);
  expect(normal.status).toBe(200);
  expect(reads).toBe(1);
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

for (const format of ["v1", "v2"] as const) test(`${format} pre-turn compaction authorizes only its exact native continuation`, async () => {
  const config = defaultConfig("full");
  const metadata = { thread_id: `thread_preturn_${format}`, turn_id: `turn_preturn_${format}` };
  const source = {
    type: "message", role: "user", id: "msg_original", content: [{ type: "input_text", text: "Continue the original task" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_before_preturn_compaction" },
  };
  const original = {
    model, stream: false, input: [source],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
  };
  const compact = format === "v1"
    ? await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST", body: JSON.stringify(original),
    }), config, compactionAdapterFactory())
    : await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ ...original, input: [source, { type: "compaction_trigger" }] }),
    }), config, compactionAdapterFactory());
  expect(compact.status).toBe(200);
  const compacted = await compact.json() as { output: unknown[] };
  const input = format === "v1" ? compacted.output : [source, ...compacted.output];
  const continuation = { ...original, input };
  let starts = 0;
  const factory = (): ProviderAdapter => ({
    name: "native-post-compaction-continuation",
    async runTurn(parsed, _incoming, emit) {
      starts += 1;
      expect(extractChatGptTurnIdentity(parsed).turnId).toBe(metadata.turn_id);
      expect(extractChatGptTurnUserRevision(parsed)).toEqual(source.content);
      emit({ type: "text_delta", text: "Continued after compaction", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  });
  const send = (body: unknown) => responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify(body),
  }), config, factory);
  const resumed = await send(continuation);
  expect(resumed.status).toBe(200);
  expect((await resumed.json() as { status: string }).status).toBe("completed");
  expect(starts).toBe(1);
  const toolRound = await send({ ...continuation, input: [...input,
    { type: "function_call", call_id: "call_native_round", name: "exec_command", arguments: "{}" },
    { type: "function_call_output", call_id: "call_native_round", output: "Native tool result" },
  ] });
  expect(toolRound.status).toBe(200);
  expect((await toolRound.json() as { status: string }).status).toBe("completed");
  // A checkpoint's text alone is not authority to start another task, another native turn,
  // a different model, or a rewritten source instruction.
  for (const changed of [
    { ...continuation, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, thread_id: "another_thread" }) } },
    { ...continuation, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, turn_id: "another_turn" }) } },
    { ...continuation, model: "chatgpt-web/medium" },
    { ...continuation, input: input.map(item => (item as { id?: string }).id === source.id
      ? { ...source, content: [{ type: "input_text", text: "Different task" }] } : item) },
    { ...continuation, input: [source, { type: "compaction", encrypted_content: encodeCompactionSummary("Unrecognized checkpoint") }] },
    { ...continuation, input: [...input, { type: "message", role: "user",
      content: [{ type: "input_text", text: "<turn_aborted>The user interrupted this turn.</turn_aborted>" }],
      internal_chat_message_metadata_passthrough: source.internal_chat_message_metadata_passthrough,
    }] },
  ]) {
    expect((await send(changed)).status).toBe(400);
  }
  expect(starts).toBe(2);
});

test("v1 goal compaction authorizes the human instruction that native Codex retains", async () => {
  const config = defaultConfig("full");
  const metadata = { thread_id: "thread_goal_compaction", turn_id: "turn_goal_continuation" };
  const source = { type: "message", role: "user", id: "msg_human",
    content: [{ type: "input_text", text: "Finish the requested work" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_human", content_item_kinds: ["user.text"] } };
  const goal = { type: "message", role: "user", id: "msg_goal_context",
    content: [{ type: "input_text", text: '<codex_internal_context source="goal">\nContinue the active goal.\n</codex_internal_context>' }],
    internal_chat_message_metadata_passthrough: { turn_id: metadata.turn_id, content_item_kinds: ["goal.internal_context"] } };
  const original = { model, stream: false, input: [source, goal],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } };
  const compact = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST", body: JSON.stringify(original),
  }), config, compactionAdapterFactory());
  expect(compact.status).toBe(200);
  const compacted = await compact.json() as { output: Array<{ id?: string }> };
  // Codex 0.152.1 process_annotated_compacted_history drops internal model context.
  // The fixture preserves the wire behavior even if our v1 producer accidentally returns it.
  const installed = compacted.output.filter(item => item.id !== goal.id);
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, input: installed }),
  }), config, () => ({ name: "native-goal-continuation", async runTurn(parsed, _incoming, emit) {
    expect(extractChatGptTurnUserRevision(parsed)).toEqual(source.content);
    emit({ type: "text_delta", text: "Goal continued" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }));
  expect(response.status).toBe(200);
  expect((await response.json() as { status: string }).status).toBe("completed");
  expect(compacted.output).not.toContainEqual(expect.objectContaining({ id: goal.id }));
});

test("v1 post-compaction continuation retains the producer's bounded source representation", async () => {
  const config = defaultConfig("full");
  const source = { type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(80_100) }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_long_source" } };
  const original = { model, stream: false, input: [source], client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_long_source", turn_id: "turn_after_long_source" }),
  } };
  const compact = await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
    method: "POST", body: JSON.stringify(original),
  }), config, compactionAdapterFactory());
  expect(compact.status).toBe(200);
  const compacted = await compact.json() as { output: unknown[] };
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, input: compacted.output }),
  }), config, () => ({ name: "bounded-continuation", async runTurn(parsed, _incoming, emit) {
    expect(extractChatGptTurnUserRevision(parsed)).toEqual([{ type: "input_text", text: "x".repeat(80_000) }]);
    emit({ type: "text_delta", text: "Done", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }));
  expect(response.status).toBe(200);
});

for (const stream of [false, true]) test(`failed compaction cannot authorize a continuation (stream=${stream})`, async () => {
  const config = defaultConfig("full");
  const source = { type: "message", role: "user", content: [{ type: "input_text", text: "Original task" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_failed_source" } };
  const original = { model, stream, input: [source], client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: `thread_failed_checkpoint_${stream}`, turn_id: "turn_failed_checkpoint" }),
  } };
  const failed = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, input: [source, { type: "compaction_trigger" }] }),
  }), config, () => ({ name: "failed-checkpoint", async runTurn(_parsed, _incoming, emit) {
    emit({ type: "text_delta", text: summary, phase: "final_answer" });
    emit({ type: "error", message: "Compaction failed before completion" });
  } }));
  // Consume the stream as native Codex does; only an actual completed checkpoint is evidence.
  expect(await failed.text()).toContain("Compaction failed before completion");
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, stream: false,
      input: [source, { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }],
    }),
  }), config, () => { throw new Error("Failed checkpoint must not authorize a new browser execution"); });
  expect(response.status).toBe(400);
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

test("v2 recompaction reads the previous checkpoint once and replaces it with one new compaction item", async () => {
  const config = defaultConfig("full");
  const firstResponse = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "First request" }] },
        { type: "compaction_trigger" },
      ],
    }),
  }), config, compactionAdapterFactory());
  expect(firstResponse.status).toBe(200);
  const firstBody = await firstResponse.json() as {
    output: Array<{ type: string; encrypted_content?: string }>;
  };
  expect(firstBody.output).toHaveLength(1);
  const previousCompaction = firstBody.output[0]!;

  const updatedSummary = "The previous checkpoint was consumed. Continue with the latest request only.";
  const secondResponse = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      input: [
        previousCompaction,
        { type: "message", role: "user", content: [{ type: "input_text", text: "Latest request" }] },
        { type: "compaction_trigger" },
      ],
    }),
  }), config, () => ({
    name: "v2-recompaction-check",
    async runTurn(parsed, _incoming, emit) {
      const previousSummaryText = `${SUMMARY_PREFIX}\n\n${summary}`;
      expect(parsed.context.messages.filter(message => (
        message.role === "user" && message.content === previousSummaryText
      ))).toHaveLength(1);
      expect(parsed.context.messages).toContainEqual(expect.objectContaining({
        role: "user",
        content: "Latest request",
      }));
      expect(parsed.context.messages.at(-1)).toMatchObject({ role: "user", content: COMPACT_PROMPT });
      emit({ type: "text_delta", text: updatedSummary, phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    },
  }));

  expect(secondResponse.status).toBe(200);
  const secondBody = await secondResponse.json() as {
    status: string;
    output: Array<{ type: string; encrypted_content?: string }>;
  };
  expect(secondBody.status).toBe("completed");
  expect(secondBody.output).toHaveLength(1);
  expect(secondBody.output[0]!.type).toBe("compaction");
  expect(decodeCompactionSummary(secondBody.output[0]!.encrypted_content ?? ""))
    .toBe(updatedSummary);
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
