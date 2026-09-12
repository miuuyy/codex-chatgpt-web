import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instrumentChatGptMcpTransport } from "../src/adapters/chatgpt-web/mcp-diagnostics";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fakeTransport() {
  const sent: JSONRPCMessage[] = [];
  const received: JSONRPCMessage[] = [];
  const transport: Transport = {
    async start() {},
    async close() { transport.onclose?.(); },
    async send(message) { sent.push(message); },
    onmessage: message => received.push(message),
  };
  return { transport, sent, received };
}

test("MCP boundary diagnostics omit secrets and preserve requests and replies", async () => {
  const events: Array<Record<string, any>> = [];
  const fake = fakeTransport();
  const transport = instrumentChatGptMcpTransport(fake.transport, event => events.push(event));
  const secret = "private-token-and-file-content-should-never-appear";
  const request: JSONRPCMessage = {
    jsonrpc: "2.0", id: `rpc-${secret}`, method: "tools/call",
    params: { name: "codex_tool_inventory", arguments: {
      turn_token: secret, query: secret, include_schema: true, [secret]: secret,
    }, _meta: { subject: secret } },
  };
  transport.onmessage?.(request);
  const reply: JSONRPCMessage = {
    jsonrpc: "2.0", id: request.id,
    result: { content: [{ type: "text", text: secret }], structuredContent: {
      total: 3, next_offset: 1,
      tools: [{ wire_name: "exec_command", kind: "function", description: secret,
        parameters: { type: "object", properties: { cmd: { description: secret } } } }],
    }, _meta: { subject: secret } },
  };
  await transport.send(reply);
  expect(fake.received).toEqual([request]);
  expect(fake.sent).toEqual([reply]);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    event: "tool_call_received", rpc_id: { sha256: hash(String(request.id)) }, call_sequence: 1,
    tool: "codex_tool_inventory",
  });
  expect(events[0]!.arguments.find((arg: any) => arg.key === "query"))
    .toMatchObject({ chars: secret.length, sha256: hash(secret) });
  expect(events[1]).toMatchObject({
    event: "tool_call_replied", call_sequence: 1, outcome: "success",
    inventory: { returned: 1, total: 3, next_offset: 1, tools: [{
      wire_name: "exec_command", kind: "function", description: { chars: secret.length, sha256: hash(secret) },
    }] },
  });
  expect(events[1]!.elapsed_ms).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(events)).not.toContain("subject");
  expect(JSON.stringify(events)).not.toContain("content");
});

test("MCP boundary diagnostics classify errors without retaining arbitrary error text", async () => {
  const events: Array<Record<string, any>> = [];
  const { transport } = fakeTransport();
  instrumentChatGptMcpTransport(transport, event => events.push(event));
  const secret = "authorization=private-command-secret";
  const errors = [
    { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text:
      `MCP error -32602: Input validation error: Invalid arguments for tool codex_exec: ${secret}` }] } },
    { jsonrpc: "2.0", id: 2, error: { code: -32603, message: secret, data: { token: secret } } },
  ] satisfies JSONRPCMessage[];
  for (const reply of errors) {
    transport.onmessage?.({ jsonrpc: "2.0", id: reply.id!, method: "tools/call", params: {
      name: "codex_exec", arguments: { turn_token: secret, cmd: secret },
    } });
    await transport.send(reply);
  }
  expect(events[1]).toMatchObject({ outcome: "tool_error", error: { category: "input_validation_error" } });
  expect(events[3]).toMatchObject({ outcome: "jsonrpc_error", error: { category: "unclassified_error", code: -32603 } });
  expect(JSON.stringify(events)).not.toContain(secret);
});

