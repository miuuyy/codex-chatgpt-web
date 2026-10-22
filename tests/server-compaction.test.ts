import { expect, test } from "bun:test";
import type { ProviderAdapter } from "../src/adapters/base";
import { defaultConfig } from "../src/config";
import { COMPACT_PROMPT, SUMMARY_PREFIX, decodeCompactionSummary, encodeCompactionSummary } from "../src/responses/compaction";
import { compactRequest, responseRequest as respond } from "../src/server";
import type { CodexProviderConfig, CodexParsedRequest } from "../src/types";
import { extractChatGptTurnEnvironment, extractChatGptTurnIdentity, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { chatGptCompactionSourceExecutionKey, chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
import { parseRequest } from "../src/responses/parser";

const model = "chatgpt-web/high";
const summary = "The repository was inspected. Continue by implementing the bounded Web context contract.";

for (const format of ["memento", "v2"] as const) {
  for (const nativeContext of [false, true]) {
  for (const stream of [false, true]) test(`${format} compaction completes for a native child with no human messages (stream=${stream}, nativeContext=${nativeContext})`, async () => {
    const metadata = {
      request_kind: format === "memento" ? "compaction" : "turn",
      thread_id: `thread_agent_only_${format}_${stream}_${nativeContext}`, turn_id: "turn_agent_only",
      parent_thread_id: "thread_parent", agent_name: "/root/independent_reviewer", subagent_kind: "thread_spawn",
      ...(format === "memento" ? { compaction: { trigger: "auto", reason: "context_limit",
        implementation: "responses", phase: "pre_turn", strategy: "memento" } } : {}),
    };
    const source = { type: "agent_message", id: "amsg_parent_instruction", author: "/root",
      recipient: "/root/independent_reviewer", content: [{ type: "input_text", text: "Finish the independent audit." }],
      internal_chat_message_metadata_passthrough: { turn_id: "turn_agent_only" } };
    // Observed native children combine AGENTS and environment in a contextual user item.
    // It is not a human instruction, even if the v1 producer includes that item in its output.
    const context = { type: "message", id: "msg_native_context", role: "user", content: [
      { type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>Verify actual outcomes.</INSTRUCTIONS>" },
      { type: "input_text", text: "<environment_context><cwd>/workspace</cwd></environment_context>" },
    ], internal_chat_message_metadata_passthrough: { turn_id: "turn_agent_only",
      content_item_kinds: ["agents_md.instructions", "environments.environment_context"] } };
    const body = { model, stream, client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
      input: [...(nativeContext ? [context] : []), source, ...(format === "v2" ? [{ type: "compaction_trigger" }] : [])] };
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify(body),
    }), defaultConfig("full"), compactionAdapterFactory());
    const text = await response.text();
    expect(response.status).toBe(200);
    const result = stream
      ? JSON.parse(text.split("\n").find(line => line.startsWith('data: {"type":"response.completed"'))!.slice(6)).response
      : JSON.parse(text);
    expect(result.status).toBe("completed");
    expect(result.output).toHaveLength(1);
    expect(result.output[0].type).toBe(format === "memento" ? "message" : "compaction");
    const checkpoint = format === "v2" ? result.output[0]
      : { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] };
    const continuation = { ...body, stream: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "turn" }) },
      input: [checkpoint],
    };
    let continued: CodexParsedRequest | undefined;
    const resumed = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify(continuation),
    }), defaultConfig("full"), () => ({ name: "agent-checkpoint-continuation", async runTurn(parsed, _incoming, emit) {
      continued = parsed;
      expect(extractChatGptTurnUserRevision(parsed)).toEqual(source.content);
      emit({ type: "text_delta", text: "Continued original child task", phase: "final_answer" });
      emit({ type: "done", stopReason: "stop", endTurn: true });
    } }));
    expect((await resumed.json()).status).toBe("completed");
    expect(continued).toBeDefined();
    const otherThread = { ...continued!, _rawBody: { ...continued!._rawBody as object,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "turn", thread_id: "unrelated_child" }) },
    } };
    expect(() => extractChatGptTurnUserRevision(otherThread)).toThrow("requires a current-turn user message");
  });
  }
}

