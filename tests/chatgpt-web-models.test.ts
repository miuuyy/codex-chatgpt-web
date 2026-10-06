import { describe, expect, test } from "bun:test";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import {
  availableChatGptWebModelRoutes,
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_LEGACY_MODEL_ROUTES,
  CHATGPT_WEB_LUNA_MODEL_ROUTES,
  CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE,
  CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
  CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW,
  CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
  CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
  CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
  CHATGPT_WEB_MODEL_ROUTES,
  requireChatGptWebModelRoute,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
} from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { routeChatGptWebRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

function parsed(modelId: string, reasoning = "medium"): CodexParsedRequest {
  return {
    modelId,
    context: { messages: [] },
    stream: false,
    options: { reasoning },
    _rawBody: { model: modelId, reasoning: { effort: reasoning } },
  };
}

describe("fixed ChatGPT Web model routes", () => {
  const plus = { solAvailable: true, extraHighAvailable: false, proAvailable: false };
  const pro = { solAvailable: true, extraHighAvailable: true, proAvailable: true };

  test("keeps the published legacy bindings while advertising named families", () => {
    expect(new Set(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug)).size).toBe(CHATGPT_WEB_MODEL_ROUTES.length);
    expect(CHATGPT_WEB_LEGACY_MODEL_ROUTES.map(route => [route.slug, route.codexEffort, route.adapterEffort])).toEqual([
      ["chatgpt-web/light", "low", "low"],
      ["chatgpt-web/medium", "medium", "medium"],
      ["chatgpt-web/high", "high", "high"],
      ["chatgpt-web/extra-high", "xhigh", "xhigh"],
      ["chatgpt-web/pro", "ultra", "max"],
    ]);
    expect(CHATGPT_WEB_MODEL_ROUTES.map(route => route.displayName)).toEqual([
      "GPT-5.6 Sol Instant (Web)", "GPT-5.6 Sol (Web)", "GPT-5.6 Pro (Web)", "GPT-6 Pro (Web)",
    ]);
    expect(CHATGPT_WEB_LUNA_MODEL_ROUTE.displayName).toBe("GPT-5.6 Luna (Web)");
  });

  test("exposes only Plus-eligible routes without the Pro account capability", () => {
    expect(availableChatGptWebModelRoutes(plus).map(route => route.slug)).toEqual([
      "chatgpt-web/gpt-5.6-sol-instant",
      "chatgpt-web/gpt-5.6-sol",
      "chatgpt-web/high",
    ]);
    expect(availableChatGptWebModelRoutes({ solAvailable: true, extraHighAvailable: true, proAvailable: true }))
      .toEqual([...CHATGPT_WEB_MODEL_ROUTES, requireChatGptWebModelRoute("chatgpt-web/high", pro)]);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/extra-high", plus))
      .toThrow("Extra High is not available for this account");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/pro", plus))
      .toThrow("Pro is not available for this account");
  });

  test("Extra High stays routable without granting Pro or Pro-sized context", () => {
    const config = { ...defaultConfig("full"), extraHighAvailable: true, proAvailable: false };
    expect(availableChatGptWebModelRoutes(config).map(route => route.slug))
      .toEqual(["chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol", "chatgpt-web/high"]);
    const request = parsed("chatgpt-web/extra-high", "low");
    expect(routeChatGptWebRequest(request, config).adapterEffort).toBe("xhigh");
    expect(request.options.reasoning).toBe("xhigh");
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", config))
      .toEqual(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", config));
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", config))
      .toEqual(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "high", config));
    expect(() => requireChatGptWebModelRoute("chatgpt-web/pro", config)).toThrow("not available");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/extra-high", { ...config, extraHighAvailable: undefined }))
      .toThrow("not available");
  });

  test("exposes Luna and Think when the authenticated account has no Sol selector", () => {
    const free = { solAvailable: false, extraHighAvailable: false, proAvailable: false };
    expect(availableChatGptWebModelRoutes(free)).toEqual(CHATGPT_WEB_LUNA_MODEL_ROUTES);
    expect(requireChatGptWebModelRoute("chatgpt-web/luna", free).backendModel)
      .toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(requireChatGptWebModelRoute("chatgpt-web/think", free))
      .toBe(CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/light", free))
      .toThrow("Luna-only account");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/luna", {
      solAvailable: true,
      extraHighAvailable: false, proAvailable: false,
    })).toThrow("only available for Luna-only accounts");
  });

  test("Zero Risk exposes one generic route independent of account capabilities", () => {
    const manual = {
      solAvailable: false,
      extraHighAvailable: false, proAvailable: false,
      browserInteractionMode: "manual" as const,
    };
    expect(availableChatGptWebModelRoutes(manual)).toEqual([CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE]);
    expect(requireChatGptWebModelRoute("chatgpt-web/zero-risk", manual))
      .toBe(CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/zero-risk-pro", manual))
      .toThrow("not enabled in Zero Risk model settings");
    const manualPro = { ...manual, zeroRiskProEnabled: true };
    expect(availableChatGptWebModelRoutes(manualPro)).toEqual([
      CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
      CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
    ]);
    expect(requireChatGptWebModelRoute("chatgpt-web/zero-risk-pro", manualPro))
      .toBe(CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/luna", manual))
      .toThrow("not available while Zero Risk is enabled");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/zero-risk", plus))
      .toThrow("only available while Zero Risk is enabled");
  });

  test("Zero Risk always publishes its fixed three-turn compaction interval and rejects multipart Bigger Context", () => {
    const manual = {
      solAvailable: true,
      extraHighAvailable: true, proAvailable: true,
      browserInteractionMode: "manual" as const,
    };
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, "low", manual)).toEqual({
      contextWindow: 123_000,
      effectiveContextWindowPercent: 78,
      autoCompactTokenLimit: 96_000,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, "low", manual)).toEqual({});
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, "low", manual)).toEqual({
      contextWindow: 336_579,
      effectiveContextWindowPercent: 85,
      autoCompactTokenLimit: 285_000,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, "low", manual)).toEqual({});
    expect(() => availableChatGptWebModelRoutes({
      ...manual,
      experimentalBiggerContext: true,
    })).toThrow("does not support Bigger Context");
  });

  test("publishes measured Plus browser windows and compacts before the transport ceiling", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "low", plus)).toEqual({
      contextWindow: 41_000,
      effectiveContextWindowPercent: 78,
      autoCompactTokenLimit: 32_000,
    });
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", plus)).toEqual({
      contextWindow: 90_000,
      effectiveContextWindowPercent: 89,
      autoCompactTokenLimit: 80_000,
    });
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", plus)).toEqual({
      contextWindow: 90_000,
      effectiveContextWindowPercent: 89,
      autoCompactTokenLimit: 80_000,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "low", plus)).toEqual({
      browserComposerCharLimit: 211_256,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", plus)).toEqual({
      browserComposerCharLimit: 1_048_572,
    });
    expect(() => resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", plus))
      .toThrow("unavailable effort");
  });

  test("publishes the usable Pro browser window instead of the unreachable underlying model window", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "low", pro)).toEqual({
      contextWindow: 111_193,
      effectiveContextWindowPercent: 85,
      autoCompactTokenLimit: 95_000,
    });
    for (const effort of ["medium", "high", "xhigh"] as const) {
      expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, effort, pro)).toEqual({
        contextWindow: 111_193,
        effectiveContextWindowPercent: 85,
        autoCompactTokenLimit: 95_000,
      });
    }
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "max", pro)).toEqual({
      contextWindow: 112_193,
      effectiveContextWindowPercent: 85,
      autoCompactTokenLimit: 95_000,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "low", pro)).toEqual({
      browserMessageTokenLimit: 103_000,
      browserComposerCharLimit: 545_000,
    });
    for (const effort of ["medium", "high", "xhigh"] as const) {
      expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, pro)).toEqual({
        browserMessageTokenLimit: 103_000,
        browserComposerCharLimit: 500_000,
      });
    }
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "max", pro)).toEqual({
      browserMessageTokenLimit: 104_000,
      browserComposerCharLimit: 1_635_000,
    });
  });

  test("publishes Luna's real model window without early native compaction", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_LUNA_BACKEND_MODEL, "low", {
      solAvailable: false,
      extraHighAvailable: false, proAvailable: false,
    })).toEqual({
      contextWindow: 1_050_000,
      effectiveContextWindowPercent: 100,
      autoCompactTokenLimit: 1_050_000,
    });
  });

  test("triples Sol context and compaction limits only when Bigger Context is enabled", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "max", {
      ...pro,
      experimentalBiggerContext: true,
    })).toEqual({
      contextWindow: 336_579,
      effectiveContextWindowPercent: 85,
      autoCompactTokenLimit: 285_000,
    });
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_LUNA_BACKEND_MODEL, "low", {
      solAvailable: false,
      extraHighAvailable: false, proAvailable: false,
      experimentalBiggerContext: true,
    })).toEqual({
      contextWindow: 1_050_000,
      effectiveContextWindowPercent: 100,
      autoCompactTokenLimit: 1_050_000,
    });
  });

  test("binds the selected model authoritatively and ignores a conflicting request effort", () => {
    const request = parsed("chatgpt-web/high", "low");
    const rawSnapshot = structuredClone(request._rawBody);
    const route = routeChatGptWebRequest(request, defaultConfig("browser-only"));

    expect(route.slug).toBe("chatgpt-web/high");
    expect(route).toMatchObject({ codexEffort: "high", adapterEffort: "high" });
    expect(route).not.toHaveProperty("modelFamily");
    expect(route).not.toHaveProperty("supportedCodexEfforts");
    expect(request._chatgptModelFamily).toBeUndefined();
    expect(request.modelId).toBe(CHATGPT_WEB_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("high");
    expect(request._rawBody).toEqual(rawSnapshot);
  });

  test("exposes only the supported High legacy binding and retains account and manual gating", () => {
    for (const capabilities of [plus, pro]) {
      const visible = availableChatGptWebModelRoutes(capabilities);
      expect(visible.filter(route => route.legacy).map(route => route.slug)).toEqual(["chatgpt-web/high"]);
      expect(visible.filter(route => route.slug === "chatgpt-web/high")).toHaveLength(1);
      expect(availableChatGptWebModelRoutes(capabilities, true).filter(route => route.slug === "chatgpt-web/high"))
        .toHaveLength(1);
    }
    const free = { solAvailable: false, proAvailable: false };
    const manual = { ...pro, browserInteractionMode: "manual" as const };
    for (const capabilities of [free, manual]) {
      for (const includeLegacy of [false, true]) {
        expect(availableChatGptWebModelRoutes(capabilities, includeLegacy).map(route => route.slug))
          .not.toContain("chatgpt-web/high");
      }
      expect(() => requireChatGptWebModelRoute("chatgpt-web/high", capabilities)).toThrow("not available");
    }
  });

  test("binds the Pro model to the browser Pro effort and fails closed for unknown routes", () => {
    const config = defaultConfig("full");
    config.extraHighAvailable = true;
    config.proAvailable = true;
    const request = parsed("chatgpt-web/pro", "low");
    expect(routeChatGptWebRequest(request, config).adapterEffort).toBe("max");
    expect(request.options.reasoning).toBe("max");
    expect(() => routeChatGptWebRequest(parsed("chatgpt-web/not-enabled"), config))
      .toThrow("model is not enabled");
  });

  test("keeps Pro compaction on the same retained Pro conversation", () => {
    const config = defaultConfig("full");
    config.extraHighAvailable = true;
    config.proAvailable = true;
    const normal = parsed("chatgpt-web/pro", "low");
    const compact = parsed("chatgpt-web/pro", "low");
    const metadata = {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_pro_compaction" }),
    };
    normal._rawBody = {
      model: "chatgpt-web/pro",
      reasoning: { effort: "low" },
      client_metadata: metadata,
    };
    compact._rawBody = structuredClone(normal._rawBody);
    compact._compactionRequest = true;

    expect(routeChatGptWebRequest(normal, config).slug).toBe("chatgpt-web/pro");
    expect(normal.options.reasoning).toBe("max");
    expect(routeChatGptWebRequest(compact, config).slug).toBe("chatgpt-web/pro");
    expect(compact.options.reasoning).toBe("max");
    expect(chatGptConversationKey(compact, "provider"))
      .toBe(chatGptConversationKey(normal, "provider"));
  });

  test("binds the Luna route to Luna without a selectable effort", () => {
    const config = defaultConfig("browser-only");
    config.solAvailable = false;
    const request = parsed("chatgpt-web/luna", "high");
    const route = routeChatGptWebRequest(request, config);
    expect(route).toBe(CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE);
    expect(request.modelId).toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("low");
  });

  test("binds the Think route to the Luna backend with explicit Think mode", () => {
    const config = defaultConfig("browser-only");
    config.solAvailable = false;
    const request = parsed("chatgpt-web/think", "high");
    const route = routeChatGptWebRequest(request, config);
    expect(route).toBe(CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE);
    expect(request.modelId).toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("medium");
  });

  test("Zero Risk routing preserves its internal backend identity and only a technical Codex effort", () => {
    const config = defaultConfig("full");
    config.browserInteractionMode = "manual";
    const request = parsed("chatgpt-web/zero-risk", "ultra");
    const route = routeChatGptWebRequest(request, config);

    expect(route).toBe(CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE);
    expect(request.modelId).toBe(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("low");

    config.zeroRiskProEnabled = true;
    const proRequest = parsed("chatgpt-web/zero-risk-pro", "ultra");
    const proRoute = routeChatGptWebRequest(proRequest, config);
    expect(proRoute).toBe(CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE);
    expect(proRequest.modelId).toBe(CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL);
    expect(proRequest.options.reasoning).toBe("low");
  });

  test("new families honor effort, gate availability, and separate pinned retained conversations", () => {
    const config = { ...defaultConfig("full"), extraHighAvailable: true, proAvailable: true };
    for (const effort of ["medium", "high", "xhigh"] as const) {
      const request = parsed("chatgpt-web/gpt-5.6-sol", effort);
      routeChatGptWebRequest(request, config);
      expect(request.options.reasoning).toBe(effort);
      expect(request._chatgptModelFamily).toBe("5.6");
    }
    for (const effort of ["low", "max", "ultra", "invented"]) {
      expect(() => routeChatGptWebRequest(parsed("chatgpt-web/gpt-5.6-sol", effort), config)).toThrow("does not support effort");
    }
    expect(() => routeChatGptWebRequest(parsed("chatgpt-web/gpt-5.6-sol", "xhigh"), {
      ...config, extraHighAvailable: false,
    })).toThrow("does not support effort");
    const luna = parsed("chatgpt-web/gpt-5.6-luna", "medium");
    routeChatGptWebRequest(luna, { ...config, solAvailable: false });
    expect(luna.options.reasoning).toBe("medium");
    const keys: string[] = [];
    for (const [model, family] of [["chatgpt-web/gpt-5.6-pro", "5.6"], ["chatgpt-web/gpt-6-pro", "6"], ["chatgpt-web/pro", undefined]] as const) {
      const request: CodexParsedRequest = { ...parsed(model), options: {} };
      request._rawBody = { client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "same-thread" }) } };
      routeChatGptWebRequest(request, config);
      expect(request.options.reasoning).toBe("max");
      expect(request._chatgptModelFamily).toBe(family);
      const key = chatGptConversationKey(request, "provider")!;
      keys.push(key);
      expect(chatGptConversationKey({ ...request, _compactionRequest: true }, "provider")).toBe(key);
      expect(() => routeChatGptWebRequest(parsed(model, "max"), { ...config, proAvailable: false })).toThrow("not available");
    }
    expect(new Set(keys).size).toBe(3);
  });
});
