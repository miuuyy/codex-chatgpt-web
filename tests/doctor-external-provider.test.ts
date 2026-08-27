import { describe, expect, test } from "bun:test";
import { codexRouteCheck } from "../src/doctor";

describe("doctor Codex route authority", () => {
  test("external provider mode does not require the retired direct route", () => {
    expect(codexRouteCheck(
      { codexIntegrationMode: "external-provider" },
      { installed: false, errors: ["stale direct route journal"] },
    )).toEqual({
      id: "codex",
      status: "ok",
      message: "Codex model routing is delegated to the launcher-verified external provider",
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
});