test("native responses/memento compaction returns assistant text, not an encrypted compaction item", async () => {
  const metadata = {
    request_kind: "compaction", thread_id: "thread_memento", turn_id: "turn_memento",
    compaction: { trigger: "auto", reason: "context_limit", implementation: "responses", phase: "pre_turn", strategy: "memento" },
  };
  const body = {
    model, client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) },
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
    input: [{ type: "message", id: "msg_source_memento", role: "user", content: [{ type: "input_text", text: "Summarize the previous work." }] }],
  };
  expect(parseRequest(body)._compactionRequest).toBe(true);
  for (const stream of [false, true]) {
    const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ ...body, stream }),
    }), defaultConfig("full"), compactionAdapterFactory());
    expect(response.status).toBe(200);
    const text = await response.text();
    const result = stream
      ? JSON.parse(text.split("\n").find(line => line.startsWith('data: {"type":"response.completed"'))!.slice(6)).response
      : JSON.parse(text);
    expect(result.output).toHaveLength(1);
    expect(result.output[0]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: summary }] });
  }
  const cwd = process.cwd();
  const continuation = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ model, stream: false,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "turn", sandbox: "none", workspaces: { [cwd]: {} } }) },
      input: [
        { type: "message", role: "user", id: "msg_environment", content: [{ type: "input_text",
          text: `<environment_context><cwd>${cwd}</cwd><sandbox_mode>danger-full-access</sandbox_mode></environment_context>` }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\n${summary}` }] },
      ],
    }),
  }), defaultConfig("full"), () => ({ name: "verified-continuation", async runTurn(parsed, _incoming, emit) {
    expect(extractChatGptTurnEnvironment(parsed).cwd).toBe(cwd);
    expect(extractChatGptTurnUserRevision(parsed)).toEqual(body.input[0]!.content);
    emit({ type: "text_delta", text: "Continued", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }));
  expect(continuation.status).toBe(200);
  expect((await continuation.json()).status).toBe("completed");
  expect(parseRequest({ ...body, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, request_kind: "turn" }) } })._compactionRequest).toBeUndefined();
  expect(() => parseRequest({ ...body, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, compaction: { strategy: "unknown" } }) } })).toThrow("Unsupported native text compaction");
});

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

test("compacts legacy and named Pro tasks with Pro effort and preserves the selected family", async () => {
  const config = defaultConfig("full");
  config.extraHighAvailable = true;
  config.proAvailable = true;
  for (const [model, family] of [["chatgpt-web/pro", undefined], ["chatgpt-web/gpt-5.6-pro", "5.6"], ["chatgpt-web/gpt-6-pro", "6"]] as const) {
    const response = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect" }] }],
      }),
    }), config, () => ({
      name: "pro-compaction-effort-check",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed._compactionRequest).toBe(true);
        expect(parsed.options.reasoning).toBe("max");
        expect(parsed._chatgptModelFamily).toBe(family);
        emit({ type: "text_delta", text: summary, phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    }));

    expect(response.status).toBe(200);
  }
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

for (const format of ["v1", "v2"] as const) test(`${format} native continuation preserves a dropped delegation past an interrupted human turn`, async () => {
  const config = defaultConfig("full");
  const metadata = { thread_id: `thread_dropped_delegation_${format}`, turn_id: "turn_after_delegation" };
  const previous = { type: "message", role: "user", id: "msg_interrupted_human", content: [{ type: "input_text", text: "Earlier human task" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_interrupted_human" } };
  const aborted = { type: "message", role: "user", id: "msg_human_abort",
    content: "<turn_aborted>The user interrupted this turn.</turn_aborted>",
    internal_chat_message_metadata_passthrough: previous.internal_chat_message_metadata_passthrough };
  const delegation = { type: "function_call_output", id: "fco_delegated_task", name: "send_message_to_thread",
    namespace: "codex_app", output: "<codex_delegation><source_thread_id>source_thread</source_thread_id><input>Finish the new delegated task.</input></codex_delegation>",
    internal_chat_message_metadata_passthrough: { turn_id: "turn_delegated_task" } };
  const original = { model, stream: false, input: [previous, aborted, delegation],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } };
  const compact = format === "v1"
    ? await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST", body: JSON.stringify(original),
    }), config, compactionAdapterFactory())
    : await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ ...original, input: [...original.input, { type: "compaction_trigger" }] }),
    }), config, compactionAdapterFactory());
  expect(compact.status).toBe(200);
  const compacted = await compact.json() as { output: unknown[] };
  const installed = format === "v1" ? compacted.output : [previous, aborted, ...compacted.output];
  let starts = 0;
  const send = (input: unknown[]) => responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, input }),
  }), config, () => ({ name: "restored-delegated-task", async runTurn(parsed, _incoming, emit) {
    starts += 1;
    expect(extractChatGptTurnUserRevision(parsed)).toBe(delegation.output);
    emit({ type: "text_delta", text: "Delegated task continued", phase: "final_answer" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }));
  const continued = await send(installed);
  expect(continued.status).toBe(200);
  expect((await continued.json()).status).toBe("completed");
  // A long-running delegated task can compact again after its synthetic source was dropped.
  const recompact = format === "v1"
    ? await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST", body: JSON.stringify({ ...original, input: installed }),
    }), config, compactionAdapterFactory())
    : await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ ...original, input: [...installed, { type: "compaction_trigger" }] }),
    }), config, compactionAdapterFactory());
  expect(recompact.status).toBe(200);
  const recompacted = await recompact.json() as { output: unknown[] };
  const reinstalled = format === "v1" ? recompacted.output : [previous, aborted, ...recompacted.output];
  const continuedAgain = await send(reinstalled);
  expect(continuedAgain.status).toBe(200);
  expect((await continuedAgain.json()).status).toBe("completed");
  // Recovery of a different task never revives an explicitly interrupted delegation.
  expect((await send([...reinstalled, { ...aborted, id: "msg_delegation_abort",
    internal_chat_message_metadata_passthrough: delegation.internal_chat_message_metadata_passthrough }])).status).toBe(400);
  expect(starts).toBe(2);
});

for (const format of ["v1", "v2"] as const) test(`${format} goal compaction preserves the current goal past a standalone AGENTS preamble`, async () => {
  const config = defaultConfig("full");
  const metadata = { thread_id: `thread_goal_compaction_${format}`, turn_id: "turn_goal_continuation" };
  const source = { type: "message", role: "user", id: "msg_human",
    content: [{ type: "input_text", text: "Finish the requested work" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_human", content_item_kinds: ["user.text"] } };
  const goal = { type: "message", role: "user", id: "msg_goal_context",
    content: [{ type: "input_text", text: '<codex_internal_context source="goal">\nContinue the active goal.\n</codex_internal_context>' }],
    internal_chat_message_metadata_passthrough: { turn_id: metadata.turn_id, content_item_kinds: ["goal.internal_context"] } };
  // Instruction refreshes can be standalone user-role context, without an environment tag.
  // Native compaction drops these and rebuilds the preamble before the last real user.
  const instructions = { type: "message", role: "user", id: "msg_agents_refresh",
    content: [{ type: "input_text", text: "# AGENTS.md instructions\n<INSTRUCTIONS>Use the repository rules.</INSTRUCTIONS>" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn_previous_goal", content_item_kinds: ["agents_md.instructions"] } };
  const original = { model, stream: false, input: [source, instructions, goal],
    client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } };
  const compact = format === "v1"
    ? await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", {
      method: "POST", body: JSON.stringify(original),
    }), config, compactionAdapterFactory())
    : await responseRequest(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", body: JSON.stringify({ ...original, input: [...original.input, { type: "compaction_trigger" }] }),
    }), config, compactionAdapterFactory());
  expect(compact.status).toBe(200);
  const compacted = await compact.json() as { output: Array<{ id?: string }> };
  // Codex 0.152.1 process_annotated_compacted_history drops internal model context.
  // The fixture preserves the wire behavior even if our v1 producer accidentally returns it.
  const retained = compacted.output.filter(item => item.id !== goal.id && item.id !== instructions.id);
  const installed = format === "v1" ? retained : [source, ...retained];
  const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", {
    method: "POST", body: JSON.stringify({ ...original, input: installed }),
  }), config, () => ({ name: "native-goal-continuation", async runTurn(parsed, _incoming, emit) {
    expect(extractChatGptTurnUserRevision(parsed)).toEqual(goal.content);
    emit({ type: "text_delta", text: "Goal continued" });
    emit({ type: "done", stopReason: "stop", endTurn: true });
  } }));
  expect(response.status).toBe(200);
  expect((await response.json() as { status: string }).status).toBe("completed");
  expect(compacted.output).not.toContainEqual(expect.objectContaining({ id: goal.id }));
  expect(compacted.output).not.toContainEqual(expect.objectContaining({ id: instructions.id }));
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

test("Luna Bigger Context accepts native v1 and v2 compaction", async () => {
  const config = { ...defaultConfig("browser-only"), solAvailable: false, experimentalBiggerContext: true };
  for (const v2 of [false, true]) {
    const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "Keep the project requirements." }] }];
    const response = await (v2 ? responseRequest : compactRequest)(new Request("http://127.0.0.1/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chatgpt-web/luna", stream: false,
        input: v2 ? [...input, { type: "compaction_trigger" }] : input }),
    }), config, compactionAdapterFactory());
    expect(response.status).toBe(200);
    const body = await response.json();
    if (v2) {
      const checkpoint = body.output.find((item: { type: string }) => item.type === "compaction");
      expect(decodeCompactionSummary(checkpoint.encrypted_content)).toBe(summary);
    } else {
      expect(body.output.at(-1).content[0].text).toBe(`${SUMMARY_PREFIX}\n${summary}`);
    }
  }
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
