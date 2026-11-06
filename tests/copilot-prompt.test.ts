import { describe, expect, test } from "bun:test";
import { compileCopilotPrompt } from "../src/copilot/prompt";
import type { CodexParsedRequest } from "../src/types";

function request(overrides: Partial<CodexParsedRequest> = {}): CodexParsedRequest {
  return {
    modelId: "copilot-web/auto",
    context: {
      systemPrompt: ["Follow the repository conventions."],
      messages: [
        { role: "user", content: "Fix the failing test.", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            { type: "toolCall", id: "call_1", name: "shell", arguments: { command: ["bun", "test"] } },
          ],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "shell",
          content: "1 failing test",
          isError: false,
          timestamp: 3,
        },
      ],
      tools: [{
        name: "shell",
        description: "Run a command.",
        parameters: { type: "object", properties: { command: { type: "array" } } },
      }],
    },
    stream: true,
    options: {},
    ...overrides,
  };
}

describe("Copilot prompt compiler", () => {
  test("serializes the complete Codex context and tool catalog", () => {
    const compiled = compileCopilotPrompt(request(), {
      turnId: "turn123",
      maxPromptChars: 100_000,
    });
    expect(compiled.turnMarker).toBe("[[codex-transport-turn:turn123]]");
    expect(compiled.text).toContain("<task_context>");
    expect(compiled.text).toContain("Follow the repository conventions.");
    expect(compiled.text).toContain('"role": "tool_result"');
    expect(compiled.text).toContain('"tool_call_id": "call_1"');
    expect(compiled.text).toContain('"name": "shell"');
    expect(compiled.text).toContain("<codex_tool_call>");
    expect(compiled.text).toContain("<tools_json>");
    expect(compiled.text.endsWith(compiled.turnMarker)).toBe(true);
    const contextJson = compiled.text.slice(
      compiled.text.lastIndexOf("<task_context>") + "<task_context>".length,
      compiled.text.indexOf("</task_context>"),
    );
    expect(JSON.parse(contextJson)).not.toHaveProperty("tools");
  });

  test("disables tools for a compaction turn", () => {
    const compiled = compileCopilotPrompt(request({
      _compactionRequest: true,
      context: {
        systemPrompt: ["system"],
        messages: [{ role: "user", content: "summarize", timestamp: 1 }],
        tools: [{ name: "shell", description: "Run", parameters: {} }],
      },
    }), { turnId: "compact1", maxPromptChars: 100_000 });
    expect(compiled.tools).toEqual([]);
    expect(compiled.text).toContain("history-compaction checkpoint");
    expect(compiled.text).not.toContain("<tool_protocol>");
    expect(compiled.text).not.toContain("<tools_json>");
    expect(compiled.text).toContain("<task_context>");
  });

  test("adds an honesty note for text-only image content", () => {
    const compiled = compileCopilotPrompt(request({
      context: {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "What is in this screenshot?" },
            { type: "image", imageUrl: "data:image/png;base64,AAAA" },
          ],
          timestamp: 1,
        }],
      },
    }), { turnId: "image1", maxPromptChars: 100_000 });
    expect(compiled.text).toContain("text-only");
    expect(compiled.text).toContain("Do not claim to have seen an image");
    expect(compiled.text).not.toContain("base64,AAAA");
  });

  test("refuses to silently truncate an oversized prompt", () => {
    expect(() => compileCopilotPrompt(request(), {
      turnId: "large",
      maxPromptChars: 100,
    })).toThrow(/above the configured limit/);
  });

  test("carries the JSON-schema output contract", () => {
    const compiled = compileCopilotPrompt(request({
      options: {
        outputFormat: {
          type: "json_schema",
          name: "answer",
          strict: true,
          schema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      },
    }), { turnId: "schema", maxPromptChars: 100_000 });
    expect(compiled.text).toContain("JSON-schema final answer");
    expect(compiled.text).toContain('"ok"');
  });
});
