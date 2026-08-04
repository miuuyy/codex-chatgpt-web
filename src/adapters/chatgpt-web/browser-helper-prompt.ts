import {
  CHATGPT_MAX_INPUT_ATTACHMENTS,
  isChatGptWebContextAttachment,
  type CompiledChatGptWebPrompt,
} from "./prompt";

export function validateBrowserHelperPreparedPrompt(value: unknown): CompiledChatGptWebPrompt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser helper prompt is invalid");
  }
  const prompt = value as Record<string, unknown>;
  if (typeof prompt.text !== "string" || !Array.isArray(prompt.images)) {
    throw new Error("Browser helper prompt is invalid");
  }
  const attachment = prompt.contextAttachment;
  if (attachment !== null && !isChatGptWebContextAttachment(attachment)) {
    throw new Error("Browser helper context attachment is invalid");
  }
  if (prompt.images.length + (attachment === null ? 0 : 1) > CHATGPT_MAX_INPUT_ATTACHMENTS) {
    throw new Error("Browser helper prompt has too many attachments");
  }
  return value as CompiledChatGptWebPrompt;
}
