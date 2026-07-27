import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createChatGptMcpServer } from "./mcp-server";

export function startChatGptMcpHttpServer(options: {
  brokerSocketPath: string;
  port: number;
}): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return Response.json({ status: "ok", service: "codex-chatgpt-web-mcp" });
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
      if (request.method !== "POST") {
        return Response.json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null,
        }, { status: 405 });
      }

      const server = createChatGptMcpServer({ brokerSocketPath: options.brokerSocketPath });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      try {
        await server.connect(transport);
        const response = await transport.handleRequest(request);
        const body = await response.arrayBuffer();
        await server.close();
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        await server.close().catch(() => {});
        return Response.json({
          jsonrpc: "2.0",
          error: { code: -32603, message: error instanceof Error ? error.message : "Internal server error" },
          id: null,
        }, { status: 500 });
      }
    },
  });
}
