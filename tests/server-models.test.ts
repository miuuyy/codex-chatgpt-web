import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import {
  CHATGPT_WEB_MODEL_PRIORITY,
} from "../src/model-catalog";
import { CHATGPT_WEB_MODEL_ROUTES, resolveChatGptWebContextLimits } from "../src/chatgpt-web-models";
import { modelsRequest } from "../src/server";

test("proxies official /models auth and query, then appends the fixed ChatGPT Web models", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models?client_version=1.2.3", {
    headers: { authorization: "Bearer codex-oauth-token", "if-none-match": "native-etag" },
  });
  let upstream: Request | undefined;
  const config = defaultConfig("full");
  config.proAvailable = true;
  const response = await modelsRequest(request, config, async input => {
    upstream = input;
    return Response.json({
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [],
        tool_mode: "code_mode_only",
      }],
    }, { headers: { etag: "native-etag" } });
  }, () => ({ model: "gpt-5.6-sol", contextWindow: 371_851 }));

  expect(upstream!.url).toBe("https://chatgpt.com/backend-api/codex/models?client_version=1.2.3");
  expect(upstream!.method).toBe("GET");
  expect(upstream!.headers.get("authorization")).toBe("Bearer codex-oauth-token");
  expect(upstream!.headers.get("if-none-match")).toBeNull();
  expect(response.headers.get("etag")).not.toBe("native-etag");
  const body = await response.json() as {
    models: Array<{
      slug: string;
      context_window?: number;
      max_context_window?: number;
      auto_compact_token_limit?: number;
      supported_in_api?: boolean;
      priority?: number;
    }>;
  };
  expect(body.models.map(model => model.slug)).toEqual([
    "gpt-5.6-sol",
    "chatgpt-web/light",
    "chatgpt-web/medium",
    "chatgpt-web/high",
    "chatgpt-web/extra-high",
    "chatgpt-web/pro",
  ]);
  expect(body.models[0]!.max_context_window).toBe(371_851);
  for (const [index, model] of body.models.slice(1).entries()) {
    const route = CHATGPT_WEB_MODEL_ROUTES[index]!;
    const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config);
    expect(model.context_window).toBe(limits.contextWindow);
    expect(model.max_context_window).toBe(limits.contextWindow);
    expect(model.auto_compact_token_limit).toBe(limits.autoCompactTokenLimit);
    expect(model.supported_in_api).toBe(true);
    expect(model.priority).toBe(CHATGPT_WEB_MODEL_PRIORITY);
  }
});

test("Luna-only account exposes no paid ChatGPT Web routes", async () => {
  const config = defaultConfig("browser-only");
  config.solAvailable = false;
  const response = await modelsRequest(
    new Request("http://127.0.0.1:17841/v1/models", {
      headers: { authorization: "Bearer codex-oauth-token" },
    }),
    config,
    async () => Response.json({
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [{ effort: "low", description: "Low" }],
        tool_mode: "code_mode_only",
      }],
    }),
  );
  const body = await response.json() as { models: Array<{ slug: string }> };
  expect(body.models.filter(model => model.slug.startsWith("chatgpt-web/")).map(model => model.slug))
    .toEqual(["chatgpt-web/luna"]);
});
