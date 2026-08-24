import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ProviderAdapter } from "../adapters/base";
import { closeChatGptBrowserWorkers } from "../adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../adapters/chatgpt-web";
import { estimateChatGptWebInputTokens } from "../adapters/chatgpt-web/usage";
import { RemoteTurnBroker, type TurnBrokerOwner } from "../adapters/chatgpt-web/turn-broker";
import {
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
} from "../adapters/chatgpt-web/input-tokens";
import {
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  requireChatGptWebModelRoute,
  resolveChatGptWebContextLimits,
} from "../chatgpt-web-models";
import type { AppConfig } from "../config";
import { parseRequest } from "../responses/parser";
import { compactRequest, responseRequest, routeChatGptWebRequest } from "../server";
import { namespacedToolName, type AdapterEvent, type CodexProviderConfig } from "../types";
import {
  createDevContextFiller,
  type DevChatModel,
  type DevChatState,
  type DevChatStore,
  type DevChatUsage,
} from "./session";

type AdapterFactory = (provider: CodexProviderConfig) => ProviderAdapter;

export type DevChatEvent =
  | { type: "reasoning"; text: string }
  | { type: "commentary"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; receipt: Record<string, unknown> }
  | { type: "compaction_start"; reason: "automatic" | "manual"; inputItems: number }
  | { type: "compaction_done"; reason: "automatic" | "manual"; inputItems: number };

export interface DevContextStatus {
  model: DevChatModel;
  inputTokens: number;
  autoCompactTokenLimit: number;
  contextWindow: number;
  browserInputTokenLimit?: number;
  percent: number;
  inputItems: number;
}

export interface DevChatTurnResult {
  text: string;
  usage: DevChatUsage;
  toolCalls: number;
  compactions: number;
  status: DevContextStatus;
}

interface ResponsesEnvelope {
  id?: string;
  status?: string;
  output?: unknown[];
  end_turn?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string } | null;
  incomplete_details?: { reason?: string; message?: string } | null;
}

interface DevToolCall {
  kind: "function" | "custom";
  callId: string;
  name: string;
  input: unknown;
}

export const DEV_CHAT_SYSTEM_INSTRUCTIONS = [
  "You are running inside the Codex Web GPT DEV outer-harness simulator.",
  "Behave like the normal Codex model backend and use the available Codex Native tools whenever they help answer the user's request.",
  "Every outer tool result is an explicit simulation receipt. No command, file edit, image read, user prompt, or external side effect actually occurs.",
  "Never describe a simulated receipt as a real-world effect. Continue reasoning from the receipt exactly as test evidence for the transport flow.",
].join(" ");

export const DEV_CHAT_BROWSER_ONLY_INSTRUCTIONS = [
  "You are running inside the Codex Web GPT DEV outer-harness simulator.",
  "Behave like the normal Codex model backend.",
  "This browser-only DEV profile exposes no outer tools. Do not claim that commands, file edits, UI actions, or external side effects occurred.",
].join(" ");

const ANY_ARGUMENTS = { type: "object", additionalProperties: true } as const;
const simulatedFunction = (name: string, description: string) => ({
  type: "function", name, parameters: ANY_ARGUMENTS,
  description: `DEV simulator: ${description}. Arguments are recorded and no side effect occurs.`,
});

