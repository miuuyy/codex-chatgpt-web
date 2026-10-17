import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatGptThreadEnvironmentStore } from "../src/adapters/chatgpt-web/thread-environment";
import { getAdditionalTrustedCodexHomes } from "../src/codex-integration-shared";
import type { CodexParsedRequest, CodexTool } from "../src/types";

// Reproduces the relevant native fields of the 2026-10-17 Codex CLI 0.163
// Account2 failure: source=exec, omitted workspace_roots, read-only sandbox,
// managed/restricted network, and no independent network declaration in XML.
// IDs, projects, instructions and account state are synthetic and isolated.
const ACCOUNT1_THREAD = "01a10000-1111-7111-8111-111111111111";
const ACCOUNT1_TURN = "01a10000-1111-7111-8111-222222222222";
const ACCOUNT2_THREAD = "01a20000-2222-7222-8222-222222222222";
const ACCOUNT2_TURN = "01a20000-2222-7222-8222-333333333333";
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "web-bridge-multi-codex-"));
  temporary.push(root);
  const primary = join(root, "primary-codex");
  const account2 = join(root, "account2-codex");
  const project = join(root, "project");
  mkdirSync(primary, { recursive: true });
  mkdirSync(account2, { recursive: true });
  mkdirSync(project, { recursive: true });
  const store = () => new ChatGptThreadEnvironmentStore(undefined, Date.now, primary, undefined, [account2]);
  return { root, primary, account2, project, store };
}

type Mode = "read-only" | "workspace-write";

function environmentXml(project: string, mode: Mode) {
  const entries = mode === "read-only"
    ? '<entry access="read"><special>:root</special></entry>'
    : `<entry access="read"><special>:root</special></entry><entry access="write"><path>${project}</path></entry>`;
  return `<environment_context><cwd>${project}</cwd><filesystem><workspace_roots><root>${project}</root></workspace_roots><permission_profile type="managed"><file_system type="restricted">${entries}</file_system></permission_profile></filesystem></environment_context>`;
}

