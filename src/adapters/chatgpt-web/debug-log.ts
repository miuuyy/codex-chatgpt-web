import { ChatGptWebAdapterError } from "./adapter-error";

export type ChatGptWebLogLevel = "info" | "warn" | "error";
export type ChatGptWebLogValue = string | number | boolean | undefined | null;

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

export function formatChatGptWebLog(
  event: string,
  fields: Record<string, ChatGptWebLogValue> = {},
): string {
  const parts = [`[chatgpt-web] event=${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    const text = typeof value === "string" ? sanitizeLogValue(value) : String(value);
    parts.push(text.includes(" ") || text.includes("=") ? `${key}=${JSON.stringify(text)}` : `${key}=${text}`);
  }
  return parts.join(" ");
}

export function chatGptWebErrorLogFields(error: unknown): Record<string, ChatGptWebLogValue> {
  if (error instanceof ChatGptWebAdapterError) {
    return {
      error: error.message,
      name: error.name,
      code: error.code,
      retryable: error.retryable,
      status: error.status,
      errorType: error.errorType,
    };
  }
  if (error instanceof Error) {
    return { error: error.message, name: error.name };
  }
  return { error: String(error) };
}

export function logChatGptWeb(
  level: ChatGptWebLogLevel,
  event: string,
  fields: Record<string, ChatGptWebLogValue> = {},
): void {
  const line = formatChatGptWebLog(event, fields);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}
