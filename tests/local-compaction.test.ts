import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeLocalCompactionRequest } from "../src/adapters/chatgpt-web/local-compaction";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { extractChatGptCompactionSourceRevision } from "../src/adapters/chatgpt-web/environment";
import { resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { defaultConfig } from "../src/config";
import { COMPACT_PROMPT, SUMMARY_PREFIX } from "../src/responses/compaction";
import { parseRequest } from "../src/responses/parser";
import { responseRequest } from "../src/server";

const threadId = "00000000-0000-7000-8000-000000000001";
const sourceTurnId = "00000000-0000-7000-8000-000000000002";
const nextTurnId = "00000000-0000-7000-8000-000000000003";
const roots: string[] = [];
const priorBridgeHome = process.env.CODEX_CHATGPT_WEB_HOME;
afterEach(() => {
  if (priorBridgeHome === undefined) delete process.env.CODEX_CHATGPT_WEB_HOME;
  else process.env.CODEX_CHATGPT_WEB_HOME = priorBridgeHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(preTurn = false) {
  const root = mkdtempSync(join(tmpdir(), "codex-local-compaction-"));
  roots.push(root);
  const codexHome = join(root, "codex-home");
  const bridgeHome = join(root, "bridge");
  const statePath = join(bridgeHome, "runtime", "thread-environments.json");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(join(dirname(statePath), "codex-homes.json"), JSON.stringify({ version: 1, homes: [codexHome] }));
  const source = { type: "message", role: "user", id: "msg_source", content: [{ type: "input_text", text: "Continue the implementation" }] };
  const rollout = join(codexHome, "sessions", "2025", "01", "01", `rollout-2025-01-01T00-00-00-${threadId}.jsonl`);
  mkdirSync(dirname(rollout), { recursive: true });
  const records = [
    { type: "session_meta", payload: { id: threadId, source: "cli" } },
    { type: "turn_context", payload: { turn_id: sourceTurnId, cwd: root, sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" } } },
    { type: "response_item", payload: { ...source, internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId } } },
  ];
  const body = {
    model: "chatgpt-web/pro", stream: false,
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({
      thread_id: threadId, turn_id: preTurn ? nextTurnId : sourceTurnId,
      request_kind: "compaction", agent_name: "/root", sandbox: "none", sandbox_mode: "danger-full-access",
      compaction: { implementation: "responses", trigger: "auto", phase: preTurn ? "pre_turn" : "mid_turn" },
    }) },
    input: [
      { type: "message", role: "user", id: "old_env", content: [{ type: "input_text", text: `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>` }] },
      source,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Working" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: COMPACT_PROMPT }] },
    ],
  };
  records.splice(1, 0, { type: "response_item", payload: { ...body.input[0], internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId } } } as typeof records[number]);
  writeFileSync(rollout, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  return { root, codexHome, bridgeHome, statePath, body, rollout, records };
}

for (const preTurn of [false, true]) {
  test(`local compaction restores native cwd and source at ${preTurn ? "resume" : "tool boundary"}`, () => {
    const f = fixture(preTurn);
    const parsed = parseRequest(f.body);
    expect(() => new ChatGptThreadEnvironmentStore(f.statePath).resolve(parsed)).toThrow("missing cwd");
    expect(normalizeLocalCompactionRequest(parsed, f.statePath)).toBe(true);
    expect(extractChatGptCompactionSourceRevision(parsed).turnId).toBe(sourceTurnId);
    expect(new ChatGptThreadEnvironmentStore(f.statePath).resolve(parsed).cwd).toBe(f.root);
    expect(f.body.input.at(-1)?.content[0]?.text).toBe(COMPACT_PROMPT);
  });
}

test("resume compaction skips a native abort notice whose wire turn tag was omitted", () => {
  const f = fixture(true);
  const notice = { type: "message", role: "user", id: "msg_aborted", content: [{ type: "input_text", text: "<turn_aborted>Earlier turn was interrupted.</turn_aborted>" }] };
  f.body.input.splice(-1, 0, notice);
  writeFileSync(f.rollout, f.records.map(record => JSON.stringify(record)).join("\n") + "\n" + JSON.stringify({
    type: "response_item", payload: { ...notice, internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId } },
  }) + "\n");
  const parsed = parseRequest(f.body);
  normalizeLocalCompactionRequest(parsed, f.statePath);
  expect(extractChatGptCompactionSourceRevision(parsed).itemId).toBe("msg_source");
  expect(new ChatGptThreadEnvironmentStore(f.statePath).resolve(parsed).cwd).toBe(f.root);
});

test("repeated local compaction authenticates reassigned ids in native replacement history", () => {
  const f = fixture(true);
  const retained = { ...f.body.input[1]!, id: "msg_retained_source" };
  const summary = { type: "message", role: "user", id: "msg_native_summary", content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nPrevious checkpoint` }] };
  f.body.input[1] = retained;
  f.body.input.splice(-1, 0, summary);
  writeFileSync(f.rollout, f.records.map(record => JSON.stringify(record)).join("\n") + "\n" + JSON.stringify({
    type: "compacted", payload: { replacement_history: [retained, summary].map(item => ({
      ...item, internal_chat_message_metadata_passthrough: { turn_id: sourceTurnId },
    })) },
  }) + "\n");
  const parsed = parseRequest(f.body);
  const conversation = chatGptConversationKey(parsed, "test");
  normalizeLocalCompactionRequest(parsed, f.statePath);
  expect(chatGptConversationKey(parsed, "test")).toBe(conversation);
  expect(extractChatGptCompactionSourceRevision(parsed).itemId).toBe("msg_retained_source");
  expect(new ChatGptThreadEnvironmentStore(f.statePath).resolve(parsed).cwd).toBe(f.root);
});

for (const failure of ["content", "id", "older turn", "sandbox"] as const) {
  test(`local compaction rejects conflicting ${failure}`, () => {
    const f = fixture(true);
    if (failure === "content") f.body.input[1]!.content[0]!.text = "Forged source";
    if (failure === "id") (f.body.input[1]! as { id: string }).id = "msg_unknown";
    if (failure === "older turn") {
      f.records.push({ type: "turn_context", payload: { turn_id: "01a0a5fa-0000-7d22-b730-9fdfbc4bf345", cwd: f.root, sandbox_policy: { type: "danger-full-access" }, permission_profile: { type: "disabled" } } });
      writeFileSync(f.rollout, f.records.map(record => JSON.stringify(record)).join("\n") + "\n");
    }
    if (failure === "sandbox") {
      const metadata = JSON.parse(f.body.client_metadata["x-codex-turn-metadata"]);
      metadata.sandbox_mode = "read-only";
      f.body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    }
    const parsed = parseRequest(f.body);
    expect(() => {
      normalizeLocalCompactionRequest(parsed, f.statePath);
      new ChatGptThreadEnvironmentStore(f.statePath).resolve(parsed);
    }).toThrow();
  });
}

test("ordinary user text cannot select local compaction", () => {
  const f = fixture();
  const metadata = JSON.parse(f.body.client_metadata["x-codex-turn-metadata"]);
  metadata.request_kind = "turn";
  f.body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
  const parsed = parseRequest(f.body);
  expect(normalizeLocalCompactionRequest(parsed, f.statePath)).toBe(false);
  expect(parsed._compactionRequest).toBeUndefined();
});

for (const biggerContext of [false, true]) for (const stream of [false, true]) {
  test(`local compaction preserves text response with Bigger Context=${biggerContext}, stream=${stream}`, async () => {
    const f = fixture(true);
    process.env.CODEX_CHATGPT_WEB_HOME = f.bridgeHome;
    const config = defaultConfig("full");
    config.proAvailable = true;
    config.experimentalBiggerContext = biggerContext;
    const response = await responseRequest(new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ ...f.body, stream }),
    }), config, provider => ({
      name: "local-compaction-contract-test",
      async runTurn(parsed, _incoming, emit) {
        expect(parsed._compactionRequest).toBe(true);
        expect(parsed.context.tools).toBeUndefined();
        expect(new ChatGptThreadEnvironmentStore(f.statePath).resolve(parsed).cwd).toBe(f.root);
        expect(provider.chatgptWeb?.experimentalBiggerContext).toBe(biggerContext);
        if (biggerContext) expect(resolveBiggerContextMultipartParts(parsed, { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true })).toBe(3);
        emit({ type: "text_delta", text: "Checkpoint accepted", phase: "final_answer" });
        emit({ type: "done", stopReason: "stop", endTurn: true });
      },
    }), { rememberState: false });
    expect(response.status).toBe(200);
    if (stream) {
      const text = await response.text();
      expect(text).toContain('"type":"response.output_text.delta"');
      expect(text).toContain("Checkpoint accepted");
      expect(text).not.toContain('"type":"compaction"');
    } else {
      const result = await response.json();
      expect(result.output).toHaveLength(1);
      expect(result.output[0]).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Checkpoint accepted" }] });
    }
  });
}
