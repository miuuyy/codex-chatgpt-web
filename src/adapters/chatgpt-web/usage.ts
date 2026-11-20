import { checkChatGptWebTransport } from "./transport-budget";
import { ChatGptWebAdapterError } from "./adapter-error";
import { skillFileTokens } from "./skill-attachments";
import { estimateTokens } from "../../lib/token-estimate";
import type { ChatGptMessageLimits } from "./message-limit-recovery";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMultipartContextWindow,
  resolveChatGptWebTransportLimits,
  supportsChatGptWebBiggerContext,
} from "../../chatgpt-web-models";
import type { CodexParsedRequest, CodexUsage } from "../../types";
import { isNativeCompactionMessage, isReadableCompactionSummaryText } from "../../responses/compaction";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import {
  CHATGPT_BIGGER_CONTEXT_PARTS,
  compileChatGptWebPrompt,
  type ChatGptWebMultipartPartCount,
  type CompiledChatGptWebPrompt,
  type CompileChatGptWebPromptOptions,
} from "./prompt";
import { extractChatGptTurnIdentity } from "./environment";
import { CHATGPT_WEB_LUNA_MODEL_ID, resolveChatGptWebModelMode, type ChatGptWebCapabilities } from "./model";
import type { BrokerToolRequest } from "./turn-broker";

// The real capability has the same length. Keeping it out of usage accounting would make
// estimates differ slightly between the prepared browser prompt and later Codex tool rounds.
const ESTIMATE_TURN_TOKEN = "turn_00000000000000000000000000000000";

export interface ChatGptWebRoundEvidence {
  answer?: string;
  reasoning?: string[];
  toolRequests?: BrokerToolRequest[];
}

function conservativeTextTokens(text: string, modelId: string): number {
  return estimateTokens(text, modelId);
}

export function estimateChatGptWebInputTokens(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: CompileChatGptWebPromptOptions = {},
  biggerContext = false,
): number {
  if (!biggerContext) return estimateCompiledChatGptWebInputTokens(compileUsagePrompt(parsed, capabilities, options), parsed.modelId, options.multipartTransactionId);
  return estimateCompiledChatGptWebInputTokens(compileUsagePrompt(parsed, capabilities,
    { ...options, experimentalBiggerContext: true }), parsed.modelId, options.multipartTransactionId);
}

function compileUsagePrompt(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  options: CompileChatGptWebPromptOptions,
): CompiledChatGptWebPrompt {
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  const mode = manual
    ? { localTools: true }
    : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const identity = extractChatGptTurnIdentity(parsed);
  const compileOptions = {
    ...options,
    ...(manual ? { manualControl: true as const } : {}),
    captureLunaCheckpoint: options.captureLunaCheckpoint ?? (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !options.experimentalBiggerContext && !parsed._compactionRequest && Boolean(identity.threadId && identity.turnId)),
  };
  const turnToken = mode.localTools ? ESTIMATE_TURN_TOKEN : undefined;
  return options.experimentalBiggerContext && !manual
    ? compileBiggerContextPrompt(parsed, capabilities, turnToken, compileOptions, "usage")
    : compileChatGptWebPrompt(parsed, capabilities, turnToken, compileOptions);
}

/** Prefer the smallest transport that carries the complete request through browser preflight. */
export function compileBiggerContextPrompt(
  parsed: CodexParsedRequest, capabilities: ChatGptWebCapabilities, turnToken?: string,
  options: CompileChatGptWebPromptOptions = {}, purpose: "submit" | "usage" = "submit",
): CompiledChatGptWebPrompt {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
    throw new Error("Bigger Context is unavailable for ChatGPT Zero Risk");
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  if (!supportsChatGptWebBiggerContext(parsed.modelId, mode.effort, parsed._chatgptModelFamily)) {
    return compileChatGptWebPrompt(parsed, capabilities, turnToken, options);
  }
  for (const parts of [undefined, 2, CHATGPT_BIGGER_CONTEXT_PARTS] as const) {
    // Luna only supports a separate native compaction request over multipart transport.
    if (!parts && parsed._compactionRequest && parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) continue;
    const largest = parts === CHATGPT_BIGGER_CONTEXT_PARTS;
    try {
      const compiled = compileChatGptWebPrompt(parsed, capabilities, turnToken, {
        ...options, experimentalBiggerContext: true, experimentalMultipartParts: parts, requireCompleteHistory: !largest,
      });
      // Usage describes canonical history even when the retained chat only sends its latest tool
      // results. A submission must pass preflight for every size, including the largest.
      if (!largest || purpose === "submit") {
        checkChatGptWebTransport(compiled, parsed.modelId, mode, capabilities, parsed._chatgptModelFamily, options.multipartTransactionId, options.messageLimits);
      }
      return compiled;
    } catch (error) {
      if (largest || !(error instanceof ChatGptWebAdapterError && ["context_length_exceeded", "chatgpt_message_transport_capacity_exceeded"].includes(error.code))) throw error;
    }
  }
  throw new Error("No Bigger Context transport was evaluated");
}

