import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import {
  CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
  CHATGPT_WEB_MODEL_ROUTES,
  resolveChatGptWebContextLimits,
} from "../src/chatgpt-web-models";
import { modelsRequest } from "../src/server";

test("proxies official /models auth and query, then appends the fixed ChatGPT Web models", async () => {
  const request = new Request("http://127.0.0.1:17841/v1/models?client_version=1.2.3", {
    headers: { authorization: "Bearer codex-oauth-token", "if-none-match": "native-etag" },
  });
  let upstream: Request | undefined;
  const config = defaultConfig("full");
  config.subagentProtocol = "native";
  config.proAvailable = true;
  const response = await modelsRequest(request, config, async input => {
    upstream = input;
    return Response.json({
      models: [{
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        priority: 1,
        visibility: "list",
        supported_in_api: true,
        multi_agent_version: "v2",
        supported_reasoning_levels: [],
        tool_mode: "code_mode_only",
        context_window: 300_000,
        max_context_window: 320_000,
        auto_compact_token_limit: 270_000,
      }],
    }, { headers: { etag: "native-etag" } });
  }, () => ({ contextWindow: 371_851 }));

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
      effective_context_window_percent?: number;
      auto_compact_token_limit?: number;
      supported_in_api?: boolean;
      priority?: number;
      multi_agent_version?: string;
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
  expect(body.models[0]!.context_window).toBe(300_000);
  expect(body.models[0]!.max_context_window).toBe(371_851);
  expect(body.models[0]!.auto_compact_token_limit).toBe(270_000);
  expect(body.models[0]!.multi_agent_version).toBe("v2");
  for (const [index, model] of body.models.slice(1).entries()) {
    const route = CHATGPT_WEB_MODEL_ROUTES[index]!;
    const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config);
    expect(model.context_window).toBe(limits.contextWindow);
    expect(model.max_context_window).toBe(limits.contextWindow);
    expect(model.effective_context_window_percent).toBe(limits.effectiveContextWindowPercent);
    expect(model.auto_compact_token_limit).toBe(limits.autoCompactTokenLimit);
    expect(model.supported_in_api).toBe(true);
    expect(model.priority).toBe(1);
    expect(model.multi_agent_version).toBe("disabled");
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
    .toEqual(["chatgpt-web/luna", "chatgpt-web/think"]);
});

test("Zero Risk returns one generic Web row without using scanned capabilities", async () => {
  const config = defaultConfig("full");
  config.browserInteractionMode = "manual";
  config.solAvailable = true;
  config.proAvailable = true;
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

  expect(response.status).toBe(200);
  const body = await response.json() as { models: Array<Record<string, unknown> & { slug: string }> };
  expect(body.models.filter(model => model.slug.startsWith("chatgpt-web/"))).toEqual([{
    slug: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.slug,
    display_name: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.displayName,
    description: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.description,
    visibility: "list",
    supported_in_api: true,
    supported_reasoning_levels: [{ effort: "low", description: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.displayName }],
    tool_mode: null,
    upgrade: null,
    default_reasoning_level: "low",
    input_modalities: ["text"],
    context_window: 123_000,
    max_context_window: 123_000,
    effective_context_window_percent: 78,
    auto_compact_token_limit: 96_000,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    multi_agent_version: "disabled",
  }]);
});

test("ChatGPT-only native catalog rows do not turn model discovery into a 502", async () => {
  const config = defaultConfig("browser-only");
  const response = await modelsRequest(
    new Request("http://127.0.0.1:17841/v1/models?client_version=0.147.0", {
      headers: { authorization: "Bearer chatgpt-session-token" },
    }),
    config,
    async () => Response.json({
      models: [{
        slug: "gpt-chatgpt-only",
        display_name: "ChatGPT only",
        visibility: "list",
        supported_in_api: false,
        supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
        tool_mode: null,
      }],
    }),
  );

  expect(response.status).toBe(200);
  const body = await response.json() as { models: Array<{ slug: string; supported_in_api?: boolean }> };
  expect(body.models[0]).toMatchObject({ slug: "gpt-chatgpt-only", supported_in_api: false });
  expect(body.models.filter(model => model.slug.startsWith("chatgpt-web/")))
    .toHaveLength(3);
  expect(body.models.filter(model => model.slug.startsWith("chatgpt-web/"))
    .every(model => model.supported_in_api === true)).toBe(true);
});
