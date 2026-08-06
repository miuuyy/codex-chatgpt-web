import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

function projectlessWire(): CodexParsedRequest {
  const turnMetadata = {
    thread_id: "thread_projectless",
    turn_id: "turn_projectless",
    sandbox: "none",
    workspace_kind: "projectless",
  };
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "developer", content: "You are Codex Desktop.", timestamp: 1 },
        { role: "user", content: "No project attached", timestamp: 2 },
      ],
    },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(turnMetadata) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "No project attached" }] }],
    },
  };
}

function projectWire(workspace = root): CodexParsedRequest {
  const turnMetadata = {
    thread_id: "thread_project",
    turn_id: "turn_project",
    sandbox: "none",
    workspace_kind: "project",
    workspaces: { [workspace]: { has_changes: true } },
  };
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: {
      messages: [
        { role: "developer", content: "You are Codex Desktop.", timestamp: 1 },
        { role: "user", content: "Inspect the project", timestamp: 2 },
      ],
    },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify(turnMetadata) },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project" }] }],
    },
  };
}

describe("projectful Codex Desktop turns without an envelope", () => {
  test("fabricates a trusted environment from workspace metadata", () => {
    expect(extractChatGptTurnEnvironment(projectWire())).toEqual({
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("rejects workspace metadata without absolute roots", () => {
    const wire = projectWire();
    wire._rawBody = {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_project",
          turn_id: "turn_project",
          sandbox: "none",
          workspace_kind: "project",
          workspaces: { "relative/path": { has_changes: true } },
        }),
      },
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Inspect" }] }],
    };
    expect(() => extractChatGptTurnEnvironment(wire)).toThrow("missing cwd");
  });
});

describe("projectless Codex Desktop turns", () => {
  test("fabricates a synthetic trusted environment keyed to the user home", () => {
    expect(extractChatGptTurnEnvironment(projectlessWire())).toEqual({
      cwd: homedir(),
      roots: [homedir()],
      writableRoots: [homedir()],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });

  test("persists the synthetic authority so follow-up turns reuse it", () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "codex-chatgpt-projectless-"));
    temporaryRoots.push(stateRoot);
    const statePath = join(stateRoot, "thread-environments.json");
    const first = projectlessWire();
    const firstTools: CodexTool[] = [{ name: "read", description: "read", parameters: { type: "object" } }];
    first.context.tools = firstTools;
    expect(new ChatGptThreadEnvironmentStore(statePath).resolve(first).tools).toEqual(firstTools);

    const next = projectlessWire();
    const nextTools: CodexTool[] = [{ name: "read", description: "read", parameters: { type: "object" } }];
    next.context.tools = nextTools;
    expect(new ChatGptThreadEnvironmentStore(statePath).resolve(next)).toEqual({
      cwd: homedir(),
      roots: [homedir()],
      writableRoots: [homedir()],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: nextTools,
    });
  });

  test("trusts a projectless native env block without workspace metadata", () => {
    const cwd = join(homedir(), "Documents", "Codex");
    const envXml = `<environment_context>
  <cwd>${cwd}</cwd>
  <shell>powershell</shell>
  <current_date>2026-08-03</current_date>
  <timezone>Asia/Riyadh</timezone>
  <filesystem><workspace_roots><root>${cwd}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
  <sandbox_mode>danger-full-access</sandbox_mode>
</environment_context>`;
    const wire = projectlessWire();
    wire._rawBody = {
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "thread_p_blank",
          turn_id: "turn_p_blank",
          sandbox: "none",
          workspace_kind: "projectless",
        }),
      },
      input: [
        {
          type: "message",
          id: "msg_env",
          role: "user",
          content: [{ type: "input_text", text: "<app-context>native</app-context>" }, { type: "input_text", text: envXml }],
        },
        { type: "message", role: "developer", id: "msg_dev", content: [{ type: "input_text", text: "tool result" }] },
        { type: "message", role: "user", id: "msg_active", content: [{ type: "input_text", text: "hi" }] },
      ],
    };
    expect(extractChatGptTurnEnvironment(wire)).toEqual({
      cwd,
      roots: [cwd],
      writableRoots: [cwd],
      sandboxPolicy: { type: "dangerFullAccess" },
      tools: [],
    });
  });
});

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
