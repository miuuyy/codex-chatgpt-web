import { createHash } from "node:crypto";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { namespacedToolName, type AdapterEvent, type CodexParsedRequest, type CodexTool, type CodexUsage } from "../../types";

export const BROWSER_RELAY_PROTOCOL = "codex-browser-relay/v1";
const MAX_RELAY_CALLS = 8;

export type BrowserRelayDecision =
  | { type: "final"; answer: string }
  | { type: "tool_calls"; calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> };

function relayTools(parsed: CodexParsedRequest): Map<string, CodexTool> {
  const tools = new Map<string, CodexTool>();
  for (const tool of parsed.context.tools ?? []) {
    const wireName = namespacedToolName(tool.namespace, tool.name);
    if (tools.has(wireName)) throw new Error(`Browser Relay has an ambiguous Codex tool: ${wireName}`);
    tools.set(wireName, tool);
  }
  return tools;
}

export function browserRelayPromptContract(parsed: CodexParsedRequest): string[] {
  const tools = [...relayTools(parsed)].map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: tool.parameters,
    ...(tool.freeform ? { freeform: true } : {}),
    ...(tool.toolSearch ? { tool_search: true } : {}),
  }));
  return [
    "Browser Relay is enabled for this Codex turn. Respond with exactly one JSON object. Do not wrap it in Markdown, explain the protocol, or call a ChatGPT plugin.",
    `For a final answer use {"protocol":"${BROWSER_RELAY_PROTOCOL}","type":"final","answer":"your complete answer"}.`,
    `To ask Codex to execute local tools use {"protocol":"${BROWSER_RELAY_PROTOCOL}","type":"tool_calls","calls":[{"name":"exact tool name","arguments":{}}]}.`,
    "Use only tools in the following catalog. Use the exact name and JSON arguments matching its schema. Freeform tools receive {\"input\":\"raw tool input\"}. Never invent a tool, tool result, or local observation.",
    "When tool results arrive in the next Codex context, use them to decide whether further tools are necessary. Tools execute in Codex under its normal sandbox and approvals.",
    "If the user requests local work and no suitable local tool is available, explain the limitation in a final answer. Never imply a tool was executed if the result is absent.",
    "Do not include tool-call instructions inside the answer field; only the tool_calls envelope authorizes local execution.",
    "<codex_browser_relay_tools_json>",
    JSON.stringify(tools),
    "</codex_browser_relay_tools_json>",
  ];
}

function envelopeText(answer: string): string {
  const trimmed = answer.trim();
  const fenced = /^\`\`\`(?:json)?\s*([\s\S]*?)\s*\`\`\`$/i.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseBrowserRelayDecision(answer: string, parsed: CodexParsedRequest): BrowserRelayDecision {
  let payload: unknown;
  try {
    payload = JSON.parse(envelopeText(answer));
  } catch {
    throw new Error("Browser Relay expected one complete JSON response; no tool was executed");
  }
  if (!isRecord(payload) || payload.protocol !== BROWSER_RELAY_PROTOCOL) {
    throw new Error("Browser Relay response has an invalid protocol; no tool was executed");
  }
  if (payload.type === "final") {
    if (typeof payload.answer !== "string") {
      throw new Error("Browser Relay final response must contain an answer string");
    }
    return { type: "final", answer: payload.answer };
  }
  if (payload.type !== "tool_calls" || !Array.isArray(payload.calls)
    || payload.calls.length < 1 || payload.calls.length > MAX_RELAY_CALLS) {
    throw new Error("Browser Relay response must contain a final answer or a bounded tool batch");
  }
  if (parsed.options.toolChoice === "none") {
    throw new Error("Browser Relay cannot invoke tools when Codex tool_choice is none");
  }
  if (parsed.options.parallelToolCalls === false && payload.calls.length > 1) {
    throw new Error("Browser Relay cannot issue parallel calls when Codex disabled them");
  }
  const catalog = relayTools(parsed);
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  const calls = payload.calls.map((entry: unknown, index: number) => {
    if (!isRecord(entry) || typeof entry.name !== "string" || !isRecord(entry.arguments)) {
      throw new Error(`Browser Relay call ${index + 1} has invalid name or arguments`);
    }
    const tool = catalog.get(entry.name);
    if (!tool) throw new Error(`Browser Relay requested an unavailable Codex tool: ${entry.name}`);
    if (tool.freeform && typeof entry.arguments.input !== "string") {
      throw new Error(`Browser Relay freeform tool ${entry.name} requires a string input`);
    }
    try {
      const validate = ajv.compile(tool.parameters);
      if (!validate(entry.arguments)) {
        throw new Error(ajv.errorsText(validate.errors));
      }
    } catch (error) {
      throw new Error(`Browser Relay arguments for ${entry.name} failed schema validation: ${error instanceof Error ? error.message : String(error)}`);
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([parsed.modelId, parsed.context.messages, answer, index]))
      .digest("hex").slice(0, 32);
    return { id: `call_${fingerprint}`, name: entry.name, arguments: entry.arguments };
  });
  return { type: "tool_calls", calls };
}

export function browserRelayEvents(decision: BrowserRelayDecision, usage: CodexUsage): AdapterEvent[] {
  if (decision.type === "final") {
    return [
      { type: "text_delta", text: decision.answer, phase: "final_answer" },
      { type: "done", stopReason: "stop", endTurn: true, usage },
    ];
  }
  const events: AdapterEvent[] = [];
  for (const call of decision.calls) {
    events.push({ type: "tool_call_start", id: call.id, name: call.name });
    events.push({ type: "tool_call_delta", arguments: JSON.stringify(call.arguments) });
    events.push({ type: "tool_call_end" });
  }
  events.push({ type: "done", stopReason: "tool_use", endTurn: false, usage });
  return events;
}
