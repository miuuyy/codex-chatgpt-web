import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectCodexCatalogRoutingFromText,
  modelCatalogDoctorCheck,
  readCatalogRequestCount,
  readCodexCatalogRouting,
} from "../src/doctor";

const roots: string[] = [];

function fixture(): { root: string; codexHome: string } {
  const root = join(tmpdir(), `codex-chatgpt-web-doctor-${process.pid}-${Date.now()}-${Math.random()}`);
  const codexHome = join(root, "codex");
  mkdirSync(codexHome, { recursive: true });
  roots.push(root);
  process.env.CODEX_HOME = codexHome;
  return { root, codexHome };
}

afterEach(() => {
  delete process.env.CODEX_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("model catalog doctor evidence", () => {
  test("treats a successful /v1/models request as catalog proof", () => {
    const check = modelCatalogDoctorCheck({
      successfulModelCatalogRequests: 1,
      routing: { status: "default" },
    });
    expect(check).toMatchObject({
      id: "model-catalog",
      status: "ok",
      message: "Codex has requested the ChatGPT Web model catalog from this daemon",
    });
    expect(check.detail).toBeUndefined();
  });

  test("warns when the daemon has received no catalog requests under built-in routing", () => {
    const check = modelCatalogDoctorCheck({
      successfulModelCatalogRequests: 0,
      routing: inspectCodexCatalogRoutingFromText([
        'openai_base_url = "http://127.0.0.1:17841/v1"',
        "",
        "[features]",
        "multi_agent = true",
        "",
      ].join("\n")),
    });
    expect(check.status).toBe("warning");
    expect(check.message).toBe("Codex has not requested the ChatGPT Web model catalog since this daemon started");
    expect(check.detail).toContain("Setup and a healthy proxy are not catalog evidence");
    expect(check.detail).not.toContain("model_provider");
  });

  test("explains zero catalog requests when a custom model_provider is selected", () => {
    const routing = inspectCodexCatalogRoutingFromText([
      'model_provider = "sub2api"',
      'openai_base_url = "http://127.0.0.1:17841/v1"',
      "",
      "[model_providers.sub2api]",
      'name = "Sub2API"',
      'base_url = "http://127.0.0.1:8080/v1"',
      "",
    ].join("\n"));
    const check = modelCatalogDoctorCheck({ successfulModelCatalogRequests: 0, routing });
    expect(routing).toEqual({ status: "custom-provider", provider: "sub2api", explicitCatalog: false });
    expect(check.status).toBe("warning");
    expect(check.message).toBe('Codex is obtaining its model catalog from the selected provider "sub2api"');
    expect(check.detail).toContain("zero requests to this daemon's /v1/models endpoint are expected");
    expect(check.detail).toContain("https://github.com/miuuyy/codex-chatgpt-web/issues/205");
    expect(check.detail).not.toContain("not proven");
  });

  test("explains zero catalog requests when model_catalog_json is set", () => {
    const routing = inspectCodexCatalogRoutingFromText([
      'openai_base_url = "http://127.0.0.1:17841/v1"',
      'model_catalog_json = "models.json"',
      "",
    ].join("\n"));
    const check = modelCatalogDoctorCheck({ successfulModelCatalogRequests: 0, routing });
    expect(routing).toEqual({ status: "explicit-catalog" });
    expect(check.status).toBe("warning");
    expect(check.message).toContain("model_catalog_json");
    expect(check.detail).toContain("Zero requests to /v1/models can be expected");
    expect(check.detail).toContain("https://github.com/miuuyy/codex-chatgpt-web/issues/205");
    expect(check.detail).not.toContain("models.json");
  });

  test("does not treat a model_providers table as selected routing", () => {
    const withBuiltIn = inspectCodexCatalogRoutingFromText([
      'openai_base_url = "http://127.0.0.1:17841/v1"',
      'model_provider = "openai"',
      "",
      "[model_providers.sub2api]",
      'name = "Sub2API (Tailscale)"',
      'base_url = "http://127.0.0.1:8080/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"));
    const tableOnly = inspectCodexCatalogRoutingFromText([
      'openai_base_url = "http://127.0.0.1:17841/v1"',
      "",
      "[model_providers.sub2api]",
      'name = "Sub2API (Tailscale)"',
      'base_url = "http://127.0.0.1:8080/v1"',
      "",
    ].join("\n"));
    for (const routing of [withBuiltIn, tableOnly]) {
      const check = modelCatalogDoctorCheck({ successfulModelCatalogRequests: 0, routing });
      expect(routing).toEqual({ status: "default" });
      expect(check.message).toBe("Codex has not requested the ChatGPT Web model catalog since this daemon started");
      expect(check.detail).not.toContain("sub2api");
    }
  });

  test("does not assume an alternate catalog owner when Codex config is unreadable", () => {
    const routing = inspectCodexCatalogRoutingFromText([
      'model_provider = "first"',
      'model_provider = "second"',
      "",
    ].join("\n"));
    const check = modelCatalogDoctorCheck({ successfulModelCatalogRequests: 0, routing });
    expect(routing.status).toBe("unreadable");
    expect(check.status).toBe("warning");
    expect(check.message).toBe("Codex has not requested the ChatGPT Web model catalog since this daemon started");
    expect(check.detail).toContain("did not assume an alternate catalog owner");
    expect(check.detail).toContain("duplicate top-level model_provider");
  });

  test("keeps catalog proof even when a custom provider is also selected", () => {
    const check = modelCatalogDoctorCheck({
      successfulModelCatalogRequests: 4,
      routing: { status: "custom-provider", provider: "sub2api", explicitCatalog: true },
    });
    expect(check.status).toBe("ok");
    expect(check.message).toBe("Codex has requested the ChatGPT Web model catalog from this daemon");
  });
});

describe("Codex catalog routing inspection", () => {
  test("reads top-level assignments from Codex config without mutating it", async () => {
    const { codexHome } = fixture();
    const path = join(codexHome, "config.toml");
    const original = [
      'model_provider = "sub2api" # selected',
      'model_catalog_json = "models.json"',
      "",
      "[model_providers.sub2api]",
      'name = "Sub2API"',
      "",
    ].join("\n");
    writeFileSync(path, original);

    expect(readCodexCatalogRouting()).toEqual({
      status: "custom-provider",
      provider: "sub2api",
      explicitCatalog: true,
    });
    expect(await Bun.file(path).text()).toBe(original);
  });

  test("treats a missing Codex config as built-in routing", () => {
    fixture();
    expect(readCodexCatalogRouting()).toEqual({ status: "default" });
  });

  test("fails closed when Codex config cannot be read", () => {
    const { codexHome } = fixture();
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "sub2api"\n');
    expect(readCodexCatalogRouting(() => {
      throw new Error("EACCES");
    })).toEqual({ status: "unreadable", detail: "Codex config could not be read" });
  });

  test("parses CR-only Codex config with the existing document splitter", () => {
    const routing = inspectCodexCatalogRoutingFromText('model_provider = "sub2api"\r[model_providers.sub2api]\rname = "Sub2API"\r');
    expect(routing).toEqual({ status: "custom-provider", provider: "sub2api", explicitCatalog: false });
  });
});

describe("healthz catalog counters", () => {
  test("reads successful_model_catalog_requests and rejects malformed counts", () => {
    expect(readCatalogRequestCount({ successful_model_catalog_requests: 0 })).toBe(0);
    expect(readCatalogRequestCount({ successful_model_catalog_requests: 2 })).toBe(2);
    expect(readCatalogRequestCount({})).toBeUndefined();
    expect(readCatalogRequestCount({ successful_model_catalog_requests: -1 })).toBeUndefined();
    expect(readCatalogRequestCount({ successful_model_catalog_requests: "0" })).toBeUndefined();
  });

  test("warns when healthz omits catalog request counts", () => {
    const check = modelCatalogDoctorCheck({
      successfulModelCatalogRequests: undefined,
      routing: { status: "default" },
    });
    expect(check.status).toBe("warning");
    expect(check.message).toBe("Responses proxy did not report model catalog request counts");
  });
});
