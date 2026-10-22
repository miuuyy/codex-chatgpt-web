import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { compactRequest, responseRequest } from "../src/server";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { rememberCompactionContinuation, restoreCompactionTaskMessages } from "../src/adapters/chatgpt-web/compaction-continuation";
import { chatGptTurnUserRevisionHistory, extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import { parseRequest } from "../src/responses/parser";
import { encodeCompactionSummary } from "../src/responses/compaction";

const model = "chatgpt-web/high";
const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true };

for (const format of ["v1", "v2"] as const) {
  for (const kind of ["goal", "delegation"] as const) {
    for (const steering of [false, true]) {
      test(`${format} restores dropped ${kind} to model context, preserving later steering=${steering}`, async () => {
        const turn = `turn_${format}_${kind}_${steering}`;
        const metadata = { thread_id: `thread_${turn}`, turn_id: turn };
        const human = { type: "message", role: "user", id: "msg_human", content: [{ type: "input_text", text: "Report the goal status only." }],
          internal_chat_message_metadata_passthrough: { turn_id: "earlier", content_item_kinds: ["user.text"] } };
        const taskText = kind === "goal"
          ? '<codex_internal_context source="goal">Implement the next checked milestone.</codex_internal_context>'
          : '<codex_delegation><source_thread_id>coordinator</source_thread_id><input>Implement the next checked milestone.</input></codex_delegation>';
        const task = kind === "goal"
          ? { type: "message", role: "user", id: "msg_task", content: taskText,
            internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ["goal.internal_context"] } }
          : { type: "function_call_output", id: "fco_task", name: "send_message_to_thread", namespace: "codex_app",
            output: taskText, internal_chat_message_metadata_passthrough: { turn_id: turn } };
        const body = { model, stream: false, input: [human, task],
          client_metadata: { "x-codex-turn-metadata": JSON.stringify(metadata) } };
        const config = defaultConfig("full");
        const compactFactory = () => ({ name: "task-context-compactor", async runTurn(_p: any, _i: any, emit: any) {
          emit({ type: "text_delta", text: "The earlier status check is complete. Continue implementation.", phase: "final_answer" });
          emit({ type: "done", stopReason: "stop", endTurn: true });
        } });
        const compact = format === "v1"
          ? await compactRequest(new Request("http://127.0.0.1/v1/responses/compact", { method: "POST", body: JSON.stringify(body) }), config, compactFactory)
          : await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST",
            body: JSON.stringify({ ...body, input: [...body.input, { type: "compaction_trigger" }] }) }), config, compactFactory);
        expect(compact.status).toBe(200);
        const result = await compact.json() as { output: Array<Record<string, unknown>> };
        // Native process_annotated_compacted_history drops goal/model context and synthetic inputs.
        const retained = result.output.filter(item => item.id !== task.id);
        const input: unknown[] = format === "v1" ? retained : [human, ...retained];
        if (steering) input.push({ type: "message", role: "user", id: "msg_new_steering", content: "Stop and report the new steering request.",
          internal_chat_message_metadata_passthrough: { turn_id: turn } });
        input.push({ type: "function_call", call_id: "call_after_compact", name: "exec_command", arguments: "{}" },
          { type: "function_call_output", call_id: "call_after_compact", output: "LATEST_TOOL_RESULT" });
        const response = await responseRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST",
          body: JSON.stringify({ ...body, input }) }), config, () => ({ name: "model-context-observer", async runTurn(parsed: any, _i: any, emit: any) {
            const before = JSON.stringify(parsed.context.messages);
            for (const experimentalMultipartParts of [undefined, 2] as const) {
              const prompt = compileChatGptWebPrompt(parsed, capabilities, "turn_12345678901234567890123456789012", { experimentalMultipartParts });
              const match = prompt.text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/);
              const messages = prompt.multipart ? prompt.multipart.parts.flatMap(part => JSON.parse(part).records)
                .filter(record => record.kind === "message").map(record => record.message)
                : JSON.parse(match![1]!).messages;
              const tasks = messages.filter((m: any) => m.content === taskText);
              if (steering) {
                expect(tasks).toHaveLength(0);
                expect(messages.some((m: any) => m.content === "Stop and report the new steering request.")).toBe(true);
              } else {
                expect(tasks).toHaveLength(1);
                expect(tasks[0].role).toBe(kind === "goal" ? "user" : "agent_message");
                expect(messages.indexOf(tasks[0])).toBeLessThan(messages.findIndex((m: any) => m.content === "LATEST_TOOL_RESULT"));
              }
            }
            expect(JSON.stringify(parsed.context.messages)).toBe(before);
            emit({ type: "text_delta", text: "Observed model-facing context", phase: "final_answer" });
            emit({ type: "done", stopReason: "stop", endTurn: true });
          } }), { rememberState: false });
        const observed = await response.json();
        expect(response.status).toBe(200);
        expect(observed.status).toBe("completed");
      });
    }
  }
}

