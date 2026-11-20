import type { ChatGptMessageLimits } from "./message-limit-recovery";
import { compiledChatGptWebMessages } from "./input-tokens";
import { estimateTokens } from "../../lib/token-estimate";
import { skillFileTokens } from "./skill-attachments";
import {
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
  CHATGPT_WEB_GPT6_INSTANT_BIGGER_CONTEXT_ERROR,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebMultipartContextWindow,
  resolveChatGptWebStagingTokenBudget,
  resolveChatGptWebTransportLimits,
  supportsChatGptWebBiggerContext,
  supportsChatGptWebBiggerInlineInput,
  type ChatGptWebModelFamily,
} from "../../chatgpt-web-models";
import { ChatGptWebAdapterError } from "./adapter-error";
import { measureChatGptWebTransport } from "./input-tokens";
import {
  CHATGPT_WEB_LUNA_MODEL_ID, CHATGPT_WEB_MODEL_ID, resolveChatGptWebModelMode,
  type ChatGptWebCapabilities, type ChatGptWebModelMode,
} from "./model";
import { isChatGptWebMultipartPartCount, type CompiledChatGptWebPrompt } from "./prompt";

export function assertChatGptWebInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities & { experimentalBiggerContext?: boolean },
  promptChars?: number,
  modelFamily?: ChatGptWebModelFamily,
): void {
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`ChatGPT web context limit is not defined for model: ${modelId}`);
  }
  if (
    modelId === CHATGPT_WEB_LUNA_MODEL_ID
    && estimatedInputTokens > CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET
  ) {
    throw new ChatGptWebAdapterError(
      `This Luna turn requires ${estimatedInputTokens.toLocaleString("en-US")} estimated input tokens, which exceeds the measured ${CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET.toLocaleString("en-US")}-token ChatGPT Free browser transport budget. Completed Luna history is already replaced by its rolling checkpoint; the remaining payload is the current Codex turn and cannot be reduced by /compact.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  const { contextWindow } = resolveChatGptWebContextLimits(modelId, effort, { ...capabilities, experimentalBiggerContext: capabilities.experimentalBiggerContext && supportsChatGptWebBiggerInlineInput(modelId, effort, capabilities) }, modelFamily);
  const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
    modelId,
    effort,
    capabilities,
  );
  if (
    browserComposerCharLimit !== undefined
    && promptChars !== undefined
    && promptChars > browserComposerCharLimit
  ) {
    throw new ChatGptWebAdapterError(
      `This prompt contains ${promptChars.toLocaleString("en-US")} inline characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary for this account and effort. Run /compact, then retry this Web model.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (browserMessageTokenLimit !== undefined && estimatedMessageTokens > browserMessageTokenLimit) {
    throw new ChatGptWebAdapterError(
      `This prompt requires ${estimatedMessageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT browser message boundary for this account and effort. The model context window is ${contextWindow.toLocaleString("en-US")} tokens; run /compact to reduce the next browser message without changing that model window.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (estimatedInputTokens < contextWindow) return;
  throw new ChatGptWebAdapterError(
    `This task is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds the ${contextWindow.toLocaleString("en-US")}-token context window for this ChatGPT Web model. Switch to a model with a larger context window, run /compact, then retry this Web model.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

export function assertChatGptWebMultipartInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  maxMessageChars: number,
  partCount: number,
  transport?: {
    stagingEffort: ChatGptWebModelMode["effort"];
    maxStageMessageTokens: number;
    maxStageChars: number;
    finalMessageTokens: number;
    finalMessageChars: number;
    finalImageTokens?: number;
  },
  modelFamily?: ChatGptWebModelFamily,
): void {
  if (!isChatGptWebMultipartPartCount(partCount)) {
    throw new Error("Bigger Context requires two or six context parts");
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context limit is not defined for model: ${modelId}`);
  }
  if (!supportsChatGptWebBiggerContext(modelId, effort, modelFamily)) {
    throw new Error(CHATGPT_WEB_GPT6_INSTANT_BIGGER_CONTEXT_ERROR);
  }
  const assertMessageBoundary = (
    label: "stage" | "final part",
    messageTokens: number,
    messageChars: number,
    messageEffort: ChatGptWebModelMode["effort"],
    imageTokens = 0,
  ): void => {
    const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
      modelId,
      messageEffort,
      capabilities,
    );
    if (browserComposerCharLimit !== undefined && messageChars > browserComposerCharLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} contains ${messageChars.toLocaleString("en-US")} characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
    if (browserMessageTokenLimit !== undefined && messageTokens > browserMessageTokenLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} requires ${messageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT message boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
    const messageBudget = label === "stage"
      ? resolveChatGptWebStagingTokenBudget(modelId, messageEffort, capabilities)
      : resolveChatGptWebMessageTokenBudget(modelId, messageEffort, capabilities, imageTokens);
    if (messageTokens > messageBudget) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} requires ${messageTokens.toLocaleString("en-US")} visible message tokens, which exceeds its ${messageBudget.toLocaleString("en-US")}-token input budget after reserving space for ChatGPT and attachments. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
  };
  if (transport) {
    assertMessageBoundary(
      "stage",
      transport.maxStageMessageTokens,
      transport.maxStageChars,
      transport.stagingEffort,
    );
    assertMessageBoundary(
      "final part",
      transport.finalMessageTokens,
      transport.finalMessageChars,
      effort,
      transport.finalImageTokens,
    );
  } else {
    assertMessageBoundary("stage", estimatedMessageTokens, maxMessageChars, effort);
  }
  const experimentalContextWindow = resolveChatGptWebMultipartContextWindow(modelId, effort, capabilities, partCount, modelFamily);
  if (estimatedInputTokens < experimentalContextWindow) return;
  const partLabel = partCount === 2 ? "two-part" : "six-part";
  throw new ChatGptWebAdapterError(
    `This Bigger Context transaction is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds its experimental ${experimentalContextWindow.toLocaleString("en-US")}-token ${partLabel} ceiling. Run /compact, then retry.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

/** Select the cheapest account-visible mode that can carry every inert multipart stage. */
export function resolveChatGptWebMultipartStagingMode(
  modelId: string,
  capabilities: ChatGptWebCapabilities,
  maxStageMessageTokens: number,
  maxStageChars: number,
): ChatGptWebModelMode {
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context staging mode is not defined for model: ${modelId}`);
  }
  const efforts: readonly ChatGptWebModelMode["effort"][] = modelId === CHATGPT_WEB_LUNA_MODEL_ID ? ["low"] : capabilities.proAvailable
    ? ["low", "medium", "max"]
    : ["low", "medium"];
  for (const effort of efforts) {
    const mode = resolveChatGptWebModelMode(modelId, effort, capabilities);
    const limits = resolveChatGptWebTransportLimits(modelId, effort, capabilities);
    const messageTokenLimit = resolveChatGptWebStagingTokenBudget(modelId, effort, capabilities);
    const tokenFits = maxStageMessageTokens <= messageTokenLimit;
    const charsFit = limits.browserComposerCharLimit === undefined
      || maxStageChars <= limits.browserComposerCharLimit;
    if (tokenFits && charsFit) return mode;
  }
  throw new ChatGptWebAdapterError(
    `No ChatGPT effort available to this account can carry a Bigger Context stage with ${maxStageMessageTokens.toLocaleString("en-US")} estimated tokens and ${maxStageChars.toLocaleString("en-US")} characters.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

/** Check the same formatted messages in transport selection and immediately before Send. */
export function checkChatGptWebTransport(
  compiled: CompiledChatGptWebPrompt, modelId: string, mode: ChatGptWebModelMode,
  caps: ChatGptWebCapabilities, family?: ChatGptWebModelFamily, transactionId?: string, messageLimits?: ChatGptMessageLimits,
) {
  const transport = measureChatGptWebTransport(compiled, modelId, transactionId);
  const { estimatedInputTokens, finalMessageTokens, finalPrompt, maxMessageChars, maxStageMessageTokens, maxStageChars } = transport;
  const binding = !compiled.multipart && messageLimits?.probeInline ? undefined : messageLimits;
  if (binding && compiledChatGptWebMessages(compiled, transactionId).some((text, index, messages) =>
    text.length > binding.chars || estimateTokens(text, modelId)
      + (index === messages.length - 1 ? skillFileTokens(compiled.skillFiles, modelId) : 0) > binding.tokens)) {
    throw new ChatGptWebAdapterError("The complete request exceeds the learned per-message upload limits.", {
      status: 400, errorType: "invalid_request_error", code: "chatgpt_message_transport_capacity_exceeded", retryable: false,
    });
  }
  if (!compiled.multipart) {
    assertChatGptWebInputWithinLimits(estimatedInputTokens, finalMessageTokens, modelId, mode.effort,
      { ...caps, experimentalBiggerContext: compiled.biggerContext === true }, maxMessageChars, family);
    return { ...transport, stagingMode: mode };
  }
  const stagingMode = compiled.preserveContextDuringStaging ? { ...mode, localTools: false }
    : resolveChatGptWebMultipartStagingMode(modelId, caps, maxStageMessageTokens, maxStageChars);
  assertChatGptWebMultipartInputWithinLimits(
    estimatedInputTokens, Math.max(maxStageMessageTokens, finalMessageTokens), modelId, mode.effort, caps,
    maxMessageChars, compiled.multipart.parts.length, {
      stagingEffort: stagingMode.effort, maxStageMessageTokens, maxStageChars,
      finalMessageTokens, finalMessageChars: finalPrompt.length, finalImageTokens: transport.imageTokens,
    }, family,
  );
  return { ...transport, stagingMode };
}
