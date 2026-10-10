export const CHATGPT_WEB_MODEL_PREFIX = "chatgpt-web/";
/** Shared automatic transport profile; exact browser version is carried by modelFamily. */
export const CHATGPT_WEB_BACKEND_MODEL = "gpt-5.6-sol";
/** Internal Luna transport identity; the Free UI does not expose a selectable model version. */
export const CHATGPT_WEB_LUNA_BACKEND_MODEL = "gpt-5.6-luna";
export const CHATGPT_WEB_GPT6_INSTANT_BIGGER_CONTEXT_ERROR =
  "GPT-6 Instant uses standard context. Select Medium, High or an available Extra High or Pro mode to use Bigger Context.";
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

export type ChatGptWebCodexEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ChatGptWebAdapterEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ChatGptWebModelFamily = "5.6" | "6";

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
// Rechecked on Plus with GPT-6 on 2026-10-08: 500,001 characters reached the
// model; 530,000 were rejected with message_length_exceeds_limit even at 67k
// tokens. Keep headroom below that independent server boundary.
export const CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT = 500_000;
/** Hidden ChatGPT product prompt and Codex Native schema reserve included in usage estimates. */
export const CHATGPT_WEB_PLATFORM_RESERVE_TOKENS = 8_192;
/** Reserve for each attachment in the final browser message; inert stages carry no images. */
export function chatGptWebImageTokenReserve(detail?: string): number {
  return detail === "original" ? 8_192 : 4_096;
}
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
// Rechecked 2026-09-19: Pro-account Medium/High accept 500k characters but the server
// rejects larger messages with HTTP 413 (message_length_exceeds_limit), even below
// the token budget. Composer insertion itself still accepts them. Keep headroom;
// Instant and the Pro model have different bounds, not this reasoning-mode ceiling.
export const CHATGPT_WEB_PRO_REASONING_COMPOSER_CHAR_LIMIT = CHATGPT_WEB_MEDIUM_HIGH_COMPOSER_CHAR_LIMIT;
export const CHATGPT_WEB_PRO_MODEL_COMPOSER_CHAR_LIMIT = 1_635_000;
/**
 * The underlying Luna model owns this context window. ChatGPT Free's much smaller browser request
 * envelope is enforced separately at the browser boundary; rolling checkpoints keep completed
 * history out of later browser requests without asking Codex to compact its canonical history.
 */
export const CHATGPT_WEB_LUNA_CONTEXT_WINDOW = 1_050_000;
/** Measured Free one-message budget, including the hidden ChatGPT platform reserve. */
export const CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET = 28_000;
export const CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER = 3;
/**
 * Opt-in experimental transport ceiling, not a verified Free recall window. Live staged tests
 * still lose older details on long inputs; never derive this from Luna's rolling-summary window.
 */
export const CHATGPT_WEB_LUNA_BIGGER_CONTEXT_WINDOW =
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET * CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER;
export const CHATGPT_WEB_LUNA_BIGGER_AUTO_COMPACT_TOKEN_LIMIT =
  (CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS)
  * CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER;
// Rechecked 2026-10-08 on Pro: GPT-6 Medium/High/Extra High retained all 12
// markers at 253k input tokens but lost the oldest markers at 283k. Keep room
// below the passing boundary and compact before reaching this context ceiling.
export const CHATGPT_WEB_GPT6_SOL_BIGGER_CONTEXT_WINDOW = 240_000;
export const CHATGPT_WEB_GPT6_SOL_BIGGER_AUTO_COMPACT_TOKEN_LIMIT = 220_000;
// Rechecked 2026-10-10 on Plus: Medium and High recovered all 12 distributed
// codes at 127k estimated input tokens. At 144k both lost the entire first part.
// Keep headroom below the passing result, with compaction before the ceiling.
export const CHATGPT_WEB_GPT6_PLUS_BIGGER_CONTEXT_WINDOW = 120_000;
export const CHATGPT_WEB_GPT6_PLUS_BIGGER_AUTO_COMPACT_TOKEN_LIMIT = 110_000;

export interface ChatGptWebContextLimits {
  contextWindow: number;
  effectiveContextWindowPercent: number;
  autoCompactTokenLimit: number;
}

export interface ChatGptWebTransportLimits {
  browserMessageTokenLimit?: number;
  browserComposerCharLimit?: number;
}