export const DEV_CHAT_TOOLS: readonly Record<string, unknown>[] = [
  simulatedFunction("exec_command", "native command execution"),
  simulatedFunction("write_stdin", "native command-session continuation"),
  { type: "custom", name: "apply_patch", description: "DEV simulator: records patch text and changes no file." },
  simulatedFunction("view_image", "native image inspection"),
  simulatedFunction("request_user_input", "native user input"),
  {
    type: "namespace", name: "mcp__dev_simulator",
    description: "Synthetic deferred MCP tools for inventory and generic dispatch tests.",
    tools: [simulatedFunction("echo", "structured MCP echo")],
  },
];

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function environmentContext(cwd: string): string {
  const escaped = xml(cwd);
  return `<environment_context>
  <cwd>${escaped}</cwd>
  <filesystem><workspace_roots><root>${escaped}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>
  <codex_dev_mode>All outer tool effects are explicitly simulated.</codex_dev_mode>
</environment_context>`;
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function turnMetadata(threadId: string, turnId: string, cwd: string): string {
  return JSON.stringify({
    thread_id: threadId,
    turn_id: turnId,
    request_kind: "turn",
    sandbox: "none",
    workspaces: { [cwd]: {} },
  });
}

function currentTurnItems(cwd: string, turnId: string, message: string): unknown[] {
  const itemMetadata = { turn_id: turnId };
  return [
    {
      type: "message",
      id: id("msg_dev_environment"),
      role: "user",
      content: [{ type: "input_text", text: environmentContext(cwd) }],
      internal_chat_message_metadata_passthrough: itemMetadata,
    },
    {
      type: "message",
      id: id("msg_dev_user"),
      role: "user",
      content: [{ type: "input_text", text: message }],
      internal_chat_message_metadata_passthrough: itemMetadata,
    },
  ];
}

function requestBody(
  state: DevChatState,
  cwd: string,
  turnId: string,
  input: unknown[],
  stream: boolean,
  localToolsEnabled: boolean,
): Record<string, unknown> {
  return {
    model: state.model,
    instructions: localToolsEnabled ? DEV_CHAT_SYSTEM_INSTRUCTIONS : DEV_CHAT_BROWSER_ONLY_INSTRUCTIONS,
    input,
    tools: localToolsEnabled ? DEV_CHAT_TOOLS : [],
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { summary: "auto" },
    stream,
    store: false,
    prompt_cache_key: state.threadId,
    client_metadata: {
      "x-codex-turn-metadata": turnMetadata(state.threadId, turnId, cwd),
    },
    metadata: { codex_chatgpt_web_dev: true, chat_name: state.name },
  };
}

function responseError(response: ResponsesEnvelope): string {
  if (response.error?.message) {
    const suffix = [response.error.type, response.error.code].filter(Boolean).join("/");
    return suffix ? `${response.error.message} (${suffix})` : response.error.message;
  }
  if (response.incomplete_details?.message) return response.incomplete_details.message;
  if (response.incomplete_details?.reason) return `Responses turn was incomplete: ${response.incomplete_details.reason}`;
  return `Responses turn ended with status ${String(response.status ?? "unknown")}`;
}

function observeAdapterEvent(event: AdapterEvent, emit: (event: DevChatEvent) => void): void {
  if (event.type === "thinking_delta") emit({ type: "reasoning", text: event.thinking });
  else if (event.type === "text_delta") {
    emit({ type: event.phase === "commentary" ? "commentary" : "text", text: event.text });
  }
}

function toolCalls(output: unknown[]): DevToolCall[] {
  const calls: DevToolCall[] = [];
  for (const value of output) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    if (typeof item.call_id !== "string") continue;
    if (item.type === "function_call" && typeof item.name === "string") {
      let input: unknown = {};
      if (typeof item.arguments === "string" && item.arguments.trim()) {
        try { input = JSON.parse(item.arguments); }
        catch { input = item.arguments; }
      }
      calls.push({
        kind: "function",
        callId: item.call_id,
        name: namespacedToolName(typeof item.namespace === "string" ? item.namespace : undefined, item.name),
        input,
      });
    } else if (item.type === "custom_tool_call" && typeof item.name === "string") {
      calls.push({ kind: "custom", callId: item.call_id, name: item.name, input: item.input ?? "" });
    }
  }
  return calls;
}

function simulatedReceipt(state: DevChatState, turnId: string, call: DevToolCall): Record<string, unknown> {
  return {
    type: "codex_dev_simulated_tool_result",
    simulated: true,
    side_effects_performed: false,
    chat: state.name,
    turn_id: turnId,
    call_id: call.callId,
    tool: { name: call.name, kind: call.kind },
    received_input: call.input,
    output: `Simulated ${call.name}; no command, file, UI, user, or external side effect was performed.`,
  };
}

