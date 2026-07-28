import type { AppConfig } from "./config";
import type { CodexModelContextOverride } from "./codex-integration";
import {
  availableChatGptWebModelRoutes,
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_MODEL_PREFIX,
  type ChatGptWebModelRoute,
} from "./chatgpt-web-models";

const NATIVE_TEMPLATE_MODEL = CHATGPT_WEB_BACKEND_MODEL;

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function slug(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as JsonObject).slug;
  return typeof candidate === "string" ? candidate : undefined;
}

function reasoningLevel(template: JsonObject, effort: string, description: string): JsonObject {
  const levels = Array.isArray(template.supported_reasoning_levels)
    ? template.supported_reasoning_levels.filter(level => level && typeof level === "object" && !Array.isArray(level)) as JsonObject[]
    : [];
  const source = levels.find(level => level.effort === effort);
  return { ...(source ? structuredClone(source) : {}), effort, description };
}

export function buildChatGptWebModel(
  templateValue: unknown,
  route: ChatGptWebModelRoute,
  config: AppConfig,
): JsonObject {
  const template = object(templateValue, `native ${NATIVE_TEMPLATE_MODEL} model`);
  if (slug(template) !== NATIVE_TEMPLATE_MODEL) {
    throw new Error(`ChatGPT Web model template must be ${NATIVE_TEMPLATE_MODEL}`);
  }
  const model: JsonObject = {
    ...structuredClone(template),
    slug: route.slug,
    display_name: route.displayName,
    description: route.description,
    input_modalities: ["text", "image"],
    visibility: "list",
    supported_in_api: false,
    tool_mode: config.mode !== "browser-only" && !route.requiresPro ? template.tool_mode : null,
    upgrade: null,
    default_reasoning_level: route.codexEffort,
    supported_reasoning_levels: [reasoningLevel(template, route.codexEffort, route.displayName)],
    // ChatGPT Web has no Codex service tier. Never inherit the native template's Fast tiers.
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
  };
  // The browser product owns its context and performs its own internal compaction. Advertising the
  // native template's context boundary makes Codex launch a second remote-compaction turn, which
  // cannot preserve the in-flight ChatGPT browser/MCP response.
  delete model.context_window;
  delete model.max_context_window;
  delete model.auto_compact_token_limit;
  delete model.comp_hash;
  delete model.availability_nux;
  return model;
}

export function augmentNativeModelCatalog(
  value: unknown,
  config: AppConfig,
  contextOverride?: CodexModelContextOverride,
): JsonObject {
  const catalog = object(value, "native Codex models response");
  if (!Array.isArray(catalog.models)) {
    throw new Error("Native Codex models response is missing a models array");
  }
  const template = catalog.models.find(model => slug(model) === NATIVE_TEMPLATE_MODEL);
  if (!template) {
    throw new Error(`Native Codex models response is missing ${NATIVE_TEMPLATE_MODEL}`);
  }
  const nativeModels = structuredClone(
    catalog.models.filter(model => !slug(model)?.startsWith(CHATGPT_WEB_MODEL_PREFIX)),
  );
  if (contextOverride) {
    const selected = nativeModels.find(model => slug(model) === contextOverride.model);
    if (selected) {
      const model = object(selected, `native ${contextOverride.model} model`);
      const current = model.max_context_window;
      if (current !== undefined && current !== null
        && (typeof current !== "number" || !Number.isSafeInteger(current) || current <= 0)) {
        throw new Error(`Native ${contextOverride.model} max_context_window must be a positive integer`);
      }
      if (current === undefined || current === null || current < contextOverride.contextWindow) {
        model.max_context_window = contextOverride.contextWindow;
      }
    }
  }
  const webModels = availableChatGptWebModelRoutes(config.proAvailable)
    .map(route => buildChatGptWebModel(template, route, config));
  return {
    ...structuredClone(catalog),
    models: [...nativeModels, ...webModels],
  };
}