function nativeProfile(project: string, mode: Mode, enabled = false) {
  const entries: Array<Record<string, unknown>> = [
    { path: { type: "special", value: { kind: "root" } }, access: "read" },
  ];
  if (mode === "workspace-write") {
    entries.push(
      { path: { type: "path", path: project }, access: "write" },
      { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
      { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
    );
  }
  const policy = mode === "read-only"
    ? { type: mode, ...(enabled ? { network_access: true } : {}) }
    : { type: mode, writable_roots: [], network_access: enabled };
  const permission = {
    type: "managed",
    network: enabled ? "enabled" : "restricted",
    file_system: { type: "restricted", entries },
  };
  return { policy, permission };
}

function writeRollout(home: string, threadId: string, turnId: string, project: string, mode: Mode, enabled = false) {
  const path = join(home, "sessions", "2026", "10", "17", `rollout-2026-10-17T02-47-39-${threadId}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  const { policy, permission } = nativeProfile(project, mode, enabled);
  writeFileSync(path, [
    { type: "session_meta", payload: { id: threadId, source: "exec" } },
    { type: "response_item", payload: {
      type: "message", id: "msg_context", role: "user",
      content: [{ type: "input_text", text: environmentXml(project, mode) }],
    } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "turn_context", payload: {
      turn_id: turnId, cwd: project,
      sandbox_policy: policy, permission_profile: permission,
    } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n", "utf8");
  return path;
}

function request(project: string, threadId: string, turnId: string, mode: Mode = "read-only", tools: CodexTool[] = []): CodexParsedRequest {
  return {
    modelId: "chatgpt-web/high", stream: true,
    context: { messages: [{ role: "user", content: "OK", timestamp: 1 }], tools },
    options: { reasoning: "high" },
    _rawBody: {
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({
        request_kind: "turn", thread_id: threadId, turn_id: turnId, agent_name: "/root",
        sandbox_mode: mode, workspaces: { [project]: {} },
      }) },
      input: [
        { type: "message", id: "msg_context", role: "user", content: [{ type: "input_text", text: environmentXml(project, mode) }] },
        { type: "message", id: "msg_prompt", role: "user", content: [{ type: "input_text", text: "OK" }] },
      ],
    },
  };
}

describe("independently trusted Codex CLI homes", () => {
  test("Account2's observed missing-network read-only envelope resolves only from its own native rollout", () => {
    const f = fixture();
    writeRollout(f.account2, ACCOUNT2_THREAD, ACCOUNT2_TURN, f.project, "read-only");
    const turn = request(f.project, ACCOUNT2_THREAD, ACCOUNT2_TURN);
    expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, f.primary).resolve(turn))
      .toThrow("network access");
    expect(f.store().resolve(turn)).toEqual({
      cwd: f.project, roots: [f.project], writableRoots: [],
      sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [],
    });
  });

  test("Account1 and Account2 keep separate native ownership, network policies and live tools", () => {
    const f = fixture();
    writeRollout(f.primary, ACCOUNT1_THREAD, ACCOUNT1_TURN, f.project, "read-only", true);
    writeRollout(f.account2, ACCOUNT2_THREAD, ACCOUNT2_TURN, f.project, "read-only", false);
    const tools: CodexTool[] = [{ name: "native_shell", description: "read-only", parameters: { type: "object" } }];
    const store = f.store();
    expect(store.resolve(request(f.project, ACCOUNT1_THREAD, ACCOUNT1_TURN, "read-only", tools))).toMatchObject({
      sandboxPolicy: { type: "readOnly", networkAccess: true }, tools,
    });
    expect(store.resolve(request(f.project, ACCOUNT2_THREAD, ACCOUNT2_TURN))).toMatchObject({
      sandboxPolicy: { type: "readOnly", networkAccess: false }, tools: [],
    });
  });

  test("both network states in workspace-write are restored from the original permission profile", () => {
    for (const enabled of [false, true]) {
      const f = fixture();
      writeRollout(f.account2, ACCOUNT2_THREAD, ACCOUNT2_TURN, f.project, "workspace-write", enabled);
      expect(f.store().resolve(request(f.project, ACCOUNT2_THREAD, ACCOUNT2_TURN, "workspace-write")))
        .toMatchObject({ sandboxPolicy: {
          type: "workspaceWrite", networkAccess: enabled, writableRoots: [f.project],
        }, writableRoots: [f.project] });
    }
  });

  test("absent, forged, stale-turn and cross-account references never obtain another task's policy", () => {
    const f = fixture();
    writeRollout(f.account2, ACCOUNT2_THREAD, ACCOUNT2_TURN, f.project, "read-only");
    expect(() => f.store().resolve(request(f.project, ACCOUNT1_THREAD, ACCOUNT1_TURN)))
      .toThrow("native Codex task proof");
    expect(() => f.store().resolve(request(f.project, "not-a-native-id", ACCOUNT2_TURN)))
      .toThrow("invalid native identifier");
    expect(() => f.store().resolve(request(f.project, ACCOUNT2_THREAD, ACCOUNT1_TURN)))
      .toThrow("current turn");
    expect(() => f.store().resolve(request(join(f.root, "other"), ACCOUNT2_THREAD, ACCOUNT2_TURN)))
      .toThrow();
    expect(() => f.store().resolve(request(f.project, ACCOUNT2_THREAD, ACCOUNT2_TURN, "workspace-write")))
      .toThrow();
  });

  test("duplicate native thread/turn identities across account homes fail closed even when policies agree", () => {
    const f = fixture();
    writeRollout(f.primary, ACCOUNT2_THREAD, ACCOUNT2_TURN, f.project, "read-only");
    writeRollout(f.account2, ACCOUNT2_THREAD, ACCOUNT2_TURN, f.project, "read-only");
    expect(() => f.store().resolve(request(f.project, ACCOUNT2_THREAD, ACCOUNT2_TURN)))
      .toThrow("Conflicting Codex rollouts");
  });

  test("malformed operator allowlist fails closed; explicitly named account directories are distinct", () => {
    const f = fixture();
    const original = process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES;
    try {
      process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = JSON.stringify([f.account2]);
      expect(getAdditionalTrustedCodexHomes()).toEqual([f.account2]);
      process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = JSON.stringify(["../not-an-absolute-path"]);
      expect(() => getAdditionalTrustedCodexHomes()).toThrow("absolute paths");
      process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = '{"home":"not-an-array"}';
      expect(() => getAdditionalTrustedCodexHomes()).toThrow("absolute paths");
      process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = JSON.stringify(Array(8).fill(f.account2));
      expect(() => getAdditionalTrustedCodexHomes()).toThrow("seven absolute paths");
      process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = JSON.stringify(["\\\\receiver.invalid\\share"]);
      expect(() => getAdditionalTrustedCodexHomes()).toThrow("absolute paths");
      process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = JSON.stringify([join(f.root, "missing")]);
      expect(() => getAdditionalTrustedCodexHomes()).toThrow("not a local directory");
    } finally {
      if (original === undefined) delete process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES;
      else process.env.CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES = original;
    }
  });
});

function rewriteNative(path: string, mutate: (records: any[]) => void) {
  const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  mutate(records);
  writeFileSync(path, records.map(value => JSON.stringify(value)).join("\n") + "\n");
}

function currentRequest(project: string, thread: string, turn: string, mode: Mode = "read-only", network?: boolean) {
  const value = request(project, thread, turn, mode);
  const body = value._rawBody as any;
  for (const item of body.input) item.internal_chat_message_metadata_passthrough = { turn_id: turn };
  if (network !== undefined) body.input[0].content[0].text = body.input[0].content[0].text.replace(
    "<filesystem>", `<network_access>${network ? "enabled" : "restricted"}</network_access><filesystem>`,
  );
  return value;
}

function state(databasePath: string, thread: string, rollout: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath, { create: true });
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, agent_path TEXT)");
  db.exec("CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT, status TEXT)");
  db.query("INSERT INTO threads VALUES (?, ?, NULL)").run(thread, rollout);
  db.close();
}

describe("multi-account native authority boundaries", () => {
  for (const account of [1, 2]) for (const mode of ["read-only", "workspace-write"] as const) {
    for (const enabled of [false, true]) test(`Account${account}: ${mode}, network=${enabled}, explicit current envelope`, () => {
      const f = fixture();
      const [home, thread, turn] = account === 1
        ? [f.primary, ACCOUNT1_THREAD, ACCOUNT1_TURN] : [f.account2, ACCOUNT2_THREAD, ACCOUNT2_TURN];
      writeRollout(home, thread, turn, f.project, mode, enabled);
      expect(f.store().resolve(currentRequest(f.project, thread, turn, mode, enabled)).sandboxPolicy)
        .toMatchObject({ networkAccess: enabled });
      expect(() => f.store().resolve(currentRequest(f.project, thread, turn, mode, !enabled)))
        .toThrow("network_access");
    });
  }

  test("a complete envelope cannot bypass duplicate-account proof or fabricate a native task", () => {
    const f = fixture();
    const body = currentRequest(f.project, ACCOUNT1_THREAD, ACCOUNT1_TURN, "read-only", false);
    expect(() => f.store().resolve(body)).toThrow("native Codex task proof");
    writeRollout(f.primary, ACCOUNT1_THREAD, ACCOUNT1_TURN, f.project, "read-only");
    writeRollout(f.account2, ACCOUNT1_THREAD, ACCOUNT1_TURN, f.project, "read-only");
    expect(() => f.store().resolve(body)).toThrow("Conflicting Codex rollouts");
  });

  test("multi-account mode neither merges legacy caches nor borrows cached permissions on a new turn", () => {
    const f = fixture();
    writeRollout(f.account2, ACCOUNT2_THREAD, ACCOUNT2_TURN, f.project, "read-only");
    const cache = join(f.root, "legacy-environments.json");
    writeFileSync(cache, "deliberately invalid legacy cache preserved byte-for-byte");
    const store = new ChatGptThreadEnvironmentStore(cache, Date.now, f.primary, undefined, [f.account2]);
    expect(store.resolve(currentRequest(f.project, ACCOUNT2_THREAD, ACCOUNT2_TURN)).sandboxPolicy.type).toBe("readOnly");
    expect(readFileSync(cache, "utf8")).toBe("deliberately invalid legacy cache preserved byte-for-byte");
    expect(() => store.resolve(currentRequest(f.project, ACCOUNT1_THREAD, ACCOUNT1_TURN))).toThrow("native Codex task proof");
    expect(existsSync(join(f.primary, "auth.json"))).toBe(false);
    expect(existsSync(join(f.account2, "auth.json"))).toBe(false);
  });

  test("Account2 does not inherit Account1's SQLite override; its own sqlite_home remains authoritative", () => {
    const f = fixture();
    const rollout = writeRollout(f.account2, ACCOUNT2_THREAD, ACCOUNT2_TURN, f.project, "read-only");
    const primaryState = join(f.root, "primary-state");
    state(join(primaryState, "state_5.sqlite"), ACCOUNT1_THREAD, join(f.primary, "missing.jsonl"));
    const previous = process.env.CODEX_SQLITE_HOME;
    process.env.CODEX_SQLITE_HOME = primaryState;
    try {
      expect(f.store().resolve(currentRequest(f.project, ACCOUNT2_THREAD, ACCOUNT2_TURN)).sandboxPolicy.type).toBe("readOnly");
      const account2State = join(f.account2, "private-state");
      writeFileSync(join(f.account2, "config.toml"), 'sqlite_home = "private-state"\n');
      state(join(account2State, "state_5.sqlite"), ACCOUNT2_THREAD, rollout);
      expect(f.store().resolve(currentRequest(f.project, ACCOUNT2_THREAD, ACCOUNT2_TURN)).sandboxPolicy.type).toBe("readOnly");
      const db = new Database(join(account2State, "state_5.sqlite"));
      db.query("UPDATE threads SET rollout_path = ?").run(join(f.primary, "outside.jsonl"));
      db.close();
      expect(() => f.store().resolve(currentRequest(f.project, ACCOUNT2_THREAD, ACCOUNT2_TURN))).toThrow();
    } finally {
      if (previous === undefined) delete process.env.CODEX_SQLITE_HOME;
      else process.env.CODEX_SQLITE_HOME = previous;
    }
  });

  test("Account2 native child is found after absent primary; parent identity cannot be substituted", () => {
    const f = fixture();
    const path = writeRollout(f.account2, ACCOUNT2_THREAD, ACCOUNT2_TURN, f.project, "read-only");
    const agent = "/root/second_account_child";
    rewriteNative(path, records => {
      records[0].payload = { id: ACCOUNT2_THREAD, source: { subagent: { thread_spawn: {
        parent_thread_id: ACCOUNT1_THREAD, depth: 1, agent_path: agent,
      } } }, parent_thread_id: ACCOUNT1_THREAD, agent_path: agent, thread_source: "subagent" };
    });
    const value = currentRequest(f.project, ACCOUNT2_THREAD, ACCOUNT2_TURN);
    const body = value._rawBody as any;
    const metadata = JSON.parse(body.client_metadata["x-codex-turn-metadata"]);
    Object.assign(metadata, { parent_thread_id: ACCOUNT1_THREAD, agent_name: agent, subagent_kind: "thread_spawn" });
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    expect(f.store().resolve(value).sandboxPolicy.type).toBe("readOnly");
    metadata.parent_thread_id = ACCOUNT2_TURN;
    body.client_metadata["x-codex-turn-metadata"] = JSON.stringify(metadata);
    expect(() => f.store().resolve(value)).toThrow("session metadata");
  });

  test("native conflicting network, malformed roots and wrong account session owner fail closed", () => {
    const f = fixture();
    const value = currentRequest(f.project, ACCOUNT2_THREAD, ACCOUNT2_TURN);
    const reset = () => writeRollout(f.account2, ACCOUNT2_THREAD, ACCOUNT2_TURN, f.project, "read-only");
    rewriteNative(reset(), records => { records.at(-1).payload.permission_profile.network = "enabled"; });
    expect(() => f.store().resolve(value)).toThrow("inconsistent");
    rewriteNative(reset(), records => { records.at(-1).payload.workspace_roots = "not-an-array"; });
    expect(() => f.store().resolve(value)).toThrow("workspace_roots is invalid");
    rewriteNative(reset(), records => { records[0].payload.id = ACCOUNT1_THREAD; });
    expect(() => f.store().resolve(value)).toThrow("session metadata");
    reset();
    const mismatch = currentRequest(f.project, ACCOUNT2_THREAD, ACCOUNT2_TURN);
    (mismatch._rawBody as any).input[0].content[0].text = environmentXml(join(f.root, "other-project"), "read-only");
    expect(() => f.store().resolve(mismatch)).toThrow();
  });
});
