import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { chatGptTurnUserRevisionHistory, extractChatGptTurnEnvironment, extractChatGptTurnUserRevision } from "../src/adapters/chatgpt-web/environment";
import { chatGptInstructionLineage } from "../src/adapters/chatgpt-web/turn-execution";
import { parseRequest } from "../src/responses/parser";
import type { CodexParsedRequest } from "../src/types";

const root = resolve(process.cwd());
const parentThreadId = "thread_parent";
const parentTurnId = "turn_parent";
const childThreadId = "thread_child";
const childTurnId = "turn_child";
const codexHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
const visualizationRoot = join(codexHome, "visualizations", "2026", "09", "07", parentThreadId);
const environment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root><root>${visualizationRoot}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;
const item = (id: string, role: "developer" | "user", text: string, turnId: string) => ({
  type: "message",
  id,
  role,
  content: [{ type: "input_text", text }],
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
});
const request = (
  threadId: string,
  turnId: string,
  input: Array<Record<string, unknown>>,
  parent?: string,
): CodexParsedRequest => ({
  modelId: "gpt-5.6-sol",
  stream: true,
  context: { messages: [], tools: [] },
  options: { reasoning: "high" },
  _rawBody: {
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn",
        thread_id: threadId,
        turn_id: turnId,
        ...(parent ? {
          parent_thread_id: parent,
          agent_name: "/root/reviewer",
          subagent_kind: "thread_spawn",
        } : {}),
        sandbox: "none",
        workspaces: { [root]: {} },
      }),
    },
    input,
  },
});

test("fork-context child accepts its inherited parent visualization root", () => {
  const parentInput = [
    item("msg_parent_environment", "user", environment, parentTurnId),
    item("msg_parent_prompt", "user", "Inspect the workspace.", parentTurnId),
  ];
  const store = new ChatGptThreadEnvironmentStore();
  const child = request(childThreadId, childTurnId, [
    ...parentInput,
    item("msg_child_developer", "developer", "Review only.", childTurnId),
    item("msg_child_prompt", "user", "Inspect the change.", childTurnId),
  ], parentThreadId);

  expect(store.resolve(child).cwd).toBe(root);
});

