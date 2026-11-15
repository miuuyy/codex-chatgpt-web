import { expect, test } from "bun:test";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { parseRequest } from "../src/responses/parser";
import {
  BROWSER_RELAY_PROTOCOL,
  browserRelayEvents,
  browserRelayPromptContract,
  parseBrowserRelayDecision,
} from "../src/adapters/chatgpt-web/browser-relay";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { AdapterEvent, CodexParsedRequest } from "../src/types";

function request(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    options: { reasoning: "high" },
    context: {
      systemPrompt: ["Respect task priorities"],
      messages: [{ role: "user", content: "Inspect the project", timestamp: 1 }],
      tools: [
        { name: "exec_command", description: "Execute a command through Codex", parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
          additionalProperties: false,
        } },
        { name: "apply_patch", description: "Apply a patch", freeform: true, parameters: {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        } },
        { name: "lookup", namespace: "mcp__docs", description: "Read docs", parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        } },
      ],
    },
  };
}
const envelope = (type: string, data: Record<string, unknown>) =>
  JSON.stringify({ protocol: BROWSER_RELAY_PROTOCOL, type, ...data });
const toolAnswer = (calls: unknown[]) => envelope("tool_calls", { calls });
const capabilities = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
const usage = { inputTokens: 25, outputTokens: 12 };

test("relay prompts describe the exact available tools, never a plugin capability", () => {
  const parsed = request();
  const prompt = compileChatGptWebPrompt(parsed, capabilities, undefined, { browserRelay: true });
  expect(prompt.text).toContain(BROWSER_RELAY_PROTOCOL);
  expect(prompt.text).toContain("exec_command");
  expect(prompt.text).toContain("mcp__docs__lookup");
  expect(prompt.text).not.toContain("no local Codex bridge attached");
  expect(prompt.text).not.toContain("Pass turn_token");
  expect(browserRelayPromptContract(parsed)).toContain("<codex_browser_relay_tools_json>");
});

test("relay emits a native function call, then Codex can supply its result in next input", async () => {
  const parsed = request();
  const decision = parseBrowserRelayDecision(toolAnswer([
    { name: "exec_command", arguments: { cmd: "rg --files src" } },
  ]), parsed);
  expect(decision.type).toBe("tool_calls");
  const events = browserRelayEvents(decision, usage);
  expect(events[0]).toMatchObject({ type: "tool_call_start", name: "exec_command" });
  const id = decision.type === "tool_calls" ? decision.calls[0]!.id : "";
  const native = bridgeToResponsesSSE((async function* (): AsyncGenerator<AdapterEvent> {
    yield* events;
  })(), parsed.modelId);
  const text = await new Response(native).text();
  expect(text).toContain("event: response.function_call_arguments.done");
  expect(text).toContain(`"call_id":"${id}"`);
  expect(text).toContain("event: response.completed");
  const replay = request();
  replay.context.messages.push({
    role: "toolResult", toolCallId: id, toolName: "exec_command", content: "src/app.ts", isError: false, timestamp: 2,
  });
  expect(compileChatGptWebPrompt(replay, capabilities, undefined, { browserRelay: true }).text)
    .toContain("src/app.ts");
});

test("relay final answer is unwrapped before Codex receives it", () => {
  const decision = parseBrowserRelayDecision(envelope("final", { answer: "Verified" }), request());
  expect(browserRelayEvents(decision, usage)).toEqual([
    { type: "text_delta", text: "Verified", phase: "final_answer" },
    { type: "done", stopReason: "stop", endTurn: true, usage },
  ]);
});

test("tool-call ids are stable on the same response and distinct across parallel calls", () => {
  const answer = toolAnswer([
    { name: "exec_command", arguments: { cmd: "pwd" } },
    { name: "mcp__docs__lookup", arguments: { query: "CI" } },
  ]);
  const first = parseBrowserRelayDecision(answer, request());
  const second = parseBrowserRelayDecision(answer, request());
  expect(first).toEqual(second);
  if (first.type === "tool_calls") expect(first.calls[0]!.id).not.toBe(first.calls[1]!.id);
});

