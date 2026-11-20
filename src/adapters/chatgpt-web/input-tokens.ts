import { CHATGPT_WEB_PLATFORM_RESERVE_TOKENS, chatGptWebImageTokenReserve } from "../../chatgpt-web-models";
import { skillFileTokens } from "./skill-attachments";
import { estimateTokens } from "../../lib/token-estimate";
import {
  CHATGPT_ESTIMATE_TRANSACTION_ID,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  type CompiledChatGptWebPrompt,
} from "./prompt";

function formatChatGptWebTransport(compiled: CompiledChatGptWebPrompt, transactionId = CHATGPT_ESTIMATE_TRANSACTION_ID) {
  const multipart = compiled.multipart;
  const stages = multipart?.parts.slice(0, -1).map((part, i) =>
    formatChatGptWebMultipartStage(part, transactionId, i + 1, multipart.parts.length));
  const finalPrompt = multipart ? formatChatGptWebMultipartCommit(multipart, transactionId) : compiled.text;
  return { stages, finalPrompt };
}

export function compiledChatGptWebMessages(compiled: CompiledChatGptWebPrompt, transactionId?: string): string[] {
  const { stages, finalPrompt } = formatChatGptWebTransport(compiled, transactionId);
  return [...(stages ?? []).map(stage => stage.text), finalPrompt];
}

export function estimateCompiledChatGptWebInputTokens(
  compiled: CompiledChatGptWebPrompt,
  modelId: string,
  transactionId?: string,
): number {
  return measureChatGptWebTransport(compiled, modelId, transactionId).estimatedInputTokens;
}

export function measureChatGptWebTransport(compiled: CompiledChatGptWebPrompt, modelId: string, transactionId?: string) {
  const { stages, finalPrompt } = formatChatGptWebTransport(compiled, transactionId);
  const imageTokens = estimateChatGptWebImageTokens(compiled);
  const finalMessageTokens = estimateTokens(finalPrompt, modelId) + skillFileTokens(compiled.skillFiles, modelId);
  const stageMessageTokens = (stages ?? []).map(stage => estimateTokens(stage.text, modelId));
  const stageTokens = (stages ?? []).reduce((sum, stage, i) =>
    sum + stageMessageTokens[i]! + estimateTokens(stage.acknowledgement, modelId), 0);
  const maxStageChars = Math.max(0, ...(stages ?? []).map(stage => stage.text.length));
  return {
    stages, finalPrompt, finalMessageTokens, imageTokens, stageMessageTokens,
    estimatedInputTokens: CHATGPT_WEB_PLATFORM_RESERVE_TOKENS + finalMessageTokens + stageTokens + imageTokens,
    maxStageMessageTokens: Math.max(0, ...stageMessageTokens), maxStageChars,
    maxMessageChars: Math.max(maxStageChars, finalPrompt.length),
  };
}

export function estimateChatGptWebImageTokens(compiled: CompiledChatGptWebPrompt): number {
  return compiled.images.reduce(
    (total, image) => total + chatGptWebImageTokenReserve(image.detail),
    0,
  );
}

export function estimateCompiledChatGptWebMessageTokens(compiled: CompiledChatGptWebPrompt, modelId: string): number {
  const measured = measureChatGptWebTransport(compiled, modelId);
  return Math.max(measured.maxStageMessageTokens, measured.finalMessageTokens);
}
export function compiledChatGptWebMaxMessageChars(compiled: CompiledChatGptWebPrompt): number {
  return Math.max(...compiledChatGptWebMessages(compiled).map(text => text.length));
}
