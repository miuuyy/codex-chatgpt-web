import { expect, test } from "bun:test";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http";

test("stateless Streamable HTTP MCP initializes over loopback", async () => {
  const server = startChatGptMcpHttpServer({
    brokerSocketPath: "/tmp/codex-chatgpt-web-unused-broker.sock",
    port: 0,
  });
  try {
    const response = await fetch(`http://localhost:${server.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    const payload = await response.json() as { result?: { serverInfo?: { name?: string } } };
    expect(response.status).toBe(200);
    expect(payload.result?.serverInfo?.name).toBe("codex-native");
  } finally {
    server.stop(true);
  }
});
