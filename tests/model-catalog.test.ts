import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import {
  augmentNativeModelCatalog,
  CHATGPT_WEB_AUTO_COMPACT_TOKEN_LIMIT,
  CHATGPT_WEB_CONTEXT_WINDOW,
  CHATGPT_WEB_MODEL_PRIORITY,
} from "../src/model-catalog";

function source(): Record<string, unknown> {
  return {
    models: [
      { slug: "gpt-5.5", display_name: "5.5", priority: 1 },
      {
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        description: "native",
        priority: 2,
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        multi_agent_version: "v2",
        base_instructions: "native harness",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "medium", description: "Medium native" },
          { effort: "high", description: "High native" },
          { effort: "xhigh", description: "Extra high native" },
        ],
        tool_mode: "code_mode_only",
        context_window: 300_000,
        max_context_window: 320_000,
        auto_compact_token_limit: 270_000,
        comp_hash: "native-compaction-contract",
        additional_speed_tiers: [{ id: "fast" }],
        service_tiers: [{ id: "fast", name: "Fast" }],
        default_service_tier: "fast",
      },
      { slug: "gpt-5.6-terra", display_name: "5.6 Terra", priority: 3 },
    ],
  };
}

describe("native /models augmentation", () => {
  test("preserves every native model in order and appends one fixed model per ChatGPT Web mode", () => {
    const native = source();
    const nativeSnapshot = structuredClone(native);
    const config = defaultConfig("full");
    config.proAvailable = true;
    const result = augmentNativeModelCatalog(native, config);
    const models = result.models as Array<Record<string, unknown>>;

    expect(native).toEqual(nativeSnapshot);
    expect(models.slice(0, 3)).toEqual(nativeSnapshot.models as Array<Record<string, unknown>>);
    const web = models.slice(3);
    expect(web.map(model => model.slug)).toEqual(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug));
    expect(web.map(model => model.display_name)).toEqual(CHATGPT_WEB_MODEL_ROUTES.map(route => route.displayName));
    for (const [index, model] of web.entries()) {
      const route = CHATGPT_WEB_MODEL_ROUTES[index]!;
      expect(model).toMatchObject({
        slug: route.slug,
        display_name: route.displayName,
        tool_mode: "code_mode_only",
        default_reasoning_level: route.codexEffort,
        supported_reasoning_levels: [{ effort: route.codexEffort, description: route.displayName }],
        multi_agent_version: "v1",
        supported_in_api: true,
        priority: CHATGPT_WEB_MODEL_PRIORITY,
        context_window: CHATGPT_WEB_CONTEXT_WINDOW,
        max_context_window: CHATGPT_WEB_CONTEXT_WINDOW,
        auto_compact_token_limit: CHATGPT_WEB_AUTO_COMPACT_TOKEN_LIMIT,
        additional_speed_tiers: [],
        service_tiers: [],
        default_service_tier: null,
      });
      expect(model).not.toHaveProperty("comp_hash");
    }
  });

  test("keeps every routed Web model in Codex's V1 spawn-agent model registry", () => {
    const config = defaultConfig("full");
    config.proAvailable = true;
    const models = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;

    // Codex treats a custom openai_base_url as an API-compatible provider, filters out models
    // unsupported by that API, sorts by priority, and exposes at most five spawn overrides.
    const spawnOverrides = models
      .filter(model => model.supported_in_api === true && model.visibility === "list")
      .toSorted((left, right) => Number(left.priority) - Number(right.priority))
      .slice(0, 5)
      .map(model => model.slug);

    expect(spawnOverrides).toEqual(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug));
  });

  test("owns only its namespace, is idempotent, and omits account-gated Pro when unavailable", () => {
    const config = defaultConfig("browser-only");
    config.proAvailable = false;
    const polluted = source();
    (polluted.models as unknown[]).push(
      { slug: "chatgpt-web/gpt-5.6-sol", display_name: "legacy generic route" },
      { slug: "chatgpt-web/pro", display_name: "stale Pro route" },
    );
    const first = augmentNativeModelCatalog(polluted, config);
    const second = augmentNativeModelCatalog(first, config);
    const models = second.models as Array<Record<string, unknown>>;
    const web = models.filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(web.map(model => model.slug)).toEqual(
      CHATGPT_WEB_MODEL_ROUTES.filter(route => !route.requiresPro).map(route => route.slug),
    );
    expect(web.every(model => model.tool_mode === null)).toBe(true);
    expect(web.every(model => model.multi_agent_version === "v1")).toBe(true);
    expect(web.every(model => (model.supported_reasoning_levels as unknown[]).length === 1)).toBe(true);
  });

  test("honors an explicit Codex context override without replacing or reordering native models", () => {
    const native = source();
    const nativeSnapshot = structuredClone(native);
    // model_context_window is one top-level Codex setting, so it must not depend on which model
    // the config's `model` line happens to name - that line can hold a ChatGPT Web slug.
    const result = augmentNativeModelCatalog(native, defaultConfig("full"), {
      model: "chatgpt-web/medium",
      contextWindow: 371_851,
    });
    const models = result.models as Array<Record<string, unknown>>;
    const originalModels = nativeSnapshot.models as Array<Record<string, unknown>>;

    expect(native).toEqual(nativeSnapshot);
    expect(models.slice(0, 3)).toEqual([
      { ...originalModels[0], max_context_window: 371_851 },
      { ...originalModels[1], max_context_window: 371_851 },
      { ...originalModels[2], max_context_window: 371_851 },
    ]);
    expect(models[1]!.context_window).toBe(300_000);
    for (const model of models.slice(3)) {
      expect(model.context_window).toBe(CHATGPT_WEB_CONTEXT_WINDOW);
      expect(model.max_context_window).toBe(CHATGPT_WEB_CONTEXT_WINDOW);
      expect(model.auto_compact_token_limit).toBe(CHATGPT_WEB_AUTO_COMPACT_TOKEN_LIMIT);
    }
  });

  test("never lowers a native window that already exceeds the Codex context override", () => {
    const native = source();
    const models = native.models as Array<Record<string, unknown>>;
    models[0]!.max_context_window = 1_000_000;
    const result = augmentNativeModelCatalog(native, defaultConfig("full"), {
      model: "gpt-5.6-sol",
      contextWindow: 371_851,
    });

    expect((result.models as Array<Record<string, unknown>>)[0]!.max_context_window).toBe(1_000_000);
  });

  test("uses an available compatible official model when an account exposes a smaller catalog", () => {
    const native = source();
    const models = native.models as Array<Record<string, unknown>>;
    models.splice(1, 1);
    Object.assign(models[1]!, {
      visibility: "list",
      supported_in_api: true,
      tool_mode: "code_mode_only",
      supported_reasoning_levels: [{ effort: "high", description: "High" }],
      shell_type: "shell_command",
    });

    const result = augmentNativeModelCatalog(native, defaultConfig("full"));
    const web = (result.models as Array<Record<string, unknown>>)
      .filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(web.length).toBe(4);
    expect(web.every(model => model.shell_type === "shell_command")).toBe(true);
    expect(web.every(model => model.tool_mode === "code_mode_only")).toBe(true);
  });

  test("follows official catalog order instead of preferring a named paid-tier model", () => {
    const native = source();
    const sourceModels = native.models as Array<Record<string, unknown>>;
    const sol = sourceModels[1]!;
    const terra = {
      ...structuredClone(sol),
      slug: "gpt-5.6-terra",
      display_name: "5.6 Terra",
      shell_type: "terra-shell",
    };
    native.models = [sourceModels[0], terra, sol];

    const result = augmentNativeModelCatalog(native, defaultConfig("full"));
    const web = (result.models as Array<Record<string, unknown>>)
      .filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(web.every(model => model.shell_type === "terra-shell")).toBe(true);
  });

  test("fails closed when no official model satisfies the harness contract", () => {
    expect(() => augmentNativeModelCatalog({
      models: [{
        slug: "other",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [],
        tool_mode: null,
      }],
    }, defaultConfig("full"))).toThrow("no list-visible, API-supported, tool-capable model");
  });
});