test("relay validates unknown tools, malformed payloads, schemata and tool-choice constraints", () => {
  const parsed = request();
  expect(() => parseBrowserRelayDecision("hello", parsed)).toThrow("complete JSON");
  expect(() => parseBrowserRelayDecision(envelope("final", { answer: 4 }), parsed)).toThrow("answer string");
  expect(() => parseBrowserRelayDecision(toolAnswer([{ name: "power_shell", arguments: {} }]), parsed))
    .toThrow("unavailable");
  expect(() => parseBrowserRelayDecision(toolAnswer([{ name: "exec_command", arguments: {} }]), parsed))
    .toThrow("schema validation");
  expect(() => parseBrowserRelayDecision(toolAnswer([{ name: "apply_patch", arguments: {} }]), parsed))
    .toThrow("string input");
  expect(() => parseBrowserRelayDecision(toolAnswer([]), parsed)).toThrow("bounded tool batch");
  expect(() => parseBrowserRelayDecision(toolAnswer(Array.from({ length: 9 }, () => ({
    name: "exec_command", arguments: { cmd: "pwd" },
  }))), parsed)).toThrow("bounded tool batch");
  parsed.options.toolChoice = "none";
  expect(() => parseBrowserRelayDecision(toolAnswer([{ name: "exec_command", arguments: { cmd: "pwd" } }]), parsed))
    .toThrow("tool_choice is none");
  parsed.options.toolChoice = "required";
  expect(() => parseBrowserRelayDecision(envelope("final", { answer: "Done" }), parsed)).toThrow("required one");
  parsed.options.toolChoice = { allowedTools: ["exec_command"], mode: "auto" };
  expect(() => parseBrowserRelayDecision(toolAnswer([{ name: "mcp__docs__lookup", arguments: { query: "x" } }]), parsed))
    .toThrow("allowed tool set");
  parsed.options.toolChoice = "auto";
  parsed.options.parallelToolCalls = false;
  expect(() => parseBrowserRelayDecision(toolAnswer([
    { name: "exec_command", arguments: { cmd: "pwd" } },
    { name: "exec_command", arguments: { cmd: "pwd" } },
  ]), parsed)).toThrow("parallel");
});

test("relay accepts JSON fenced by ChatGPT and preserves freeform content", () => {
  const patch = "*** Begin Patch\n*** End Patch";
  const answer = "```json\n" + toolAnswer([{ name: "apply_patch", arguments: { input: patch } }]) + "\n```";
  const decision = parseBrowserRelayDecision(answer, request());
  expect(decision.type).toBe("tool_calls");
  if (decision.type === "tool_calls") expect(decision.calls[0]!.arguments.input).toBe(patch);
});


test("relay tells ChatGPT the same tool restrictions enforced by Codex", () => {
  const parsed = request();
  parsed.options.toolChoice = { allowedTools: ["exec_command"], mode: "required" };
  parsed.options.parallelToolCalls = false;
  const contract = browserRelayPromptContract(parsed).join("\n");
  expect(contract).toContain("requires a tool call");
  expect(contract).toContain('["exec_command"]');
  expect(contract).toContain("only one tool call");
  expect(() => parseBrowserRelayDecision(envelope("final", { answer: "Done" }), parsed))
    .toThrow("required one");
  expect(() => parseBrowserRelayDecision(toolAnswer([
    { name: "mcp__docs__lookup", arguments: { query: "test" } },
  ]), parsed)).toThrow("allowed tool set");
});

test("relay honors a forced named tool and a disabled-tool turn", () => {
  const parsed = request();
  parsed.options.toolChoice = { name: "exec_command" };
  expect(browserRelayPromptContract(parsed).join("\n")).toContain("requires exactly this tool: exec_command");
  expect(() => parseBrowserRelayDecision(toolAnswer([
    { name: "apply_patch", arguments: { input: "content" } },
  ]), parsed)).toThrow("requested tool");
  parsed.options.toolChoice = "none";
  expect(browserRelayPromptContract(parsed).join("\n")).toContain("prohibited tool calls");
  expect(parseBrowserRelayDecision(envelope("final", { answer: "No action required" }), parsed))
    .toEqual({ type: "final", answer: "No action required" });
});


test("Codex parser reconstructs an actual Browser Relay tool call and tool output", () => {
  const source = request();
  const decision = parseBrowserRelayDecision(toolAnswer([
    { name: "exec_command", arguments: { cmd: "pwd" } },
  ]), source);
  const events = browserRelayEvents(decision, usage);
  const native = buildResponseJSON(events, source.modelId);
  const calls = (native.output as Array<Record<string, unknown>>)
    .filter(item => item.type === "function_call");
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.name).toBe("exec_command");
  const parsed = parseRequest({
    model: source.modelId,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect project" }] },
      ...calls,
      { type: "function_call_output", call_id: call.call_id, output: "C:/project" },
    ],
    tools: [{ type: "function", name: "exec_command", description: "Run a command", parameters: {
      type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"],
    } }],
  });
  const assistant = parsed.context.messages.find(message => message.role === "assistant");
  expect(assistant).toBeDefined();
  if (assistant?.role === "assistant") {
    expect(assistant.content).toContainEqual(expect.objectContaining({
      type: "toolCall", id: call.call_id, name: "exec_command",
    }));
  }
  const result = parsed.context.messages.find(message => message.role === "toolResult");
  expect(result).toMatchObject({
    toolCallId: call.call_id, toolName: "exec_command", content: "C:/project",
  });
});
