import { describe, expect, test } from "bun:test";
import {
  buildToolProtocolInstructions,
  copilotTurnMarker,
  parseCopilotResponse,
  stripCopilotTurnMarker,
} from "../src/copilot/tool-protocol";
import type { CodexTool } from "../src/types";

const tools: CodexTool[] = [
  {
    name: "shell",
    description: "Run a shell command.",
    parameters: { type: "object", properties: { command: { type: "array" } } },
  },
  {
    name: "apply_patch",
    description: "Apply a patch.",
    parameters: { type: "object", properties: { input: { type: "string" } } },
    freeform: true,
  },
  {
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    namespace: "mcp__fs",
  },
];

describe("Copilot text tool protocol", () => {
  test("returns plain text when no tool block is present", () => {
    expect(parseCopilotResponse("Hello from Copilot.", tools)).toEqual({
      text: "Hello from Copilot.",
      toolCalls: [],
    });
  });

  test("parses prose and a single tool call", () => {
    const response = parseCopilotResponse(
      'I will inspect the directory.\n<codex_tool_call>{"name":"shell","arguments":{"command":["pwd"]}}</codex_tool_call>',
      tools,
    );
    expect(response.text).toBe("I will inspect the directory.");
    expect(response.toolCalls).toEqual([{
      name: "shell",
      arguments: { command: ["pwd"] },
      raw: '{"name":"shell","arguments":{"command":["pwd"]}}',
    }]);
  });

  test("parses multiple tool calls and preserves the surrounding prose", () => {
    const response = parseCopilotResponse(
      [
        "Checking both files.",
        '<codex_tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</codex_tool_call>',
        '<codex_tool_call>{"name":"read_file","arguments":{"path":"b.ts"}}</codex_tool_call>',
        "Done.",
      ].join("\n"),
      tools,
    );
    expect(response.text).toBe("Checking both files.\n\nDone.");
    expect(response.toolCalls.map(call => call.arguments)).toEqual([
      { path: "a.ts" },
      { path: "b.ts" },
    ]);
  });

  test("accepts a block wrapped in a Markdown code fence", () => {
    const response = parseCopilotResponse(
      '```json\n<codex_tool_call>{"name":"shell","arguments":{"command":["ls"]}}</codex_tool_call>\n```',
      tools,
    );
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]!.arguments).toEqual({ command: ["ls"] });
  });

  test("accepts a longer fence around a tool call", () => {
    const response = parseCopilotResponse(
      '````json\n<codex_tool_call>{"name":"shell","arguments":{"command":["ls"]}}</codex_tool_call>\n````',
      tools,
    );
    expect(response.toolCalls).toHaveLength(1);
  });

  test("preserves backticks in a fenced freeform tool input", () => {
    const patch = "*** Begin Patch\n+  return `Hello, ${name}!`;\n*** End Patch";
    const response = parseCopilotResponse(
      "```json\n<codex_tool_call>"
        + JSON.stringify({ name: "apply_patch", arguments: { input: patch } })
        + "</codex_tool_call>\n```",
      tools,
    );
    expect(response.toolCalls[0]!.arguments).toEqual({ input: patch });
  });

  test("tells the model to fence tool calls and escape JSON quotes", () => {
    const instructions = buildToolProtocolInstructions(tools);
    expect(instructions).toContain("fenced code block");
    expect(instructions).toContain("escape literal double quotes");
  });

  test("wraps freeform tool input", () => {
    const response = parseCopilotResponse(
      '<codex_tool_call>{"name":"apply_patch","input":"*** Begin Patch\\n*** End Patch"}</codex_tool_call>',
      tools,
    );
    expect(response.toolCalls[0]!.arguments).toEqual({ input: "*** Begin Patch\n*** End Patch" });
  });

  test("resolves namespaced wire names", () => {
    const response = parseCopilotResponse(
      '<codex_tool_call>{"name":"mcp__fs__read_file","arguments":{"path":"x"}}</codex_tool_call>',
      tools,
    );
    expect(response.toolCalls[0]!.name).toBe("mcp__fs__read_file");
  });

  test("accepts a JSON tool_calls fallback", () => {
    const response = parseCopilotResponse(
      JSON.stringify({ tool_calls: [{ name: "shell", arguments: { command: ["pwd"] } }] }),
      tools,
    );
    expect(response.text).toBe("");
    expect(response.toolCalls).toHaveLength(1);
  });

  test("rejects an unknown tool name", () => {
    expect(() => parseCopilotResponse(
      '<codex_tool_call>{"name":"rm_rf","arguments":{}}</codex_tool_call>',
      tools,
    )).toThrow(/unknown tool/);
  });

  test("rejects malformed JSON", () => {
    expect(() => parseCopilotResponse(
      '<codex_tool_call>{"name":"shell",</codex_tool_call>',
      tools,
    )).toThrow(/invalid JSON/);
  });

  test("rejects an unterminated block", () => {
    expect(() => parseCopilotResponse(
      '<codex_tool_call>{"name":"shell","arguments":{}}',
      tools,
    )).toThrow(/unterminated/);
  });

  test("strips the transport marker", () => {
    const marker = copilotTurnMarker("abc123");
    expect(stripCopilotTurnMarker(`answer\n${marker}\n`)).toBe("answer");
  });

  test("does not execute tool blocks when tools are disabled", () => {
    const response = parseCopilotResponse(
      'summary\n<codex_tool_call>{"name":"shell","arguments":{"command":["pwd"]}}</codex_tool_call>',
      tools,
      { allowTools: false },
    );
    expect(response.text).toBe("summary");
    expect(response.toolCalls).toEqual([]);
  });
});
