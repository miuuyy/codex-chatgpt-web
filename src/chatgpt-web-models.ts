export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";
export const CHATGPT_WEB_BACKEND_MODEL = "gpt-5.6-sol";
export const CHATGPT_WEB_LUNA_BACKEND_MODEL = "gpt-5.6-luna";
/** Internal adapter identity for a turn whose ChatGPT model is selected by the user in the launcher. */
export const CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL = "chatgpt-web-zero-risk";
/** Internal adapter identity for the explicitly enabled, Pro-sized Zero Risk context profile. */
export const CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL = "chatgpt-web-zero-risk-pro";

export type ChatGptWebAutomaticBackendModel =
  | typeof CHATGPT_WEB_BACKEND_MODEL
  | typeof CHATGPT_WEB_LUNA_BACKEND_MODEL;
export type ChatGptWebBackendModel =
  | ChatGptWebAutomaticBackendModel
  | ChatGptWebZeroRiskBackendModel;
export type ChatGptWebZeroRiskBackendModel =
  | typeof CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL
  | typeof CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL;

export type ChatGptWebCodexEffort = "low" | "medium" | "high" | "xhigh" | "ultra";
export type ChatGptWebAdapterEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Measured Plus browser transport windows, including the fixed hidden ChatGPT platform reserve.
 * Codex compacts the visible task at the lower explicit threshold before the next browser turn is
 * compiled. The remaining headroom is owned by ChatGPT's product prompt and Codex Native schemas.
 */
export const CHATGPT_WEB_INSTANT_CONTEXT_WINDOW = 41_000;
export const CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT = 32_000;
/**
 * Zero Risk keeps one visible ChatGPT conversation across sequential Codex turns. Its fixed route
 * therefore uses the requested three-turn compaction interval without enabling Bigger Context's
 * automatic multipart transport; the user still pastes exactly one incremental prompt per turn.
 */
export const CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW = CHATGPT_WEB_INSTANT_CONTEXT_WINDOW * 3;
export const CHATGPT_WEB_ZERO_RISK_AUTO_COMPACT_TOKEN_LIMIT = CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT * 3;
export const CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW = 90_000;
export const CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT = 80_000;
export const CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT = 211_256;
export const CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT = 1_048_572;
/** Hidden ChatGPT product prompt and Codex Native schema reserve included in usage estimates. */
export const CHATGPT_WEB_PLATFORM_RESERVE_TOKENS = 8_192;
/** Pro-account usable browser windows and separately measured one-message boundaries. */
export const CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT = 95_000;
export const CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT = 103_000;
export const CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT = 104_000;
// Browser message maxima are inclusive, while the context preflight treats its ceiling as an
// exclusive upper bound. The extra token preserves the last accepted payload exactly.
export const CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW =
  CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
export const CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW =
  CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
/**
 * Zero Risk Pro keeps the same three-turn manual conversation budget as the default profile, but
 * sizes each turn from the measured ChatGPT Pro boundary. The launcher cannot verify that the user
 * actually selected Pro, so this profile is exposed only through an explicit user setting.
 */
export const CHATGPT_WEB_ZERO_RISK_PRO_CONTEXT_WINDOW =
  CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW * 3;
export const CHATGPT_WEB_ZERO_RISK_PRO_AUTO_COMPACT_TOKEN_LIMIT =
  CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT * 3;
export const CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT = 545_000;
export const CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT = 1_045_000;
export const CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT = 1_635_000;
/**
 * The underlying Luna model owns this context window. ChatGPT Free's much smaller browser request
 * envelope is enforced separately at the browser boundary; rolling checkpoints keep completed
 * history out of later browser requests without asking Codex to compact its canonical history.
 */
export const CHATGPT_WEB_LUNA_CONTEXT_WINDOW = 1_050_000;
export const CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER = 3;

export interface ChatGptWebContextLimits {
  contextWindow: number;
  effectiveContextWindowPercent: number;
  autoCompactTokenLimit: number;
}

