import { namespacedToolName, type CodexTool } from "../types";

export const COPILOT_TOOL_OPEN = "<codex_tool_call>";
export const COPILOT_TOOL_CLOSE = "</codex_tool_call>";
export const COPILOT_TURN_MARKER_PREFIX = "[[codex-transport-turn:";
export const COPILOT_TURN_MARKER_SUFFIX = "]]";

export interface CopilotToolCall {
  name: string;
  arguments: Record<string, unknown>;
  raw: string;
}

export interface ParsedCopilotResponse {
  text: string;
  toolCalls: CopilotToolCall[];
}

export function copilotToolWireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolByName(tools: CodexTool[] | undefined, name: string): CodexTool | undefined {
  const exact = tools?.find(tool => copilotToolWireName(tool) === name);
  if (exact) return exact;
  // Accept a bare tool name when the namespace is unambiguous, then normalize the emitted call
  // back to the wire name so Codex's namespace routing still works.
  const bare = tools?.filter(tool => tool.name === name) ?? [];
  return bare.length === 1 ? bare[0] : undefined;
}

function availableToolNames(tools: CodexTool[] | undefined): string {
  const names = (tools ?? []).map(copilotToolWireName);
  return names.length > 0 ? names.join(", ") : "(none)";
}

export function copilotTurnMarker(turnId: string): string {
  return `${COPILOT_TURN_MARKER_PREFIX}${turnId}${COPILOT_TURN_MARKER_SUFFIX}`;
}

export function stripCopilotTurnMarker(text: string): string {
  return text
    .replace(/\[\[codex-transport-turn:[A-Za-z0-9_-]+\]\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function serializeToolCatalog(tools: CodexTool[] | undefined): string {
  if (!tools || tools.length === 0) return "[]";
  return JSON.stringify(tools.map(tool => ({
    name: copilotToolWireName(tool),
    kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
    description: tool.description,
    parameters: tool.parameters,
  })), null, 2);
}

export function buildToolProtocolInstructions(tools: CodexTool[] | undefined): string {
  if (!tools || tools.length === 0) {
    return [
      "<tool_protocol>",
      "No tools are available for this turn. Answer in plain Markdown and do not emit a tool-call block.",
      "</tool_protocol>",
    ].join("\n");
  }
  return [
    "<tool_protocol>",
    "You can ask me to run tools on this computer. These are the tools available for this turn. They are real; I will run them locally and send back the output.",
    "<tools_json>",
    serializeToolCatalog(tools),
    "</tools_json>",
    "If you need a tool, include one or more blocks in exactly this form:",
    `${COPILOT_TOOL_OPEN}{"name":"TOOL_NAME","arguments":{...}}${COPILOT_TOOL_CLOSE}`,
    "Rules:",
    "- Use the exact tool name from the catalog, including any namespace prefix such as `mcp__server__tool`.",
    "- `arguments` must be one JSON object that matches the tool's parameters.",
    "- For a freeform tool (kind `freeform`, for example `apply_patch`), pass the raw tool input as a string in `{\"input\":\"...\"}`.",
    "- Put each tool call in its own block. Put any short commentary before the blocks. Do not repeat a tool result that you have already received.",
    "- Wrap every tool-call block in a Markdown fenced code block. Use three backticks, or a longer fence when the tool input itself contains backticks. This chat renders Markdown; without a fence, characters such as backticks, asterisks, and angle brackets can be lost.",
    "- The block must be valid JSON: escape literal double quotes inside strings as \\\" and encode line breaks as \\n.",
    "- After emitting tool calls, stop and wait. I will run them and send the results in the next message.",
    "- If the latest request needs a tool that appears in this catalog, emit the block instead of saying the tool is unavailable.",
    "- If no tool is needed, answer normally and do not emit a tool-call block.",
    "</tool_protocol>",
  ].join("\n");
}

function stripCodeFencesAroundBlocks(text: string): string {
  return text.replace(
    /(?:`{3,}|~{3,})[A-Za-z0-9_-]*[ \t]*\r?\n?[ \t]*(<codex_tool_call>[\s\S]*?<\/codex_tool_call>)[ \t]*\r?\n?[ \t]*(?:`{3,}|~{3,})/g,
    "$1",
  );
}

function parseArguments(
  tool: CodexTool | undefined,
  raw: unknown,
  rawBlock: string,
): Record<string, unknown> {
  if (raw === undefined || raw === null) return tool?.freeform ? { input: "" } : {};
  if (typeof raw === "string") {
    if (tool?.freeform) return { input: raw };
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Fall through to the descriptive error below.
    }
    throw new Error(`Copilot tool call ${JSON.stringify(tool ? copilotToolWireName(tool) : "unknown")} has non-object arguments`);
  }
  if (!isRecord(raw)) {
    throw new Error(`Copilot tool call arguments must be a JSON object: ${rawBlock.slice(0, 200)}`);
  }
  if (tool?.freeform && typeof raw.input !== "string") {
    throw new Error(
      `Copilot freeform tool ${JSON.stringify(copilotToolWireName(tool))} must pass a string \`input\` argument`,
    );
  }
  return raw;
}

function parseBlock(
  block: string,
  tools: CodexTool[] | undefined,
): CopilotToolCall {
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    throw new Error(
      `Copilot emitted an invalid tool call (invalid JSON): ${block.slice(0, 300)}`
        + (error instanceof Error ? ` (${error.message})` : ""),
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`Copilot tool call must be a JSON object: ${block.slice(0, 300)}`);
  }
  const rawName = parsed.name ?? parsed.tool ?? parsed.tool_name;
  if (typeof rawName !== "string" || rawName.trim().length === 0) {
    throw new Error(`Copilot tool call is missing a tool name: ${block.slice(0, 300)}`);
  }
  const name = rawName.trim();
  const tool = toolByName(tools, name);
  if (!tool) {
    throw new Error(
      `Copilot called unknown tool ${JSON.stringify(name)}. Available tools: ${availableToolNames(tools)}`,
    );
  }
  const rawArguments = parsed.arguments ?? parsed.parameters ?? parsed.args ?? parsed.input;
  return {
    name: copilotToolWireName(tool),
    arguments: parseArguments(tool, rawArguments, block),
    raw: block,
  };
}

function parseJsonToolCalls(
  text: string,
  tools: CodexTool[] | undefined,
): CopilotToolCall[] | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const entries = Array.isArray(parsed.tool_calls)
    ? parsed.tool_calls
    : Array.isArray(parsed.toolCalls)
      ? parsed.toolCalls
      : typeof parsed.name === "string" && (parsed.arguments !== undefined || parsed.parameters !== undefined)
        ? [parsed]
        : undefined;
  if (!entries) return undefined;
  const calls: CopilotToolCall[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) return undefined;
    const name = entry.name ?? entry.tool ?? entry.tool_name;
    if (typeof name !== "string" || !toolByName(tools, name.trim())) return undefined;
    const rawArguments = entry.arguments ?? entry.parameters ?? entry.args ?? entry.input;
    const tool = toolByName(tools, name.trim());
    calls.push({
      name: copilotToolWireName(tool!),
      arguments: parseArguments(tool, rawArguments, JSON.stringify(entry)),
      raw: JSON.stringify(entry),
    });
  }
  return calls.length > 0 ? calls : undefined;
}

