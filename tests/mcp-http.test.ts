import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createChatGptMcpServer } from "../src/adapters/chatgpt-web/mcp-server";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.stop(true);
});

describe("ChatGPT Web MCP Streamable HTTP transport", () => {
  test("publishes the native bridge ABI without changing its tool contract", async () => {
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const serverTransport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const mcpServer = createChatGptMcpServer({
          brokerSocketPath: "/tmp/codex-chatgpt-web-http-contract.sock",
          contract: "native",
        });
        await mcpServer.connect(serverTransport);
        return serverTransport.handleRequest(request);
      },
    });
    servers.push(http);

    const clientTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${http.port}/mcp`),
    );
    const client = new Client({ name: "routing-plugin-contract-test", version: "1.0.0" });
    try {
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name).sort()).toEqual([
        "codex_apply_patch",
        "codex_exec",
        "codex_tool_call",
        "codex_tool_inventory",
        "codex_view_image",
        "codex_write_stdin",
      ]);
      for (const tool of listed.tools) {
        expect(JSON.stringify(tool.inputSchema)).toContain("turn_token");
        expect(JSON.stringify(tool.inputSchema)).not.toContain("request_id");
      }
    } finally {
      await client.close().catch(() => {});
    }
  });
});
