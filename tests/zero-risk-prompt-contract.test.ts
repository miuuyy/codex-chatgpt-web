import { expect, test } from "bun:test";
import { compileChatGptWebPromptWithinPageCapacity } from "../src/adapters/chatgpt-web/capacity";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import {
  activeCompactionToolResultInstruction,
  zeroRiskActiveCompactionToolResultInstruction,
} from "../src/adapters/chatgpt-web/native-compaction-control";
import type { CodexParsedRequest } from "../src/types";

const capabilities = { localToolsEnabled: true, solAvailable: false, proAvailable: false };
const requestId = "request_12345678901234567890123456789012";

function request(compaction = false): CodexParsedRequest {
  return {
    modelId: "chatgpt-web-zero-risk",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "Inspect the repository and fix the defect.", timestamp: 1 }],
      tools: [{
        name: "exec_command",
        description: "Run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
    },
    ...(compaction ? { _compactionRequest: true } : {}),
  };
}

test("Zero Risk prompt carries only a neutral request id while MCP metadata owns its lifecycle", () => {
  const compiled = compileChatGptWebPrompt(request(), capabilities, requestId, {
    manualControl: true,
  });
  expect(compiled.multipart).toBeUndefined();
  expect(compiled.text).toContain("<codex_zero_risk_request_json>");
  expect(compiled.text).toContain(`\"request_id\":\"${requestId}\"`);
  expect(compiled.text).not.toContain("turn_token");
  expect(compiled.text).not.toContain("surface_nonce");
  expect(compiled.text).not.toContain("Before reasoning");
  expect(compiled.text).not.toContain("ordinary assistant text");
  expect(compiled.text).not.toContain("exactly once");
  expect(compiled.text).not.toContain("codex_turn_start");
  expect(compiled.text).not.toContain("codex_turn_complete");
  expect(compiled.text).not.toContain("ChatGPT Web Medium with no Codex Native bridge");
});

test("Zero Risk compaction prompt stays task-focused while MCP metadata owns completion", () => {
  const compiled = compileChatGptWebPrompt(request(true), capabilities, requestId, {
    manualControl: true,
  });
  expect(compiled.text).toContain("This is a Codex history-compaction checkpoint");
  expect(compiled.text).toContain("Do not call work tools or ChatGPT-native tools");
  expect(compiled.text).toContain("Produce the requested checkpoint summary now");
  expect(compiled.text).not.toContain("codex_turn_start");
  expect(compiled.text).not.toContain("codex_turn_complete");
});

test("Zero Risk prompt fails closed without Full harness or an exact manual binding", () => {
  expect(() => compileChatGptWebPrompt(request(), { ...capabilities, localToolsEnabled: false }, requestId, {
    manualControl: true,
  })).toThrow("requires the Full Codex harness");
  expect(() => compileChatGptWebPrompt(request(), capabilities, undefined, {
    manualControl: true,
  })).toThrow("requires a broker request id");
  expect(() => compileChatGptWebPrompt(request(), capabilities, requestId, {
    manualControl: true,
    experimentalMultipartParts: 2,
  })).toThrow("does not support rolling or multipart browser transport");
});

test("Zero Risk reports page capacity explicitly instead of attempting multipart transport", () => {
  const oversized = request();
  oversized.context.messages = [{
    role: "user",
    content: `manual-capacity-${"x".repeat(12_000)}`,
    timestamp: 1,
  }];
  expect(() => compileChatGptWebPromptWithinPageCapacity(
    oversized,
    capabilities,
    requestId,
    { manualControl: true, maxMessageChars: 5_000 },
  )).toThrow(/Zero Risk cannot split.*5,000|5,000.*Zero Risk cannot split/);
});

test("active Zero Risk compaction returns its checkpoint through the bound completion control", () => {
  const automatic = activeCompactionToolResultInstruction();
  const safe = zeroRiskActiveCompactionToolResultInstruction(true);

  expect(automatic).toContain("separate structured compaction handoff request");
  expect(automatic.toLowerCase()).toContain("call no more tools");
  expect(automatic).not.toContain("codex_turn_complete");
  expect(safe).toContain("codex_turn_complete");
  expect(safe).toContain("Return only the complete checkpoint summary to Codex");
  expect(safe).toContain("CONTEXT CHECKPOINT COMPACTION");
  expect(safe).not.toContain("separate structured compaction handoff request");
});
