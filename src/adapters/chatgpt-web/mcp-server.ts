import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import type { ChatGptTurnEnvironment } from "./environment";
import { callTurnBroker, type BrokerToolResult } from "./turn-broker";
import { observeCommandInvocation } from "./command-observability";

interface ClaimedTurn {
  bindingId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
}

const turnTokenSchema = z.string().min(20).max(256);
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});
export const CHATGPT_WEB_AGENT_WAIT_POLL_MS = 10_000;
const escalationSandboxPermissionsSchema = z.literal("require_escalated");
const escalationJustificationSchema = z.string().min(1).max(4_000);
const PENDING_CELL_TEXT = /^Script running with cell ID ([^\s\x00-\x1f\x7f]{1,256})(?:\r?\nWall time \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n[\s\S]*)?$/;
const TERMINAL_OUTPUT_TEXT = /^Script completed\r?\nWall time \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n([\s\S]*)$/;
const TERMINAL_FINAL_OUTPUT_TEXT = /^Script completed\r?\nWall time \d+(?:\.\d+)? seconds\r?\nProcess exited with code 0\r?\nFinal output:\r?\n([\s\S]*)$/;
const TERMINAL_FAILURE_TEXT = /^(Script failed|Script terminated)(?:\r?\n[\s\S]*)?$/;
const UNRESOLVED_UNKNOWN_OUTCOME = "UNRESOLVED_UNKNOWN_OUTCOME: outcome remains UNKNOWN; the original invocation cannot be retried and the command slot remains locked";
const GATEWAY_COMMAND_RESULT_PROTOCOL = "codex_exec_gateway_result_v1";

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function brokerInvocationKey(scope: string, value: unknown): string {
  return createHash("sha256").update(JSON.stringify({ scope, value })).digest("base64url");
}

function requestScopeSummary(extra: {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
}): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: {
      chars: String(extra.requestId).length,
      hash: scopeHash(String(extra.requestId)),
    },
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function exactTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  const matches = environment.tools.filter(tool => !tool.namespace && tool.name === name);
  if (matches.length > 1) throw new Error(`This Codex turn advertised duplicate native tools: ${name}`);
  return matches[0];
}

function namedTool(environment: ChatGptTurnEnvironment, requestedWireName: string): CodexTool {
  const matches = environment.tools.filter(candidate => wireName(candidate) === requestedWireName);
  if (matches.length === 0) throw new Error(`Codex tool is not available in this turn: ${requestedWireName}`);
  if (matches.length > 1) throw new Error(`This Codex turn advertised duplicate tools: ${requestedWireName}`);
  return matches[0];
}

function isDedicatedCommandTool(tool: CodexTool): boolean {
  const normalized = gatewayNestedToolName(tool.name);
  return normalized === "exec"
    || normalized === "exec_command"
    || normalized === "shell_command"
    || normalized === "wait"
    || normalized === "write_stdin";
}

function isAgentWaitTool(tool: CodexTool): boolean {
  return tool.name === "wait_agent"
    && (tool.namespace === "multi_agent_v1" || tool.namespace === "multi_agent_v2");
}

function browserToolDescription(tool: CodexTool): string {
  if (!isAgentWaitTool(tool)) return tool.description;
  return `${tool.description}\n\nChatGPT Web transport rule: wait for exactly 10 seconds per call, then release the MCP channel so spawned Web agents can use their own tools. Repeat with the same target ids until a terminal status is returned.`;
}

function browserToolParameters(tool: CodexTool): Record<string, unknown> {
  if (!isAgentWaitTool(tool)) return tool.parameters;
  const parameters = structuredClone(tool.parameters);
  const properties = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, unknown>
    : {};
  const timeout = properties.timeout_ms && typeof properties.timeout_ms === "object" && !Array.isArray(properties.timeout_ms)
    ? properties.timeout_ms as Record<string, unknown>
    : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...parameters,
    properties: {
      ...properties,
      timeout_ms: {
        ...timeout,
        type: "number",
        const: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        minimum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        maximum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        description: "Required transport-safe polling interval. Use exactly 10000 and repeat the same targets until completion.",
      },
    },
    required: [...new Set([...required, "timeout_ms"])],
  };
}

function assertBrowserToolArguments(tool: CodexTool, args: Record<string, unknown>): void {
  if (!isAgentWaitTool(tool)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

function invocationTimeout(environment: ChatGptTurnEnvironment & { expiresAt?: number }): number | null {
  return environment.expiresAt === undefined ? null : Math.max(1, environment.expiresAt - Date.now());
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: value._meta as Record<string, unknown> }
      : {}),
  };
}