export interface ChatGptWebTransportLimits {
  browserMessageTokenLimit?: number;
  browserComposerCharLimit?: number;
}

export function isChatGptWebZeroRiskBackendModel(
  model: string,
): model is ChatGptWebZeroRiskBackendModel {
  return model === CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL
    || model === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL;
}

function contextLimits(
  contextWindow: number,
  autoCompactTokenLimit: number,
): ChatGptWebContextLimits {
  return {
    contextWindow,
    // Codex reports this effective window in its context indicator. Align it with the practical
    // pre-compaction budget instead of exposing an unreachable underlying model window.
    effectiveContextWindowPercent: Math.round((autoCompactTokenLimit / contextWindow) * 100),
    autoCompactTokenLimit,
  };
}

/** Resolve the product limit for the selected visible ChatGPT mode. */
export function resolveChatGptWebContextLimits(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebContextLimits {
  if (isChatGptWebZeroRiskBackendModel(backendModel)) {
    if (capabilities.experimentalBiggerContext) {
      throw new Error("Zero Risk does not support Bigger Context");
    }
    if (backendModel === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL) {
      return contextLimits(
        CHATGPT_WEB_ZERO_RISK_PRO_CONTEXT_WINDOW,
        CHATGPT_WEB_ZERO_RISK_PRO_AUTO_COMPACT_TOKEN_LIMIT,
      );
    }
    return contextLimits(
      CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW,
      CHATGPT_WEB_ZERO_RISK_AUTO_COMPACT_TOKEN_LIMIT,
    );
  }
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    // Luna carries continuity through a private checkpoint on every completed browser turn. Codex
    // internally clamps this field to 90% of the model window, but the reported active usage is the
    // bounded payload actually sent to ChatGPT and therefore stays far below that threshold.
    return contextLimits(CHATGPT_WEB_LUNA_CONTEXT_WINDOW, CHATGPT_WEB_LUNA_CONTEXT_WINDOW);
  }

  if (effort === "xhigh" && !(capabilities.proAvailable || capabilities.extraHighAvailable === true)) {
    throw new Error(`ChatGPT Plus context limit is not defined for unavailable effort: ${effort}`);
  }

  let limits: ChatGptWebContextLimits;
  if (capabilities.proAvailable) {
    const contextWindow = effort === "low"
      ? CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW
      : effort === "max"
        ? CHATGPT_WEB_PRO_MODEL_CONTEXT_WINDOW
        : CHATGPT_WEB_PRO_STANDARD_CONTEXT_WINDOW;
    limits = contextLimits(contextWindow, CHATGPT_WEB_PRO_AUTO_COMPACT_TOKEN_LIMIT);
  } else if (effort === "low") {
    limits = contextLimits(
      CHATGPT_WEB_INSTANT_CONTEXT_WINDOW,
      CHATGPT_WEB_INSTANT_AUTO_COMPACT_TOKEN_LIMIT,
    );
  } else if (effort === "medium" || effort === "high" || effort === "xhigh") {
    limits = contextLimits(
      CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW,
      CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT,
    );
  } else {
    throw new Error(`ChatGPT Plus context limit is not defined for unavailable effort: ${effort}`);
  }
  if (!capabilities.experimentalBiggerContext) return limits;
  return contextLimits(
    limits.contextWindow * CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
    limits.autoCompactTokenLimit * CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
  );
}

