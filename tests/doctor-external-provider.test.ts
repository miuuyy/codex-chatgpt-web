import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexRouteCheck } from "../src/doctor";
import { inspectExternalProvider } from "../src/external-provider";

describe("doctor Codex route authority", () => {
  test("external provider mode does not require the retired direct route", () => {
    expect(codexRouteCheck(
      { codexIntegrationMode: "external-provider" },
      { installed: false, errors: ["stale direct route journal"] },
      {
        active: true,
        reason: "verified-external-provider",
        provider: "cgw",
        verifiedModels: ["cgw/chatgpt-web/light", "cgw/chatgpt-web/medium"],
      },
    )).toEqual({
      id: "codex",
      status: "ok",
      message: "Codex model routing is delegated to a live verified external provider",
      detail: "cgw/chatgpt-web/light, cgw/chatgpt-web/medium",
    });
  });

  test("external provider mode fails closed when its live catalog is stale", () => {
    expect(codexRouteCheck(
      { codexIntegrationMode: "external-provider" },
      { installed: false, errors: [] },
      { active: false, reason: "external-provider-unreachable" },
    )).toEqual({
      id: "codex",
      status: "error",
      message: "External Codex provider model catalog is unavailable",
      detail: "external-provider-unreachable",
    });
  });

  test("direct mode keeps the native route fail-closed checks", () => {
    expect(codexRouteCheck(
      { codexIntegrationMode: "direct" },
      { installed: false, errors: [] },
    )).toEqual({
      id: "codex",
      status: "error",
      message: "Codex model route is not installed",
    });

    expect(codexRouteCheck(
      { codexIntegrationMode: "direct" },
      { installed: true, errors: ["route mismatch"] },
    )).toEqual({
      id: "codex",
      status: "error",
      message: "Codex integration is inconsistent",
      detail: "route mismatch",
    });
  });

  test("live inspection binds one loopback provider to every eligible web model", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-web-gpt-doctor-provider-"));
    const configPath = join(root, "config.toml");
    try {
      writeFileSync(configPath, 'openai_base_url = "http://127.0.0.1:10100/v1"\n');
      const models = ["light", "medium", "high", "extra-high", "pro"]
        .map(effort => `cgw/chatgpt-web/${effort}`);
      const result = await inspectExternalProvider(
        { port: 17841, solAvailable: true, proAvailable: true },
        {
          codexConfigPath: configPath,
          fetchImpl: async () => new Response(JSON.stringify({
            data: models.map(id => ({ id })),
          }), { status: 200, headers: { "content-type": "application/json" } }),
        },
      );
      expect(result).toEqual({
        active: true,
        reason: "verified-external-provider",
        provider: "cgw",
        verifiedModels: models,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
