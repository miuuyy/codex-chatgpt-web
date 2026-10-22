import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { buildCompactV1Output, encodeCompactionSummary, extractCompactUserMessages } from "../src/responses/compaction";
import { canonicalizeCompactionHandoff, LATEST_USER_PROMPT_MARKER } from "../src/adapters/chatgpt-web/compaction-handoff";
import { rememberCompactionContinuation } from "../src/adapters/chatgpt-web/compaction-continuation";
import { chatGptTurnUserRevisionHistory, extractChatGptCompactionSourceRevision, extractChatGptTurnIdentity,
  extractChatGptTurnUserRevision, findChatGptCompactionSourceRevision } from "../src/adapters/chatgpt-web/environment";

type Item = Record<string, any>;
const text = (content: any): string => typeof content === "string" ? content : content.map((part: any) => part.text).join("\n");

for (const format of ["v1", "v2"] as const) {
  test(`${format}: repeated native goal compaction never relabels an obsolete human request as the latest task`, () => {
    const turnId = `goal_source_${format}`;
    const human: Item = { type: "message", role: "user", id: "old_human", content: [{ type: "input_text", text: "Retrieve the already-completed old audit only." }],
      internal_chat_message_metadata_passthrough: { turn_id: "old_turn", content_item_kinds: ["user.text"] } };
    const goalText = '<codex_internal_context source="goal">Continue the current regression repair. The old audit is complete.</codex_internal_context>';
    const goal: Item = { type: "message", role: "user", id: "current_goal", content: [{ type: "input_text", text: goalText }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["goal.internal_context"] } };
    const parse = (input: Item[]) => parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input,
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: `thread_${turnId}`, turn_id: turnId }) } });
    let input = [human, goal];
    for (let checkpoint = 1; checkpoint <= 3; checkpoint++) {
      const parsed = parse(input);
      parsed._compactionRequest = true;
      const summary = canonicalizeCompactionHandoff(parsed, `Checkpoint ${checkpoint}: continue the regression repair.`);
      expect(JSON.parse(summary.split(`${LATEST_USER_PROMPT_MARKER}\n`)[1]!)).toBe(goalText);
      const source = extractChatGptCompactionSourceRevision(parsed);
      expect(source.itemId).toBe(goal.id);
      const retained = buildCompactV1Output(extractCompactUserMessages(input), summary);
      const alias = findChatGptCompactionSourceRevision({ ...parsed, _rawBody: { ...parsed._rawBody as Item, input: retained } },
        { recoverCheckpoint: false });
      rememberCompactionContinuation(parsed, extractChatGptTurnIdentity(parsed), alias ? [source, alias] : [source], summary);
      input = format === "v1" ? retained : [human, { type: "compaction", encrypted_content: encodeCompactionSummary(summary) }];
      const resumed = parse(input);
      expect(text(extractChatGptTurnUserRevision(resumed))).toBe(goalText);
      expect(chatGptTurnUserRevisionHistory(resumed).map(revision => revision.itemId)).toEqual([goal.id]);
      // Recovery must not authorize a rewritten retained message or an unrecognized checkpoint.
      const changedHistory = input.map(item => item.id === human.id
        ? { ...item, content: [{ type: "input_text", text: "An unrecognized retained instruction." }] } : item);
      const changedCheckpoint = buildCompactV1Output(extractCompactUserMessages(input), "Unrecognized checkpoint");
      for (const rejected of [parse(changedHistory), parse(changedCheckpoint)]) {
        rejected._compactionRequest = true;
        expect(extractChatGptCompactionSourceRevision(rejected).itemId).toBe(human.id);
        expect(() => extractChatGptTurnUserRevision(rejected)).toThrow("conflicts with native Codex turn_id");
      }
    }
    const steering = { type: "message", role: "user", id: "new_steering", content: human.content,
      internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["user.text"] } };
    const steered = parse([...input, steering]);
    steered._compactionRequest = true;
    expect(extractChatGptCompactionSourceRevision(steered).itemId).toBe(steering.id);
    expect(JSON.parse(canonicalizeCompactionHandoff(steered, "New human steering wins.").split(`${LATEST_USER_PROMPT_MARKER}\n`)[1]!))
      .toBe(text(human.content));
  });
}
