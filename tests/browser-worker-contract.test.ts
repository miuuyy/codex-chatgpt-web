import { expect, test } from "bun:test";
import { ChatGptTurnDomHealthTracker, ChatGptVisibleTraceTracker, chatGptCanonicalComposerText, chatGptComposerPrompt, chatGptEffortLabelsMatch, isChatGptTraceControl, redactChatGptUiDiagnostic } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_INTERNAL_COMPACTION_MARKER, containsChatGptCompactionMarker, stripChatGptTransportMarkers } from "../src/adapters/chatgpt-web/prompt";

test("Firefox normalizes only outer transport line feeds", () => {
  const prompt = "contract line\n{\"message\":\"keeps\\\\nJSON escape\"}\nresume";
  expect(chatGptComposerPrompt("firefox", prompt)).toBe(
    "contract line {\"message\":\"keeps\\\\nJSON escape\"} resume",
  );
  expect(chatGptComposerPrompt("chromium", prompt)).toBe(prompt);
  expect(chatGptCanonicalComposerText("firefox", "plain\u00a0\u00a0spaces")).toBe("plain  spaces");
  expect(chatGptCanonicalComposerText("chromium", "plain\u00a0space")).toBe("plain\u00a0space");
});

test("effort selection is idempotent across rendered whitespace", () => {
  expect(chatGptEffortLabelsMatch("High", "High")).toBe(true);
  expect(chatGptEffortLabelsMatch("Instant", "Instant 5.5")).toBe(true);
  expect(chatGptEffortLabelsMatch("Instant\n5.5", "Instant 5.5")).toBe(true);
  expect(chatGptEffortLabelsMatch("High", "Extra High")).toBe(false);
});

test("browser diagnostics redact context envelopes and capability values", () => {
  const diagnostic = redactChatGptUiDiagnostic(
    "<codex_context_json>private context</codex_context_json> turn_12345678901234567890 binding_12345678901234567890",
  );
  expect(diagnostic).not.toContain("private context");
  expect(diagnostic).not.toContain("12345678901234567890");
  expect(diagnostic).toContain("<codex_context_json>[redacted]</codex_context_json>");
});

test("visible DOM trace emits statuses and stable commentary but withholds the final answer", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  expect(tracker.observe([
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "markdown", text: "The implementation has a concrete state drift." },
  ], false)).toEqual([{ kind: "reasoning", text: "Reviewed architecture documentation" }]);
  const commentaryBlocks = [
    { kind: "status", text: "Reviewed architecture documentation" },
    { kind: "markdown", text: "The implementation has a concrete state drift." },
    { kind: "status", text: "Inspecting runtime evidence" },
    { kind: "markdown", text: "Final answer still streaming" },
  ] as const;
  expect(tracker.observe([...commentaryBlocks], false, 1_000)).toEqual([
    { kind: "commentary", text: "The implementation has a concrete state drift." },
  ]);
  expect(tracker.observe([...commentaryBlocks], false, 1_100)).toEqual([
    { kind: "reasoning", text: "Inspecting runtime evidence" },
  ]);
  expect(tracker.observe([
    { kind: "markdown", text: "Final answer complete" },
  ], true)).toEqual([]);
});

test("visible DOM trace streams a growing commentary block as append-only deltas", () => {
  const tracker = new ChatGptVisibleTraceTracker(100);
  const initial = [
    { kind: "markdown", text: "I’m reading" },
    { kind: "status", text: "Read context file contents" },
  ] as const;
  expect(tracker.observe([...initial], false, 1_000)).toEqual([
    { kind: "commentary", text: "I’m reading" },
  ]);
  const expanded = [
    { kind: "markdown", text: "I’m reading the repository’s mandatory architecture" },
    { kind: "status", text: "Read context file contents" },
  ] as const;
  expect(tracker.observe([...expanded], false, 1_050)).toEqual([
    { kind: "commentary", text: " the repository’s mandatory architecture", continuation: true },
  ]);
  expect(tracker.observe([...expanded], false, 1_100)).toEqual([]);
  expect(tracker.observe([...expanded], false, 1_150)).toEqual([
    { kind: "reasoning", text: "Read context file contents" },
  ]);
});

test("visible DOM trace translates the explicit ChatGPT compaction marker once", () => {
  const tracker = new ChatGptVisibleTraceTracker();
  expect(tracker.observe([
    { kind: "markdown", text: CHATGPT_INTERNAL_COMPACTION_MARKER },
  ], false)).toEqual([{ kind: "reasoning", text: "Context automatically compacted" }]);
  expect(tracker.observe([
    { kind: "status", text: CHATGPT_INTERNAL_COMPACTION_MARKER },
  ], false)).toEqual([]);
  expect(stripChatGptTransportMarkers(
    `Before\n\n${CHATGPT_INTERNAL_COMPACTION_MARKER}\n\nAfter`,
  )).toBe("Before\n\nAfter");
  const partial = "[[CODEX_INTERNAL_CONTEXT_COMPACT";
  expect(containsChatGptCompactionMarker(partial)).toBe(true);
  expect(stripChatGptTransportMarkers(partial)).toBe("");
  expect(new ChatGptVisibleTraceTracker().observe([
    { kind: "markdown", text: partial },
  ], false)).toEqual([{ kind: "reasoning", text: "Context automatically compacted" }]);
});

test("trace parsing excludes the Answer now UI control", () => {
  expect(isChatGptTraceControl({ kind: "status", text: "Answer now" })).toBe(true);
  expect(isChatGptTraceControl({ kind: "status", text: "Reviewing repository invariants" })).toBe(false);
  expect(isChatGptTraceControl({ kind: "markdown", text: "Answer now" })).toBe(false);
});

test("browser DOM health fails closed on a vanished or empty ChatGPT response", () => {
  const missing = new ChatGptTurnDomHealthTracker(1_000, 500);
  const absent = {
    responsePresent: false,
    running: true,
    currentText: "",
    completionActionVisible: false,
  };
  expect(missing.update(absent, 1_000)).toBeUndefined();
  expect(missing.update(absent, 2_000)).toContain("did not create a response DOM");

  const empty = new ChatGptTurnDomHealthTracker(1_000, 500);
  const terminal = {
    ...absent,
    responsePresent: true,
    running: false,
    completionActionVisible: true,
  };
  expect(empty.update(terminal, 1_000)).toBeUndefined();
  expect(empty.update(terminal, 1_500)).toContain("completed without a final answer");
});

test("visible reasoning keeps the browser turn healthy before final assistant markdown exists", () => {
  const health = new ChatGptTurnDomHealthTracker(1_000, 500);
  const reasoning = {
    responsePresent: true,
    running: false,
    currentText: "",
    completionActionVisible: false,
  };
  expect(health.update(reasoning, 1_000)).toBeUndefined();
  expect(health.update(reasoning, 10_000)).toBeUndefined();
});