/**
 * Parse a Copilot answer into prose and Codex tool calls.
 *
 * The text protocol is deliberately strict: an unknown tool name or malformed block is an
 * adapter error rather than silently becoming prose, so Codex can retry instead of losing an
 * action.
 */
export function parseCopilotResponse(
  value: string,
  tools: CodexTool[] | undefined,
  options: { allowTools?: boolean } = {},
): ParsedCopilotResponse {
  const allowTools = options.allowTools !== false && Boolean(tools?.length);
  const text = stripCodeFencesAroundBlocks(stripCopilotTurnMarker(value));
  if (!allowTools) {
    const withoutBlocks = text.replace(
      /<codex_tool_call>[\s\S]*?<\/codex_tool_call>/g,
      "",
    );
    return { text: stripCopilotTurnMarker(withoutBlocks).trim(), toolCalls: [] };
  }

  const calls: CopilotToolCall[] = [];
  let output = "";
  let cursor = 0;
  for (;;) {
    const open = text.indexOf(COPILOT_TOOL_OPEN, cursor);
    if (open < 0) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, open);
    const close = text.indexOf(COPILOT_TOOL_CLOSE, open + COPILOT_TOOL_OPEN.length);
    if (close < 0) {
      throw new Error(
        "Copilot response contains an unterminated <codex_tool_call> block. "
          + "The turn was stopped before any tool was executed.",
      );
    }
    const block = text.slice(open + COPILOT_TOOL_OPEN.length, close).trim();
    calls.push(parseBlock(block, tools));
    cursor = close + COPILOT_TOOL_CLOSE.length;
  }

  if (calls.length === 0) {
    const jsonCalls = parseJsonToolCalls(text, tools);
    if (jsonCalls) return { text: "", toolCalls: jsonCalls };
  }

  return {
    text: stripCopilotTurnMarker(output).replace(/\n{3,}/g, "\n\n").trim(),
    toolCalls: calls,
  };
}