test("MCP diagnostics sink and send failures do not change transport semantics", async () => {
  const fake = fakeTransport();
  instrumentChatGptMcpTransport(fake.transport, () => { throw new Error("sink unavailable"); });
  const request: JSONRPCMessage = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "codex_exec" } };
  fake.transport.onmessage?.(request);
  const reply: JSONRPCMessage = { jsonrpc: "2.0", id: 1, result: {} };
  await fake.transport.send(reply);
  expect(fake.received).toEqual([request]);
  expect(fake.sent).toEqual([reply]);

  const events: Array<Record<string, any>> = [];
  const failed = fakeTransport();
  const error = new Error("secret send failure");
  failed.transport.send = async () => { throw error; };
  instrumentChatGptMcpTransport(failed.transport, event => events.push(event));
  failed.transport.onmessage?.(request);
  await expect(failed.transport.send(reply)).rejects.toBe(error);
  expect(events[1]).toMatchObject({ event: "tool_call_reply_send_failed", call_sequence: 1 });
  expect(JSON.stringify(events)).not.toContain(error.message);
});

test("real MCP stdio logs input validation before claim and preserves inventory-to-exec", async () => {
  const socketPath = join(tmpdir(), `cgw-diag-${randomBytes(5).toString("hex")}.sock`);
  const broker = TurnBroker.forSocket(socketPath);
  const description = "Private schema documentation must only appear as a fingerprint";
  const token = await broker.register({
    cwd: tmpdir(), roots: [tmpdir()], writableRoots: [],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    tools: [{ name: "exec_command", description, parameters: { type: "object" } }],
  }, 60_000);
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
    cwd: process.cwd(), stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: "mcp-boundary-diagnostics-test", version: "1" });
  const events = () => stderr.split("\n").filter(line => line.startsWith("[chatgpt-web-mcp] transport="))
    .map(line => JSON.parse(line.slice("[chatgpt-web-mcp] transport=".length)) as Record<string, any>);
  const awaitEvents = async (count: number) => {
    const deadline = Date.now() + 2_000;
    while (events().length < count && Date.now() < deadline) await Bun.sleep(5);
    expect(events()).toHaveLength(count);
  };
  try {
    await client.connect(transport);
    const invalid = await client.callTool({ name: "codex_exec", arguments: { turn_token: token } });
    expect(invalid.isError).toBeTrue();
    expect(JSON.stringify(invalid)).toContain("Input validation error");
    await awaitEvents(2);
    expect(stderr).not.toContain("scope=");
    const [received, replied] = events();
    expect(received).toMatchObject({ event: "tool_call_received", tool: "codex_exec" });
    expect(replied).toMatchObject({
      event: "tool_call_replied", rpc_id: received!.rpc_id, call_sequence: received!.call_sequence,
      outcome: "tool_error", error: { category: "input_validation_error" },
    });

    const inventory = await client.callTool({ name: "codex_tool_inventory", arguments: {
      turn_token: token, query: "exec_command", include_schema: true,
    } });
    expect(inventory.structuredContent).toMatchObject({ total: 1, tools: [{ wire_name: "exec_command" }] });
    const command = "synthetic command: never executed by this test";
    const execution = client.callTool({ name: "codex_exec", arguments: { turn_token: token, cmd: command } });
    const [request] = await broker.nextToolBatch(token);
    expect(request).toMatchObject({ wireName: "exec_command", arguments: { cmd: command } });
    broker.completeTool(token, request!.callId, {
      content: [{ type: "text", text: "private-file-result" }], structuredContent: { output: "private-file-result" },
    });
    expect((await execution).structuredContent).toEqual({ output: "private-file-result" });
    await awaitEvents(6);
    expect(events()[3]).toMatchObject({ outcome: "success", inventory: { returned: 1, total: 1, next_offset: null } });
    expect(events()[5]).toMatchObject({ outcome: "success", tool: "codex_exec" });
    for (const privateValue of [token, description, command, "private-file-result"]) {
      expect(JSON.stringify(events())).not.toContain(privateValue);
    }
  } finally {
    await client.close().catch(() => {});
    broker.revoke(token);
    await broker.close();
  }
});
