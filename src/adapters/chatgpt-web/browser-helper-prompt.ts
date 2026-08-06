import {
  CHATGPT_MAX_INPUT_ATTACHMENTS,
  containsChatGptWebContextEnvelope,
  isChatGptWebContextAttachment,
  type CompiledChatGptWebPrompt,
} from "./prompt";

const BROWSER_HELPER_PROMPT_KEYS = new Set(["text", "images", "contextAttachment"]);

export function validateBrowserHelperPreparedPrompt(value: unknown): CompiledChatGptWebPrompt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser helper prompt is invalid");
  }
  const prompt = value as Record<string, unknown>;
  const keys = Object.keys(prompt);
  if (
    keys.length !== BROWSER_HELPER_PROMPT_KEYS.size
    || !keys.every(key => BROWSER_HELPER_PROMPT_KEYS.has(key))
  ) {
    throw new Error("Browser helper prompt contains unexpected fields");
  }
  if (typeof prompt.text !== "string" || !prompt.text.trim() || !Array.isArray(prompt.images)) {
    throw new Error("Browser helper prompt is invalid");
  }
  if (containsChatGptWebContextEnvelope(prompt.text)) {
    throw new Error("Browser helper prompt must keep the task context only in its attachment");
  }
  if (!isChatGptWebContextAttachment(prompt.contextAttachment)) {
    throw new Error("Browser helper task context attachment is missing or invalid");
  }
  if (prompt.images.length + 1 > CHATGPT_MAX_INPUT_ATTACHMENTS) {
    throw new Error("Browser helper prompt has too many attachments");
  }
  return value as CompiledChatGptWebPrompt;
}
