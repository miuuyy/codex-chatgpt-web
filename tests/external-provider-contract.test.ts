import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBrokerEndpoint, defaultConfig, loadConfig, loadConfigForSetup } from "../src/config";
import { buildExternalProviderModelCatalog } from "../src/model-catalog";
import {
  compactRequest,
  modelsRequest,
  responseRequest,
} from "../src/server";

function isolatedHome(): string {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-external-"));
  process.env.CODEX_CHATGPT_WEB_HOME = root;
  process.env.CODEX_HOME = join(root, "codex");
  mkdirSync(join(root, "codex"), { recursive: true });
  return root;
}

test("legacy configs without integrationMode keep direct ownership", () => {
  const root = isolatedHome();
  try {
    const legacy = { ...defaultConfig("browser-only") } as Record<string, unknown>;
    delete legacy.integrationMode;
    writeFileSync(join(root, "config.json"), `${JSON.stringify(legacy)}\n`);
    expect(loadConfig().integrationMode).toBe("direct");
    expect(loadConfigForSetup().integrationMode).toBe("direct");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit external-provider alias survives a missing bridgeEnabled-style field", () => {
  const root = isolatedHome();
  try {
    const raw = {
      ...defaultConfig("browser-only"),
      integrationMode: undefined,
      codexIntegrationMode: "external-provider",
    } as Record<string, unknown>;
    delete raw.integrationMode;
    writeFileSync(join(root, "config.json"), `${JSON.stringify(raw)}\n`);
    expect(loadConfig().integrationMode).toBe("external-provider");
    expect(loadConfigForSetup().integrationMode).toBe("external-provider");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflicting aliases keep the conservative external-provider ownership", () => {
  const root = isolatedHome();
  try {
    writeFileSync(join(root, "config.json"), `${JSON.stringify({
      ...defaultConfig("browser-only"),
      integrationMode: "direct",
      codexIntegrationMode: "external-provider",
    })}\n`);
    expect(loadConfig().integrationMode).toBe("external-provider");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external-provider model lists do not call native Codex and omit unavailable models", async () => {
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  config.proAvailable = false;
  let upstreamCalls = 0;
  const response = await modelsRequest(
    new Request("http://127.0.0.1:17841/v1/models"),
    config,
    async () => {
      upstreamCalls += 1;
      throw new Error("native Codex must not be contacted");
    },
  );
  expect(upstreamCalls).toBe(0);
  expect(response.status).toBe(200);
  const body = await response.json() as { data: Array<{ id: string; capabilities?: string[] }> };
  expect(body.data.map(model => model.id)).toEqual([
    "chatgpt-web/light",
    "chatgpt-web/medium",
    "chatgpt-web/high",
  ]);
  expect(body.data.every(model => model.capabilities?.includes("tools") !== true)).toBe(true);
});

test("external-provider Full catalogs advertise tools and compact only for supported Web models", () => {
  const config = defaultConfig("full");
  config.integrationMode = "external-provider";
  config.proAvailable = true;
  const catalog = buildExternalProviderModelCatalog(config) as {
    data: Array<{ id: string; capabilities: string[]; context_window: number }>;
  };
  expect(catalog.data.map(model => model.id)).toContain("chatgpt-web/pro");
  expect(catalog.data.find(model => model.id === "chatgpt-web/high")?.capabilities).toEqual(
    expect.arrayContaining(["tools", "compact", "reasoning"]),
  );
});

test("external-provider Responses reject unknown models instead of native fallback", async () => {
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  const response = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
  }), config, () => {
    throw new Error("adapter must not start");
  });
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("not provided by codex-chatgpt-web");
});

test("external-provider compact preserves turn metadata and rejects native models", async () => {
  const config = defaultConfig("full");
  config.integrationMode = "external-provider";
  const native = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_a", turn_id: "turn_a" }),
    },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
  }), config);
  expect(native.status).toBe(400);

  const web = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_web", turn_id: "turn_web" }),
    },
    body: JSON.stringify({
      model: "chatgpt-web/high",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Compact this" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn_web" },
        },
      ],
    }),
  }), config, () => ({
    name: "test-web-compactor",
    async runTurn(parsed, incoming, emit) {
      expect(incoming.headers.get("x-codex-turn-metadata")).toContain("thread_web");
      expect(parsed._compactionRequest).toBe(true);
      emit({ type: "text_delta", text: "Summary", phase: "final_answer" });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true },
      });
    },
  }));
  expect(web.status).toBe(200);
});
