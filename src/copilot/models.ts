import type { CopilotConfig, CopilotModelConfig } from "./config";

/**
 * Codex consumes the native `models` array from GET /v1/models. Other OpenAI-compatible
 * clients expect `data`, so the endpoint returns both representations.
 */
export function copilotModelRow(model: CopilotModelConfig, priority: number): Record<string, unknown> {
  return {
    slug: model.id,
    display_name: model.displayName,
    description: model.description,
    visibility: "list",
    supported_in_api: true,
    priority,
    input_modalities: ["text"],
    // Keep the regular Responses tool surface instead of collapsing tools into code mode.
    tool_mode: null,
    // This bridge does not implement Codex's native multi-agent protocol. Tools still work.
    multi_agent_version: "disabled",
    default_reasoning_level: model.defaultReasoningLevel,
    supported_reasoning_levels: model.supportedReasoningLevels.map(level => ({
      effort: level.effort,
      description: level.description,
    })),
    context_window: model.contextWindow,
    max_context_window: model.contextWindow,
    effective_context_window_percent: 95,
    auto_compact_token_limit: model.autoCompactTokenLimit,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    base_instructions: "You are a coding agent running through a local Microsoft 365 Copilot Web bridge.",
    shell_type: "shell_command",
    upgrade: null,
    // Required by current Codex catalog parsing. The bridge handles text verbosity in the prompt,
    // does not implement encrypted reasoning summaries, and runs tool calls sequentially.
    support_verbosity: true,
    default_verbosity: "medium",
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    supports_parallel_tool_calls: false,
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10_000 },
    experimental_supported_tools: [],
  };
}

export function copilotCatalog(config: CopilotConfig): Record<string, unknown> {
  const models = config.models.map((model, index) => copilotModelRow(model, index + 1));
  return {
    object: "list",
    data: config.models.map(model => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: "copilot-web",
    })),
    models,
  };
}