/** Resolve limits of one visible ChatGPT composer message, independently of model context. */
export function resolveChatGptWebTransportLimits(
  backendModel: ChatGptWebBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebTransportLimits {
  if (isChatGptWebZeroRiskBackendModel(backendModel)) return {};
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) return {};
  if (effort === "xhigh" && !(capabilities.proAvailable || capabilities.extraHighAvailable === true)) {
    throw new Error(`ChatGPT Plus transport limit is not defined for unavailable effort: ${effort}`);
  }
  if (!capabilities.proAvailable) {
    if (effort === "low") {
      return { browserComposerCharLimit: CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT };
    }
    if (effort === "medium" || effort === "high" || effort === "xhigh") {
      return { browserComposerCharLimit: CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT };
    }
    throw new Error(`ChatGPT Plus transport limit is not defined for unavailable effort: ${effort}`);
  }
  if (effort === "low") {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_INSTANT_COMPOSER_CHAR_LIMIT,
    };
  }
  if (effort === "max") {
    return {
      browserMessageTokenLimit: CHATGPT_WEB_PRO_MODEL_MESSAGE_TOKEN_LIMIT,
      browserComposerCharLimit: CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT,
    };
  }
  return {
    browserMessageTokenLimit: CHATGPT_WEB_PRO_STANDARD_MESSAGE_TOKEN_LIMIT,
    browserComposerCharLimit: CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT,
  };
}

interface ChatGptWebModelRouteBase {
  slug: string;
  displayName: string;
  description: string;
  codexEffort: ChatGptWebCodexEffort;
  requiresExtraHigh?: boolean;
  requiresPro: boolean;
}

export interface ChatGptWebAutomaticModelRoute extends ChatGptWebModelRouteBase {
  interactionMode: "automatic";
  backendModel: ChatGptWebAutomaticBackendModel;
  adapterEffort: ChatGptWebAdapterEffort;
}

export interface ChatGptWebZeroRiskModelRoute extends ChatGptWebModelRouteBase {
  interactionMode: "manual";
  backendModel: ChatGptWebZeroRiskBackendModel;
  /** Technical protocol value only; Zero Risk must not use it to choose the ChatGPT model. */
  adapterEffort: "low";
}

export type ChatGptWebModelRoute = ChatGptWebAutomaticModelRoute | ChatGptWebZeroRiskModelRoute;

export interface ChatGptWebAccountCapabilities {
  solAvailable: boolean;
  /** Missing on pre-5.0.3 persisted state; legacy state inherits this from proAvailable. */
  extraHighAvailable?: boolean;
  proAvailable: boolean;
  experimentalBiggerContext?: boolean;
  browserInteractionMode?: "automatic" | "manual";
  zeroRiskProEnabled?: boolean;
}

export const CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE: ChatGptWebZeroRiskModelRoute = {
  slug: "chatgpt-web/zero-risk",
  displayName: "ChatGPT Web — Zero Risk",
  description: "Zero Risk keeps model selection and prompt submission under your control while preserving the native Codex harness.",
  interactionMode: "manual",
  backendModel: CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: false,
};

export const CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE: ChatGptWebZeroRiskModelRoute = {
  slug: "chatgpt-web/zero-risk-pro",
  displayName: "ChatGPT Web — Zero Risk Pro",
  description: "Explicit Pro-sized Zero Risk context; select ChatGPT Pro manually for every turn.",
  interactionMode: "manual",
  backendModel: CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: true,
};

export const CHATGPT_WEB_LUNA_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/luna",
  displayName: "ChatGPT Web — Luna",
  description: "ChatGPT Web Luna for accounts without the Sol model selector.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: false,
};

export const CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE: ChatGptWebModelRoute = {
  slug: "chatgpt-web/think",
  displayName: "ChatGPT Web — Think",
  description: "ChatGPT Web Think for Luna-only accounts.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  // The backend model remains Luna. This internal adapter effort distinguishes the explicit
  // Think route after Codex has selected its separate catalog row.
  adapterEffort: "medium",
  requiresPro: false,
};

export const CHATGPT_WEB_LUNA_MODEL_ROUTES: readonly ChatGptWebModelRoute[] = [
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE,
];

/**
 * The selected Codex model is the authoritative ChatGPT browser mode. Codex's signed desktop UI
 * always renders an Effort row, so every routed model advertises exactly one immutable protocol
 * effort. Pro uses Codex's `ultra` protocol value but binds explicitly to ChatGPT Pro (`max`) at
 * the adapter boundary.
 */
