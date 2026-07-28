import { expect, test } from "bun:test";
import {
  isRecoverablePromptRelayFormatError,
  parsePromptRelayDomResponse,
  parsePromptRelayResponse,
  promptRelayCorrection,
  promptRelayContract,
  promptRelayResults,
} from "../src/adapters/chatgpt-web/prompt-tool-relay";
import type { CodexTool } from "../src/types";

const tools: CodexTool[] = [
  {
    name: "exec",
    description: "Run a command",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "apply_patch",
    description: "Apply a patch",
    parameters: {},
    freeform: true,
  },
];

test("prompt relay exposes exact tools and parses a nonce-bound batch", () => {
  const nonce = "test-nonce";
  expect(promptRelayContract(tools, nonce).join("\n")).toContain("\"name\":\"exec\"");
  const parsed = parsePromptRelayResponse(
    `Checking the workspace.\nCODEX_TOOL_CALLS_BEGIN nonce=${nonce}\n[{"name":"exec","arguments":{"command":"git status"}},{"name":"apply_patch","input":"*** Begin Patch"}]\nCODEX_TOOL_CALLS_END`,
    nonce,
    tools,
  );
  expect(parsed.visibleText).toBe("Checking the workspace.");
  expect(parsed.calls).toEqual([
    { wireName: "exec", freeform: false, arguments: { command: "git status" } },
    { wireName: "apply_patch", freeform: true, input: "*** Begin Patch" },
  ]);
});

test("prompt relay decodes ChatGPT Markdown escapes before nonce and JSON validation", () => {
  const parsed = parsePromptRelayResponse(
    String.raw`CODEX\_TOOL\_CALLS\_BEGIN nonce=test-nonce
\[{"name":"apply\_patch","input":"\*\*\* Begin Patch"}\]
CODEX\_TOOL\_CALLS\_END`,
    "test-nonce",
    tools,
  );
  expect(parsed.calls).toEqual([
    { wireName: "apply_patch", freeform: true, input: "*** Begin Patch" },
  ]);
});

test("prompt relay preserves valid JSON backslashes before Markdown punctuation", () => {
  const payload = JSON.stringify([{ name: "apply_patch", input: String.raw`replace \[literal\]` }]);
  const parsed = parsePromptRelayResponse(
    `CODEX_TOOL_CALLS_BEGIN nonce=test-nonce\n${payload}\nCODEX_TOOL_CALLS_END`,
    "test-nonce",
    tools,
  );
  expect(parsed.calls?.[0]?.input).toBe(String.raw`replace \[literal\]`);
});

test("prompt relay removes only the added Markdown escape in fallback JSON", () => {
  const parsed = parsePromptRelayResponse(
    String.raw`CODEX\_TOOL\_CALLS\_BEGIN nonce=test-nonce
\[{"name":"apply\_patch","input":"replace \\\[literal\\\]"}\]
CODEX\_TOOL\_CALLS\_END`,
    "test-nonce",
    tools,
  );
  expect(parsed.calls?.[0]?.input).toBe(String.raw`replace \[literal\]`);
});

test("prompt relay falls back to Markdown only when DOM text loses Windows JSON escapes", () => {
  const parsed = parsePromptRelayDomResponse(
    String.raw`CODEX_TOOL_CALLS_BEGIN nonce=test-nonce
[{"name":"exec","arguments":{"command":"Get-Content","workdir":"C:\workspace\project"}}]
CODEX_TOOL_CALLS_END`,
    String.raw`CODEX\_TOOL\_CALLS\_BEGIN nonce=test-nonce
\[{"name":"exec","arguments":{"command":"Get-Content","workdir":"C:\\workspace\\project"}}\]
CODEX\_TOOL\_CALLS\_END`,
    "test-nonce",
    tools,
  );
  expect(parsed.calls?.[0]?.arguments?.workdir).toBe("C:\\workspace\\project");
});

test("prompt relay prefers DOM text for multiline freeform input", () => {
  const payload = JSON.stringify([{ name: "apply_patch", input: "*** Begin Patch\n+alpha\n*** End Patch" }]);
  const parsed = parsePromptRelayDomResponse(
    `CODEX_TOOL_CALLS_BEGIN nonce=test-nonce\n${payload}\nCODEX_TOOL_CALLS_END`,
    "not valid relay Markdown",
    "test-nonce",
    tools,
  );
  expect(parsed.calls?.[0]?.input).toBe("*** Begin Patch\n+alpha\n*** End Patch");
});

test("prompt relay falls back when DOM closing-marker rendering is incomplete", () => {
  const parsed = parsePromptRelayDomResponse(
    'CODEX_TOOL_CALLS_BEGIN nonce=test-nonce\n[{"name":"exec","arguments":{"command":"pwd"}}]',
    String.raw`CODEX\_TOOL\_CALLS\_BEGIN nonce=test-nonce
\[{"name":"exec","arguments":{"command":"pwd"}}\]
CODEX\_TOOL\_CALLS\_END`,
    "test-nonce",
    tools,
  );
  expect(parsed.calls?.[0]?.arguments?.command).toBe("pwd");
});

test("prompt relay fails closed for invalid nonce, unknown tools, and trailing output", () => {
  expect(() => parsePromptRelayResponse(
    'CODEX_TOOL_CALLS_BEGIN nonce=wrong\n[{"name":"exec","arguments":{}}]\nCODEX_TOOL_CALLS_END',
    "right",
    tools,
  )).toThrow("invalid turn nonce");
  expect(() => parsePromptRelayResponse(
    'CODEX_TOOL_CALLS_BEGIN nonce=right\n[{"name":"delete_everything","arguments":{}}]\nCODEX_TOOL_CALLS_END',
    "right",
    tools,
  )).toThrow("unavailable Codex tool");
  expect(() => parsePromptRelayResponse(
    'CODEX_TOOL_CALLS_BEGIN nonce=right\n[{"name":"exec","arguments":{}}]\nCODEX_TOOL_CALLS_END\nfinal',
    "right",
    tools,
  )).toThrow("non-terminal");
});

test("prompt relay serializes authoritative Codex results for continuation", () => {
  const continuation = promptRelayResults(
    "nonce",
    [{ callId: "call_1", wireName: "exec" }],
    [{ content: [{ type: "text", text: "ok" }], structuredContent: { exitCode: 0 } }],
  );
  expect(continuation.text).toContain('"call_id":"call_1"');
  expect(continuation.text).toContain('"exitCode":0');
  expect(continuation.images).toEqual([]);
});

test("prompt relay correction keeps the nonce and only retries framing errors", () => {
  expect(promptRelayCorrection("nonce-123", "invalid JSON")).toContain(
    "CODEX_TOOL_CALLS_BEGIN nonce=nonce-123",
  );
  expect(isRecoverablePromptRelayFormatError(
    new Error("ChatGPT emitted invalid JSON in the tool-call block"),
  )).toBe(true);
  expect(isRecoverablePromptRelayFormatError(
    new Error("ChatGPT emitted a tool-call block with an invalid turn nonce"),
  )).toBe(false);
});
