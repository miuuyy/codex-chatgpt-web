import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  probeOpenCodex,
  resolveOpenCodexUpstream,
  resetOpenCodexCache,
  detectOpenCodexConfigOwnership,
  openCodexEndpointUrl,
  fetchOpenCodexModels,
  OPENCODEX_DEFAULT_PORT,
  OPENCODEX_SERVICE_IDENTITY,
  type OpenCodexUpstream,
} from "../src/opencodex";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("opencodex compatibility", () => {
  beforeEach(() => {
    resetOpenCodexCache();
  });

  describe("probeOpenCodex", () => {
    test("returns null when nothing is listening", async () => {
      const result = await probeOpenCodex(59999, "127.0.0.1", 500);
      expect(result).toBeNull();
    });

    test("returns null for a non-opencodex service", async () => {
      const server = Bun.serve({
        port: 0,
        fetch() {
          return Response.json({ status: "ok", service: "something-else" });
        },
      });
      const port = server.port;
      try {
        const result = await probeOpenCodex(port, "127.0.0.1", 2000);
        expect(result).toBeNull();
      } finally {
        await server.stop(true);
      }
    });

    test("detects a running opencodex instance", async () => {
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/healthz") {
            return Response.json({
              status: "ok",
              service: "opencodex",
              version: "2.9.1",
              uptime: 123.4,
              pid: 12345,
              port: 10100,
            });
          }
          return new Response("Not found", { status: 404 });
        },
      });
      const port = server.port;
      try {
        const result = await probeOpenCodex(port, "127.0.0.1", 2000);
        expect(result).not.toBeNull();
        expect(result!.baseUrl).toBe(`http://127.0.0.1:${port}`);
        expect(result!.version).toBe("2.9.1");
        expect(result!.pid).toBe(12345);
      } finally {
        await server.stop(true);
      }
    });

    test("returns null when status is not ok", async () => {
      const server = Bun.serve({
        port: 0,
        fetch() {
          return Response.json({ status: "degraded", service: "opencodex" });
        },
      });
      const port = server.port;
      try {
        const result = await probeOpenCodex(port, "127.0.0.1", 2000);
        expect(result).toBeNull();
      } finally {
        await server.stop(true);
      }
    });
  });

  describe("resolveOpenCodexUpstream", () => {
    test("caches results within cooldown window", async () => {
      let probeCount = 0;
      const server = Bun.serve({
        port: 0,
        fetch() {
          probeCount += 1;
          return Response.json({ status: "ok", service: "opencodex", version: "2.9.1" });
        },
      });
      const port = server.port;
      try {
        // First call probes.
        const first = await resolveOpenCodexUpstream(`http://127.0.0.1:${port}`);
        expect(first).not.toBeNull();
        expect(probeCount).toBe(1);
        // Second call within cooldown uses cache.
        const second = await resolveOpenCodexUpstream(`http://127.0.0.1:${port}`);
        expect(second).not.toBeNull();
        expect(probeCount).toBe(1);
      } finally {
        await server.stop(true);
      }
    });
  });

  describe("detectOpenCodexConfigOwnership", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(tmpdir(), `ocx-test-${crypto.randomUUID()}`);
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    test("returns null when config does not exist", () => {
      const result = detectOpenCodexConfigOwnership(join(tempDir, "nonexistent.toml"));
      expect(result).toBeNull();
    });

    test("returns null when opencodex marker is absent", () => {
      const configPath = join(tempDir, "config.toml");
      writeFileSync(configPath, 'openai_base_url = "http://127.0.0.1:17841/v1"\n');
      const result = detectOpenCodexConfigOwnership(configPath);
      expect(result).toBeNull();
    });

    test("detects opencodex ownership and extracts URL", () => {
      const configPath = join(tempDir, "config.toml");
      writeFileSync(configPath, [
        "# Auto-injected by opencodex",
        'openai_base_url = "http://127.0.0.1:10100/v1"',
        "",
      ].join("\n"));
      const result = detectOpenCodexConfigOwnership(configPath);
      expect(result).toBe("http://127.0.0.1:10100/v1");
    });
  });

  describe("openCodexEndpointUrl", () => {
    test("builds correct endpoint URLs", () => {
      const upstream: OpenCodexUpstream = { baseUrl: "http://127.0.0.1:10100" };
      expect(openCodexEndpointUrl(upstream, "models")).toBe("http://127.0.0.1:10100/v1/models");
      expect(openCodexEndpointUrl(upstream, "responses")).toBe("http://127.0.0.1:10100/v1/responses");
      expect(openCodexEndpointUrl(upstream, "responses/compact")).toBe("http://127.0.0.1:10100/v1/responses/compact");
    });
  });

  describe("fetchOpenCodexModels", () => {
    test("returns null on failure", async () => {
      const upstream: OpenCodexUpstream = { baseUrl: "http://127.0.0.1:59998" };
      const result = await fetchOpenCodexModels(upstream, undefined, 500);
      expect(result).toBeNull();
    });

    test("fetches models from a running opencodex", async () => {
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/v1/models") {
            return Response.json({
              models: [
                { slug: "claude-sonnet-5", visibility: "list", display_name: "Claude Sonnet 5" },
                { slug: "deepseek-v4-pro", visibility: "list", display_name: "DeepSeek V4 Pro" },
                { slug: "hidden-model", visibility: "hidden", display_name: "Hidden" },
              ],
            });
          }
          return new Response("Not found", { status: 404 });
        },
      });
      const port = server.port;
      try {
        const upstream: OpenCodexUpstream = { baseUrl: `http://127.0.0.1:${port}` };
        const models = await fetchOpenCodexModels(upstream);
        expect(models).not.toBeNull();
        expect(models!.length).toBe(3);
      } finally {
        await server.stop(true);
      }
    });
  });
});
