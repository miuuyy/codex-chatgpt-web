import { createHash } from "node:crypto";

export const COMMAND_OBSERVATION_PREFIX = "[chatgpt-web-mcp-observation] ";
export const PLATFORM_HTTP_ENDPOINT_NOT_OBSERVABLE = "PLATFORM_HTTP_ENDPOINT_NOT_OBSERVABLE";

type RequestExtra = {
  requestId: string | number;
  sessionId?: string;
  _meta?: unknown;
};

type CommandTerminalClass = "success" | "pending" | "terminal_error" | "unknown" | "handler_exception";

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function connectorCorrelation(extra: RequestExtra): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? extra._meta as Record<string, unknown>
    : {};
  const platformSession = typeof meta["openai/session"] === "string" ? meta["openai/session"] : "";
  return fingerprint(JSON.stringify({
    platformSession,
    requestId: String(extra.requestId),
    sessionId: extra.sessionId ?? "",
  }));
}

function commandTerminalClass(value: unknown): CommandTerminalClass {
  const result = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const serialized = JSON.stringify(result);
  if (serialized.includes("UNRESOLVED_UNKNOWN_OUTCOME")) return "unknown";
  const structured = result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent as Record<string, unknown>
    : {};
  if (structured.session_id !== undefined || structured.cell_id !== undefined
    || structured.status === "running" || structured.status === "pending") return "pending";
  if (result.isError === true) return "terminal_error";
  return "success";
}

function emitObservation(value: Record<string, unknown>): void {
  console.error(`${COMMAND_OBSERVATION_PREFIX}${JSON.stringify({ time: new Date().toISOString(), ...value })}`);
}

export async function observeCommandInvocation<T>(
  tool: "codex_exec" | "codex_write_stdin",
  extra: RequestExtra,
  run: () => Promise<T>,
): Promise<T> {
  const correlation = connectorCorrelation(extra);
  emitObservation({
    schema: "command-observation-v1",
    event: "connector_invocation_start",
    tool,
    correlation,
  });
  try {
    const response = await run();
    const terminalClass = commandTerminalClass(response);
    emitObservation({
      schema: "command-observation-v1",
      event: "connector_invocation_terminal",
      tool,
      correlation,
      terminal_class: terminalClass,
      remote_failure_class: terminalClass === "unknown"
        ? "native_outcome_unknown"
        : terminalClass === "terminal_error"
          ? "connector_result_error_unattributed"
          : "none",
    });
    return response;
  } catch (error) {
    emitObservation({
      schema: "command-observation-v1",
      event: "connector_invocation_terminal",
      tool,
      correlation,
      terminal_class: "handler_exception",
      remote_failure_class: "connector_handler_exception",
      error_class: error instanceof Error ? error.name : "unknown_error",
    });
    throw error;
  }
}

interface ParsedLine {
  time?: string;
  msg?: string;
  level?: string;
  component?: string;
  request_id?: string;
  cmd_request_id?: string;
  event?: string;
  correlation?: string;
  terminal_class?: string;
  remote_failure_class?: string;
}

function parsedLine(line: string): ParsedLine | null {
  const observationAt = line.indexOf(COMMAND_OBSERVATION_PREFIX);
  const jsonText = observationAt >= 0
    ? line.slice(observationAt + COMMAND_OBSERVATION_PREFIX.length)
    : line.trim();
  try {
    const value: unknown = JSON.parse(jsonText);
    return value && typeof value === "object" ? value as ParsedLine : null;
  } catch {
    return null;
  }
}

function inWindow(entry: ParsedLine, since?: string, until?: string): boolean {
  if (!entry.time) return true;
  const time = Date.parse(entry.time);
  if (!Number.isFinite(time)) return true;
  return (!since || time >= Date.parse(since)) && (!until || time <= Date.parse(until));
}

export function summarizeCommandObservabilityLog(
  text: string,
  window: { since?: string; until?: string } = {},
): Record<string, unknown> {
  const entries = text.split(/\r?\n/)
    .map(parsedLine)
    .filter((entry): entry is ParsedLine => entry !== null)
    .filter(entry => inWindow(entry, window.since, window.until));
  const forwarded = entries.filter(entry => entry.msg === "dispatcher forwarded command to MCP server");
  const posted = entries.filter(entry => entry.msg === "posted response to control-plane");
  const forwardedIds = new Set(forwarded.flatMap(entry => [entry.request_id, entry.cmd_request_id])
    .filter((value): value is string => Boolean(value)));
  const matchingPosted = posted.filter(entry => [entry.request_id, entry.cmd_request_id]
    .some(value => typeof value === "string" && forwardedIds.has(value)));
  const starts = entries.filter(entry => entry.event === "connector_invocation_start");
  const terminals = entries.filter(entry => entry.event === "connector_invocation_terminal");
  const tunnelCorrelations = [...new Set(forwarded.flatMap(entry => [entry.cmd_request_id, entry.request_id])
    .filter((value): value is string => Boolean(value))
    .map(fingerprint))];
  const connectorCorrelations = [...new Set(starts.map(entry => entry.correlation).filter((value): value is string => Boolean(value)))];
  const tunnelFailures = entries
    .filter(entry => entry.level === "ERROR" || entry.level === "WARN")
    .map(entry => `${entry.component ?? "unknown"}_error`);
  const remoteFailureClasses = [...new Set([
    ...terminals.map(entry => entry.remote_failure_class).filter((value): value is string => Boolean(value) && value !== "none"),
    ...tunnelFailures,
  ])];
  const boundedWindow = Boolean(window.since && window.until);
  const temporalSingletonCandidate = boundedWindow
    && forwarded.length === 1 && matchingPosted.length === 1 && starts.length === 1 && terminals.length === 1;

  return {
    schema: "command-observability-summary-v1",
    platform_http_endpoint: PLATFORM_HTTP_ENDPOINT_NOT_OBSERVABLE,
    window: { since: window.since ?? null, until: window.until ?? null },
    candidate_poll_arrival: forwarded.length > 0,
    candidate_poll_arrival_count: forwarded.length,
    candidate_response_post: matchingPosted.length > 0,
    candidate_response_post_count: matchingPosted.length,
    unmatched_response_post_count: posted.length - matchingPosted.length,
    connector_invocation_start: starts.length > 0,
    connector_invocation_start_count: starts.length,
    connector_terminal_classes: terminals.map(entry => entry.terminal_class ?? "unknown"),
    remote_failure_classes: remoteFailureClasses,
    sanitized_correlation: {
      tunnel: tunnelCorrelations,
      connector: connectorCorrelations,
      method: "separate_stage_fingerprints_no_shared_connector_identifier",
      temporal_singleton_candidate: temporalSingletonCandidate,
      status: "INCONCLUSIVE_NO_SHARED_IDENTIFIER",
    },
  };
}
