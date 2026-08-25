import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bridgeToResponsesSSE, buildResponseJSON } from "../src/bridge";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { parseRequest } from "../src/responses/parser";
import { toolBridgeMaps } from "../src/server";
import { namespacedToolName } from "../src/types";

type AdditionalToolsFixture = {
  type: "additional_tools";
  role: "developer";
  tools: Array<Record<string, unknown>>;
};

function fixture(): AdditionalToolsFixture {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures/real-additional-tools.json"), "utf8"));
}

function fixtureWithSyntheticNamespaceCollisions(): AdditionalToolsFixture {
  const additionalTools = fixture();
  const functions = additionalTools.tools[0] as { tools: Array<Record<string, unknown>> };
  functions.tools.splice(1, 0,
    {
      type: "custom",
      name: "inspect",
      description: "A normal namespaced custom tool.",
      format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
    },
  );
  additionalTools.tools.splice(1, 0, {
    type: "namespace",
    name: "audit",
    description: "",
    tools: [
      {
        type: "custom",
        name: "inspect",
        description: "A same-leaf custom in another namespace.",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
      {
        type: "function",
        name: "read",
        description: "A normal function in a non-default namespace.",
        parameters: { type: "object", properties: {} },
      },
    ],
  });
  return additionalTools;
}

function parseAdditionalTools(additionalTools = fixture()) {
  return parseRequest({
    model: "chatgpt-web/high",
    input: [additionalTools],
  });
}

describe("Responses additional_tools parser ABI", () => {
  test("preserves the real nested custom exec and both nested function tools", () => {
    const parsed = parseAdditionalTools();
    const tools = parsed.context.tools ?? [];
    const wireNames = tools.map(tool => namespacedToolName(tool.namespace, tool.name));

    expect(wireNames).toEqual([
      "exec",
      "wait",
      "request_user_input",
      "top_function",
      "top_custom",
    ]);
    expect(tools.find(tool => tool.name === "exec")).toMatchObject({
      name: "exec",
      freeform: true,
      parameters: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
    });
    expect(tools.find(tool => tool.name === "exec")?.namespace).toBeUndefined();
  });

  test("preserves namespace for ordinary nested custom tools with duplicate leaf names", () => {
    const tools = parseAdditionalTools(fixtureWithSyntheticNamespaceCollisions()).context.tools ?? [];

    expect(tools.find(tool => tool.name === "inspect" && tool.namespace === "functions")).toMatchObject({
      namespace: "functions",
      name: "inspect",
      freeform: true,
    });
    expect(tools.find(tool => tool.name === "inspect" && tool.namespace === "audit")).toMatchObject({
      namespace: "audit",
      name: "inspect",
      freeform: true,
    });
  });

  test("keeps top-level and namespaced function contracts backward compatible", () => {
    const tools = parseAdditionalTools().context.tools ?? [];

    expect(tools.find(tool => tool.name === "wait")).toEqual({
      name: "wait",
      description: "Wait on a yielded exec cell.",
      strict: false,
      parameters: {
        type: "object",
        properties: { cell_id: { type: "string" } },
        required: ["cell_id"],
      },
      loadedFromToolSearch: true,
    });
    expect(tools.find(tool => tool.name === "top_function")).toMatchObject({
      name: "top_function",
      description: "A top-level function tool.",
      strict: true,
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    });
    expect(tools.find(tool => tool.name === "top_custom")).toMatchObject({
      name: "top_custom",
      freeform: true,
    });
  });

  test("fails closed when custom tools collide after namespace flattening", () => {
    const additionalTools = fixture();
    additionalTools.tools.push({ type: "custom", name: "exec", description: "collision" });

    expect(() => parseAdditionalTools(additionalTools)).toThrow("duplicate Codex tool wire name: exec");

    const nestedFunctionCollision = fixture();
    const functions = nestedFunctionCollision.tools[0] as { tools: Array<Record<string, unknown>> };
    functions.tools.splice(1, 0, {
      type: "function",
      name: "exec",
      description: "A default-namespace function sharing the custom command wire name.",
      parameters: { type: "object", properties: {} },
    });
    expect(() => parseAdditionalTools(nestedFunctionCollision)).toThrow("duplicate Codex tool wire name: exec");
  });

  test("fails closed on a malformed nested custom entry", () => {
    const additionalTools = fixture();
    const namespace = additionalTools.tools[0] as { tools: Array<Record<string, unknown>> };
    namespace.tools[0] = { type: "custom", description: "missing name" };

    expect(() => parseAdditionalTools(additionalTools)).toThrow("invalid custom tool name");
  });

  test("fails closed on a malformed custom grammar", () => {
    const additionalTools = fixture();
    const namespace = additionalTools.tools[0] as { tools: Array<Record<string, unknown>> };
    namespace.tools[0] = {
      type: "custom",
      name: "exec",
      format: { type: "grammar", syntax: "lark" },
    };

    expect(() => parseAdditionalTools(additionalTools)).toThrow("invalid custom tool grammar format");
  });

  test("fails closed on unknown custom format types and grammar syntaxes", () => {
    const unknownType = fixture();
    unknownType.tools.push({ type: "custom", name: "bad_type", format: { type: "bogus" } });
    expect(() => parseAdditionalTools(unknownType)).toThrow("invalid custom tool format type");

    const unknownSyntax = fixture();
    unknownSyntax.tools.push({
      type: "custom",
      name: "bad_syntax",
      format: { type: "grammar", syntax: "bogus", definition: "start: /.+/" },
    });
    expect(() => parseAdditionalTools(unknownSyntax)).toThrow("invalid custom tool grammar format");
  });

  test("rejects whitespace-padded command aliases before they enter the catalog", () => {
    const additionalTools = fixture();
    additionalTools.tools.push({ type: "custom", name: " exec ", description: "padded alias" });

    expect(() => parseAdditionalTools(additionalTools)).toThrow("invalid custom tool name");
  });

  test("deduplicates identical definitions but rejects conflicting definitions", () => {
    const identical = fixture();
    identical.tools.push(structuredClone(identical.tools.at(-1)!));
    expect(parseAdditionalTools(identical).context.tools?.filter(tool => tool.name === "top_custom")).toHaveLength(1);

    const conflicting = fixture();
    conflicting.tools.push({ type: "custom", name: "top_custom", description: "different" });
    expect(() => parseAdditionalTools(conflicting)).toThrow("duplicate Codex tool wire name: top_custom");

    const grammarConflict = fixture();
    grammarConflict.tools.push({
      ...structuredClone(grammarConflict.tools.at(-1)!),
      format: { type: "grammar", syntax: "lark", definition: "start: /DIFFERENT/" },
    });
    expect(() => parseAdditionalTools(grammarConflict)).toThrow("duplicate Codex tool wire name: top_custom");
  });

  test("keeps the explicit computer-use compatibility ABI but drops hosted and unknown types", () => {
    const additionalTools = fixture();
    additionalTools.tools.push(
      { type: "computer_use_preview", name: "computer", description: "Client computer tool", parameters: {} },
      { type: "web_search", name: "hosted_search", description: "Hosted" },
      { type: "future_server_side_tool", name: "must_not_execute", description: "Unknown" },
    );

    const tools = parseAdditionalTools(additionalTools).context.tools ?? [];
    expect(tools.find(tool => tool.name === "computer")).toMatchObject({ name: "computer" });
    expect(tools.some(tool => tool.name === "hosted_search")).toBe(false);
    expect(tools.some(tool => tool.name === "must_not_execute")).toBe(false);
  });

  test("uses the active parser catalog for tool_search exact-name guidance", () => {
    const loaded = fixture().tools;
    const parsed = parseRequest({
      model: "chatgpt-web/high",
      input: [
        { type: "tool_search_call", call_id: "search_1", arguments: { query: "command" } },
        { type: "tool_search_output", call_id: "search_1", status: "completed", tools: loaded },
      ],
    });
    const result = parsed.context.messages.find(message => message.role === "toolResult");
    const content = result?.content;
    const expectedWireNames = (parsed.context.tools ?? [])
      .map(tool => namespacedToolName(tool.namespace, tool.name));

    expect(content).toBe(`Tool search loaded these tools — they are now in your available tools. Call one by its EXACT name: ${expectedWireNames.join(", ")}.`);
  });

  test("round-trips custom namespace through history and both bridge modes", async () => {
    const parsed = parseRequest({
      model: "chatgpt-web/high",
      input: [
        { type: "custom_tool_call", call_id: "custom_1", name: "inspect", namespace: "audit", input: "record" },
        { type: "custom_tool_call_output", call_id: "custom_1", output: "ok" },
        { type: "custom_tool_call", call_id: "exec_1", name: "exec", namespace: "functions", input: "text('ok')" },
        { type: "custom_tool_call_output", call_id: "exec_1", output: "ok" },
        fixtureWithSyntheticNamespaceCollisions(),
      ],
    });
    const historyCall = parsed.context.messages
      .flatMap(message => message.role === "assistant" ? message.content : [])
      .find(part => part.type === "toolCall" && part.id === "custom_1");
    const historyResult = parsed.context.messages.find(message => message.role === "toolResult" && message.toolCallId === "custom_1");
    expect(historyCall).toMatchObject({ name: "inspect", namespace: "audit", customWireName: "inspect" });
    expect(historyResult).toMatchObject({ toolName: "inspect", toolNamespace: "audit" });
    const historicalExec = parsed.context.messages
      .flatMap(message => message.role === "assistant" ? message.content : [])
      .find(part => part.type === "toolCall" && part.id === "exec_1");
    expect(historicalExec).toMatchObject({ name: "exec", customWireName: "exec" });
    expect(historicalExec).not.toHaveProperty("namespace");
    parsed.modelId = CHATGPT_WEB_MODEL_ID;
    const compiled = compileChatGptWebPrompt(
      parsed,
      { localToolsEnabled: true, solAvailable: true, proAvailable: true },
      "turn_12345678901234567890123456789012",
    );
    expect(compiled.text).toContain('"name":"audit__inspect"');
    expect(compiled.text).toContain('"tool_name":"audit__inspect"');

    const maps = toolBridgeMaps(parsed);
    const events = [
      { type: "tool_call_start" as const, id: "call_fn", name: "audit__read" },
      { type: "tool_call_delta" as const, id: "call_fn", arguments: "{}" },
      { type: "tool_call_start" as const, id: "call_custom", name: "audit__inspect" },
      { type: "tool_call_delta" as const, id: "call_custom", arguments: '{"input":"record"}' },
      { type: "done" as const, stopReason: "tool_use", endTurn: false },
    ];
    const response = buildResponseJSON(events, "chatgpt-web/high", maps) as { output: Array<Record<string, unknown>> };
    expect(response.output.find(item => item.call_id === "call_fn")).toMatchObject({
      type: "function_call", name: "read", namespace: "audit",
    });
    expect(response.output.find(item => item.call_id === "call_custom")).toMatchObject({
      type: "custom_tool_call", name: "inspect", namespace: "audit", input: "record",
    });

    async function* streamEvents() { yield* events; }
    const stream = bridgeToResponsesSSE(
      streamEvents(),
      "chatgpt-web/high",
      maps.toolNsMap,
      maps.freeformToolNames,
      maps.toolSearchToolNames,
    );
    const sse = await new Response(stream).text();
    const payloads = sse.split("\n")
      .filter(line => line.startsWith("data: ") && line !== "data: [DONE]")
      .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const doneItems = payloads
      .filter(payload => payload.type === "response.output_item.done")
      .map(payload => payload.item as Record<string, unknown>);
    expect(doneItems.find(item => item.call_id === "call_fn")).toMatchObject({
      type: "function_call", name: "read", namespace: "audit",
    });
    expect(doneItems.find(item => item.call_id === "call_custom")).toMatchObject({
      type: "custom_tool_call", name: "inspect", namespace: "audit", input: "record",
    });
  });

  test("does not turn an unknown named tool type into an executable tool", () => {
    const additionalTools = fixture();
    additionalTools.tools.push({
      type: "future_server_side_tool",
      name: "must_not_execute",
      description: "Unknown tool kinds are not client executable by default.",
    });

    const tools = parseAdditionalTools(additionalTools).context.tools ?? [];
    expect(tools.some(tool => tool.name === "must_not_execute")).toBe(false);
  });
});
