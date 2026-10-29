import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { encodeCompactionSummary } from "../src/responses/compaction";
import { rememberCompactionContinuation, restoreCompactionTaskMessages } from "../src/adapters/chatgpt-web/compaction-continuation";
import { extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity, extractChatGptTurnUserRevision,
  chatGptTurnUserRevisionHistory } from "../src/adapters/chatgpt-web/environment";

type Item = Record<string, any>;
function fixture(name: string) {
  const thread = `preturn_${name}`;
  const goal: Item = { type: "message", role: "user", id: `${name}_goal`, content: "Continue the measured research goal.",
    internal_chat_message_metadata_passthrough: { turn_id: "previous", content_item_kinds: ["goal.internal_context"] } };
  const parse = (input: Item[], turn = "next", owner = thread, effort = "high") => parseRequest({
    model: "gpt-6-sol", reasoning: { effort }, input,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: owner, turn_id: turn }) },
  });
  const summary = `Verified completed checkpoint ${name}`;
  const seed = (turn = "previous") => {
    const parsed = parse([{ ...goal, internal_chat_message_metadata_passthrough: { ...goal.internal_chat_message_metadata_passthrough, turn_id: turn } }], turn);
    parsed._compactionRequest = true;
    const source = extractChatGptCompactionSourceRevision(parsed);
    rememberCompactionContinuation(parsed, extractChatGptTurnIdentity(parsed), [source], summary);
  };
  const compact = (input: Item[], turn = "next", owner = thread, effort = "high") => {
    const parsed = parse(input, turn, owner, effort);
    parsed._compactionRequest = true;
    return parsed;
  };
  const checkpoint: Item = { type: "compaction", encrypted_content: encodeCompactionSummary(summary) };
  const context: Item = { type: "message", role: "user", id: `${name}_context`, content: "<environment_context>Context only</environment_context>",
    internal_chat_message_metadata_passthrough: { turn_id: "previous", content_item_kinds: ["environments.environment_context"] } };
  return { thread, goal, parse, compact, seed, checkpoint, context, summary };
}

test("a new turn can compact a verified previous-turn checkpoint after native history dropped every instruction", () => {
  const f = fixture("native_goal");
  f.seed();
  const input = [f.context, f.checkpoint, { type: "function_call_output", call_id: "data", output: "Historical tool data" }];
  const compact = f.compact(input);
  expect(extractChatGptCompactionSourceRevision(compact).itemId).toBe(f.goal.id);
  expect(() => extractChatGptCompactionSourceRevision(compact, { recoverCheckpoint: false })).toThrow("requires a source user message");
  // Historical source recovery is exclusive to compaction; it never restores an old goal
  // as a newly authorized ordinary turn or fabricates a new native goal instruction.
  const ordinary = f.parse(input);
  expect(() => extractChatGptTurnUserRevision(ordinary)).toThrow("current-turn user message");
  expect(restoreCompactionTaskMessages(ordinary, extractChatGptTurnIdentity(ordinary), chatGptTurnUserRevisionHistory(ordinary))
    .some(message => message.role === "user" && message.content === f.goal.content)).toBe(false);
  const fresh = { ...f.goal, id: "fresh_goal", content: "Measure the next distinct research milestone.",
    internal_chat_message_metadata_passthrough: { turn_id: "next", content_item_kinds: ["goal.internal_context"] } };
  expect(extractChatGptCompactionSourceRevision(f.compact([...input, fresh])).itemId).toBe(fresh.id);
  const source = extractChatGptCompactionSourceRevision(compact);
  rememberCompactionContinuation(compact, extractChatGptTurnIdentity(compact), [source], "New pre-turn checkpoint");
  const replaced = [{ type: "compaction", encrypted_content: encodeCompactionSummary("New pre-turn checkpoint") }, fresh];
  expect(extractChatGptTurnUserRevision(f.parse(replaced))).toBe(fresh.content);
  const resumed = f.parse(replaced);
  expect(restoreCompactionTaskMessages(resumed, extractChatGptTurnIdentity(resumed), chatGptTurnUserRevisionHistory(resumed))
    .filter(message => message.role === "user" && message.content === fresh.content)).toHaveLength(1);
  // An existing current-turn checkpoint must not roll back to an older turn's summary.
  expect(() => extractChatGptCompactionSourceRevision(f.compact(input))).toThrow("requires a source user message");
});

test("pre-turn recovery rejects unknown, changed, wrong-owner, wrong-thread, wrong-effort and ambiguous checkpoints", () => {
  const f = fixture("guards");
  f.seed();
  const reject = [
    f.compact([{ type: "compaction", encrypted_content: encodeCompactionSummary("Unknown summary") }]),
    f.compact([f.checkpoint, { type: "compaction", encrypted_content: encodeCompactionSummary("New unknown summary") }]),
    f.compact([{ ...f.checkpoint, internal_chat_message_metadata_passthrough: { turn_id: "unrecognized" } }]),
    f.compact([f.checkpoint], "next", "other_thread"),
    f.compact([f.checkpoint], "next", f.thread, "medium"),
    { ...f.compact([f.checkpoint]), modelId: "gpt-6-pro" },
  ];
  for (const parsed of reject) expect(() => extractChatGptCompactionSourceRevision(parsed)).toThrow("requires a source user message");
  f.seed("another_previous");
  expect(() => extractChatGptCompactionSourceRevision(f.compact([f.checkpoint]))).toThrow("requires a source user message");
});