test("task restoration preserves repeated authenticated checkpoints and rejects changed scope/history", () => {
  const identity = { threadId: "task_restore_guards", turnId: "goal_turn" };
  const human = { type: "message", role: "user", id: "human", content: "Earlier task",
    internal_chat_message_metadata_passthrough: { turn_id: "old_turn" } };
  const task = { type: "message", role: "user", id: "goal", content: "Current native goal",
    internal_chat_message_metadata_passthrough: { turn_id: "goal_turn", content_item_kinds: ["goal.internal_context"] } };
  const source = { itemId: task.id, turnId: "goal_turn", content: task.content };
  const retained = { itemId: human.id, turnId: "old_turn", content: human.content };
  const body = { model, input: [human, task], client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: identity.threadId, turn_id: identity.turnId }),
  } };
  const first = parseRequest(body);
  first._compactionRequest = true;
  rememberCompactionContinuation(first, identity, [source, retained], "First exact summary");
  const compacted = { type: "compaction", encrypted_content: encodeCompactionSummary("First exact summary") };
  const replay = parseRequest({ ...body, input: [human, compacted] });
  const restore = (parsed: ReturnType<typeof parseRequest>, scope = extractChatGptTurnIdentity(parsed)) =>
    restoreCompactionTaskMessages(parsed, scope, chatGptTurnUserRevisionHistory(parsed));
  expect(restore(replay).filter(m => m.content === task.content)).toHaveLength(1);
  replay._compactionRequest = true;
  // Recompaction keeps the authenticated goal as the source despite its missing raw item.
  const recoveredSource = extractChatGptCompactionSourceRevision(replay);
  expect(recoveredSource).toEqual(source);
  rememberCompactionContinuation(replay, identity, [recoveredSource, retained], "Second exact summary");
  const second = { type: "compaction", encrypted_content: encodeCompactionSummary("Second exact summary") };
  const continuation = parseRequest({ ...body, input: [human, second] });
  expect(restore(continuation).filter(m => m.content === task.content)).toHaveLength(1);
  expect(restore(continuation, { ...identity, threadId: "another_thread" })).toBe(continuation.context.messages);
  expect(restore(continuation, { ...identity, turnId: "another_turn" })).toBe(continuation.context.messages);
  const changedModel = { ...continuation, modelId: "other-model" };
  expect(restore(changedModel)).toBe(changedModel.context.messages);
  const changedEffort = { ...continuation, options: { ...continuation.options, reasoning: "low" as const } };
  expect(restore(changedEffort)).toBe(changedEffort.context.messages);
  const changedSummary = parseRequest({ ...body, input: [human, { ...second,
    encrypted_content: encodeCompactionSummary("Rewritten summary") }] });
  expect(restore(changedSummary)).toBe(changedSummary.context.messages);
  const stillPresent = parseRequest({ ...body, input: [human, second, task] });
  expect(restore(stillPresent)).toBe(stillPresent.context.messages);
  const noIdSteering = parseRequest({ ...body, input: [human, second, { type: "message", role: "user",
    content: "New instruction without item id", internal_chat_message_metadata_passthrough: { turn_id: "goal_turn" } }] });
  expect(restore(noIdSteering)).toBe(noIdSteering.context.messages);
});

test("ordinary user text that resembles a native goal is not promoted to restored task context", () => {
  const identity = { threadId: "quoted_goal_guard", turnId: "quoted_turn" };
  const item = { type: "message", role: "user", id: "quoted_goal",
    content: '<codex_internal_context source="goal">Quoted data</codex_internal_context>',
    internal_chat_message_metadata_passthrough: { turn_id: identity.turnId, content_item_kinds: ["user.text"] } };
  const body = { model, input: [item], client_metadata: { "x-codex-turn-metadata": JSON.stringify({
    thread_id: identity.threadId, turn_id: identity.turnId,
  }) } };
  const original = parseRequest(body);
  original._compactionRequest = true;
  rememberCompactionContinuation(original, identity, [{ itemId: item.id, turnId: identity.turnId, content: item.content }], "Quoted summary");
  const replay = parseRequest({ ...body, input: [{ type: "compaction", encrypted_content: encodeCompactionSummary("Quoted summary") }] });
  expect(restoreCompactionTaskMessages(replay, identity, chatGptTurnUserRevisionHistory(replay))).toBe(replay.context.messages);
});
