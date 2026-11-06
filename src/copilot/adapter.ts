import { randomUUID } from "node:crypto";
import type { IncomingMeta, ProviderAdapter } from "../adapters/base";
import { estimateTokens } from "../lib/token-estimate";
import type { AdapterEvent, CodexParsedRequest } from "../types";
import { CopilotBrowser, copilotBrowserForConfig } from "./browser";
import { resolveCopilotModel, type CopilotConfig } from "./config";
import { compileCopilotPrompt } from "./prompt";
import { parseCopilotResponse } from "./tool-protocol";

const HEARTBEAT_MS = 5_000;

export class CopilotWebAdapter implements ProviderAdapter {
  readonly name = "copilot-web";

  constructor(
    private readonly config: CopilotConfig,
    private readonly browser: Pick<CopilotBrowser, "runPrompt">,
  ) {}

  async runTurn(
    parsed: CodexParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void> {
    if (parsed._opaqueMultiAgentV2Payload) {
      throw new Error(
        "Copilot Web cannot read this encrypted cross-backend subagent payload. Start a new task without MultiAgent V2.",
      );
    }
    const turnId = randomUUID().replaceAll("-", "");
    const compiled = compileCopilotPrompt(parsed, {
      turnId,
      maxPromptChars: this.config.maxPromptChars,
      toolProtocol: this.config.toolProtocol,
    });
    const model = resolveCopilotModel(this.config, parsed.modelId);
    const heartbeat = setInterval(() => {
      try {
        emit({ type: "heartbeat" });
      } catch {
        // The stream may already be closed; heartbeats are best effort.
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    let text: string;
    try {
      const result = await this.browser.runPrompt(compiled.text, model, {
        signal: incoming.abortSignal,
        onHeartbeat: () => {
          try {
            emit({ type: "heartbeat" });
          } catch {
            // The stream may already be closed; heartbeats are best effort.
          }
        },
        onProgress: message => console.info(`[copilot-web] ${message}`),
      });
      text = result.text;
    } finally {
      clearInterval(heartbeat);
    }

    const allowTools = parsed._compactionRequest !== true && this.config.toolProtocol;
    const response = parseCopilotResponse(text, compiled.tools, { allowTools });
    if (response.text.length > 0) {
      emit({
        type: "text_delta",
        text: response.text,
        ...(parsed._compactionRequest ? {} : { phase: "final_answer" as const }),
      });
    }
    for (const call of response.toolCalls) {
      emit({ type: "tool_call_start", id: `call_${randomUUID().replaceAll("-", "")}`, name: call.name });
      emit({ type: "tool_call_delta", arguments: JSON.stringify(call.arguments) });
      emit({ type: "tool_call_end" });
    }
    const inputTokens = estimateTokens(compiled.text);
    const outputTokens = estimateTokens(text);
    emit({
      type: "done",
      ...(response.toolCalls.length > 0
        ? { stopReason: "tool_use", endTurn: false }
        : { stopReason: "stop", endTurn: true }),
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimated: true,
      },
    });
  }
}

export function createCopilotWebAdapter(config: CopilotConfig): ProviderAdapter {
  return new CopilotWebAdapter(config, copilotBrowserForConfig(config));
}