function toolOutput(call: DevToolCall, receipt: Record<string, unknown>): Record<string, unknown> {
  const metadata = { turn_id: receipt.turn_id };
  if (call.kind === "custom") {
    return {
      type: "custom_tool_call_output",
      call_id: call.callId,
      output: JSON.stringify(receipt),
      internal_chat_message_metadata_passthrough: metadata,
    };
  }
  return {
    type: "function_call_output",
    call_id: call.callId,
    output: JSON.stringify(receipt),
    internal_chat_message_metadata_passthrough: metadata,
  };
}

function historyOutput(output: unknown[], turnId: string): unknown[] {
  return output.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const item = value as Record<string, unknown>;
    const metadata = item.internal_chat_message_metadata_passthrough;
    if (metadata !== undefined && (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) {
      throw new Error("DEV Responses output carried invalid native item metadata");
    }
    const existing = (metadata as Record<string, unknown> | undefined)?.turn_id;
    if (existing !== undefined && existing !== turnId) {
      throw new Error(`DEV Responses output belongs to another turn: ${String(existing)}`);
    }
    return {
      ...item,
      internal_chat_message_metadata_passthrough: {
        ...(metadata as Record<string, unknown> | undefined),
        turn_id: turnId,
      },
    };
  });
}

function outputText(output: unknown[]): string {
  const parts: string[] = [];
  for (const value of output) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as { type?: unknown; phase?: unknown; content?: unknown };
    if (item.type !== "message" || !Array.isArray(item.content) || item.phase === "commentary") continue;
    for (const raw of item.content) {
      const block = raw as { type?: unknown; text?: unknown };
      if ((block.type === "output_text" || block.type === "text") && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
  }
  return parts.join("");
}

function usageOf(response: ResponsesEnvelope): DevChatUsage {
  const inputTokens = Number.isInteger(response.usage?.input_tokens) ? response.usage!.input_tokens! : 0;
  const outputTokens = Number.isInteger(response.usage?.output_tokens) ? response.usage!.output_tokens! : 0;
  const totalTokens = Number.isInteger(response.usage?.total_tokens)
    ? response.usage!.total_tokens!
    : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

export function defaultDevChatModel(config: AppConfig): DevChatModel {
  return config.solAvailable ? "chatgpt-web/light" : "chatgpt-web/luna";
}

export function prepareWorkingTreeBrowserHelper(): string | undefined {
  const root = resolve(import.meta.dir, "..", "..");
  const buildScript = join(root, "scripts", "build-browser-helper.ts");
  if (!existsSync(buildScript)) return undefined;
  const output = join(root, ".launcher-runtime", "browser-helper.cjs");
  const build = Bun.spawnSync([process.execPath, "run", buildScript, output], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    throw new Error(`Could not build the working-tree browser helper: ${build.stderr.toString().trim() || build.stdout.toString().trim()}`);
  }
  return output;
}

export function createLauncherDevAdapter(
  config: AppConfig,
  runtimeStateRoot: string,
  options: { broker?: TurnBrokerOwner; browserHelperScriptPath?: string } = {},
): { broker: TurnBrokerOwner; adapterFactory: AdapterFactory } {
  const broker = options.broker ?? new RemoteTurnBroker(config.brokerSocketPath);
  const browserHelperScriptPath = options.browserHelperScriptPath ?? prepareWorkingTreeBrowserHelper();
  const adapterFactory: AdapterFactory = provider => createChatGptWebAdapter({
    ...provider,
    chatgptWeb: {
      ...provider.chatgptWeb,
      ...(browserHelperScriptPath ? { browserHelperScriptPath } : {}),
      browserDiagnosticsPath: join(runtimeStateRoot, "diagnostics", "browser-turns"),
      threadEnvironmentStatePath: join(runtimeStateRoot, "thread-environments.json"),
      lunaCheckpointStatePath: join(runtimeStateRoot, "luna-checkpoints.json"),
      turnTimeoutMs: 60 * 60_000,
    },
  }, { broker });
  return { broker, adapterFactory };
}

export class DevChatDriver {
  constructor(
    readonly config: AppConfig,
    readonly store: DevChatStore,
    readonly adapterFactory: AdapterFactory,
    readonly cwd = process.cwd(),
  ) {}

  open(name: string, requestedModel?: DevChatModel): { state: DevChatState; created: boolean } {
    const model = requestedModel ?? defaultDevChatModel(this.config);
    requireChatGptWebModelRoute(model, this.config);
    const opened = this.store.loadOrCreate(name, model, this.cwd);
    if (resolve(opened.state.cwd) !== resolve(this.cwd)) {
      throw new Error(`DEV chat ${JSON.stringify(name)} belongs to ${opened.state.cwd}; use another name for ${this.cwd}`);
    }
    requireChatGptWebModelRoute(opened.state.model, this.config);
    if (opened.created) this.store.save(opened.state);
    return opened;
  }

  setModel(state: DevChatState, model: DevChatModel): void {
    requireChatGptWebModelRoute(model, this.config);
    state.model = model;
    this.store.save(state);
  }

  reset(state: DevChatState): void {
    this.store.reset(state);
  }

  fill(state: DevChatState, targetTokens: number): { addedTokens: number; status: DevContextStatus } {
    const filler = createDevContextFiller(targetTokens);
    const fillerTurnId = id("dev_fill_turn");
    state.input.push({
      type: "message",
      id: id("msg_dev_fill"),
      role: "user",
      content: [{ type: "input_text", text: filler.text }],
      internal_chat_message_metadata_passthrough: { turn_id: fillerTurnId },
    });
    state.syntheticFills += 1;
    this.store.save(state);
    return { addedTokens: filler.tokens, status: this.status(state) };
  }

  status(state: DevChatState): DevContextStatus {
    const probeTurnId = id("dev_status_turn");
    const input = [...state.input, ...currentTurnItems(this.cwd, probeTurnId, "(DEV context status probe)")];
    return { ...this.statusForInput(state, probeTurnId, input), inputItems: state.input.length };
  }

  async compact(
    state: DevChatState,
    emit: (event: DevChatEvent) => void = () => {},
  ): Promise<DevContextStatus> {
    if (state.input.length === 0) throw new Error("DEV chat has no history to compact");
    const output = await this.compactInput(state, state.input, "manual", emit);
    state.input = output;
    state.compactions += 1;
    this.store.save(state);
    return this.status(state);
  }

  async send(
    state: DevChatState,
    message: string,
    emit: (event: DevChatEvent) => void = () => {},
  ): Promise<DevChatTurnResult> {
    const prompt = message.trim();
    if (!prompt) throw new Error("DEV chat message must not be empty");
    const turnId = id("dev_turn");
    let compactions = 0;
    let pendingCompactions = 0;
    let workingInput = [...state.input, ...currentTurnItems(this.cwd, turnId, prompt)];
    let context = this.statusForInput(state, turnId, workingInput);

    if (this.shouldAutoCompact(state, context) && state.input.length > 0) {
      state.input = await this.compactInput(state, state.input, "automatic", emit);
      state.compactions += 1;
      compactions += 1;
      this.store.save(state);
      workingInput = [...state.input, ...currentTurnItems(this.cwd, turnId, prompt)];
      context = this.statusForInput(state, turnId, workingInput);
    }
    if (this.shouldAutoCompact(state, context)) {
      throw new Error(
        `DEV turn still requires ${context.inputTokens.toLocaleString("en-US")} tokens after compaction; `
        + `the selected mode compacts at ${context.autoCompactTokenLimit.toLocaleString("en-US")}`,
      );
    }

    let totalToolCalls = 0;
    const usage: DevChatUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let finalText = "";
    for (let round = 0; round < 64; round += 1) {
      const body = requestBody(state, this.cwd, turnId, workingInput, false, this.config.mode === "full");
      const response = await responseRequest(new Request("http://codex-web-gpt.dev/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }), this.config, this.adapterFactory, {
        rememberState: false,
        onAdapterEvent: event => observeAdapterEvent(event, emit),
      });
      const envelope = await response.json() as ResponsesEnvelope;
      if (!Array.isArray(envelope.output)) throw new Error("DEV Responses handler returned no output array");
      if (envelope.status !== "completed") throw new Error(responseError(envelope));
      const output = historyOutput(envelope.output!, turnId);
      workingInput.push(...output);
      const roundUsage = usageOf(envelope);
      usage.inputTokens += roundUsage.inputTokens;
      usage.outputTokens += roundUsage.outputTokens;
      usage.totalTokens += roundUsage.totalTokens;
      const calls = toolCalls(output);
      if (calls.length === 0) {
        if (envelope.end_turn !== true) {
          throw new Error("DEV Responses turn completed without tool calls or end_turn=true");
        }
        finalText = outputText(output);
        state.input = workingInput;
        state.turns += 1;
        state.compactions += pendingCompactions;
        state.lastUsage = usage;
        this.store.save(state);
        return {
          text: finalText,
          usage,
          toolCalls: totalToolCalls,
          compactions,
          status: this.status(state),
        };
      }

      totalToolCalls += calls.length;
      for (const call of calls) {
        emit({ type: "tool_call", name: call.name, input: call.input });
        const receipt = simulatedReceipt(state, turnId, call);
        emit({ type: "tool_result", name: call.name, receipt });
        workingInput.push(toolOutput(call, receipt));
      }

      context = this.statusForInput(state, turnId, workingInput);
      if (this.shouldAutoCompact(state, context)) {
        workingInput = await this.compactInput(state, workingInput, "automatic", emit);
        pendingCompactions += 1;
        compactions += 1;
      }
    }
    throw new Error("DEV chat exceeded 64 simulated tool rounds without a final answer");
  }

  async close(): Promise<void> {
    await closeChatGptBrowserWorkers();
  }

  private shouldAutoCompact(state: DevChatState, context: DevContextStatus): boolean {
    return state.model !== "chatgpt-web/luna" && context.inputTokens >= context.autoCompactTokenLimit;
  }

  private statusForInput(state: DevChatState, turnId: string, input: unknown[]): DevContextStatus {
    const parsed = parseRequest(requestBody(
      state,
      this.cwd,
      turnId,
      input,
      false,
      this.config.mode === "full",
    ));
    const route = routeChatGptWebRequest(parsed, this.config);
    const inputTokens = estimateChatGptWebInputTokens(parsed, {
      localToolsEnabled: this.config.mode === "full",
      solAvailable: this.config.solAvailable,
      proAvailable: this.config.proAvailable,
    });
    const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, this.config);
    return {
      model: state.model,
      inputTokens,
      autoCompactTokenLimit: limits.autoCompactTokenLimit,
      contextWindow: limits.contextWindow,
      ...(route.backendModel === CHATGPT_WEB_LUNA_BACKEND_MODEL
        ? { browserInputTokenLimit: CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET }
        : {}),
      percent: Math.round((inputTokens / limits.autoCompactTokenLimit) * 1_000) / 10,
      inputItems: input.length,
    };
  }

  private async compactInput(
    state: DevChatState,
    input: unknown[],
    reason: "automatic" | "manual",
    emit: (event: DevChatEvent) => void,
  ): Promise<unknown[]> {
    if (state.model === "chatgpt-web/luna") {
      throw new Error("ChatGPT Web Luna uses its production rolling checkpoint and does not support a separate compact command");
    }
    const compactTurnId = id("dev_compact_turn");
    emit({ type: "compaction_start", reason, inputItems: input.length });
    const response = await compactRequest(new Request("http://codex-web-gpt.dev/v1/responses/compact", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-codex-turn-metadata": turnMetadata(state.threadId, compactTurnId, this.cwd),
      },
      body: JSON.stringify({
        model: state.model,
        input,
        instructions: DEV_CHAT_SYSTEM_INSTRUCTIONS,
        store: false,
      }),
    }), this.config, this.adapterFactory);
    if (!response.ok) {
      let message = `DEV compaction failed with HTTP ${response.status}`;
      try {
        const body = await response.json() as { error?: { message?: unknown } };
        if (typeof body.error?.message === "string") message = body.error.message;
      } catch {}
      throw new Error(message);
    }
    const body = await response.json() as { output?: unknown };
    if (!Array.isArray(body.output) || body.output.length === 0) {
      throw new Error("DEV compaction returned no replacement history");
    }
    emit({ type: "compaction_done", reason, inputItems: body.output.length });
    return body.output;
  }
}
