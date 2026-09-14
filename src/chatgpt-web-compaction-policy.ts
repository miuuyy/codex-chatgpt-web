import { CHATGPT_WEB_BACKEND_MODEL } from "./chatgpt-web-models";
import type { ChatGptWebCapabilities } from "./adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "./types";

export type ChatGptWebCompactionExecution =
  | { effort: "xhigh"; modelVersion: "5.6" }
  | { effort: "max"; modelVersion: "5.5" | "5.6" };

const COMPACTION_EXECUTIONS = {
  "extra-high": { effort: "xhigh", modelVersion: "5.6" },
  "5.6-pro": { effort: "max", modelVersion: "5.6" },
  "5.5-pro": { effort: "max", modelVersion: "5.5" },
} as const satisfies Record<string, ChatGptWebCompactionExecution>;

export type ChatGptWebCompactionModel = keyof typeof COMPACTION_EXECUTIONS;

export interface ChatGptWebCompactionPlan {
  /**
   * Request used only for summary generation. Source identity, retained lookup, cancellation, and
   * retirement must continue to use the original request passed to the resolver.
   */
  execution: CodexParsedRequest;
  compactionExecution?: ChatGptWebCompactionExecution;
}

export function parseChatGptWebCompactionModel(
  value: unknown,
): ChatGptWebCompactionModel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && Object.hasOwn(COMPACTION_EXECUTIONS, value)) {
    return value as ChatGptWebCompactionModel;
  }
  throw new Error(
    "Invalid compactionModel; expected extra-high, 5.6-pro, 5.5-pro, or an omitted value",
  );
}

/** Parse the exact daemon-to-browser contract and reject ambiguous effort/family combinations. */
export function parseChatGptWebCompactionExecution(
  value: unknown,
): ChatGptWebCompactionExecution {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid compaction execution");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some(key => key !== "effort" && key !== "modelVersion")) {
    throw new Error("Invalid compaction execution");
  }
  if (record.effort === "xhigh" && record.modelVersion === "5.6" && keys.length === 2) {
    return { effort: "xhigh", modelVersion: "5.6" };
  }
  if (record.effort === "max"
    && (record.modelVersion === "5.5" || record.modelVersion === "5.6")
    && keys.length === 2) {
    return { effort: "max", modelVersion: record.modelVersion };
  }
  throw new Error("Invalid compaction execution");
}

function executionFor(model: ChatGptWebCompactionModel): ChatGptWebCompactionExecution {
  return { ...COMPACTION_EXECUTIONS[model] };
}

export function resolveChatGptWebCompactionPlan(
  source: CodexParsedRequest,
  configuredModel: ChatGptWebCompactionModel | undefined,
  capabilities: ChatGptWebCapabilities,
): ChatGptWebCompactionPlan {
  const eligible = configuredModel !== undefined
    && source._compactionRequest === true
    && source.modelId === CHATGPT_WEB_BACKEND_MODEL
    && source.options.reasoning === "max"
    && capabilities.solAvailable
    && capabilities.proAvailable;
  if (!eligible) return { execution: source };

  const compactionExecution = executionFor(configuredModel);
  return {
    execution: {
      ...source,
      options: { ...source.options, reasoning: compactionExecution.effort },
    },
    compactionExecution,
  };
}
