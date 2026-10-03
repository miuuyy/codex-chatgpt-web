import { describe, expect, test } from "bun:test";
import {
  compileChatGptWebPrompt,
  stripHistoricalTurnTokens,
  isChatGptTokenRejection,
} from "../src/adapters/chatgpt-web/prompt";
import { createGracefulTokenNoticeResult } from "../src/adapters/chatgpt-web/mcp-server";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import type { CodexParsedRequest } from "../src/types";

describe("stale token scrubbing and compaction prompt hygiene", () => {
  test("scrubbing preserves literal whitespace outside capability blocks", () => {
    const literal = "  indented code\n\n\n\ntrailing whitespace  \n";
    expect(stripHistoricalTurnTokens(literal)).toBe(literal);
    const binding = '<codex_native_binding_json>{"turn_token":"old"}</codex_native_binding_json>';
    expect(stripHistoricalTurnTokens(`\n${binding}${literal}`)).toBe(`\n${literal}`);
  });
  test("stripHistoricalTurnTokens removes old native binding, zero risk, and compaction control blocks", () => {
    const dirty = [
      "Here is the previous turn result.",
      "<codex_native_binding_json>",
      '{"turn_token":"stale_native_token_1234567890abcdef","token_chars":34}',
      "</codex_native_binding_json>",
      "And another line of text.",
      "<codex_zero_risk_request_json>",
      '{"request_id":"stale_zero_risk_token_9876543210"}',
      "</codex_zero_risk_request_json>",
      "<codex_compaction_control>",
      "turn_token stale_compaction_token_11223344",
      "wire_name codex.control.compaction_handoff",
      "handoff_id handoff_123",
      "</codex_compaction_control>",
      "Task completed.",
    ].join("\n");

    const cleaned = stripHistoricalTurnTokens(dirty);

    expect(cleaned).not.toContain("stale_native_token_1234567890abcdef");
    expect(cleaned).not.toContain("stale_zero_risk_token_9876543210");
    expect(cleaned).not.toContain("stale_compaction_token_11223344");
    expect(cleaned).not.toContain("<codex_native_binding_json>");
    expect(cleaned).not.toContain("<codex_zero_risk_request_json>");
    expect(cleaned).not.toContain("<codex_compaction_control>");
    expect(cleaned).toContain("Here is the previous turn result.");
    expect(cleaned).toContain("And another line of text.");
    expect(cleaned).toContain("Task completed.");
  });

  test("compileChatGptWebPrompt scrubs old tokens from message history while injecting only the current active token", () => {
    const parsed: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      context: {
        messages: [
          {
            role: "user",
            content: "Please check the status.",
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Status checked.\n<codex_native_binding_json>\n{\"turn_token\":\"old_token_alpha\"}\n</codex_native_binding_json>",
              },
            ],
            timestamp: 2,
          },
          {
            role: "user",
            content: "Now report to thread.\n<codex_native_binding_json>\n{\"turn_token\":\"old_token_beta\"}\n</codex_native_binding_json>",
            timestamp: 3,
          },
        ],
      },
      options: { reasoning: "low" },
      stream: true,
    };

    const currentToken = "active_turn_token_fresh_9999999999999";
    const compiled = compileChatGptWebPrompt(
      parsed,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      currentToken,
    );

    // Old tokens must be scrubbed from messages
    expect(compiled.text).not.toContain("old_token_alpha");
    expect(compiled.text).not.toContain("old_token_beta");

    // Only the current token must be present in the binding
    expect(compiled.text).toContain("active_turn_token_fresh_9999999999999");
  });

  test("compileChatGptWebPrompt during compaction completely omits tokens and explicitly forbids tool calls", () => {
    const parsed: CodexParsedRequest = {
      modelId: CHATGPT_WEB_MODEL_ID,
      _compactionRequest: true,
      context: {
        messages: [
          {
            role: "user",
            content: "Previous work.\n<codex_native_binding_json>\n{\"turn_token\":\"stale_token_gamma\"}\n</codex_native_binding_json>",
            timestamp: 1,
          },
        ],
      },
      options: { reasoning: "low" },
      stream: true,
    };

    const compiled = compileChatGptWebPrompt(
      parsed,
      { localToolsEnabled: true, solAvailable: true, extraHighAvailable: true, proAvailable: true },
      undefined,
    );

    // No stale tokens
    expect(compiled.text).not.toContain("stale_token_gamma");
    expect(compiled.text).not.toContain("<codex_native_binding_json>");

    // Compaction instructions explicitly forbid calling tools
    expect(compiled.text).toContain("Do not call");
    expect(compiled.text).toContain("codex_tool_inventory");
  });
});

describe("turn token rejection detection", () => {
  test("isChatGptTokenRejection accurately detects rejection signatures across languages and formats", () => {
    const sampleEnglish = "The request failed because turn token is invalid, expired, or revoked. Please try again.";
    const sampleKorean = "Native2 도구 호출을 시도했지만 현재 제공된 runtime turn token이 invalid, expired, or revoked 오류로 거부되었습니다. 시도: codex_tool_inventory(send_message_to_thread, include_schema=true)";
    const sampleRetired = "This turn_token was issued for turn_trace_123, which has already finished. This Codex Native action can no longer run.";
    const sampleSafe = "This request_id was issued for turn_trace_456, which has already finished.";
    const sampleNormal = "The build succeeded and all 42 tests have passed.";
    const sampleNormalError = "File not found: /path/to/missing/file.txt";

    expect(isChatGptTokenRejection(sampleEnglish)).toBe(true);
    expect(isChatGptTokenRejection(sampleKorean)).toBe(true);
    expect(isChatGptTokenRejection(sampleRetired)).toBe(true);
    expect(isChatGptTokenRejection(sampleSafe)).toBe(true);
    expect(isChatGptTokenRejection(sampleNormal)).toBe(false);
    expect(isChatGptTokenRejection(sampleNormalError)).toBe(false);
  });

  test("createGracefulTokenNoticeResult generates a non-fatal guidance payload advising summary completion", () => {
    const errorDetail = "turn token is invalid, expired, or revoked";
    const notice = createGracefulTokenNoticeResult(errorDetail);

    expect(notice.status).toBe("notice");
    expect(notice.action_required).toBe("conclude_summary");
    expect(notice.guidance).toContain("Context compaction is in progress or the active turn token was renewed");
    expect(notice.guidance).toContain("Do not call any further tools");
    expect(notice.guidance).toContain("Conclude your turn by outputting the summary");
    expect(notice.error_detail).toBe(errorDetail);
  });
});
