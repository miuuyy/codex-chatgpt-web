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

function currentSeatbeltWire(mode: "readOnly" | "workspaceWrite"): CodexParsedRequest {
  const wire = currentWire({ sandbox: "seatbelt" });
  const body = wire._rawBody as {
    client_metadata: { "x-codex-turn-metadata": string };
    input: Array<{
      internal_chat_message_metadata_passthrough?: { turn_id: string };
      content: Array<{ text: string }>;
    }>;
  };
  body.client_metadata["x-codex-turn-metadata"] = JSON.stringify({
    thread_id: "thread_current",
    turn_id: "turn_current",
    sandbox: "seatbelt",
  });
  for (const item of body.input) {
    item.internal_chat_message_metadata_passthrough = { turn_id: "turn_current" };
  }
  const entries = mode === "readOnly"
    ? '<entry access="read"><special>:root</special></entry>'
    : `<entry access="read"><special>:root</special></entry>
      <entry access="write"><path>${root}</path></entry>
      <entry access="write"><special>:tmpdir</special></entry>`;
  body.input[0]!.content[1]!.text = `<environment_context>
    <cwd>${root}</cwd>
    <filesystem><workspace_roots><root>${root}</root></workspace_roots><permission_profile type="managed"><file_system type="restricted">${entries}</file_system></permission_profile></filesystem>
  </environment_context>`;
  return wire;
}

describe("trusted current Codex environment envelope", () => {
  test("accepts the v0.146 split envelope when workspace and sandbox metadata agree", () => {
    expect(extractChatGptTurnEnvironment(currentWire())).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("accepts current file_system and camelCase read-only metadata when they agree", () => {
    const wire = currentWire({ sandbox: "readOnly" });
    const input = (wire._rawBody as { input: Array<{ content: Array<{ text: string }> }> }).input;
    input[0]!.content[1]!.text = environmentXml.replace('type="unrestricted"', 'type="read-only"');
    expect(extractChatGptTurnEnvironment(wire)).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      tools: [],
    });
  });

  test("accepts the current macOS Seatbelt read-only envelope", () => {
    expect(extractChatGptTurnEnvironment(currentSeatbeltWire("readOnly"))).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      tools: [],
    });
  });

  test("derives writable roots from the current macOS Seatbelt envelope", () => {
    expect(extractChatGptTurnEnvironment(currentSeatbeltWire("workspaceWrite"))).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [root], networkAccess: false },
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
