import type { AppConfig } from "./config";
import type { CodexParsedRequest } from "./types";
import { compileChatGptWebPrompt, countChatGptContextImages } from "./adapters/chatgpt-web/prompt";
import { checkChatGptWebTransport } from "./adapters/chatgpt-web/transport-budget";
import { resolveChatGptWebModelMode } from "./adapters/chatgpt-web/model";

/** Apply the user's prediction policy without changing the originating task's model or settings. */
export function configureComposerPrediction(parsed: CodexParsedRequest, config: AppConfig): AppConfig {
  if (!config.composerPredictionsEnabled) throw new Error("Next-message predictions are disabled in Launcher settings.");
  if (config.browserInteractionMode !== "automatic" || !config.solAvailable) {
    throw new Error("Next-message predictions require GPT-6 Sol Medium in Automatic mode.");
  }
  parsed.modelId = "chatgpt-web/gpt-6-sol";
  parsed.options.reasoning = "medium";
  // This app-generated turn only suggests text for the empty composer. It must not perform work.
  delete parsed.context.tools;
  delete parsed.options.toolChoice;
  delete parsed.options.parallelToolCalls;
  return {
    ...config,
    mode: "browser-only",
    experimentalBiggerContext: false,
    experimentalSkillAttachments: false,
    experimentalFreshConversationPerTurn: true,
  };
}

/** Run before constructing the adapter, so an oversized suggestion never opens a browser tab. */
export function assertComposerPredictionFits(parsed: CodexParsedRequest, config: AppConfig): void {
  const capabilities = {
    localToolsEnabled: false,
    solAvailable: config.solAvailable,
    proAvailable: config.proAvailable,
    extraHighAvailable: config.extraHighAvailable === true,
  };
  const compiled = compileChatGptWebPrompt(parsed, capabilities);
  if (compiled.images.length !== countChatGptContextImages(parsed.context.messages)) {
    throw new Error("The conversation contains more images than a prediction can include.");
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, "medium", capabilities);
  checkChatGptWebTransport(compiled, parsed.modelId, mode, capabilities, parsed._chatgptModelFamily);
}
