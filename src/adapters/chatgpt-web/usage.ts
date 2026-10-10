import { skillFileTokens } from "./skill-attachments";
import { estimateTokens } from "../../lib/token-estimate";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
  CHATGPT_WEB_PLATFORM_RESERVE_TOKENS,
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
  supportsChatGptWebBiggerContext,
} from "../../chatgpt-web-models";
import type { CodexParsedRequest, CodexUsage } from "../../types";
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
): number {
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  const mode = manual
    ? { localTools: true }
    : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const identity = extractChatGptTurnIdentity(parsed);
  const compiled = compileChatGptWebPrompt(
    parsed,
    capabilities,
    mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    {
      ...options,
      ...(manual ? { manualControl: true as const } : {}),
      captureLunaCheckpoint: options.captureLunaCheckpoint ?? (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
        && !parsed._compactionRequest
        && Boolean(identity.threadId && identity.turnId)),
    },
  );
  return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
}

/**
 * The compaction threshold chooses the initial part count. Whole records and composer limits
 * can require more parts even when the total token estimate is small. Plan before submission;
 * compaction always receives all six parts without passing through the legacy inline budget.
 */
export function resolveBiggerContextMultipartParts(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalSkillAttachments = false,
): ChatGptWebMultipartPartCount | undefined {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
    throw new Error("Bigger Context is unavailable for ChatGPT Zero Risk");
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  if (!supportsChatGptWebBiggerContext(parsed.modelId, mode.effort, parsed._chatgptModelFamily)) return undefined;
  if (parsed._compactionRequest) return CHATGPT_BIGGER_CONTEXT_PARTS;
  const backendModel = parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID ? CHATGPT_WEB_LUNA_MODEL_ID : CHATGPT_WEB_BACKEND_MODEL;
  const { autoCompactTokenLimit } = resolveChatGptWebContextLimits(
    backendModel,
    mode.effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const contextWindow = resolveChatGptWebMessageTokenBudget(backendModel, mode.effort, capabilities)
    + CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + 1;
  const compile = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => compileChatGptWebPrompt(
    parsed, capabilities, mode.localTools ? ESTIMATE_TURN_TOKEN : undefined,
    { experimentalMultipartParts: parts, experimentalSkillAttachments, captureLunaCheckpoint: false },
  );
  const inline = compile();
  const inputTokens = estimateCompiledChatGptWebInputTokens(inline, parsed.modelId);
  const initialParts = biggerContextPartCount(inputTokens, Math.min(contextWindow, autoCompactTokenLimit), false);
  if (initialParts === CHATGPT_BIGGER_CONTEXT_PARTS) return initialParts;

  const fits = (compiled: CompiledChatGptWebPrompt): boolean => {
    const messages = compiledChatGptWebMessages(compiled);
    // Inert stages may use any explicitly available staging effort; execution keeps the chosen
    // effort. These are the widest stage modes used by the browser's existing selector.
    const stagingEffort = backendModel === CHATGPT_WEB_LUNA_MODEL_ID ? "low" : capabilities.proAvailable ? "max" : "medium";
    for (const [index, text] of messages.entries()) {
      const final = index === messages.length - 1;
      const effort = final ? mode.effort : stagingEffort;
      const { browserComposerCharLimit } = resolveChatGptWebTransportLimits(backendModel, effort, capabilities);
      if (browserComposerCharLimit !== undefined && text.length > browserComposerCharLimit) return false;
      const budget = resolveChatGptWebMessageTokenBudget(
        backendModel, effort, capabilities, final ? estimateChatGptWebImageTokens(compiled) + skillFileTokens(compiled.skillFiles, parsed.modelId) : 0,
      );
      if (estimateTokens(text, parsed.modelId) > budget) return false;
    }
    return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId)
      < contextWindow * Math.min(messages.length, CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER);
  };
  if (initialParts === undefined && fits(inline)) return undefined;
  return fits(compile(2)) ? 2 : CHATGPT_BIGGER_CONTEXT_PARTS;
}

export function biggerContextPartCount(
  inputTokens: number,
  onePartLimit: number,
  compaction: boolean,
): ChatGptWebMultipartPartCount | undefined {
  if (compaction) return CHATGPT_BIGGER_CONTEXT_PARTS;
  if (inputTokens < onePartLimit) return undefined;
  if (inputTokens < onePartLimit * 2) return 2;
  return CHATGPT_BIGGER_CONTEXT_PARTS;
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

export function estimateChatGptWebUsage(
  parsed: CodexParsedRequest,
  evidence: ChatGptWebRoundEvidence,
  capabilities: ChatGptWebCapabilities,
  experimentalBiggerContext = false,
  experimentalSkillAttachments = false,
): CodexUsage {
  const inputTokens = estimateChatGptWebInputTokens(parsed, capabilities, {
    ...(experimentalBiggerContext ? { captureLunaCheckpoint: false } : {}),
    experimentalSkillAttachments,
    experimentalMultipartParts: experimentalBiggerContext
      ? resolveBiggerContextMultipartParts(parsed, capabilities, experimentalSkillAttachments)
      : undefined,
  });
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
