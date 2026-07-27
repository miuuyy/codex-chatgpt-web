import { expect, test } from "bun:test";
import { startChatGptMcpHttpServer } from "../src/adapters/chatgpt-web/mcp-http";

const accessToken = "mcp-access-token-0123456789abcdef0123456789";
const initializeRequest = {
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
};

test("stateless Streamable HTTP MCP requires its access token", async () => {
  const server = startChatGptMcpHttpServer({
    brokerSocketPath: "/tmp/codex-chatgpt-web-unused-broker.sock",
    port: 0,
    accessToken,
  });
  try {
    const unauthorized = await fetch(`http://localhost:${server.port}/mcp`, initializeRequest);
    expect(unauthorized.status).toBe(401);

    const response = await fetch(
      `http://localhost:${server.port}/mcp?access_token=${encodeURIComponent(accessToken)}`,
      initializeRequest,
    );
    const payload = await response.json() as { result?: { serverInfo?: { name?: string } } };
    expect(response.status).toBe(200);
    expect(payload.result?.serverInfo?.name).toBe("codex-native");

    const bearerResponse = await fetch(`http://localhost:${server.port}/mcp`, {
      ...initializeRequest,
      headers: { ...initializeRequest.headers, authorization: `Bearer ${accessToken}` },
    });
    expect(bearerResponse.status).toBe(200);
  } finally {
    server.stop(true);
  }
});
