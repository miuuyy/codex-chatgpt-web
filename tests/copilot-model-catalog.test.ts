import { describe, expect, test } from "bun:test";
import { defaultCopilotConfig } from "../src/copilot/config";
import { copilotCatalog } from "../src/copilot/models";

describe("Copilot model catalog", () => {
  test("exposes every configured model in both native and OpenAI list shapes", () => {
    const config = defaultCopilotConfig();
    const catalog = copilotCatalog(config);
    const models = catalog.models as Array<Record<string, unknown>>;
    const data = catalog.data as Array<Record<string, unknown>>;
    expect(models).toHaveLength(config.models.length);
    expect(data).toHaveLength(config.models.length);
    expect(models.map(model => model.slug)).toEqual(config.models.map(model => model.id));
    expect(data.map(model => model.id)).toEqual(config.models.map(model => model.id));
  });

  test("marks rows as list-visible Responses models with no native multi-agent protocol", () => {
    const config = defaultCopilotConfig();
    const models = copilotCatalog(config).models as Array<Record<string, unknown>>;
    for (const model of models) {
      expect(model.visibility).toBe("list");
      expect(model.supported_in_api).toBe(true);
      expect(model.tool_mode).toBeNull();
      expect(model.multi_agent_version).toBe("disabled");
      expect(model.input_modalities).toEqual(["text"]);
      expect(model.context_window).toBeGreaterThan(0);
      expect(model.auto_compact_token_limit).toBeLessThan(model.context_window as number);
      expect(model.supported_reasoning_levels).toBeInstanceOf(Array);
      expect(model.supported_in_api).toBe(true);
      expect(model.support_verbosity).toBe(true);
      expect(model.supports_reasoning_summaries).toBe(false);
      expect(model.supports_parallel_tool_calls).toBe(false);
      expect(model.apply_patch_tool_type).toBe("freeform");
      expect(model.truncation_policy).toEqual({ mode: "tokens", limit: 10_000 });
      expect(model.experimental_supported_tools).toEqual([]);
    }
  });

  test("keeps prompt limits below Copilot's message ceiling", () => {
    const config = defaultCopilotConfig();
    expect(config.maxPromptChars).toBeLessThanOrEqual(128_000);
    for (const model of config.models) {
      expect(model.contextWindow).toBeLessThanOrEqual(32_000);
      expect(model.autoCompactTokenLimit).toBeLessThan(model.contextWindow);
    }
    expect(config.models.find(model => model.id === "copilot-web/gpt")?.menuLabel).toBe("GPT");
  });
});
