import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  createCloudflareRuntimeConfig,
  defaultCloudflareConfigPath,
  inspectCloudflareConfig,
} from "../src/cloudflare-config";
import type { CloudflareTunnelConfig } from "../src/config";
import { handleChatGptMcpHttpRequest } from "../src/adapters/chatgpt-web/mcp-server";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cloudflare-test-"));
  roots.push(root);
  return root;
}

const SOURCE = `tunnel: 6ff42ae2-765d-4adf-8112-31c55c1551ef
credentials-file: credentials/tunnel.json
ingress:
  - hostname: mcp.example.com
    service: http://localhost:8080
    originRequest:
      disableChunkedEncoding: true
  - hostname: "*.example.com"
    service: http://localhost:9000
  - service: http_status:404
`;

function settings(root: string): CloudflareTunnelConfig {
  return {
    kind: "cloudflare",
    binaryPath: join(root, "cloudflared"),
    configPath: join(root, "config.yml"),
    hostname: "mcp.example.com",
    mcpPath: `/mcp/${"a".repeat(43)}`,
  };
}

describe("Cloudflare named tunnel config", () => {
  test("uses the standard config.yml path and lists only exact path-free hostnames", async () => {
    expect(defaultCloudflareConfigPath("/Users/dev")).toBe(join("/Users/dev", ".cloudflared", "config.yml"));
    const root = tempRoot();
    writeFileSync(join(root, "config.yml"), SOURCE);
    expect(await inspectCloudflareConfig(join(root, "config.yml"))).toEqual({
      path: join(root, "config.yml"),
      exists: true,
      hostnames: ["mcp.example.com"],
      error: null,
    });
  });

  test("writes a private runtime config that exposes only the MCP and OAuth paths", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "credentials"));
    writeFileSync(join(root, "config.yml"), SOURCE);
    const config = settings(root);
    const runtime = await createCloudflareRuntimeConfig(config, "http://127.0.0.1:17841");
    const generated = parse(readFileSync(runtime.path, "utf8")) as Record<string, any>;
    expect(generated.tunnel).toBe("6ff42ae2-765d-4adf-8112-31c55c1551ef");
    expect(generated["credentials-file"]).toBe(join(root, "credentials", "tunnel.json"));
    expect(generated.ingress).toEqual([
      {
        hostname: "mcp.example.com",
        path: `^${config.mcpPath}(?:/.*)?$`,
        service: "http://127.0.0.1:17841",
        originRequest: {
          disableChunkedEncoding: true,
          httpHostHeader: "127.0.0.1:17841",
        },
      },
      {
        hostname: "mcp.example.com",
        path: `^/\\.well-known/(?:oauth-protected-resource|oauth-authorization-server)${config.mcpPath}/?$`,
        service: "http://127.0.0.1:17841",
        originRequest: {
          disableChunkedEncoding: true,
          httpHostHeader: "127.0.0.1:17841",
        },
      },
      { service: "http_status:404" },
    ]);
    expect(readFileSync(join(root, "config.yml"), "utf8")).toBe(SOURCE);
    await runtime.cleanup();
    expect(() => readFileSync(runtime.path)).toThrow();
  });
});

describe("Cloudflare MCP HTTP transport", () => {
  test("serves the existing tool contract through a stateless JSON response", async () => {
    const response = await handleChatGptMcpHttpRequest(new Request("http://127.0.0.1:17841/mcp/test", {
      method: "POST",
      headers: {
        host: "127.0.0.1:17841",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    }), {
      brokerSocketPath: join(tempRoot(), "unused-broker.sock"),
      allowedHost: "127.0.0.1:17841",
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.result.serverInfo).toEqual({ name: "codex-native", version: expect.any(String) });
    expect(body.result.capabilities.tools).toEqual({ listChanged: true });
  });

  test("rejects a forged Host header before MCP dispatch", async () => {
    const response = await handleChatGptMcpHttpRequest(new Request("http://attacker.invalid/mcp/test", {
      method: "POST",
      headers: { host: "attacker.invalid", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }), {
      brokerSocketPath: join(tempRoot(), "unused-broker.sock"),
      allowedHost: "127.0.0.1:17841",
    });
    expect(response.status).toBe(403);
  });
});