/** Compatibility for callers that need the selected part count rather than the compiled prompt. */
export function resolveBiggerContextMultipartParts(
  parsed: CodexParsedRequest, capabilities: ChatGptWebCapabilities, experimentalSkillAttachments = false,
  appName?: string, messageLimits?: ChatGptMessageLimits,
): ChatGptWebMultipartPartCount | undefined {
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  return compileBiggerContextPrompt(parsed, capabilities, mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    { appName, messageLimits, experimentalSkillAttachments, captureLunaCheckpoint: false }, "usage").multipart?.parts.length as ChatGptWebMultipartPartCount | undefined;
}

function roundEvidenceText(evidence: ChatGptWebRoundEvidence): string {
  return JSON.stringify({
    reasoning: evidence.reasoning ?? [],
    ...(evidence.answer !== undefined ? { answer: evidence.answer } : {}),
    ...(evidence.toolRequests ? {
      tool_calls: evidence.toolRequests.map(request => ({
        call_id: request.callId,
        name: request.wireName,
        ...(request.freeform
          ? { input: request.input ?? "" }
          : { arguments: request.arguments ?? {} }),
      })),
    } : {}),
  });
}

function pendingToolOutputTokens(evidence: ChatGptWebRoundEvidence, fallback: number): number {
  let boundedTokens = 0;
  let hasUnbounded = false;
  for (const request of evidence.toolRequests ?? []) {
    // These outer Codex tools enforce this output budget. Other tools keep the existing
    // one-message headroom; arbitrary similarly named arguments are not a size guarantee.
    const bounded = ["exec_command", "write_stdin", "functions.exec_command", "functions.write_stdin"]
      .includes(request.wireName);
    const limit = request.arguments?.max_output_tokens;
    if (bounded && Number.isSafeInteger(limit) && Number(limit) > 0) boundedTokens += Number(limit);
    else hasUnbounded = true;
  }
  // The existing reserve belongs to the round, not to each unbounded call in a batch.
  return boundedTokens + (hasUnbounded ? fallback : 0);
}

