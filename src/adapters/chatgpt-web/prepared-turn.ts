import { isDeepStrictEqual } from "node:util";
import type { CodexParsedRequest } from "../../types";
import type { ChatGptTurnEnvironment } from "./environment";
import { ChatGptWebAdapterError } from "./adapter-error";

function identity(parsed: CodexParsedRequest) {
  return { body: parsed._rawBody, model: parsed.modelId, options: parsed.options, context: parsed.context,
    compaction: parsed._compactionRequest, format: parsed._compactionResponseFormat };
}

/** One admission per parsed request. Execution cannot silently substitute another authority. */
export class PreparedChatGptTurnStore {
  private readonly turns = new WeakMap<CodexParsedRequest, { identity: unknown; environment: ChatGptTurnEnvironment }>();

  prepare(parsed: CodexParsedRequest, environment: ChatGptTurnEnvironment): void {
    this.turns.set(parsed, { identity: structuredClone(identity(parsed)), environment: structuredClone(environment) });
  }

  get(parsed: CodexParsedRequest): ChatGptTurnEnvironment | undefined {
    const prepared = this.turns.get(parsed);
    if (!prepared) return undefined;
    if (!isDeepStrictEqual(prepared.identity, identity(parsed))) {
      throw new ChatGptWebAdapterError("Codex turn changed after execution admission", {
        status: 400, errorType: "invalid_request_error", code: "turn_preflight_changed", retryable: false,
      });
    }
    return structuredClone(prepared.environment);
  }
}