test("V2 parent instructions bind the current environment without changing native message roles", () => {
  const environmentItem = { ...item("msg_environment", "user", environment, childTurnId) };
  delete (environmentItem as Record<string, unknown>).internal_chat_message_metadata_passthrough;
  const task = {
    type: "agent_message", id: "amsg_task", author: "/root", recipient: "/root/reviewer",
    content: [{ type: "input_text", text: "Inspect the workspace." }],
  };
  const raw = request(childThreadId, childTurnId, [environmentItem, task], parentThreadId)._rawBody as Record<string, unknown>;
  raw.model = "chatgpt-web/high";
  const parsed = parseRequest(raw);
  expect(extractChatGptTurnEnvironment(parsed).cwd).toBe(root);
  expect(extractChatGptTurnUserRevision(parsed)).toEqual(task.content);
  expect(parsed.context.messages.at(-1)?.role).toBe("agentMessage");
  expect(parsed._rawBody).toEqual(raw);

  // A reply from a nested child or a peer is context, not a superseding parent instruction.
  const reply = { ...task, id: "amsg_reply", author: "/root/reviewer/worker", content: [{ type: "input_text", text: "Done." }] };
  for (const author of [reply.author, "/root/peer"]) {
    const continued = parseRequest({ ...raw, input: [environmentItem, task, { ...reply, author }] });
    expect(extractChatGptTurnUserRevision(continued)).toEqual(task.content);
    expect(chatGptTurnUserRevisionHistory(continued).map(revision => revision.itemId)).toEqual([task.id]);
  }
  const followup = { ...task, id: "amsg_followup", content: [{ type: "input_text", text: "Review the second file." }] };
  const continued = parseRequest({ ...raw, input: [environmentItem, task, reply, followup] });
  expect(extractChatGptTurnUserRevision(continued)).toEqual(followup.content);
  expect(chatGptTurnUserRevisionHistory(continued).map(revision => revision.itemId)).toEqual([task.id, followup.id]);

  for (const invalid of [
    { ...task, id: undefined }, { ...task, author: "/root/peer" },
    { ...task, recipient: "/root/other" }, { ...task, author: "/root/reviewer/worker" },
  ]) {
    const rejected = parseRequest({ ...raw, input: [environmentItem, invalid] });
    expect(() => extractChatGptTurnEnvironment(rejected)).toThrow("missing cwd");
    expect(() => extractChatGptTurnUserRevision(rejected)).toThrow("current-turn user message");
  }
  const stale = parseRequest({ ...raw, input: [environmentItem, { ...task, internal_chat_message_metadata_passthrough: { turn_id: parentTurnId } }] });
  expect(() => extractChatGptTurnEnvironment(stale)).toThrow("missing cwd");
  expect(() => extractChatGptTurnUserRevision(stale)).toThrow("conflicts with native Codex turn_id");
  const metadata = JSON.parse((raw.client_metadata as Record<string, string>)["x-codex-turn-metadata"]!);
  for (const changes of [{ parent_thread_id: undefined }, { parent_thread_id: childThreadId }, { subagent_kind: undefined }, { agent_name: "/root" }]) {
    const rejected = parseRequest({ ...raw, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, ...changes }) } });
    expect(() => extractChatGptTurnEnvironment(rejected)).toThrow("missing cwd");
    expect(() => extractChatGptTurnUserRevision(rejected)).toThrow("current-turn user message");
  }
  const restricted = parseRequest({ ...raw, client_metadata: { "x-codex-turn-metadata": JSON.stringify({ ...metadata, sandbox: "read-only" }) } });
  expect(() => extractChatGptTurnEnvironment(restricted)).toThrow("missing cwd");
});

test("OpenCodex-stripped V2 agent_message still binds the parent task and follow-up lineage", () => {
  const environmentItem = { ...item("msg_environment", "user", environment, childTurnId) };
  const task = {
    type: "agent_message", id: "amsg_task", author: "/root", recipient: "/root/reviewer",
    content: [{ type: "input_text", text: "Inspect the workspace." }],
  };
  const followup = {
    ...task,
    id: "amsg_followup",
    content: [{ type: "input_text", text: "Review the second file." }],
  };
  const raw = request(childThreadId, childTurnId, [environmentItem, task], parentThreadId)._rawBody as Record<string, unknown>;
  raw.model = "chatgpt-web/high";
  const stripProvenance = (value: Record<string, unknown>) => {
    const next = { ...value };
    delete next.id;
    delete next.internal_chat_message_metadata_passthrough;
    return next;
  };
  const strippedTask = parseRequest({
    ...raw,
    input: [stripProvenance(environmentItem), stripProvenance(task)],
  });
  expect(extractChatGptTurnEnvironment(strippedTask).cwd).toBe(root);
  expect(extractChatGptTurnUserRevision(strippedTask)).toEqual(task.content);
  const taskLineage = chatGptInstructionLineage(strippedTask);

  const strippedFollowup = parseRequest({
    ...raw,
    input: [stripProvenance(environmentItem), stripProvenance(task), stripProvenance(followup)],
  });
  expect(extractChatGptTurnUserRevision(strippedFollowup)).toEqual(followup.content);
  const followupLineage = chatGptInstructionLineage(strippedFollowup);
  expect(followupLineage.current).not.toBe(taskLineage.current);
  expect(followupLineage.predecessors.has(taskLineage.current)).toBe(true);

  const strippedPeer = parseRequest({
    ...raw,
    input: [
      stripProvenance(environmentItem),
      stripProvenance({ ...task, author: "/root/peer", recipient: "/root/reviewer" }),
    ],
  });
  expect(() => extractChatGptTurnUserRevision(strippedPeer)).toThrow("current-turn user message");
});