/** Account capabilities gate model availability, not access to staged context. */
export function supportsChatGptWebBiggerContext(
  backendModel: string,
  effort: ChatGptWebAdapterEffort,
  modelFamily?: ChatGptWebModelFamily,
): boolean {
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) return effort === "low" || effort === "medium";
  return backendModel === CHATGPT_WEB_BACKEND_MODEL && (
    modelFamily !== "6" || effort !== "low"
  );
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
  modelFamily?: ChatGptWebModelFamily,
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
    if (capabilities.experimentalBiggerContext) {
      return contextLimits(CHATGPT_WEB_LUNA_BIGGER_CONTEXT_WINDOW, CHATGPT_WEB_LUNA_BIGGER_AUTO_COMPACT_TOKEN_LIMIT);
    }
    // Luna carries continuity through a private checkpoint on every completed browser turn. Codex
    // internally clamps this field to 90% of the model window, but the reported active usage is the
    // bounded payload actually sent to ChatGPT and therefore stays far below that threshold.
    return contextLimits(CHATGPT_WEB_LUNA_CONTEXT_WINDOW, CHATGPT_WEB_LUNA_CONTEXT_WINDOW);
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
  } else if (effort === "medium" || effort === "high" || (effort === "xhigh" && capabilities.extraHighAvailable)) {
    limits = contextLimits(
      CHATGPT_WEB_MEDIUM_HIGH_CONTEXT_WINDOW,
      CHATGPT_WEB_MEDIUM_HIGH_AUTO_COMPACT_TOKEN_LIMIT,
    );
  } else {
    throw new Error(`ChatGPT Plus context limit is not defined for unavailable effort: ${effort}`);
  }
  if (!capabilities.experimentalBiggerContext
    || !supportsChatGptWebBiggerContext(backendModel, effort, modelFamily)) return limits;
  if (modelFamily === "6" && effort !== "max") {
    return contextLimits(
      capabilities.proAvailable ? CHATGPT_WEB_GPT6_SOL_BIGGER_CONTEXT_WINDOW : CHATGPT_WEB_GPT6_PLUS_BIGGER_CONTEXT_WINDOW,
      capabilities.proAvailable ? CHATGPT_WEB_GPT6_SOL_BIGGER_AUTO_COMPACT_TOKEN_LIMIT : CHATGPT_WEB_GPT6_PLUS_BIGGER_AUTO_COMPACT_TOKEN_LIMIT,
    );
  }
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
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return { browserMessageTokenLimit: CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS };
  }
  if (!capabilities.proAvailable) {
    if (effort === "low") {
      return { browserComposerCharLimit: CHATGPT_WEB_INSTANT_COMPOSER_CHAR_LIMIT };
    }
    if (effort === "medium" || effort === "high" || (effort === "xhigh" && capabilities.extraHighAvailable)) {
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

/**
 * Visible text that fits one ordinary input after its hidden reserve and images. This is derived
 * from the existing context contract, not a new measured browser limit or a compaction trigger.
 * Bigger Context expands the transaction, never this per-message budget.
 */
export function resolveChatGptWebMessageTokenBudget(
  backendModel: ChatGptWebAutomaticBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
  imageTokens = 0,
): number {
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    return Math.max(0, CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - imageTokens);
  }
  const { contextWindow } = resolveChatGptWebContextLimits(
    backendModel, effort, { ...capabilities, experimentalBiggerContext: false },
  );
  const { browserMessageTokenLimit } = resolveChatGptWebTransportLimits(backendModel, effort, capabilities);
  return Math.max(0, Math.min(
    contextWindow - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - imageTokens - 1,
    browserMessageTokenLimit ?? Infinity,
  ));
}

/** Keep repeated Plus Instant uploads within the ordinary pre-compaction input target. */
export function resolveChatGptWebStagingTokenBudget(
  backendModel: ChatGptWebAutomaticBackendModel,
  effort: ChatGptWebAdapterEffort,
  capabilities: ChatGptWebAccountCapabilities,
): number {
  const messageBudget = resolveChatGptWebMessageTokenBudget(backendModel, effort, capabilities);
  if (backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL || effort !== "low" || capabilities.proAvailable) return messageBudget;
  // A first near-maximum Instant message can succeed while the next is rejected (#777).
  // Reuse normal Instant's input headroom, including the existing platform reserve;
  // this changes staging allocation, not the selected model's advertised context window.
  const { autoCompactTokenLimit } = resolveChatGptWebContextLimits(backendModel, effort, {
    ...capabilities, experimentalBiggerContext: false,
  });
  return Math.min(messageBudget, Math.max(0, autoCompactTokenLimit - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - 1));
}

interface ChatGptWebModelRouteBase {
  slug: string;
  displayName: string;
  description: string;
  codexEffort: ChatGptWebCodexEffort;
  requiresPro: boolean;
  requiresExtraHigh?: boolean;
  /** Old task identities remain resolvable, but are omitted from the picker. */
  legacy?: boolean;
  /** Omission denotes an immutable route, including all pre-6.0 task identities. */
  supportedCodexEfforts?: readonly ChatGptWebCodexEffort[];
}

export interface ChatGptWebAutomaticModelRoute extends ChatGptWebModelRouteBase {
  interactionMode: "automatic";
  backendModel: ChatGptWebAutomaticBackendModel;
  adapterEffort: ChatGptWebAdapterEffort;
  /** Exact browser family, independent of the generic adapter's context/transport profile. */
  modelFamily?: ChatGptWebModelFamily;
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
  /** Missing in older saved observations; setup must probe before exposing Extra High. */
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

export const CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/luna",
  displayName: "ChatGPT Web — Luna",
  description: "ChatGPT Web Luna for accounts without the Sol model selector.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  requiresPro: false,
  legacy: true,
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
  legacy: true,
};

export const CHATGPT_WEB_LUNA_MODEL_ROUTE: ChatGptWebAutomaticModelRoute = {
  slug: "chatgpt-web/gpt-5.6-luna",
  displayName: "Luna (Web)",
  description: "ChatGPT Luna. Light selects the ordinary mode; Medium enables Think.",
  interactionMode: "automatic",
  backendModel: CHATGPT_WEB_LUNA_BACKEND_MODEL,
  codexEffort: "low",
  adapterEffort: "low",
  supportedCodexEfforts: ["low", "medium"],
  requiresPro: false,
};

export const CHATGPT_WEB_LUNA_MODEL_ROUTES: readonly ChatGptWebModelRoute[] = [
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
];

/**
 * Preserve the exact pre-6.0 bindings for saved tasks, including the old unpinned Pro route.
 * Native Codex may normalize its technical effort; these identities have always owned the mode.
 */
export const CHATGPT_WEB_LEGACY_MODEL_ROUTES: readonly ChatGptWebAutomaticModelRoute[] = [
  {
    slug: "chatgpt-web/light",
    displayName: "ChatGPT Web — Instant",
    description: "ChatGPT Web Instant through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "low",
    adapterEffort: "low",
    requiresPro: false,
    legacy: true,
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
    legacy: true,
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
    legacy: true,
  },
  {
    slug: "chatgpt-web/extra-high",
    displayName: "ChatGPT Web — Extra High",
    description: "Account-gated ChatGPT Web Extra High through the native Codex harness.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    codexEffort: "xhigh",
    adapterEffort: "xhigh",
    requiresPro: false,
    requiresExtraHigh: true,
    legacy: true,
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
    legacy: true,
  },
];

/** Group only efforts with identical context and compaction budgets. */
export const CHATGPT_WEB_MODEL_ROUTES: readonly ChatGptWebAutomaticModelRoute[] = [
  {
    slug: "chatgpt-web/gpt-6-sol-instant",
    displayName: "GPT-6 Sol Instant (Web)",
    description: "GPT-6 Sol Instant through ChatGPT. Uses standard context even when Bigger Context is enabled.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "6",
    codexEffort: "low",
    adapterEffort: "low",
    supportedCodexEfforts: ["low"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-6-sol",
    displayName: "GPT-6 Sol (Web)",
    description: "GPT-6 Sol with Medium, High, or account-supported Extra High. Experimental Bigger Context is available on Plus and Pro, with a context window sized for the account.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "6",
    codexEffort: "high",
    adapterEffort: "high",
    supportedCodexEfforts: ["medium", "high", "xhigh"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-5.6-sol-instant",
    displayName: "GPT-5.6 Sol Instant (Web)",
    description: "GPT-5.6 Sol Instant through ChatGPT, with its own context and compaction budget.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "5.6",
    codexEffort: "low",
    adapterEffort: "low",
    supportedCodexEfforts: ["low"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-5.6-sol",
    displayName: "GPT-5.6 Sol (Web)",
    description: "GPT-5.6 Sol through ChatGPT with Medium, High, or account-supported Extra High reasoning.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "5.6",
    codexEffort: "high",
    adapterEffort: "high",
    supportedCodexEfforts: ["medium", "high", "xhigh"],
    requiresPro: false,
  },
  {
    slug: "chatgpt-web/gpt-5.6-pro",
    displayName: "GPT-5.6 Pro (Web)",
    description: "GPT-5.6 Pro through ChatGPT. The fixed Max effort selects Pro.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "5.6",
    codexEffort: "max",
    adapterEffort: "max",
    supportedCodexEfforts: ["max"],
    requiresPro: true,
  },
  {
    slug: "chatgpt-web/gpt-6-pro",
    displayName: "GPT-6 Pro (Web)",
    description: "GPT-6 Pro through ChatGPT. The fixed Max effort selects Pro.",
    interactionMode: "automatic",
    backendModel: CHATGPT_WEB_BACKEND_MODEL,
    modelFamily: "6",
    codexEffort: "max",
    adapterEffort: "max",
    supportedCodexEfforts: ["max"],
    requiresPro: true,
  },
];

const routesBySlug = new Map(
  [
    CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
    CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
    ...CHATGPT_WEB_LUNA_MODEL_ROUTES,
    ...CHATGPT_WEB_MODEL_ROUTES,
    CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE,
    CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE,
    ...CHATGPT_WEB_LEGACY_MODEL_ROUTES,
  ]
    .map(route => [route.slug, route]),
);

export function isChatGptWebModelSlug(modelId: string): boolean {
  return modelId.startsWith(CHATGPT_WEB_MODEL_PREFIX);
}

export function availableChatGptWebModelRoutes(
  capabilities: ChatGptWebAccountCapabilities,
  includeLegacy = false,
): readonly ChatGptWebModelRoute[] {
  if (capabilities.browserInteractionMode === "manual") {
    if (capabilities.experimentalBiggerContext) {
      throw new Error("Zero Risk does not support Bigger Context");
    }
    return capabilities.zeroRiskProEnabled
      ? [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE, CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE]
      : [CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE];
  }
  if (!capabilities.solAvailable) return includeLegacy
    ? [...CHATGPT_WEB_LUNA_MODEL_ROUTES, CHATGPT_WEB_LEGACY_LUNA_MODEL_ROUTE, CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE]
    : CHATGPT_WEB_LUNA_MODEL_ROUTES;
  const candidates = includeLegacy
    ? [...CHATGPT_WEB_MODEL_ROUTES, ...CHATGPT_WEB_LEGACY_MODEL_ROUTES]
    : CHATGPT_WEB_MODEL_ROUTES;
  return candidates.filter(route =>
    (!route.requiresPro || capabilities.proAvailable)
    && (!route.requiresExtraHigh || capabilities.extraHighAvailable));
}

export function chatGptWebRouteEfforts(
  route: ChatGptWebModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
): readonly ChatGptWebCodexEffort[] {
  return (route.supportedCodexEfforts ?? [route.codexEffort])
    .filter(effort => effort !== "xhigh" || capabilities.extraHighAvailable === true);
}

export function requireChatGptWebModelRoute(
  modelId: string,
  capabilities: ChatGptWebAccountCapabilities,
  reasoning?: string,
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
    return resolveRouteEffort(route, capabilities, reasoning);
  }
  if (!capabilities.solAvailable) {
    throw new Error(`${route.displayName} is not available for this Luna-only account`);
  }
  if ((route.requiresPro && !capabilities.proAvailable)
    || (route.requiresExtraHigh && !capabilities.extraHighAvailable)) {
    throw new Error(`${route.displayName} is not available for this account`);
  }
  return resolveRouteEffort(route, capabilities, reasoning);
}

function resolveRouteEffort(
  route: ChatGptWebAutomaticModelRoute,
  capabilities: ChatGptWebAccountCapabilities,
  reasoning?: string,
): ChatGptWebAutomaticModelRoute {
  if (!route.supportedCodexEfforts) return route;
  const effort = reasoning ?? route.codexEffort;
  if (!chatGptWebRouteEfforts(route, capabilities).includes(effort as ChatGptWebCodexEffort)) {
    throw new Error(`${route.displayName} does not support effort ${JSON.stringify(effort)} for this account`);
  }
  if (effort === route.codexEffort) return route;
  return { ...route, codexEffort: effort as ChatGptWebCodexEffort, adapterEffort: effort as ChatGptWebAdapterEffort };
}