export const CHATGPT_WEB_MODEL_ROUTES: readonly ChatGptWebAutomaticModelRoute[] = [
  {
    slug: "chatgpt-web/light",
    displayName: "ChatGPT Web — Instant",
    description: "ChatGPT Web Instant through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "low",
    adapterEffort: "low",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/medium",
    displayName: "ChatGPT Web — Medium",
    description: "ChatGPT Web Medium through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "medium",
    adapterEffort: "medium",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/high",
    displayName: "ChatGPT Web — High",
    description: "ChatGPT Web High through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "high",
    adapterEffort: "high",
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/extra-high",
    displayName: "ChatGPT Web — Extra High",
    description: "Account-gated ChatGPT Web Extra High through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "xhigh",
    adapterEffort: "xhigh",
    requiresExtraHigh: true,
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/pro",
    displayName: "ChatGPT Web — Pro",
    description: "Account-gated ChatGPT Pro through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "ultra",
    adapterEffort: "max",
    requiresPro: true,
  },
];

const routesBySlug = new Map(
  [
    CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
    CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
    ...CHATGPT_WEB_LUNA_MODEL_ROUTES,
    ...CHATGPT_WEB_MODEL_ROUTES,
  ]
    .map(route => [route.slug, route]),
);

export function isChatGptWebModelSlug(modelId: string): boolean {
  return modelId.startsWith(CHATGPT_WEB_MODEL_PREFIX);
}

export function availableChatGptWebModelRoutes(
  capabilities: ChatGptWebAccountCapabilities,
): readonly ChatGptWebModelRoute[] {
  if (capabilities.browserInteractionMode === "manual") {
    if (capabilities.experimentalBiggerContext) {
      throw new Error("Zero Risk does not support Bigger Context");
    }
    return capabilities.zeroRiskProEnabled
      ? [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE, CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE]
      : [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE];
  }
  if (!capabilities.solAvailable) return CHATGPT_WEB_LUNA_MODEL_ROUTES;
  const extraHighAvailable = capabilities.proAvailable || capabilities.extraHighAvailable === true;
  return CHATGPT_WEB_MODEL_ROUTES.filter(route => (
    (!route.requiresExtraHigh || extraHighAvailable)
    && (!route.requiresPro || capabilities.proAvailable)
  ));
}

export function requireChatGptWebModelRoute(
  modelId: string,
  capabilities: ChatGptWebAccountCapabilities,
): ChatGptWebModelRoute {
  if (capabilities.browserInteractionMode === "manual" && capabilities.experimentalBiggerContext) {
    throw new Error("Zero Risk does not support Bigger Context");
  }
  const route = routesBySlug.get(modelId);
  if (!route) throw new Error(`ChatGPT web model is not enabled: ${modelId}`);
  if (capabilities.browserInteractionMode === "manual") {
    if (route.interactionMode !== "manual") {
      throw new Error(`${route.displayName} is not available while Zero Risk is enabled`);
    }
    if (route === CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE && !capabilities.zeroRiskProEnabled) {
      throw new Error(`${route.displayName} is not enabled in Zero Risk model settings`);
    }
    return route;
  }
  if (route.interactionMode === "manual") {
    throw new Error(`${route.displayName} is only available while Zero Risk is enabled`);
  }
  if (route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    if (capabilities.solAvailable) {
      throw new Error(`${route.displayName} is only available for Luna-only accounts`);
    }
    return route;
  }
  if (!capabilities.solAvailable) {
    throw new Error(`${route.displayName} is not available for this Luna-only account`);
  }
  const extraHighAvailable = capabilities.proAvailable || capabilities.extraHighAvailable === true;
  if (route.requiresExtraHigh && !extraHighAvailable) {
    throw new Error(`${route.displayName} is not available for this account`);
  }
  if (route.requiresPro && !capabilities.proAvailable) {
    throw new Error(`${route.displayName} is not available for this account`);
  }
  return route;
}
