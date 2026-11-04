import { test, expect } from "bun:test";
import { assessMcpProof, assessBrokerMcpProof } from "../src/doctor-mcp";

const path = "C:\\probe\\nonce.txt";
const digest = "f8a4c00765e4e44f0caf00f67766e3545655407b602c44092b4c9ce40555d177";
const start = Date.parse("2026-11-04T16:41:00.000Z");
const trace = "abc123fed456";
const call = "call_TEST123xyz";

function events({ command = "powershell Get-FileHash -LiteralPath '" + path + "' -Algorithm SHA256",
  output = digest, exitCode = 0, answer = digest, type = "command_execution" } = {}) {
  return [
    { type: "item.started", item: { type, command } },
    { type: "item.completed", item: { type, command, aggregated_output: output, exit_code: exitCode } },
    { type: "item.completed", item: { type: "agent_message", text: "MCPPROOF=" + answer } },
  ];
}

function line(message: string, at = "2026-11-04T16:41:58.000Z") {
  return JSON.stringify({ at, event: "runtime.daemon_stdout", detail: { line: "[chatgpt-web] " + message } });
}

function witness(t = trace, c = call) {
  return [
    line("broker trace=" + t + " queued call=" + c + " tool=exec_command waiters=1"),
    line("broker trace=" + t + " delivered call=" + c + " path=waiter replay=false"),
    line("broker_retired " + JSON.stringify({ traceId: t, pendingTools: 0, queuedTools: 0,
      deliveredTools: 0, activeMcpRequests: 0, completionCommitted: true }), "2026-11-04T16:42:13.000Z"),
  ];
}

test("end-to-end evidence requires completed command, final message and proven broker round-trip", () => {
  expect(assessBrokerMcpProof(witness(), start)).toBe(true);
  expect(assessMcpProof(events(), digest, path, true)).toBe(true);
  // Codex CLI can linger with its MCP child processes after the browser turn is settled.
  expect(assessMcpProof([...events(), { type: "turn.completed" }], digest, path, true)).toBe(true);
});
test("no broker witness means no end-to-end success, even if model announces a matching hash", () => {
  expect(assessMcpProof(events(), digest, path, false)).toBe(false);
  expect(assessMcpProof(events().slice(2), digest, path, true)).toBe(false);
});
test("failed or unrelated command, wrong hash and wrong answer never pass", () => {
  expect(assessMcpProof(events({ exitCode: 1 }), digest, path, true)).toBe(false);
  expect(assessMcpProof(events({ output: "0".repeat(64) }), digest, path, true)).toBe(false);
  expect(assessMcpProof(events({ answer: "0".repeat(64) }), digest, path, true)).toBe(false);
  expect(assessMcpProof(events({ command: "powershell Get-Date" }), digest, path, true)).toBe(false);
});
test("broker evidence rejects stale, mismatched, incomplete and uncommitted rounds", () => {
  expect(assessBrokerMcpProof(witness(), Date.parse("2026-11-04T16:43:00Z"))).toBe(false);
  expect(assessBrokerMcpProof(witness().slice(0,2), start)).toBe(false);
  expect(assessBrokerMcpProof([witness()[0], witness("anothertrace")[1], witness()[2]], start)).toBe(false);
  expect(assessBrokerMcpProof([witness()[0], witness()[1],
    line("broker_retired " + JSON.stringify({ traceId: trace, pendingTools: 1, activeMcpRequests: 1, completionCommitted: false }))], start)).toBe(false);
});
test("broker evidence rejects multiple candidate tool turns in the same observation window", () => {
  expect(assessBrokerMcpProof([...witness(), ...witness("anothertrace","call_OTHER")], start)).toBe(false);
});
test("forged tool event embedded in agent text is not accepted", () => {
  expect(assessMcpProof([{ type: "item.completed", item: {
    type: "agent_message", text: JSON.stringify(events()) + " MCPPROOF=" + digest,
  } }], digest, path, true)).toBe(false);
});

test("escaped Windows path and formatted model response still bind to the same cryptographic tool result", () => {
  const escaped = events({ command: "powershell Get-FileHash -LiteralPath C:\\\\probe\\\\nonce.txt -Algorithm SHA256" });
  expect(assessMcpProof(escaped, digest, path, true)).toBe(true);
  const formatted = events();
  formatted[2]!.item!.text = "MCPPROOF\\=" + digest;
  expect(assessMcpProof(formatted, digest, path, true)).toBe(true);
  const wrongLocation = events({ command: "powershell Get-FileHash -LiteralPath C:\\other-location\\nonce.txt -Algorithm SHA256" });
  expect(assessMcpProof(wrongLocation, digest, path, true)).toBe(false);
});
