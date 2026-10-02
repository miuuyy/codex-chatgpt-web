import { skillFileTokens } from "./skill-attachments";
import { estimateTokens } from "../../lib/token-estimate";
import {
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
  isChatGptWebZeroRiskBackendModel,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import type { CodexParsedRequest, CodexUsage } from "../../types";
import { compiledChatGptWebMessages, estimateChatGptWebImageTokens, estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import {
  CHATGPT_BIGGER_CONTEXT_PARTS,
  CHATGPT_MAX_MULTIPART_PARTS,
  compileChatGptWebPrompt,
  createChatGptWebPromptPreparation,
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
const ESTIMATE_REQUEST_ID = "request_00000000000000000000000000000000";

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
    manual ? ESTIMATE_REQUEST_ID : mode.localTools && !parsed._compactionRequest ? ESTIMATE_TURN_TOKEN : undefined,
    {
      ...options,
      ...(manual ? { manualControl: true as const } : {}),
      captureLunaCheckpoint: parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
        && !parsed._compactionRequest
        && Boolean(identity.threadId && identity.turnId),
    },
  );
  return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId);
}

/**
 * The compaction threshold chooses the initial part count. Whole records and composer limits
 * can require more parts even when the total token estimate is small. Plan before submission;
 * compaction starts at six parts without passing through the legacy inline byte budget.
 * More transport parts keep each message small; they never increase the total context ceiling.
 */
export function resolveBiggerContextMultipartParts(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  experimentalSkillAttachments = false,
): ChatGptWebMultipartPartCount | undefined {
  if (isChatGptWebZeroRiskBackendModel(parsed.modelId)) {
    throw new Error("Bigger Context is unavailable for ChatGPT Zero Risk");
  }
  if (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error("Bigger Context is unavailable for Luna because its accumulated browser transcript still shares one 28,000-token transport budget");
  }
  const mode = resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const preparation = createChatGptWebPromptPreparation(parsed);
  const estimate = preparation.estimate;
  const { contextWindow, autoCompactTokenLimit } = resolveChatGptWebContextLimits(
    CHATGPT_WEB_BACKEND_MODEL,
    mode.effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const compile = (parts?: ChatGptWebMultipartPartCount): CompiledChatGptWebPrompt => compileChatGptWebPrompt(
    parsed, capabilities, mode.localTools && !parsed._compactionRequest ? ESTIMATE_TURN_TOKEN : undefined,
    { experimentalMultipartParts: parts, experimentalSkillAttachments, preparation },
  );
  const widestComposer = Math.max(...([mode.effort, capabilities.proAvailable ? "max" : "medium"] as const).map(effort =>
    resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities).browserComposerCharLimit ?? Infinity));
  // A very long plain-text history gets a multipart probe first. Its sanitized serialized
  // records establish the lower bound; raw text alone never decides the final transport.
  const plainTextChars = parsed.context.messages.reduce((sum, message) => sum
    + (typeof message.content === "string" ? message.content.length : 0), 0);
  const probe = !parsed._compactionRequest && plainTextChars > widestComposer * CHATGPT_BIGGER_CONTEXT_PARTS
    ? compile(CHATGPT_BIGGER_CONTEXT_PARTS) : undefined;
  const probeRequiresMoreParts = probe && preparation.records!.prepared.reduce((sum, record) => sum + record.text.length, 0)
    > widestComposer * CHATGPT_BIGGER_CONTEXT_PARTS;
  // Compaction and histories proven too large for six composers bypass inline tokenization.
  const inline = parsed._compactionRequest || probeRequiresMoreParts ? undefined : compile();
  const inputTokens = inline ? estimateCompiledChatGptWebInputTokens(inline, parsed.modelId, estimate) : 0;
  const initialParts = probeRequiresMoreParts ? CHATGPT_BIGGER_CONTEXT_PARTS
    : biggerContextPartCount(inputTokens, autoCompactTokenLimit, parsed._compactionRequest === true);

  const fits = (compiled: CompiledChatGptWebPrompt): boolean => {
    const messages = compiledChatGptWebMessages(compiled);
    // Inert stages may use any explicitly available staging effort; execution keeps the chosen
    // effort. These are the widest stage modes used by the browser's existing selector.
    const stagingEffort = capabilities.proAvailable ? "max" : "medium";
    // Reject a character-overflowing candidate before tokenizing any of its other messages.
    if (messages.some((text, index) => {
      const effort = index === messages.length - 1 ? mode.effort : stagingEffort;
      const limit = resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities).browserComposerCharLimit;
      return limit !== undefined && text.length > limit;
    })) return false;
    for (const [index, text] of messages.entries()) {
      const final = index === messages.length - 1;
      const effort = final ? mode.effort : stagingEffort;
      const { browserComposerCharLimit } = resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, capabilities);
      if (browserComposerCharLimit !== undefined && text.length > browserComposerCharLimit) return false;
      const budget = resolveChatGptWebMessageTokenBudget(
        CHATGPT_WEB_BACKEND_MODEL, effort, capabilities, final ? estimateChatGptWebImageTokens(compiled) + skillFileTokens(compiled.skillFiles, parsed.modelId) : 0,
      );
      if (estimate(text, parsed.modelId) > budget) return false;
    }
    return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId, estimate)
      < contextWindow * Math.min(messages.length, CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER);
  };
  if (initialParts === undefined && inline && fits(inline)) return undefined;
  const firstParts = initialParts ?? 2;
  const first = probe && firstParts === CHATGPT_BIGGER_CONTEXT_PARTS ? probe : compile(firstParts);
  if (fits(first)) return firstParts;
  // No partition can fit more record characters than its combined composer capacity. Skip
  // those impossible counts before repeating serialization and tokenization of a long history.
  // Record-only sizes exclude wrappers and attachments, keeping this a conservative lower bound.
  const recordChars = preparation.records!.prepared.reduce((total, record) => total + record.text.length, 0);
  const minimumParts = Math.ceil(Math.ceil(recordChars / widestComposer) / 2) * 2;
  for (let count = Math.max(firstParts + 2, minimumParts); count <= CHATGPT_MAX_MULTIPART_PARTS; count += 2) {
    const parts = count as ChatGptWebMultipartPartCount;
    if (fits(compile(parts))) return parts;
  }
  // Preserve the complete records and let browser preflight report an oversized record or total
  // context. Silently dropping history would change the user's task.
  return CHATGPT_MAX_MULTIPART_PARTS;
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
