import { createHash } from "node:crypto";
import { CHATGPT_WEB_BIGGER_CONTEXT_STANDARD_WINDOW } from "../../chatgpt-web-models";
import { ChatGptWebAdapterError } from "./adapter-error";

export const CHATGPT_CONTEXT_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const CHATGPT_CONTEXT_FILE_FEATURE = "context-file-v1";

export interface ChatGptContextFile {
  name: string;
  mimeType: "text/plain";
  content: string;
  sha256: string;
  maxInputTokens: number;
}

export function createChatGptContextFile(content: string, maxInputTokens: number): ChatGptContextFile {
  if (Buffer.byteLength(content, "utf8") > CHATGPT_CONTEXT_FILE_MAX_BYTES) {
    throw new ChatGptWebAdapterError("The context TXT exceeds the 8 MiB transport bound; reduce the request before retrying", {
      status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false,
    });
  }
  const sha256 = createHash("sha256").update(content).digest("hex");
  const file: ChatGptContextFile = { name: `codex-context-${sha256.slice(0, 16)}.txt`, mimeType: "text/plain", content, sha256, maxInputTokens };
  assertChatGptContextFile(file);
  return file;
}

export function assertChatGptContextFile(value: unknown): asserts value is ChatGptContextFile {
  const file = value as Partial<ChatGptContextFile> | undefined;
  if (!file || typeof file.content !== "string" || file.mimeType !== "text/plain"
    || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
    || file.name !== `codex-context-${file.sha256.slice(0, 16)}.txt`
    || !Number.isSafeInteger(file.maxInputTokens) || file.maxInputTokens! < 1
    || file.maxInputTokens! > CHATGPT_WEB_BIGGER_CONTEXT_STANDARD_WINDOW
    || Buffer.byteLength(file.content, "utf8") > CHATGPT_CONTEXT_FILE_MAX_BYTES
    || createHash("sha256").update(file.content).digest("hex") !== file.sha256) {
    throw new Error("Invalid ChatGPT context-file attachment");
  }
  let envelope: any;
  try { envelope = JSON.parse(file.content); } catch { throw new Error("ChatGPT context file must contain valid JSON"); }
  if (envelope?.version !== 3 || !Array.isArray(envelope.system) || !Array.isArray(envelope.messages)) {
    throw new Error("ChatGPT context file has an invalid context envelope");
  }
}

export function acceptsChatGptFiles(accept: string, files: readonly { name: string; mimeType: string }[]): boolean {
  const types = accept.toLowerCase().split(",").map(value => value.trim()).filter(Boolean);
  if (types.length === 0 || types.includes("*") || types.includes("*/*")) return true;
  return files.every(file => types.some(type => type === file.mimeType.toLowerCase()
    || (type.endsWith("/*") && file.mimeType.toLowerCase().startsWith(type.slice(0, -1)))
    || (type.startsWith(".") && file.name.toLowerCase().endsWith(type))));
}
