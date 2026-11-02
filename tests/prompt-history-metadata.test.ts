import { expect, test } from "bun:test";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true, proPlan: true };
const turnToken = "turn_12345678901234567890123456789012";

function parsed(): CodexParsedRequest {
  return {
    modelId: CHATGPT_WEB_MODEL_ID,
    stream: true,
    options: { reasoning: "high" },
    context: {
      messages: [
        {
          role: "assistant",
          phase: "commentary",
          content: [
            { type: "text", text: "I am checking the external state first." },
            {
              type: "toolCall",
              id: "call_1",
              name: "lookup",
              namespace: "mcp__inventory",
              arguments: { sku: "A-1" },
            },
          ],
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "lookup",
          toolNamespace: "mcp__inventory",
          content: "in stock",
          isError: false,
          timestamp: 2,
        },
        {
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "text", text: "The item is in stock." }],
          timestamp: 3,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Legacy phase-less assistant history." }],
          timestamp: 4,
        },
      ],
    },
  };
}

function inlineEnvelope(text: string): Record<string, unknown> {
  const match = text.match(/<codex_context_json>\n([^\n]+)\n<\/codex_context_json>/);
  if (!match?.[1]) throw new Error("inline Codex context JSON missing");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

test("inline Web context preserves assistant phase and MCP namespace metadata", () => {
  const compiled = compileChatGptWebPrompt(parsed(), capabilities, turnToken);
  const envelope = inlineEnvelope(compiled.text) as { messages: Array<Record<string, unknown>> };
  expect(envelope.messages[0]?.phase).toBe("commentary");
  expect((envelope.messages[0]?.content as Array<Record<string, unknown>>)[1]?.namespace).toBe("mcp__inventory");
  expect(envelope.messages[1]?.tool_namespace).toBe("mcp__inventory");
  expect(envelope.messages[2]?.phase).toBe("final_answer");
  expect(envelope.messages[3]).not.toHaveProperty("phase");
});

test("multipart Web context preserves the same history metadata", () => {
  const compiled = compileChatGptWebPrompt(
    parsed(),
    capabilities,
    turnToken,
    { experimentalMultipartParts: 2 },
  );
  const records = compiled.multipart!.parts.flatMap(part => {
    const decoded = JSON.parse(part) as { records: Array<Record<string, unknown>> };
    return decoded.records;
  });
  const messages = records
    .filter(record => record.kind === "message")
    .map(record => record.message as Record<string, unknown>);
  expect(messages[0]?.phase).toBe("commentary");
  expect((messages[0]?.content as Array<Record<string, unknown>>)[1]?.namespace).toBe("mcp__inventory");
  expect(messages[1]?.tool_namespace).toBe("mcp__inventory");
  expect(messages[2]?.phase).toBe("final_answer");
});
