import { test, expect } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnBroker } from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint } from "../src/config";
import { imageContextId, prepareImageContext } from "../src/adapters/chatgpt-web/image-context";

test("image retrieval over MCP is bound to the authenticated thread without changing connector ABI", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-images-mcp-"));
  const broker = TurnBroker.forSocket(defaultBrokerEndpoint(join(root, "broker")));
  const url = "data:image/png;base64,aGVsbG8=";
  prepareImageContext("thread-a", [{ role: "user", timestamp: 0, content: [{ type: "image", imageUrl: url }] }], join(root, "runtime", "image-context"));
  const base = { cwd: root, roots: [root], writableRoots: [], sandboxPolicy: { type: "readOnly" as const, networkAccess: false }, tools: [] };
  const token = await broker.register({ ...base, imageContextThreadId: "thread-a" }, 60_000);
  const other = await broker.register({ ...base, imageContextThreadId: "thread-b" }, 60_000);
  const transport = new StdioClientTransport({ command: process.execPath, args: ["src/cli.ts", "mcp", "--broker-socket", defaultBrokerEndpoint(join(root, "broker"))], cwd: process.cwd(), env: { ...process.env as Record<string, string>, CODEX_CHATGPT_WEB_HOME: root }, stderr: "pipe" });
  const client = new Client({ name: "image-context-test", version: "1" });
  try {
    await client.connect(transport);
    const get = (t: string) => client.callTool({ name: "codex_tool_call", arguments: { turn_token: t, wire_name: "codex.image_context", arguments: { action: "get", ids: [imageContextId(url)] } } });
    // Outer Responses observers refresh tools without the runtime-only archive binding.
    broker.updateEnvironment(token, base);
    expect(() => broker.updateEnvironment(token, { ...base, imageContextThreadId: "thread-b" })).toThrow("thread changed");
    const fetched = await get(token);
    expect(fetched.isError).not.toBeTrue();
    expect(fetched.content).toContainEqual({ type: "image", mimeType: "image/png", data: "aGVsbG8=" });
    expect((await get(other)).isError).toBeTrue();
    await broker.revoke(token);
    expect((await get(token)).isError).toBeTrue();
  } finally {
    await client.close(); await broker.close(); rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
