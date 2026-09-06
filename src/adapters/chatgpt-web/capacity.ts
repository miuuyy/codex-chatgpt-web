import type { CodexParsedRequest } from "../../types";
import { ChatGptWebAdapterError } from "./adapter-error";
import {
  compiledChatGptWebMaxMessageChars,
  DEFAULT_CHATGPT_WEB_MAX_MESSAGE_CHARS,
} from "./input-tokens";
import { CHATGPT_WEB_LUNA_MODEL_ID, type ChatGptWebCapabilities } from "./model";
import {
  CHATGPT_BIGGER_CONTEXT_PARTS,
  compileChatGptWebPrompt,
  type CompileChatGptWebPromptOptions,
  type CompiledChatGptWebPrompt,
} from "./prompt";

export { DEFAULT_CHATGPT_WEB_MAX_MESSAGE_CHARS } from "./input-tokens";

export interface ChatGptWebCapacityCompileOptions
  extends Omit<CompileChatGptWebPromptOptions, "multipartParts" | "experimentalMultipartParts" | "preserveCompactionHistory"> {
  maxMessageChars?: number;
}

function capacityError(
  actualChars: number,
  maxMessageChars: number,
  transport: "automatic" | "manual" | "luna",
): ChatGptWebAdapterError {
  const actual = actualChars.toLocaleString("en-US");
  const limit = maxMessageChars.toLocaleString("en-US");
  const transportGuidance = transport === "manual"
    ? " Zero Risk cannot split the prompt into multiple browser messages."
    : transport === "luna"
      ? " Luna cannot use multipart browser transport because its staged transcript shares one browser input budget."
      : " Even the three-part browser transport cannot keep every message within the configured page limit.";
  return new ChatGptWebAdapterError(
    `ChatGPT browser prompt requires ${actual} characters in one message, above the configured page limit of ${limit}.${transportGuidance}`
      + " Reduce or compact the Codex context, or raise chatGptWebMaxMessageChars only after verifying this machine's ChatGPT page capacity.",
    {
      status: 413,
      errorType: "invalid_request_error",
      code: "browser_message_too_large",
      retryable: false,
    },
  );
}

export function compileChatGptWebPromptWithinPageCapacity(
  parsed: CodexParsedRequest,
  capabilities: ChatGptWebCapabilities,
  turnToken?: string,
  options: ChatGptWebCapacityCompileOptions = {},
): CompiledChatGptWebPrompt {
  const maxMessageChars = options.maxMessageChars ?? DEFAULT_CHATGPT_WEB_MAX_MESSAGE_CHARS;
  if (!Number.isSafeInteger(maxMessageChars) || maxMessageChars <= 0) {
    throw new Error("ChatGPT browser maxMessageChars must be a positive safe integer");
  }
  const { maxMessageChars: _ignored, ...compileOptions } = options;
  const baseOptions = {
    ...compileOptions,
    preserveCompactionHistory: true,
  } satisfies CompileChatGptWebPromptOptions;
  const inline = compileChatGptWebPrompt(parsed, capabilities, turnToken, baseOptions);
  const inlineChars = compiledChatGptWebMaxMessageChars(inline);
  if (inlineChars <= maxMessageChars) return inline;

  if (options.manualControl === true) {
    throw capacityError(inlineChars, maxMessageChars, "manual");
  }
  if (parsed.modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw capacityError(inlineChars, maxMessageChars, "luna");
  }

  let lastChars = inlineChars;
  for (const multipartParts of [2, CHATGPT_BIGGER_CONTEXT_PARTS] as const) {
    const candidate = compileChatGptWebPrompt(parsed, capabilities, turnToken, {
      ...baseOptions,
      multipartParts,
    });
    lastChars = compiledChatGptWebMaxMessageChars(candidate);
    if (lastChars <= maxMessageChars) return candidate;
  }
  throw capacityError(lastChars, maxMessageChars, "automatic");
}