function asMcpError(value: BrokerToolResult) {
  return asMcpResult({ ...value, isError: true });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function schemaAllowsLiteral(schema: unknown, literal: string): boolean {
  const value = record(schema);
  if (!value) return false;
  if (value.const === literal) return true;
  if (Array.isArray(value.enum) && value.enum.includes(literal)) return true;
  return [value.anyOf, value.oneOf]
    .filter(Array.isArray)
    .some(branches => branches.some(branch => schemaAllowsLiteral(branch, literal)));
}

function schemaAllowsString(schema: unknown): boolean {
  const value = record(schema);
  if (!value) return false;
  if (value.type === "string") return true;
  return [value.anyOf, value.oneOf]
    .filter(Array.isArray)
    .some(branches => branches.some(branch => schemaAllowsString(branch)));
}

function directExecSupportsEscalation(tool: CodexTool): boolean {
  if (tool.name !== "exec_command" || tool.freeform) return false;
  const properties = record(record(tool.parameters)?.properties);
  return schemaAllowsLiteral(properties?.sandbox_permissions, "require_escalated")
    && schemaAllowsString(properties?.justification);
}

function contentText(value: BrokerToolResult): string | undefined {
  if (!Array.isArray(value.content) || value.content.length !== 1) return undefined;
  const content = record(value.content[0]);
  return content?.type === "text" && typeof content.text === "string" ? content.text : undefined;
}

type CommandFailureKind = "denial" | "failure" | "cancellation";
type GatewayExecResultState =
  | { kind: "pending"; cellId: string }
  | { kind: "session"; sessionId: number }
  | { kind: "success"; cellId?: string }
  | { kind: CommandFailureKind; cellId?: string }
  | { kind: "unknown" };

function validCellId(value: unknown): value is string {
  return typeof value === "string" && /^[^\s\x00-\x1f\x7f]{1,256}$/.test(value);
}

function failureKind(state: unknown): CommandFailureKind | undefined {
  if (state === "denied" || state === "rejected") return "denial";
  if (state === "failed" || state === "failure" || state === "error") return "failure";
  if (state === "terminated" || state === "cancelled" || state === "canceled") return "cancellation";
  return undefined;
}

type DirectCommandResultState = GatewayExecResultState;

function directCommandResultState(value: BrokerToolResult): DirectCommandResultState {
  const state = gatewayExecResultState(value);
  return state.kind === "pending" ? { kind: "unknown" } : state;
}

function structuredGatewayState(structured: Record<string, unknown>): GatewayExecResultState {
  const status = structured.status;
  const state = structured.state;
  if ((status !== undefined && typeof status !== "string")
    || (state !== undefined && typeof state !== "string")
    || (status !== undefined && state !== undefined && status !== state)) {
    return { kind: "unknown" };
  }
  if (Object.hasOwn(structured, "cellId") || Object.hasOwn(structured, "cell")) {
    return { kind: "unknown" };
  }
  const terminalState = status ?? state;
  const cellId = structured.cell_id;
  if (cellId !== undefined && !validCellId(cellId)) return { kind: "unknown" };
  const hasSessionId = structured.session_id !== undefined;
  if (terminalState === undefined && structured.exit_code === undefined && structured.session_id !== undefined) {
    return cellId === undefined
      && typeof structured.session_id === "number"
      && Number.isSafeInteger(structured.session_id)
      && structured.session_id >= 0
      ? { kind: "session", sessionId: structured.session_id }
      : { kind: "unknown" };
  }
  if (terminalState === "pending" || terminalState === "running") {
    if (structured.exit_code !== undefined || hasSessionId || !validCellId(cellId)) return { kind: "unknown" };
    return { kind: "pending", cellId };
  }
  if (terminalState === "completed" || terminalState === "success") {
    if (hasSessionId || (structured.exit_code !== undefined && structured.exit_code !== 0)) return { kind: "unknown" };
    return { kind: "success", ...(cellId ? { cellId } : {}) };
  }
  const failed = failureKind(terminalState);
  if (failed) {
    if (hasSessionId || structured.exit_code === 0) return { kind: "unknown" };
    return { kind: failed, ...(cellId ? { cellId } : {}) };
  }
  if (terminalState !== undefined) return { kind: "unknown" };
  if (typeof structured.exit_code === "number" && Number.isInteger(structured.exit_code)) {
    if (hasSessionId) return { kind: "unknown" };
    return structured.exit_code === 0
      ? { kind: "success", ...(cellId ? { cellId } : {}) }
      : { kind: "failure", ...(cellId ? { cellId } : {}) };
  }
  return { kind: "unknown" };
}

function taggedGatewayState(value: unknown): GatewayExecResultState {
  const envelope = record(value);
  if (!envelope
    || envelope.protocol !== GATEWAY_COMMAND_RESULT_PROTOCOL
    || Object.keys(envelope).sort().join(",") !== "protocol,result") {
    return { kind: "unknown" };
  }
  const nestedResult = record(envelope.result);
  if (!nestedResult) return { kind: "unknown" };
  if (Array.isArray(nestedResult.content)) {
    return gatewayExecResultState(nestedResult as unknown as BrokerToolResult);
  }
  return structuredGatewayState(nestedResult);
}

function textGatewayState(text: string): GatewayExecResultState {
  const pending = PENDING_CELL_TEXT.exec(text);
  if (pending && validCellId(pending[1])) return { kind: "pending", cellId: pending[1] };
  const completedOutput = (TERMINAL_OUTPUT_TEXT.exec(text)?.[1]
    ?? TERMINAL_FINAL_OUTPUT_TEXT.exec(text)?.[1])?.trim();
  if (completedOutput) {
    try {
      const nested: unknown = JSON.parse(completedOutput);
      return taggedGatewayState(nested);
    } catch {
      return { kind: "unknown" };
    }
    return { kind: "unknown" };
  }
  const terminal = TERMINAL_FAILURE_TEXT.exec(text)?.[1];
  if (terminal === "Script failed") return { kind: "failure" };
  if (terminal === "Script terminated") return { kind: "cancellation" };
  return { kind: "unknown" };
}

function gatewayStatesConflict(
  structured: GatewayExecResultState,
  textual: GatewayExecResultState,
): boolean {
  if (textual.kind === "unknown") return false;
  if (structured.kind !== textual.kind) return true;
  if (structured.kind === "session" && textual.kind === "session") {
    return structured.sessionId !== textual.sessionId;
  }
  const structuredCellId = "cellId" in structured ? structured.cellId : undefined;
  const textualCellId = "cellId" in textual ? textual.cellId : undefined;
  if (structuredCellId || textualCellId) return structuredCellId !== textualCellId;
  return false;
}

function gatewayExecResultState(value: BrokerToolResult): GatewayExecResultState {
  if (!record(value) || !Array.isArray(value.content)) return { kind: "unknown" };
  let state: GatewayExecResultState;
  if (value.structuredContent !== undefined) {
    const structured = record(value.structuredContent);
    if (!structured) return { kind: "unknown" };
    state = structuredGatewayState(structured);
    const text = contentText(value);
    if (text !== undefined && gatewayStatesConflict(state, textGatewayState(text))) {
      return { kind: "unknown" };
    }
  } else {
    const text = contentText(value);
    if (text === undefined) return { kind: "unknown" };
    state = textGatewayState(text);
  }
  return value.isError === true
    && state.kind !== "denial"
    && state.kind !== "failure"
    && state.kind !== "cancellation"
    ? { kind: "unknown" }
    : state;
}

function outerGatewayExecResultState(value: BrokerToolResult): GatewayExecResultState {
  if (!record(value) || !Array.isArray(value.content)) return { kind: "unknown" };
  let state: GatewayExecResultState;
  if (value.structuredContent !== undefined) {
    state = taggedGatewayState(value.structuredContent);
    const text = contentText(value);
    if (text !== undefined && gatewayStatesConflict(state, textGatewayState(text))) {
      return { kind: "unknown" };
    }
  } else {
    const text = contentText(value);
    if (text === undefined) return { kind: "unknown" };
    // A bare wrapper failure proves only that the outer Code Mode program stopped. The nested OS
    // command may already have been dispatched and can still be running, so only a tagged nested
    // result may supply terminal evidence for failure or cancellation.
    state = TERMINAL_FAILURE_TEXT.test(text) ? { kind: "unknown" } : textGatewayState(text);
  }
  return value.isError === true
    && state.kind !== "denial"
    && state.kind !== "failure"
    && state.kind !== "cancellation"
    ? { kind: "unknown" }
    : state;
}

function commandLifecycleError(message: string) {
  return result({ error: message }, true);
}

function withContinuationToken(value: BrokerToolResult, continuationToken: string): McpExecResult {
  const structured = record(value.structuredContent);
  if (!structured) {
    return commandLifecycleError(`The native command session omitted its structured result. ${UNRESOLVED_UNKNOWN_OUTCOME}`);
  }
  const augmented = { ...structured, continuation_token: continuationToken };
  return asMcpResult({
    ...value,
    structuredContent: augmented,
    content: [{ type: "text", text: JSON.stringify(augmented) }],
  });
}

function refreshContinuationToken(value: McpExecResult, continuationToken: string): McpExecResult {
  const structured = record(value.structuredContent);
  if (!structured) return value;
  const augmented = { ...structured, continuation_token: continuationToken };
  return {
    ...value,
    structuredContent: augmented,
    content: [{ type: "text", text: JSON.stringify(augmented) }],
  };
}

type McpExecResult = ReturnType<typeof asMcpResult> | ReturnType<typeof commandLifecycleError>;
interface McpExecOutcome {
  response: McpExecResult;
  terminalEvidence: boolean;
  sessionId?: number;
  continuationToken?: string;
}

interface BrokerOperationIdentity {
  operationKey: string;
  operationRequestKey: string;
}

function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
}

