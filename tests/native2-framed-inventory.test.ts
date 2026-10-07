import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import type { CodexTool } from "../src/types";

// Every capability in this fixture is minted by its own broker. No real account, goal,
// message recipient, worker token, browser or deferred backend is contacted.
const testRoot = mkdtempSync(join(tmpdir(), "native2-discovery-fixture-"));
afterAll(() => {
  if (dirname(resolve(testRoot)) !== resolve(tmpdir())) throw new Error("Unexpected fixture cleanup path");
  rmSync(testRoot, { recursive: true, force: true });
});

const searchSchema = {
  type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } },
  required: ["query"], additionalProperties: false,
};
const commandTools: CodexTool[] = [
  {
    name: "exec_command", description: "Run a shell command, returning a PTY session when still running",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
  },
  { name: "write_stdin", description: "Poll a PTY session", parameters: { type: "object" } },
  { name: "tool_search", description: "Load deferred tools", parameters: searchSchema, toolSearch: true },
];
const replSchema = {
  type: "object", properties: { code: { type: "string" }, timeout_ms: { type: "integer" }, title: { type: "string" } },
  required: ["code"], additionalProperties: false,
};
const replSpec = {
  type: "namespace", name: "mcp__node_repl", tools: [{
    type: "function", name: "js", description: "Execute JavaScript in a persistent node_repl session", parameters: replSchema,
  }],
};
const fixtureImage = {
  type: "image" as const, mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/2uQAAAAASUVORK5CYII=",
};

function environment(tools: CodexTool[]): ChatGptTurnEnvironment {
  return { cwd: testRoot, roots: [testRoot], writableRoots: [testRoot], sandboxPolicy: { type: "dangerFullAccess" }, tools };
}

async function fixture(name: string) {
  const home = join(testRoot, name);
  const socket = process.platform === "win32" ? defaultBrokerEndpoint(home, "win32") : `${home}.sock`;
  const broker = TurnBroker.forSocket(socket);
  const tokens: string[] = [];
  const register = async (tools: CodexTool[]) => {
    const token = await broker.register(environment(tools), 60_000);
    tokens.push(token);
    return token;
  };
  // Start the broker listener before connecting the real MCP stdio client.
  await register([]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [process.env.CODEX_NATIVE2_DISCOVERY_CLI ?? "src/cli.ts", "mcp", "--broker-socket", socket],
    cwd: process.cwd(), env: { CODEX_CHATGPT_WEB_HOME: home }, stderr: "pipe",
  });
  const client = new Client({ name: "native2-offline-discovery", version: "1.0.0" });
  await client.connect(transport);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  return { broker, register, call, close: async () => {
    await client.close();
    for (const token of tokens) broker.revoke(token);
    await broker.close();
  } };
}

test("Computer Use discovery returns only registered node_repl wires and preserves schemas and screenshots", async () => {
  const f = await fixture("computer-use-direct");
  try {
    const parsed = parseRequest({ model: "chatgpt-web/gpt-5.6-sol", tools: [replSpec], input: [] });
    const token = await f.register(parsed.context.tools ?? []);
    for (const query of ["computer use", "computer-use", "node_repl", "@oai/sky"]) {
      const inventory = await f.call("codex_tool_inventory", { turn_token: token, query, include_schema: true });
      expect(inventory.structuredContent).toMatchObject({ total: 1, tools: [{
        wire_name: "mcp__node_repl__js", kind: "function", parameters: replSchema,
      }] });
    }
    const arguments_ = { code: "await sky.get_window_state({ window: globalThis.fixtureWindow });", title: "fixture capture" };
    const pending = f.call("codex_tool_call", { turn_token: token, wire_name: "mcp__node_repl__js", arguments: arguments_ });
    const [request] = await f.broker.nextToolBatch(token);
    expect(request).toMatchObject({ wireName: "mcp__node_repl__js", arguments: arguments_ });
    f.broker.completeTool(token, request!.callId, { content: [{ type: "text", text: "fixture capture" }, fixtureImage] });
    expect((await pending).content).toContainEqual(fixtureImage);

    const missingToken = await f.register(commandTools);
    const missing = await f.call("codex_tool_inventory", { turn_token: missingToken, query: "computer use", include_schema: true });
    expect(missing.structuredContent).toMatchObject({ total: 0, tools: [], discovery_tools: [{ wire_name: "tool_search" }] });
    const unavailable = await f.call("codex_tool_call", { turn_token: missingToken,
      wire_name: "mcp__node_repl__js", arguments: arguments_ });
    expect(unavailable.isError).toBe(true);
  } finally { await f.close(); }
}, 15_000);

