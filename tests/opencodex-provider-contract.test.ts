import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { compactRequest, modelsRequest, responseRequest } from "../src/server";

const TRAILING_SLASHES = /\/+$/;
const TRAILING_RESPONSES = /\/responses\/?$/;
const TRAILING_V1 = /\/v1\/?$/;

/** Mirror OpenCodex src/adapters/openai-responses-url.ts without importing that repository. */
function openaiResponsesUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  const trimmedPath = url.pathname.replace(TRAILING_SLASHES, "");
  const withoutEndpoint = trimmedPath.replace(TRAILING_RESPONSES, "");
  const withoutV1 = withoutEndpoint.replace(TRAILING_V1, "");
  url.pathname = `${withoutV1}/v1/responses`;
  return url.toString();
}

function providerUrl(baseUrl: string, responsesPath?: string): string {
  if (responsesPath === undefined) return openaiResponsesUrl(baseUrl);
  return `${baseUrl.replace(/\/$/, "")}${responsesPath}`;
}

test("OpenCodex openai-responses URL construction does not duplicate /v1", () => {
  expect(providerUrl("http://127.0.0.1:17841/v1")).toBe("http://127.0.0.1:17841/v1/responses");
  expect(providerUrl("http://127.0.0.1:17841/v1/")).toBe("http://127.0.0.1:17841/v1/responses");
  expect(providerUrl("http://127.0.0.1:17841")).toBe("http://127.0.0.1:17841/v1/responses");
  expect(providerUrl("http://127.0.0.1:17841/v1", "/responses")).toBe("http://127.0.0.1:17841/v1/responses");
  expect(providerUrl("http://127.0.0.1:17841/v1", "/responses/compact"))
    .toBe("http://127.0.0.1:17841/v1/responses/compact");
});

test("OpenCodex-shaped HTTP requests keep compact headers and reject unknown models", async () => {
  const config = defaultConfig("browser-only");
  config.integrationMode = "external-provider";
  let nativeCalls = 0;
  const models = await modelsRequest(
    new Request("http://127.0.0.1:17841/v1/models"),
    config,
    async () => {
      nativeCalls += 1;
      throw new Error("native Codex must not be contacted");
    },
  );
  expect(nativeCalls).toBe(0);
  expect(models.status).toBe(200);
  const catalog = await models.json() as { data: Array<{ id: string }> };
  expect(catalog.data.every(model => model.id.startsWith("chatgpt-web/"))).toBe(true);

  const unknown = await responseRequest(new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: [] }),
  }), config);
  expect(unknown.status).toBe(400);

  const compact = await compactRequest(new Request("http://127.0.0.1:17841/v1/responses/compact", {
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
          content: [{ type: "input_text", text: "Compact" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn_web" },
        },
      ],
    }),
  }), config, () => ({
    name: "test-web",
    async runTurn(_parsed, incoming, emit) {
      expect(incoming.headers.get("x-codex-turn-metadata")).toContain("thread_web");
      emit({ type: "text_delta", text: "ok", phase: "final_answer" });
      emit({
        type: "done",
        stopReason: "stop",
        endTurn: true,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true },
      });
    },
  }));
  expect(compact.status).toBe(200);
});