function directCommandTool(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  const candidates = [exactTool(environment, "exec_command"), exactTool(environment, "shell_command")]
    .filter((tool): tool is CodexTool => Boolean(tool));
  if (candidates.length > 1) throw new Error("This Codex turn advertised multiple native command tools");
  return candidates[0];
}

function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

function execGatewayResultProgram(invocation: string[]): string {
  return [
    ...invocation,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
): string {
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return execGatewayResultProgram([
    `const result = await tools[${JSON.stringify(gatewayNestedToolName(nestedToolName))}](${JSON.stringify(nestedInput)});`,
  ]);
}

function execCommandGatewayProgram(
  execCommandArguments: Record<string, unknown>,
  shellCommandArguments: Record<string, unknown>,
  escalationRequested = false,
): string {
  const execCommandName = gatewayNestedToolName("exec_command");
  const shellCommandName = gatewayNestedToolName("shell_command");
  return [
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native command tool registry is unavailable\");",
    "const nativeCommandNames = ALL_TOOLS.map(tool => tool?.name);",
    "const normalizeNativeCommandName = name => String(name).replace(/[^A-Za-z0-9_$]/g, \"_\");",
    `const nativeCommandCandidates = nativeCommandNames.filter(name => ${JSON.stringify(escalationRequested ? [execCommandName] : [execCommandName, shellCommandName])}.includes(normalizeNativeCommandName(name)));`,
    "if (nativeCommandCandidates.length !== 1) throw new Error(\"Expected exactly one native command tool; found \" + (nativeCommandCandidates.join(\", \") || \"none\"));",
    "const nativeCommandName = nativeCommandCandidates[0];",
    "if (nativeCommandName !== normalizeNativeCommandName(nativeCommandName)) throw new Error(\"Native command tool name is non-canonical: \" + nativeCommandName);",
    ...(escalationRequested ? [
      "const nativeCommandEntry = ALL_TOOLS.find(tool => tool?.name === nativeCommandName);",
      "const nativeCommandSchema = nativeCommandEntry?.description;",
      "const sandboxPermissionsSchema = /sandbox_permissions\\?\\s*:\\s*(?:\\\"use_default\\\"\\s*\\|\\s*)?\\\"require_escalated\\\"(?:\\s*\\|\\s*\\\"use_default\\\")?\\s*;/.test(nativeCommandSchema ?? \"\");",
      "const justificationSchema = /justification\\?\\s*:\\s*string\\s*;/.test(nativeCommandSchema ?? \"\");",
      "if (!sandboxPermissionsSchema || !justificationSchema) throw new Error(\"Native exec_command escalation ABI is unavailable\");",
    ] : []),
    "const nativeCommand = tools[nativeCommandName];",
    "if (typeof nativeCommand !== \"function\") throw new Error(\"Native command tool \" + nativeCommandName + \" is listed but unavailable\");",
    `const nativeCommandInput = nativeCommandName === ${JSON.stringify(execCommandName)} ? ${JSON.stringify(execCommandArguments)} : ${JSON.stringify(shellCommandArguments)};`,
    "const result = await nativeCommand(nativeCommandInput);",
    `text({ protocol: ${JSON.stringify(GATEWAY_COMMAND_RESULT_PROTOCOL)}, result });`,
  ].join("\n");
}

export async function runChatGptMcpServer(options: { brokerSocketPath: string }): Promise<void> {
  const server = new McpServer({ name: "codex-native", version: "4.0.0" });
  type ActiveExecOperation = {
    operationKey: string;
    requestKey: string;
    promise: Promise<McpExecResult>;
    sessionId?: number;
    continuationToken?: string;
    bindingId?: string;
    continuation?: { requestKey: string; promise: Promise<McpExecResult> };
    published: boolean;
  };
  const activeExecOperations = new Map<string, ActiveExecOperation>();
  const terminalizedExecRequests = new Set<string>();
  const commandOperationKey = brokerInvocationKey("codex_exec_global_operation", {
    brokerSocketPath: options.brokerSocketPath,
  });

  const claimTurn = async (
    toolName: string,
    turnToken: string,
    extra: Parameters<typeof requestScopeSummary>[0] & { signal: AbortSignal },
  ): Promise<ClaimedTurn> => {
    console.error(`[chatgpt-web-mcp] ${toolName} scope=${requestScopeSummary(extra)}`);
    return await callTurnBroker<ClaimedTurn>(
      options.brokerSocketPath,
      { method: "claim", token: turnToken },
      undefined,
      extra.signal,
    );
  };

  const invokeBroker = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    invocationKey: string,
    timeout: number | null = invocationTimeout(bound),
    signal?: AbortSignal,
    operationIdentity?: BrokerOperationIdentity,
    continuationToken?: string,
  ) => callTurnBroker<BrokerToolResult>(options.brokerSocketPath, {
      method: "invoke",
      bindingId,
      invocationKey,
      wireName: wireName(tool),
      freeform: tool.freeform === true,
      ...operationIdentity,
      ...(continuationToken ? { continuationToken } : {}),
      ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
    }, timeout, signal);

  const brokerContinuationToken = async (
    method: "continuation" | "advance_continuation",
    bindingId: string,
    operationIdentity: BrokerOperationIdentity,
    currentToken?: string,
    invocationKey?: string,
  ): Promise<string> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await callTurnBroker<{ continuationToken: string }>(options.brokerSocketPath, {
          method,
          bindingId,
          ...operationIdentity,
          ...(currentToken ? { continuationToken: currentToken } : {}),
          ...(invocationKey ? { invocationKey } : {}),
        });
        if (!/^[A-Za-z0-9_-]{20,256}$/.test(response.continuationToken)) {
          throw new Error("Codex command broker returned an invalid continuation token");
        }
        return response.continuationToken;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  const invoke = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    invocationKey: string,
    signal?: AbortSignal,
  ) => asMcpResult(await invokeBroker(bindingId, bound, tool, payload, invocationKey, invocationTimeout(bound), signal));

  const terminalizeExecOperation = async (
    bindingId: string,
    operationIdentity: BrokerOperationIdentity,
  ): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const terminalized = await callTurnBroker<{ terminalized: boolean; pending: boolean }>(
          options.brokerSocketPath,
          { method: "terminalize", bindingId, ...operationIdentity },
        );
        if (!terminalized.terminalized || terminalized.pending) {
          throw new Error("Codex command operation could not be safely terminalized");
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = error;
      }
    }
    throw lastError;
  };

  const execOperationStatus = (
    bindingId: string,
    operationIdentity: BrokerOperationIdentity,
  ) => callTurnBroker<{ terminalized: boolean; active: boolean }>(options.brokerSocketPath, {
    method: "operation_status",
    bindingId,
    ...operationIdentity,
  });

  const reconcileActiveExecOperation = async (
    active: ActiveExecOperation,
  ): Promise<"active" | "terminalized" | "unknown"> => {
    if (!active.bindingId) return "active";
    const operationIdentity = {
      operationKey: active.operationKey,
      operationRequestKey: active.requestKey,
    };
    let status: { terminalized: boolean; active: boolean };
    try {
      status = await execOperationStatus(active.bindingId, operationIdentity);
    } catch {
      return "unknown";
    }
    if (status.terminalized) {
      terminalizedExecRequests.add(active.requestKey);
      if (activeExecOperations.get(active.operationKey) === active) {
        activeExecOperations.delete(active.operationKey);
      }
      return "terminalized";
    }
    if (!status.active) return "unknown";
    if (active.sessionId !== undefined && active.continuationToken) {
      try {
        active.continuationToken = await brokerContinuationToken(
          "continuation",
          active.bindingId,
          operationIdentity,
        );
      } catch {
        try {
          status = await execOperationStatus(active.bindingId, operationIdentity);
        } catch {
          return "unknown";
        }
        if (status.terminalized) {
          terminalizedExecRequests.add(active.requestKey);
          if (activeExecOperations.get(active.operationKey) === active) {
            activeExecOperations.delete(active.operationKey);
          }
          return "terminalized";
        }
        return "unknown";
      }
    }
    return "active";
  };

  const invokeNestedNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
    invocationKey: string,
    signal?: AbortSignal,
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This Codex turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    return invoke(bindingId, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload),
    }, invocationKey, signal);
  };

  const awaitGatewayExec = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    initial: BrokerToolResult,
    originalInvocationKey: string,
    operationIdentity: BrokerOperationIdentity,
    signal?: AbortSignal,
  ): Promise<McpExecOutcome> => {
    const initialState = outerGatewayExecResultState(initial);
    if (initialState.kind === "success") {
      return { response: asMcpResult(initial), terminalEvidence: true };
    }
    if (initialState.kind === "denial" || initialState.kind === "failure" || initialState.kind === "cancellation") {
      return { response: asMcpError(initial), terminalEvidence: true };
    }
    if (initialState.kind === "session") {
      return {
        response: commandLifecycleError("The outer exec gateway returned a live native session that cannot be continued safely"),
        terminalEvidence: false,
      };
    }
    if (initialState.kind !== "pending") {
      return {
        response: commandLifecycleError(
          `The initial outer exec returned an unknown command state. ${UNRESOLVED_UNKNOWN_OUTCOME}`,
        ),
        terminalEvidence: false,
      };
    }

    const waitTool = exactTool(bound, "wait");
    if (!waitTool || waitTool.freeform) {
      return {
        response: commandLifecycleError(`Codex command is pending, but the outer wait tool is unavailable. ${UNRESOLVED_UNKNOWN_OUTCOME}`),
        terminalEvidence: false,
      };
    }
    if (signal?.aborted) {
      return {
        response: commandLifecycleError(`Waiting for the pending Codex command was aborted. ${UNRESOLVED_UNKNOWN_OUTCOME}`),
        terminalEvidence: false,
      };
    }

    let waited: BrokerToolResult;
    try {
      waited = await invokeBroker(
        bindingId,
        bound,
        waitTool,
        { arguments: { cell_id: initialState.cellId } },
        brokerInvocationKey("codex_exec_wait", { originalInvocationKey, cellId: initialState.cellId }),
        null,
        signal,
        operationIdentity,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        response: commandLifecycleError(`${
          signal?.aborted || (error instanceof DOMException && error.name === "AbortError")
            ? "Waiting for the pending Codex command was aborted"
            : `The outer wait tool failed before returning a terminal result: ${message}`
        }. ${UNRESOLVED_UNKNOWN_OUTCOME}`),
        terminalEvidence: false,
      };
    }

    const waitedState = outerGatewayExecResultState(waited);
    if (waitedState.kind === "pending") {
      if (waitedState.cellId !== initialState.cellId) {
        return {
          response: commandLifecycleError(`The outer wait tool returned a different pending command handle. ${UNRESOLVED_UNKNOWN_OUTCOME}`),
          terminalEvidence: false,
        };
      }
      return {
        response: commandLifecycleError(`The outer wait tool did not return a terminal command state. ${UNRESOLVED_UNKNOWN_OUTCOME}`),
        terminalEvidence: false,
      };
    }
    if ("cellId" in waitedState && waitedState.cellId && waitedState.cellId !== initialState.cellId) {
      return {
        response: commandLifecycleError(`The outer wait tool returned a different command handle. ${UNRESOLVED_UNKNOWN_OUTCOME}`),
        terminalEvidence: false,
      };
    }
    if (waitedState.kind === "success") {
      return { response: asMcpResult(waited), terminalEvidence: true };
    }
    if (waitedState.kind === "denial" || waitedState.kind === "failure" || waitedState.kind === "cancellation") {
      return { response: asMcpError(waited), terminalEvidence: true };
    }
    if (waitedState.kind === "session") {
      return {
        response: commandLifecycleError("The outer wait tool returned a live native session that cannot be continued safely"),
        terminalEvidence: false,
      };
    }
    return {
      response: commandLifecycleError(
        `The outer wait tool returned an unknown command state. ${UNRESOLVED_UNKNOWN_OUTCOME}`,
      ),
      terminalEvidence: false,
    };
  };

  server.registerTool(
    "codex_exec",
    {
      title: "Run a native Codex command",
      description: "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id.",
      inputSchema: {
        turn_token: turnTokenSchema,
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
        sandbox_permissions: escalationSandboxPermissionsSchema.optional(),
        justification: escalationJustificationSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ turn_token, cmd, workdir, yield_time_ms, max_output_tokens, tty, sandbox_permissions, justification }, extra) => observeCommandInvocation("codex_exec", extra, async () => {
      const escalationRequested = sandbox_permissions === "require_escalated";
      if (escalationRequested && (!justification || justification.trim().length === 0)) {
        throw new Error("codex_exec require_escalated requires a non-empty justification");
      }
      if (!escalationRequested && justification !== undefined) {
        throw new Error("codex_exec justification is only valid with sandbox_permissions=require_escalated");
      }
      const execCommandArguments = {
        cmd,
        ...(workdir ? { workdir } : {}),
        ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
        ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
        ...(tty !== undefined ? { tty } : {}),
        ...(escalationRequested ? { sandbox_permissions, justification } : {}),
      };
      const shellCommandArguments = {
        command: cmd,
        ...(workdir ? { workdir } : {}),
        ...(yield_time_ms !== undefined ? { timeout_ms: yield_time_ms } : {}),
      };
      const operationKey = commandOperationKey;
      const requestKey = brokerInvocationKey("codex_exec_request", {
        turnToken: turn_token,
        arguments: execCommandArguments,
      });
      if (terminalizedExecRequests.has(requestKey)) {
        return commandLifecycleError("This codex_exec request has already been terminalized and cannot be retried");
      }
      let active = activeExecOperations.get(operationKey);
      while (active) {
        if (active.requestKey === requestKey) {
          const joinedBeforePublication = !active.published;
          const response = await active.promise;
          if (joinedBeforePublication) return response;
          const reconciliation = await reconcileActiveExecOperation(active);
          if (reconciliation === "terminalized") {
            return commandLifecycleError("This codex_exec request has already been terminalized and cannot be retried");
          }
          if (reconciliation === "unknown") {
            return commandLifecycleError(
              `The active native command could not be reconciled with the broker. ${UNRESOLVED_UNKNOWN_OUTCOME}`,
            );
          }
          return active.continuationToken
            ? refreshContinuationToken(response, active.continuationToken)
            : response;
        }
        if (!active.published) {
          return commandLifecycleError("A codex_exec operation is already active under a different request identity");
        }
        const reconciliation = await reconcileActiveExecOperation(active);
        if (reconciliation === "terminalized") {
          const replacement = activeExecOperations.get(operationKey);
          if (replacement && replacement !== active) {
            active = replacement;
            continue;
          }
          break;
        } else if (reconciliation === "unknown") {
          return commandLifecycleError(
            `The active native command could not be reconciled with the broker. ${UNRESOLVED_UNKNOWN_OUTCOME}`,
          );
        } else {
          return commandLifecycleError("A codex_exec operation is already active under a different request identity");
        }
      }

      let dispatchAttempted = false;
      let activeEntry!: ActiveExecOperation;
      const operation = (async (): Promise<McpExecOutcome> => {
        const claimed = await claimTurn("codex_exec", turn_token, extra);
        activeEntry.bindingId = claimed.bindingId;
        const bound = claimed.environment;
        const tool = directCommandTool(bound);
        const operationIdentity = { operationKey, operationRequestKey: requestKey };
        // A stable turn+argument identity makes transport loss and MCP restarts replay the broker's
        // original promise/result instead of enqueueing the command a second time.
        const originalInvocationKey = brokerInvocationKey("codex_exec", operationIdentity);
        if (tool) {
          if (escalationRequested && !directExecSupportsEscalation(tool)) {
            throw new Error("The advertised native command tool does not expose the formal exec_command escalation ABI");
          }
          const args = tool.name === "exec_command" ? execCommandArguments : shellCommandArguments;
          dispatchAttempted = true;
          const direct = await invokeBroker(
            claimed.bindingId,
            bound,
            tool,
            { arguments: args },
            originalInvocationKey,
            invocationTimeout(bound),
            undefined,
            operationIdentity,
          );
          const directState = directCommandResultState(direct);
          if (directState.kind === "session") {
            const issuedToken = await brokerContinuationToken(
              "continuation",
              claimed.bindingId,
              operationIdentity,
            );
            return {
              response: withContinuationToken(direct, issuedToken),
              terminalEvidence: false,
              sessionId: directState.sessionId,
              continuationToken: issuedToken,
            };
          }
          if (directState.kind === "success") {
            return { response: asMcpResult(direct), terminalEvidence: true };
          }
          if (directState.kind === "denial" || directState.kind === "failure" || directState.kind === "cancellation") {
            return { response: asMcpError(direct), terminalEvidence: true };
          }
          return {
            response: commandLifecycleError(`The native exec returned an unknown command state. ${UNRESOLVED_UNKNOWN_OUTCOME}`),
            terminalEvidence: false,
          };
        }
        const gateway = execGateway(bound);
        if (!gateway) {
          throw new Error("This Codex turn did not advertise a native command tool or the native exec gateway");
        }
        dispatchAttempted = true;
        const gatewayResult = await invokeBroker(claimed.bindingId, bound, gateway, {
          input: execCommandGatewayProgram(execCommandArguments, shellCommandArguments, escalationRequested),
        }, originalInvocationKey, invocationTimeout(bound), undefined, operationIdentity);
        const outcome = await awaitGatewayExec(
          claimed.bindingId,
          bound,
          gatewayResult,
          originalInvocationKey,
          operationIdentity,
          undefined,
        );
        return outcome;
      })();
      const publishedResponse = (async (): Promise<McpExecResult> => {
        try {
          const outcome = await operation;
          if (outcome.sessionId !== undefined && outcome.continuationToken) {
            activeEntry.sessionId = outcome.sessionId;
            activeEntry.continuationToken = outcome.continuationToken;
          } else if (outcome.terminalEvidence) {
            await terminalizeExecOperation(activeEntry.bindingId!, { operationKey, operationRequestKey: requestKey });
            terminalizedExecRequests.add(requestKey);
            if (activeExecOperations.get(operationKey) === activeEntry) {
              activeExecOperations.delete(operationKey);
            }
          }
          return outcome.response;
        } catch (error) {
          if (dispatchAttempted) {
            if (activeEntry.bindingId) {
              try {
                const status = await execOperationStatus(activeEntry.bindingId, {
                  operationKey,
                  operationRequestKey: requestKey,
                });
                if (status.terminalized) {
                  terminalizedExecRequests.add(requestKey);
                  if (activeExecOperations.get(operationKey) === activeEntry) {
                    activeExecOperations.delete(operationKey);
                  }
                  return commandLifecycleError("This codex_exec request has already been terminalized and cannot be retried");
                }
              } catch {
                // Without a trusted terminal receipt, preserve UNKNOWN quarantine below.
              }
            }
            return commandLifecycleError(
              `The native command transport ended without terminal evidence. ${UNRESOLVED_UNKNOWN_OUTCOME}`,
            );
          }
          if (activeExecOperations.get(operationKey) === activeEntry) {
            activeExecOperations.delete(operationKey);
          }
          throw error;
        } finally {
          activeEntry.published = true;
        }
      })();
      activeEntry = {
        operationKey,
        requestKey,
        promise: publishedResponse,
        published: false,
      };
      activeExecOperations.set(operationKey, activeEntry);
      return await publishedResponse;
    }),
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a native Codex command session",
      description: "Write characters to, or poll, a session_id returned by codex_exec.",
      inputSchema: {
        turn_token: turnTokenSchema,
        session_id: z.number().int().nonnegative(),
        continuation_token: turnTokenSchema,
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ turn_token, session_id, continuation_token, chars, yield_time_ms, max_output_tokens }, extra) => observeCommandInvocation("codex_write_stdin", extra, async () => {
      const operationKey = commandOperationKey;
      const active = activeExecOperations.get(operationKey);
      if (!active || active.sessionId !== session_id) {
        return commandLifecycleError("codex_write_stdin does not match the active codex_exec session");
      }
      if (!active.continuationToken || active.continuationToken !== continuation_token) {
        return commandLifecycleError("codex_write_stdin continuation token is invalid or no longer current");
      }
      const payload = { arguments: {
        session_id,
        ...(chars !== undefined ? { chars } : {}),
        ...(yield_time_ms !== undefined ? { yield_time_ms } : {}),
        ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
      } };
      const requestKey = brokerInvocationKey("codex_write_stdin_request", {
        operationRequestKey: active.requestKey,
        continuationToken: continuation_token,
        arguments: payload.arguments,
      });
      if (active.continuation) {
        if (active.continuation.requestKey === requestKey) return await active.continuation.promise;
        return commandLifecycleError("A codex_write_stdin operation is already active under a different request identity");
      }
      let continuationResolved = false;
      const continuation = (async (): Promise<McpExecResult> => {
        const claimed = await claimTurn("codex_write_stdin", turn_token, extra);
        const bound = claimed.environment;
        const tool = exactTool(bound, "write_stdin");
        const operationIdentity = { operationKey, operationRequestKey: active.requestKey };
        if (!tool) {
          return commandLifecycleError("The active codex_exec session cannot be continued without the native write_stdin tool");
        }
        const invocationKey = brokerInvocationKey("codex_write_stdin", {
          operationRequestKey: active.requestKey,
          continuationToken: continuation_token,
        });
        const continued = await invokeBroker(
          claimed.bindingId,
          bound,
          tool,
          payload,
          invocationKey,
          invocationTimeout(bound),
          undefined,
          operationIdentity,
          continuation_token,
        );
        const continuedState = directCommandResultState(continued);
        if (continuedState.kind === "session" && continuedState.sessionId === session_id) {
          const nextToken = await brokerContinuationToken(
            "advance_continuation",
            claimed.bindingId,
            operationIdentity,
            continuation_token,
            invocationKey,
          );
          active.continuationToken = nextToken;
          continuationResolved = true;
          return withContinuationToken(continued, nextToken);
        }
        const terminal = continuedState.kind === "success"
          || continuedState.kind === "denial"
          || continuedState.kind === "failure"
          || continuedState.kind === "cancellation";
        const response = continuedState.kind === "success"
          ? asMcpResult(continued)
          : continuedState.kind === "denial" || continuedState.kind === "failure" || continuedState.kind === "cancellation"
            ? asMcpError(continued)
            : commandLifecycleError(`The native write_stdin returned an unknown command state. ${UNRESOLVED_UNKNOWN_OUTCOME}`);
        if (terminal) {
          await terminalizeExecOperation(claimed.bindingId, operationIdentity);
          terminalizedExecRequests.add(active.requestKey);
          if (activeExecOperations.get(operationKey) === active) activeExecOperations.delete(operationKey);
          continuationResolved = true;
        }
        return response;
      })();
      active.continuation = { requestKey, promise: continuation };
      try {
        return await continuation;
      } finally {
        if (continuationResolved && active.continuation?.promise === continuation) delete active.continuation;
      }
    }),
  );

  server.registerTool(
    "codex_apply_patch",
    {
      title: "Apply a native Codex patch",
      description: "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task.",
      inputSchema: { turn_token: turnTokenSchema, patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ turn_token, patch }, extra) => {
      const claimed = await claimTurn("codex_apply_patch", turn_token, extra);
      const bound = claimed.environment;
      const tool = exactTool(bound, "apply_patch");
      const invocationKey = brokerInvocationKey("codex_apply_patch", {
        requestId: String(extra.requestId),
        sessionId: extra.sessionId ?? null,
      });
      if (!tool) return invokeNestedNative(claimed.bindingId, bound, "apply_patch", true, { input: patch }, invocationKey, extra.signal);
      return tool.freeform
        ? invoke(claimed.bindingId, bound, tool, { input: patch }, invocationKey, extra.signal)
        : invoke(claimed.bindingId, bound, tool, { arguments: { input: patch } }, invocationKey, extra.signal);
    },
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View an image through native Codex",
      description: "Invoke the outer Codex view_image tool and return its multimodal result to this same ChatGPT response.",
      inputSchema: {
        turn_token: turnTokenSchema,
        path: z.string().min(1).max(16_384),
        detail: z.enum(["high", "original"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ turn_token, path, detail }, extra) => {
      const claimed = await claimTurn("codex_view_image", turn_token, extra);
      const bound = claimed.environment;
      const tool = exactTool(bound, "view_image");
      const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
      const invocationKey = brokerInvocationKey("codex_view_image", {
        requestId: String(extra.requestId),
        sessionId: extra.sessionId ?? null,
      });
      return tool
        ? invoke(claimed.bindingId, bound, tool, payload, invocationKey, extra.signal)
        : invokeNestedNative(claimed.bindingId, bound, "view_image", false, payload, invocationKey, extra.signal);
    },
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "Discover tools from the current Codex harness",
      description: "Search the exact tool registry supplied to the current outer Codex turn, including configured MCP/app tools.",
      inputSchema: {
        turn_token: turnTokenSchema,
        query: z.string().max(500).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        include_schema: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ turn_token, query, offset, limit, include_schema }, extra) => {
      const claimed = await claimTurn("codex_tool_inventory", turn_token, extra);
      const bound = claimed.environment;
      const needle = query?.trim().toLowerCase();
      const matches = bound.tools.filter(tool => !needle || [
        wireName(tool),
        tool.name,
        tool.namespace ?? "",
        tool.description,
      ].join("\n").toLowerCase().includes(needle));
      const page = matches.slice(offset, offset + limit).map(tool => ({
        wire_name: wireName(tool),
        name: tool.name,
        namespace: tool.namespace ?? null,
        description: browserToolDescription(tool),
        kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
        ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
      }));
      return result({
        tools: page,
        total: matches.length,
        next_offset: offset + page.length < matches.length ? offset + page.length : null,
      });
    },
  );

  server.registerTool(
    "codex_tool_call",
    {
      title: "Call any tool from the current Codex harness",
      description: "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle.",
      inputSchema: {
        turn_token: turnTokenSchema,
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
        input: z.string().max(5_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ turn_token, wire_name, arguments: args, input }, extra) => {
      const claimed = await claimTurn("codex_tool_call", turn_token, extra);
      const bound = claimed.environment;
      const tool = namedTool(bound, wire_name);
      if (isDedicatedCommandTool(tool)) {
        throw new Error(`Codex command tool ${wire_name} is reserved for codex_exec and codex_write_stdin`);
      }
      const invocationKey = brokerInvocationKey("codex_tool_call", {
        requestId: String(extra.requestId),
        sessionId: extra.sessionId ?? null,
      });
      if (tool.freeform) {
        if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
        if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
        return invoke(claimed.bindingId, bound, tool, { input }, invocationKey, extra.signal);
      }
      if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
      const invocationArguments = args ?? {};
      assertBrowserToolArguments(tool, invocationArguments);
      return invoke(claimed.bindingId, bound, tool, { arguments: invocationArguments }, invocationKey, extra.signal);
    },
  );

  await server.connect(new StdioServerTransport());
}
