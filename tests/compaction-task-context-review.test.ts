import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { buildCompactV1Output, encodeCompactionSummary, extractCompactUserMessages } from "../src/responses/compaction";
import { extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity, findChatGptCompactionSourceRevision,
  chatGptTurnUserRevisionHistory } from "../src/adapters/chatgpt-web/environment";
import { rememberCompactionContinuation, restoreCompactionTaskMessages } from "../src/adapters/chatgpt-web/compaction-continuation";

type Item = Record<string, any>;
const plain = (content: any): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => part.text ?? "").join("\n") : "";

function fixture(name: string, kind: "goal" | "delegation" = "goal") {
  const turn = `review_${name}_current`;
  const human: Item = { type: "message", id: `human_${name}`, role: "user", content: [{ type: "input_text", text: "Check the previous goal status only." }],
    internal_chat_message_metadata_passthrough: { turn_id: `review_${name}_old`, content_item_kinds: ["user.text"] } };
  const taskText = kind === "goal" ? '<codex_internal_context source="goal">Execute the current measured milestone.</codex_internal_context>'
    : '<codex_delegation><source_thread_id>review_parent</source_thread_id><input>Execute the current measured milestone.</input></codex_delegation>';
  const task: Item = kind === "goal"
    ? { type: "message", id: `task_${name}`, role: "user", content: [{ type: "input_text", text: taskText }],
      internal_chat_message_metadata_passthrough: { turn_id: turn, content_item_kinds: ["goal.internal_context"] } }
    : { type: "function_call_output", id: `task_${name}`, name: "send_message_to_thread", namespace: "codex_app", output: taskText,
      internal_chat_message_metadata_passthrough: { turn_id: turn } };
  const parse = (input: Item[]) => parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `review_thread_${name}`, turn_id: turn }) } });
  const checkpoint = (summary: string): Item => ({ type: "compaction", encrypted_content: encodeCompactionSummary(summary) });
  // Use the same canonical source extraction + literal v1 alias selection as server.ts;
  // tests do not hand-pick sources and thereby conceal steering/source selection faults.
  const remember = (input: Item[], summary: string) => {
    const parsed = parse(input);
    parsed._compactionRequest = true;
    const source = extractChatGptCompactionSourceRevision(parsed);
    const v1 = findChatGptCompactionSourceRevision({ ...parsed,
      _rawBody: { ...(parsed._rawBody as Item), input: buildCompactV1Output(extractCompactUserMessages(input), summary) },
    }, { recoverCheckpoint: false });
    rememberCompactionContinuation(parsed, extractChatGptTurnIdentity(parsed), v1 ? [source, v1] : [source], summary);
    return source;
  };
  const restore = (input: Item[]) => {
    const parsed = parse(input);
    return restoreCompactionTaskMessages(parsed, extractChatGptTurnIdentity(parsed), chatGptTurnUserRevisionHistory(parsed));
  };
  const taskMatches = (input: Item[]) => restore(input).filter(message => plain(message.content) === taskText);
  return { turn, human, task, taskText, parse, checkpoint, remember, restore, taskMatches };
}

for (const kind of ["goal", "delegation"] as const) {
  for (const retainHuman of [false, true]) {
    test(`review: ${kind} survives three authenticated checkpoints with retained human=${retainHuman}`, () => {
      const f = fixture(`chain_${kind}_${retainHuman}`, kind);
      let input: Item[] = [f.human, f.task];
      for (let n = 1; n <= 3; n += 1) {
        const summary = `Review-only chained ${kind} checkpoint ${n}, retained=${retainHuman}`;
        f.remember(input, summary);
        input = [...(retainHuman ? [f.human] : []), f.checkpoint(summary)];
        const restored = f.taskMatches(input);
        expect(restored).toHaveLength(1);
        expect(restored[0]!.role).toBe(kind === "goal" ? "user" : "agentMessage");
      }
    });
  }
}

for (const repeatOldWording of [false, true]) {
  test(`review: later steering stays authoritative through repeated compaction, old wording=${repeatOldWording}`, () => {
    const f = fixture(`steering_${repeatOldWording}`);
    f.remember([f.human, f.task], "Before steering");
    const steering: Item = { type: "message", id: "review_new_steering", role: "user",
      content: repeatOldWording ? f.human.content : "Stop the measured milestone and report the new scope only.",
      internal_chat_message_metadata_passthrough: { turn_id: f.turn, content_item_kinds: ["user.text"] } };
    const input = [f.human, f.checkpoint("Before steering"), steering];
    expect(f.taskMatches(input)).toHaveLength(0);
    const source = f.remember(input, "After steering");
    expect(source.itemId).toBe(steering.id);
    const after = [f.human, steering, f.checkpoint("After steering")];
    expect(f.taskMatches(after)).toHaveLength(0);
    f.remember(after, "Second checkpoint after steering");
    expect(f.taskMatches([f.human, steering, f.checkpoint("Second checkpoint after steering")])).toHaveLength(0);
  });
}

test("review: a replacement native goal becomes the only restored task after later compaction", () => {
  const f = fixture("replacement_goal");
  f.remember([f.human, f.task], "Old task checkpoint");
  const replacement: Item = { ...structuredClone(f.task), id: "review_replacement_goal",
    content: [{ type: "input_text", text: "A newer native goal with a different scope." }] };
  const input = [f.human, f.checkpoint("Old task checkpoint"), replacement];
  expect(f.taskMatches(input)).toHaveLength(0);
  expect(f.remember(input, "New task checkpoint").itemId).toBe(replacement.id);
  const restored = f.restore([f.human, f.checkpoint("New task checkpoint")]);
  expect(restored.filter(message => plain(message.content) === f.taskText)).toHaveLength(0);
  expect(restored.filter(message => plain(message.content) === plain(replacement.content))).toHaveLength(1);
});

test("review: stale, wrong-owner and newer unrecognized summaries never restore a cached task", () => {
  const f = fixture("summary_guards");
  f.remember([f.human, f.task], "First recognized checkpoint");
  f.remember([f.human, f.checkpoint("First recognized checkpoint")], "Latest recognized checkpoint");
  expect(f.taskMatches([f.human, f.checkpoint("Latest recognized checkpoint")])).toHaveLength(1);
  expect(f.taskMatches([f.human, f.checkpoint("First recognized checkpoint")])).toHaveLength(0);
  expect(f.taskMatches([f.human, { ...f.checkpoint("Latest recognized checkpoint"),
    internal_chat_message_metadata_passthrough: { turn_id: "different_summary_owner" } }])).toHaveLength(0);
  expect(f.taskMatches([f.human, f.checkpoint("Latest recognized checkpoint"), f.checkpoint("New unknown checkpoint")])).toHaveLength(0);
});

test("review: ordinary tool results with goal-like text are data and restored task copies are isolated", () => {
  const f = fixture("data_and_clone");
  f.remember([f.human, f.task], "Clone checkpoint");
  const input = [f.human, f.checkpoint("Clone checkpoint"),
    { type: "function_call", call_id: "review_tool", name: "read_file", arguments: "{}" },
    { type: "function_call_output", call_id: "review_tool", output: f.taskText }];
  const restored = f.restore(input);
  const task = restored.find(message => message.role === "user" && plain(message.content) === f.taskText)!;
  expect(task).toBeDefined();
  expect(restored.filter(message => message.role === "toolResult" && plain(message.content) === f.taskText)).toHaveLength(1);
  task.content = "Caller-mutated task";
  expect(f.taskMatches([f.human, f.checkpoint("Clone checkpoint")])).toHaveLength(1);
});