export function estimateChatGptWebUsage(
  parsed: CodexParsedRequest,
  evidence: ChatGptWebRoundEvidence,
  capabilities: ChatGptWebCapabilities,
  experimentalBiggerContext = false,
  experimentalSkillAttachments = false,
  appName?: string,
  messageLimits?: ChatGptMessageLimits,
): CodexUsage {
  const evidenceText = roundEvidenceText(evidence);
  const outputTokens = conservativeTextTokens(evidenceText, parsed.modelId);
  let multipartParts: ChatGptWebMultipartPartCount | undefined;
  let transportCapacityExceeded = false;
  const options = {
    appName,
    ...(experimentalBiggerContext ? { captureLunaCheckpoint: false } : {}),
    experimentalSkillAttachments,
    experimentalBiggerContext,
    messageLimits,
  };
  let compiled: CompiledChatGptWebPrompt;
  try {
    compiled = compileUsagePrompt(parsed, capabilities, options);
    multipartParts = compiled.multipart?.parts.length as ChatGptWebMultipartPartCount | undefined;
  } catch (error) {
    if (!experimentalBiggerContext || !(error instanceof ChatGptWebAdapterError)
      || error.code !== "chatgpt_message_transport_capacity_exceeded") throw error;
    // Usage runs after real tool results have arrived. Report pressure to Codex so its next
    // action is automatic compaction, rather than failing an already completed tool round.
    // This does not authorize an over-limit browser submission; preflight remains strict.
    transportCapacityExceeded = true;
    compiled = compileUsagePrompt(parsed, capabilities, { ...options, messageLimits: undefined });
  }
  let inputTokens = estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
  const checkpointIndex = parsed.context.messages.findLastIndex(message => isNativeCompactionMessage(message)
    || (message.role === "user" && isReadableCompactionSummaryText(message.content)));
  const hasNewToolResults = parsed.context.messages.slice(checkpointIndex + 1).some(message => message.role === "toolResult");
  if (experimentalBiggerContext && !parsed._compactionRequest && !isChatGptWebZeroRiskBackendModel(parsed.modelId)
    && (checkpointIndex < 0 || hasNewToolResults)) {
    const backendModel = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID ? CHATGPT_WEB_LUNA_MODEL_ID : CHATGPT_WEB_BACKEND_MODEL;
    const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
    const base = resolveChatGptWebContextLimits(backendModel, mode.effort,
      { ...capabilities, experimentalBiggerContext: false }, parsed._chatgptModelFamily);
    const bigger = resolveChatGptWebContextLimits(backendModel, mode.effort,
      { ...capabilities, experimentalBiggerContext: true }, parsed._chatgptModelFamily);
    const bindingLimits = messageLimits?.probeInline ? undefined : messageLimits;
    const messages = bindingLimits ? compiledChatGptWebMessages(compiled) : [];
    const transportLoad = bindingLimits ? Math.max(
      messages.reduce((sum, text) => sum + text.length, 0) / (bindingLimits.chars * CHATGPT_BIGGER_CONTEXT_PARTS),
      (messages.reduce((sum, text) => sum + estimateTokens(text, parsed.modelId), 0)
        + skillFileTokens(compiled.skillFiles, parsed.modelId)) / (bindingLimits.tokens * CHATGPT_BIGGER_CONTEXT_PARTS),
    ) : 0;
    if (transportCapacityExceeded || transportLoad >= bigger.autoCompactTokenLimit / bigger.contextWindow) {
      console.info(`[chatgpt-web] compaction_transport_reserve ${JSON.stringify({
        inputTokens, transportLoad, transportCapacityExceeded,
        reportedInputTokens: Math.max(inputTokens, bigger.autoCompactTokenLimit),
      })}`);
      inputTokens = Math.max(inputTokens, bigger.autoCompactTokenLimit);
    }
    const pendingResultTokens = pendingToolOutputTokens(evidence, base.contextWindow - base.autoCompactTokenLimit);
    // The current answer/tool call also joins the next input. Reserve framing space without
    // charging every small read the full ordinary 10k-token compaction headroom.
    const continuationTokens = outputTokens + pendingResultTokens + 512;
    const projectedInputTokens = inputTokens + continuationTokens;
    const projectedMessageChars = compiled.text.length + evidenceText.length + pendingResultTokens * 4 + 2_048;
    const inlineTransport = resolveChatGptWebTransportLimits(backendModel, mode.effort, capabilities);
    const inlineVisibleTokenLimit = Math.min(inlineTransport.browserMessageTokenLimit ?? Infinity, bindingLimits?.tokens ?? Infinity);
    const projectedVisibleTokens = projectedInputTokens - CHATGPT_WEB_PLATFORM_RESERVE_TOKENS - estimateChatGptWebImageTokens(compiled);
    const inlineCharLimit = Math.min(inlineTransport.browserComposerCharLimit ?? Infinity, bindingLimits?.chars ?? Infinity);
    const inlineTokenCeiling = compiled.biggerContext ? bigger.contextWindow : base.contextWindow;
    const inlineWouldOverflow = projectedInputTokens >= inlineTokenCeiling
      || projectedVisibleTokens > inlineVisibleTokenLimit || projectedMessageChars > inlineCharLimit;
    if (!transportCapacityExceeded && supportsChatGptWebBiggerContext(parsed.modelId, mode.effort, parsed._chatgptModelFamily)
      && inlineWouldOverflow
      && multipartParts === undefined) {
      const staged = compileChatGptWebPrompt(parsed, capabilities, mode.localTools ? ESTIMATE_TURN_TOKEN : undefined, {
        appName, experimentalSkillAttachments, messageLimits, captureLunaCheckpoint: false,
        experimentalMultipartParts: CHATGPT_BIGGER_CONTEXT_PARTS,
      });
      const stagedTokens = estimateCompiledChatGptWebInputTokens(staged, parsed.modelId);
      const ceiling = resolveChatGptWebMultipartContextWindow(backendModel, mode.effort, capabilities,
        CHATGPT_BIGGER_CONTEXT_PARTS, parsed._chatgptModelFamily);
      if (stagedTokens >= ceiling) {
        // Codex controls automatic compaction through this conservative usage estimate.
        // Request it only when this continuation threatens the last fitting transport.
        console.info(`[chatgpt-web] compaction_capacity_reserve ${JSON.stringify({
          inputTokens, stagedTokens, ceiling, projectedInputTokens, projectedMessageChars, pendingResultTokens,
          inlineTokenCeiling,
          reportedInputTokens: Math.max(inputTokens, bigger.autoCompactTokenLimit),
        })}`);
        inputTokens = Math.max(inputTokens, bigger.autoCompactTokenLimit);
      }
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
