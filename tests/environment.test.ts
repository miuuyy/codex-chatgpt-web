import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import type { CodexParsedRequest, CodexTool } from "../src/types";

const root = resolve(process.cwd());
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});
const environmentXml = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
</environment_context>`;

function currentWire(options: { workspace?: string; sandbox?: string; includeIds?: boolean } = {}): CodexParsedRequest {
  const workspace = options.workspace ?? root;
  const sandbox = options.sandbox ?? "none";
  const includeIds = options.includeIds ?? true;
  const turnMetadata = {
    thread_id: "thread_current",
    turn_id: "turn_current",
    sandbox,
    workspaces: { [workspace]: { has_changes: true } },
  };
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: { messages: [{ role: "user", content: "Inspect the workspace", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(turnMetadata) },
      input: [
        {
          type: "message",
          ...(includeIds ? { id: "msg_context" } : {}),
          role: "user",
          content: [
            { type: "input_text", text: "<app-context>native app context</app-context>" },
            { type: "input_text", text: environmentXml },
          ],
        },
        {
          type: "message",
          ...(includeIds ? { id: "msg_active" } : {}),
          role: "user",
          content: [{ type: "input_text", text: "Inspect the workspace" }],
        },
      ],
    },
  };
}

describe("trusted current Codex environment envelope", () => {
  test("accepts the v0.145 managed restricted workspace envelope", () => {
    const managedEnvironment = `<environment_context>
  <cwd>${root}</cwd>
  <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="managed"><file_system type="restricted"><entry access="read"><special>:root</special></entry><entry access="write"><path>${root}</path></entry></file_system></permission_profile></filesystem>
</environment_context>`;
    const parsed = currentWire({ sandbox: "workspace-write" });
    const input = (parsed._rawBody as { input: Array<{ content: Array<{ text: string }> }> }).input;
    input[0]!.content[1]!.text = managedEnvironment;

    expect(extractChatGptTurnEnvironment(parsed)).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      tools: [],
    });
  });

  test("accepts the v0.145 trusted prose sandbox envelope", () => {
    const parsed = currentWire();
    parsed._rawBody = {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Inspect the workspace" }],
        },
      ],
    };
    parsed.context.systemPrompt = [
      `<environment_context><cwd>${root}</cwd><filesystem><workspace_roots><root>${root}</root></workspace_roots></filesystem></environment_context>`,
    ];
    parsed.context.messages.unshift({
      role: "developer",
      content: "<permissions instructions>Filesystem sandboxing is active. `sandbox_mode` is `workspace-write`.</permissions instructions>",
      timestamp: 0,
    });

    expect(extractChatGptTurnEnvironment(parsed)).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
      tools: [],
    });
  });

  test("accepts the v0.146 split envelope when workspace and sandbox metadata agree", () => {
    expect(extractChatGptTurnEnvironment(currentWire())).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("rejects a workspace mismatch", () => {
    expect(() => extractChatGptTurnEnvironment(currentWire({ workspace: resolve(root, "elsewhere") })))
      .toThrow("missing cwd");
  });

  test("rejects a sandbox mismatch", () => {
    expect(() => extractChatGptTurnEnvironment(currentWire({ sandbox: "read-only" })))
      .toThrow("missing cwd");
  });

  test("rejects unprovenanced adjacent user content without native item ids", () => {
    expect(() => extractChatGptTurnEnvironment(currentWire({ includeIds: false })))
      .toThrow("missing cwd");
  });
});

describe("trusted Codex task environment continuity", () => {
  test("persists the trusted first-turn authority and refreshes tools from every follow-up", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "codex-chatgpt-thread-environment-"));
    temporaryRoots.push(stateRoot);
    const statePath = join(stateRoot, "thread-environments.json");
    const first = currentWire();
    const firstTools: CodexTool[] = [{ name: "first_tool", description: "first", parameters: { type: "object" } }];
    first.context.tools = firstTools;

    expect(new ChatGptThreadEnvironmentStore(statePath).resolve(first).tools).toEqual(firstTools);
    const onDisk = readFileSync(statePath, "utf8");
    expect(onDisk).toContain('"thread_current"');
    expect(onDisk).not.toContain("first_tool");

    const next = currentWire();
    const nextTools: CodexTool[] = [{ name: "next_tool", description: "next", parameters: { type: "object" } }];
    next.context.tools = nextTools;
    next._rawBody = {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_current", turn_id: "turn_next" }),
      },
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue the same task" }],
      }],
    };

    expect(new ChatGptThreadEnvironmentStore(statePath).resolve(next)).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: nextTools,
    });
  });

  test("does not borrow authority across threads or hide an invalid trusted update", () => {
    const store = new ChatGptThreadEnvironmentStore();
    store.resolve(currentWire());

    const unrelated = currentWire();
    unrelated._rawBody = {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_unrelated", turn_id: "turn_next" }),
      },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] }],
    };
    expect(() => store.resolve(unrelated)).toThrow("missing cwd");

    const invalidUpdate = currentWire({ sandbox: "read-only" });
    invalidUpdate.context.systemPrompt = [`<environment_context><cwd>${root}</cwd></environment_context>`];
    expect(() => store.resolve(invalidUpdate)).toThrow("requires one explicit trusted Codex sandbox mode");
  });
});
