import { estimateTokens } from "../../lib/token-estimate";
import { isChatGptWebZeroRiskBackendModel, supportsChatGptWebBiggerContext } from "../../chatgpt-web-models";
import { ChatGptWebAdapterError } from "./adapter-error";
import { checkChatGptWebTransport } from "./transport-budget";
import type { CodexParsedRequest, CodexUsage } from "../../types";
import { estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import {
  CHATGPT_BIGGER_CONTEXT_PARTS,
  compileChatGptWebPrompt,
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
  const manual = isChatGptWebZeroRiskBackendModel(parsed.modelId);
  const mode = manual
    ? { localTools: true }
    : resolveChatGptWebModelMode(parsed.modelId, parsed.options.reasoning, capabilities);
  const identity = extractChatGptTurnIdentity(parsed);
  const turnToken = mode.localTools ? ESTIMATE_TURN_TOKEN : undefined;
  const compileOptions = {
    ...options,
    ...(manual ? { manualControl: true as const } : {}),
    captureLunaCheckpoint: options.captureLunaCheckpoint ?? (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID
      && !biggerContext && !parsed._compactionRequest && Boolean(identity.threadId && identity.turnId)),
  };
  const compiled = biggerContext
    ? compileBiggerContextPrompt(parsed, capabilities, turnToken, compileOptions, "usage")
    : compileChatGptWebPrompt(parsed, capabilities, turnToken, compileOptions);
  return estimateCompiledChatGptWebInputTokens(compiled, parsed.modelId, options.multipartTransactionId);
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
        ...options, experimentalMultipartParts: parts, requireCompleteHistory: !largest,
      });
      // Usage describes canonical history even when the retained chat only sends its latest tool
      // results. A submission must pass preflight for every size, including the largest.
      if (!largest || purpose === "submit") {
        checkChatGptWebTransport(compiled, parsed.modelId, mode, capabilities, parsed._chatgptModelFamily, options.multipartTransactionId);
      }
      return compiled;
    } catch (error) {
      if (largest || !(error instanceof ChatGptWebAdapterError && error.code === "context_length_exceeded")) throw error;
    }
  }
  throw new Error("No Bigger Context transport was evaluated");
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
  appName?: string,
): CodexUsage {
  const inputTokens = estimateChatGptWebInputTokens(parsed, capabilities, {
    appName,
    ...(experimentalBiggerContext ? { captureLunaCheckpoint: false } : {}),
    experimentalSkillAttachments,
  }, experimentalBiggerContext);
  const outputTokens = conservativeTextTokens(roundEvidenceText(evidence), parsed.modelId);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimated: true,
  };
}
