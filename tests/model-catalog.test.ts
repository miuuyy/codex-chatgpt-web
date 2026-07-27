import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { CHATGPT_WEB_MODEL_ROUTES } from "../src/chatgpt-web-models";
import { augmentNativeModelCatalog } from "../src/model-catalog";

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
        prefer_websockets: true,
        tool_mode: route.requiresPro ? null : "code_mode_only",
        default_reasoning_level: route.codexEffort,
        supported_reasoning_levels: [{ effort: route.codexEffort, description: route.displayName }],
        additional_speed_tiers: [],
        service_tiers: [],
        default_service_tier: null,
      });
      expect(model).not.toHaveProperty("context_window");
      expect(model).not.toHaveProperty("max_context_window");
      expect(model).not.toHaveProperty("auto_compact_token_limit");
      expect(model).not.toHaveProperty("comp_hash");
    }
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
    expect(web.every(model => (model.supported_reasoning_levels as unknown[]).length === 1)).toBe(true);
  });

  test("honors an explicit Codex context override without replacing or reordering native models", () => {
    const native = source();
    const nativeSnapshot = structuredClone(native);
    const result = augmentNativeModelCatalog(native, defaultConfig("full"), {
      model: "gpt-5.6-sol",
      contextWindow: 371_851,
    });
    const models = result.models as Array<Record<string, unknown>>;
    const originalModels = nativeSnapshot.models as Array<Record<string, unknown>>;

    expect(native).toEqual(nativeSnapshot);
    expect(models.slice(0, 3)).toEqual([
      originalModels[0],
      { ...originalModels[1], max_context_window: 371_851 },
      originalModels[2],
    ]);
    expect(models[1]!.context_window).toBe(300_000);
  });

  test("fails closed when the official native template is absent", () => {
    expect(() => augmentNativeModelCatalog({ models: [{ slug: "other" }] }, defaultConfig("full")))
      .toThrow("missing gpt-5.6-sol");
  });
});