test("Computer Use through the nested exec gateway retains observation, input and image results", async () => {
  const f = await fixture("computer-use-gateway");
  try {
    const token = await f.register([{ name: "exec", description: "Run JavaScript with ALL_TOOLS", parameters: {}, freeform: true }]);
    const wire = "mcp__node_repl__js";
    const calls: unknown[] = [];
    const execute = async (program: string) => {
      const content: Array<{ type: "text"; text: string } | typeof fixtureImage> = [];
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      await new AsyncFunction("tools", "ALL_TOOLS", "text", "image", "audio", "generatedImage", program)(
        { [wire]: async (args: unknown) => {
          calls.push(args);
          return { content: [{ type: "text", text: "fixture receipt" }, fixtureImage] };
        } },
        [{ name: wire, description: `Execute JavaScript in a persistent node_repl session. Input schema: ${JSON.stringify(replSchema)}` }],
        (value: unknown) => content.push({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }),
        (value: typeof fixtureImage) => content.push(value),
        () => { throw new Error("Unexpected audio"); }, () => { throw new Error("Unexpected generated image"); },
      );
      return { content };
    };
    const inventoryPending = f.call("codex_tool_inventory", { turn_token: token, query: "computer use", include_schema: true });
    const [catalog] = await f.broker.nextToolBatch(token);
    const catalogResult = await execute(catalog!.input!);
    catalogResult.content = catalogResult.content.map(item => item.type === "text"
      ? { type: "text", text: `Script completed\nWall time 0.0 seconds\nOutput:\n${item.text}` } : item);
    f.broker.completeTool(token, catalog!.callId, catalogResult);
    expect((await inventoryPending).structuredContent).toMatchObject({ total: 1, tools: [{ wire_name: wire, kind: "gateway" }] });
    expect(calls).toHaveLength(0);
    for (const code of [
      "await sky.list_windows();",
      "await sky.get_window_state({ window: globalThis.fixtureWindow });",
      "await sky.click({ window: globalThis.fixtureWindow, element_index: 3 });",
      "await sky.type_text({ window: globalThis.fixtureWindow, text: 'fixture only' });",
    ]) {
      const args = { code, timeout_ms: 10_000, title: "Computer Use fixture" };
      const pending = f.call("codex_tool_call", { turn_token: token, wire_name: wire, arguments: args });
      const [request] = await f.broker.nextToolBatch(token);
      f.broker.completeTool(token, request!.callId, await execute(request!.input!));
      expect((await pending).content).toContainEqual(fixtureImage);
      expect(calls.at(-1)).toEqual(args);
    }
  } finally { await f.close(); }
}, 15_000);

test("a prior native exec catalog frame cannot register tools for a subsequent inventory call", async () => {
  const f = await fixture("computer-use-stale-catalog");
  try {
    const token = await f.register([{ name: "exec", description: "Run JavaScript with ALL_TOOLS", parameters: {}, freeform: true }]);
    const first = f.call("codex_tool_inventory", { turn_token: token, query: "computer use", include_schema: true });
    const [request] = await f.broker.nextToolBatch(token);
    const content: Array<{ type: "text"; text: string }> = [];
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction("ALL_TOOLS", "text", request!.input!)(
      [{ name: "mcp__node_repl__js", description: "Execute JavaScript in node_repl" }],
      (value: string) => content.push({ type: "text", text: `Script completed\nWall time 0.0 seconds\nOutput:\n${value}` }),
    );
    f.broker.completeTool(token, request!.callId, { content });
    expect((await first).structuredContent).toMatchObject({ total: 1, tools: [{ wire_name: "mcp__node_repl__js" }] });
    const second = f.call("codex_tool_inventory", { turn_token: token, query: "computer use", include_schema: true });
    const [next] = await f.broker.nextToolBatch(token);
    f.broker.completeTool(token, next!.callId, { content });
    const stale = await second;
    expect(stale.isError).toBe(true);
    expect(JSON.stringify(stale.content)).toContain("invalid catalog frame");
  } finally { await f.close(); }
}, 15_000);

for (const scenario of [
  {
    name: "unframed",
    corrupt: (_value: string) => JSON.stringify({ tools: [{ name: "mcp__node_repl__js", description: "node_repl" }], total: 1 }),
    error: "invalid catalog frame",
  },
  {
    name: "duplicate",
    corrupt: (value: string) => `${value}\n${value}`,
    error: "invalid catalog frame",
  },
  {
    name: "invalid-json",
    corrupt: (value: string) => `${value.slice(0, value.indexOf("\n"))}\n{invalid}\n${value.slice(value.lastIndexOf("\n") + 1)}`,
    error: "invalid JSON",
  },
]) {
  test(`native exec inventory rejects ${scenario.name} catalogs instead of registering tools`, async () => {
    const f = await fixture(`catalog-${scenario.name}`);
    try {
      const token = await f.register([{ name: "exec", description: "Run JavaScript with ALL_TOOLS", parameters: {}, freeform: true }]);
      const pending = f.call("codex_tool_inventory", { turn_token: token, query: "computer use", include_schema: true });
      const [request] = await f.broker.nextToolBatch(token);
      const content: Array<{ type: "text"; text: string }> = [];
      const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
      await new AsyncFunction("ALL_TOOLS", "text", request!.input!)(
        [{ name: "mcp__node_repl__js", description: "Execute JavaScript in node_repl" }],
        (value: string) => content.push({ type: "text", text: `Script completed\nOutput:\n${scenario.corrupt(value)}` }),
      );
      f.broker.completeTool(token, request!.callId, { content });
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(scenario.error);
      expect(result.structuredContent).toBeUndefined();
    } finally { await f.close(); }
  }, 15_000);
}
