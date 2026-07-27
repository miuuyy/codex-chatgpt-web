export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";
export const CHATGPT_WEB_BACKEND_MODEL = "gpt-5.6-sol";

export type ChatGptWebCodexEffort = "low" | "medium" | "high" | "xhigh" | "ultra";
export type ChatGptWebAdapterEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatGptWebModelRoute {
  slug: string;
  displayName: string;
  description: string;
  codexEffort: ChatGptWebCodexEffort;
  adapterEffort: ChatGptWebAdapterEffort;
  requiresPro: boolean;
  requiresFullHarness?: boolean;
  ultraOrchestration?: boolean;
}

/**
 * The selected Codex model is the authoritative ChatGPT browser mode. Codex's signed desktop UI
 * always renders an Effort row, so every routed model advertises exactly one immutable protocol
 * effort. Pro uses Codex's `ultra` protocol value but binds explicitly to ChatGPT Pro (`max`) at
 * the adapter boundary.
 */
export const CHATGPT_WEB_MODEL_ROUTES: readonly ChatGptWebModelRoute[] = [
  {
    slug: "chatgpt-web/light",
    displayName: "ChatGPT Web — Instant",
    description: "ChatGPT Web Instant through the native Codex harness.",
    codexEffort: "low",
    adapterEffort: "low",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/medium",
    displayName: "ChatGPT Web — Medium",
    description: "ChatGPT Web Medium through the native Codex harness.",
    codexEffort: "medium",
    adapterEffort: "medium",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/high",
    displayName: "ChatGPT Web — High",
    description: "ChatGPT Web High through the native Codex harness.",
    codexEffort: "high",
    adapterEffort: "high",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/extra-high",
    displayName: "ChatGPT Web — Extra High",
    description: "ChatGPT Web Extra High through the native Codex harness.",
    codexEffort: "xhigh",
    adapterEffort: "xhigh",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/ultra",
    displayName: "ChatGPT Web — Ultra",
    description: "Extra High coordinator that may fan out to three inherited Codex agents. Uses the default service tier.",
    codexEffort: "xhigh",
    adapterEffort: "xhigh",
    requiresPro: false,
    requiresFullHarness: true,
    ultraOrchestration: true,
  },
  {
    slug: "chatgpt-web/pro",
    displayName: "ChatGPT Web — Pro",
    description: "Account-gated ChatGPT Pro through the native Codex harness. Local tool calls are unavailable in this mode.",
    codexEffort: "ultra",
    adapterEffort: "max",
    requiresPro: true,
  },
];

const routesBySlug = new Map(CHATGPT_WEB_MODEL_ROUTES.map(route => [route.slug, route]));

export function isChatGptWebModelSlug(modelId: string): boolean {
  return modelId.startsWith(CHATGPT_WEB_MODEL_PREFIX);
}

export function availableChatGptWebModelRoutes(
  proAvailable: boolean,
  fullHarness = true,
): readonly ChatGptWebModelRoute[] {
  return CHATGPT_WEB_MODEL_ROUTES.filter(route =>
    (proAvailable || !route.requiresPro)
    && (fullHarness || !route.requiresFullHarness)
  );
}

export function requireChatGptWebModelRoute(
  modelId: string,
  proAvailable: boolean,
  fullHarness = true,
): ChatGptWebModelRoute {
  const route = routesBySlug.get(modelId);
  if (!route) throw new Error(`ChatGPT web model is not enabled: ${modelId}`);
  if (route.requiresPro && !proAvailable) {
    throw new Error("ChatGPT Web Pro is not available for this account");
  }
  if (route.requiresFullHarness && !fullHarness) {
    throw new Error("ChatGPT Web Ultra requires the full Codex Native harness");
  }
  return route;
}
