import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import type { ChatGptTurnEnvironment } from "../src/adapters/chatgpt-web/environment";

describe("Subagent delegation bridging (send_message_to_thread)", () => {
  test("inventory exposes send_message_to_thread when searched by thread or delegation query", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "codex-test-delegation-"));
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\codex-test-delegation-${process.pid}-${Date.now()}`
      : join(tempRoot, "broker.sock");
    const broker = TurnBroker.forSocket(socketPath);

    const envWithCollaboration: ChatGptTurnEnvironment = {
      cwd: tempRoot,
      roots: [tempRoot],
      writableRoots: [tempRoot],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [tempRoot], networkAccess: false },
      tools: [
        {
          name: "send_message",
          namespace: "collaboration",
          description: "Deliver message to thread",
          parameters: {
            type: "object",
            properties: { message: { type: "string" }, receiver_thread_id: { type: "string" } },
            required: ["message"],
          },
        },
      ],
    };

    const token = await broker.register(envWithCollaboration, 30_000);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "test-delegation-client", version: "1.0.0" });
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    try {
      await client.connect(transport);

      // 1. Query inventory for "send_message_to_thread"
      const res = await call("codex_tool_inventory", {
        turn_token: token,
        query: "send_message_to_thread",
        include_schema: true,
      }) as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(res.content[0]!.text) as {
        tools: Array<{ wire_name: string; name: string }>;
        total: number;
      };
      expect(parsed.total).toBeGreaterThanOrEqual(1);
      const delegationTool = parsed.tools.find(t => t.wire_name === "collaboration__send_message");
      expect(delegationTool).toBeDefined();
      expect(parsed.tools.some(t => t.wire_name === "send_message_to_thread")).toBe(false);

      // 2. Call send_message_to_thread - should route to collaboration__send_message
      const callPromise = call("codex_tool_call", {
        turn_token: token,
        wire_name: delegationTool!.wire_name,
        arguments: {
          receiver_thread_id: "thread_manager_123",
          message: "Pytest passed successfully with 42 tests",
        },
      });

      const [toolRequest] = await broker.nextToolBatch(token);
      expect(toolRequest).toBeDefined();
      expect(toolRequest?.wireName).toBe("collaboration__send_message");
      expect(toolRequest?.arguments).toMatchObject({
        receiver_thread_id: "thread_manager_123",
        message: "Pytest passed successfully with 42 tests",
      });

      broker.completeTool(token, toolRequest!.callId, {
        content: [{ type: "text", text: '{"status":"delivered"}' }],
      });

      const callResult = await callPromise as { content: Array<{ type: string; text: string }> };
      expect(callResult.content[0]!.text).toContain("delivered");
    } finally {
      await broker.close();
      await client.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("missing collaboration tool is not advertised and cannot fabricate a delivery acknowledgement", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "codex-test-delegation-ack-"));
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\codex-test-delegation-ack-${process.pid}-${Date.now()}`
      : join(tempRoot, "broker.sock");
    const broker = TurnBroker.forSocket(socketPath);

    const envWithoutCollaboration: ChatGptTurnEnvironment = {
      cwd: tempRoot,
      roots: [tempRoot],
      writableRoots: [tempRoot],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [tempRoot], networkAccess: false },
      tools: [
        {
          name: "exec_command",
          description: "Run command",
          parameters: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ],
    };

    const token = await broker.register(envWithoutCollaboration, 30_000);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--broker-socket", socketPath],
      cwd: process.cwd(),
      stderr: "pipe",
    });
    const client = new Client({ name: "test-delegation-ack-client", version: "1.0.0" });
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    try {
      await client.connect(transport);

      // No delivery tool exists in this turn; inventory must not claim otherwise.
      const invRes = await call("codex_tool_inventory", {
        turn_token: token,
        query: "send_message_to_thread",
        include_schema: true,
      }) as { content: Array<{ type: string; text: string }> };
      const invParsed = JSON.parse(invRes.content[0]!.text) as {
        tools: Array<{ wire_name: string }>;
        total: number;
      };
      expect(invParsed.tools.some(t => t.wire_name === "send_message_to_thread")).toBe(false);

      // A call must fail explicitly instead of synthesizing success.
      const callRes = await call("codex_tool_call", {
        turn_token: token,
        wire_name: "send_message_to_thread",
        arguments: {
          thread_id: "thread_manager_999",
          message: "Done with task",
        },
      }) as { isError?: boolean; content: Array<{ type: string; text: string }> };
      expect(callRes.isError).toBe(true);
      expect(callRes.content[0]!.text).toContain("not available in this turn");
      expect(callRes.content[0]!.text).not.toContain('"delivered":true');
    } finally {
      await broker.close();
      await client.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
