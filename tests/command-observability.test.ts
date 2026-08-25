import { describe, expect, test } from "bun:test";
import {
  COMMAND_OBSERVATION_PREFIX,
  observeCommandInvocation,
  PLATFORM_HTTP_ENDPOINT_NOT_OBSERVABLE,
  summarizeCommandObservabilityLog,
} from "../src/adapters/chatgpt-web/command-observability";

describe("command observability", () => {
  test("emits only sanitized connector correlation and terminal classes", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line?: unknown) => { lines.push(String(line)); };
    try {
      await observeCommandInvocation("codex_exec", {
        requestId: "raw-request-secret",
        sessionId: "raw-session-secret",
        _meta: { "openai/session": "raw-platform-session-secret" },
      }, async () => ({ structuredContent: { output: "ok", exit_code: 0 } }));
    } finally {
      console.error = original;
    }

    expect(lines).toHaveLength(2);
    expect(lines.every(line => line.startsWith(COMMAND_OBSERVATION_PREFIX))).toBe(true);
    const joined = lines.join("\n");
    expect(joined).not.toContain("raw-request-secret");
    expect(joined).not.toContain("raw-session-secret");
    expect(joined).not.toContain("raw-platform-session-secret");
    expect(joined).toContain('"terminal_class":"success"');
  });

  test("summarizes a bounded tunnel-to-connector window without exposing raw IDs", () => {
    const log = [
      JSON.stringify({ time: "2026-08-22T10:00:00Z", level: "INFO", msg: "dispatcher forwarded command to MCP server", request_id: "raw-tunnel-request", cmd_request_id: "raw-command-request" }),
      `${COMMAND_OBSERVATION_PREFIX}${JSON.stringify({ event: "connector_invocation_start", correlation: "connector-fingerprint" })}`,
      `${COMMAND_OBSERVATION_PREFIX}${JSON.stringify({ event: "connector_invocation_terminal", correlation: "connector-fingerprint", terminal_class: "terminal_error", remote_failure_class: "connector_result_error_unattributed" })}`,
      JSON.stringify({ time: "2026-08-22T10:00:01Z", level: "INFO", msg: "posted response to control-plane", request_id: "raw-tunnel-request" }),
    ].join("\n");
    const summary = summarizeCommandObservabilityLog(log, {
      since: "2026-08-22T09:59:59Z",
      until: "2026-08-22T10:00:02Z",
    });
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      platform_http_endpoint: PLATFORM_HTTP_ENDPOINT_NOT_OBSERVABLE,
      candidate_poll_arrival: true,
      candidate_response_post: true,
      connector_invocation_start: true,
      connector_terminal_classes: ["terminal_error"],
      remote_failure_classes: ["connector_result_error_unattributed"],
      sanitized_correlation: {
        temporal_singleton_candidate: true,
        status: "INCONCLUSIVE_NO_SHARED_IDENTIFIER",
      },
    });
    expect(serialized).not.toContain("raw-tunnel-request");
    expect(serialized).not.toContain("raw-command-request");
  });

  test("reports absent stages and inconclusive correlation explicitly", () => {
    expect(summarizeCommandObservabilityLog("")).toMatchObject({
      platform_http_endpoint: PLATFORM_HTTP_ENDPOINT_NOT_OBSERVABLE,
      candidate_poll_arrival: false,
      candidate_response_post: false,
      connector_invocation_start: false,
      sanitized_correlation: { status: "INCONCLUSIVE_NO_SHARED_IDENTIFIER" },
    });
  });

  test("does not correlate unrelated response posts or an unbounded singleton", () => {
    const log = [
      JSON.stringify({ time: "2026-08-22T10:00:00Z", level: "INFO", msg: "dispatcher forwarded command to MCP server", request_id: "request-a" }),
      `${COMMAND_OBSERVATION_PREFIX}${JSON.stringify({ event: "connector_invocation_start", correlation: "connector-a" })}`,
      JSON.stringify({ time: "2026-08-22T10:00:01Z", level: "INFO", msg: "posted response to control-plane", request_id: "request-b" }),
    ].join("\n");
    expect(summarizeCommandObservabilityLog(log)).toMatchObject({
      candidate_poll_arrival: true,
      candidate_response_post: false,
      unmatched_response_post_count: 1,
      sanitized_correlation: {
        temporal_singleton_candidate: false,
        status: "INCONCLUSIVE_NO_SHARED_IDENTIFIER",
      },
    });
  });
});
