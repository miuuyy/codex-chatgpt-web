import { expect, test } from "bun:test";
import {
  parseChatGptWebCompactionExecution,
  parseChatGptWebCompactionModel,
  resolveChatGptWebCompactionPlan,
  type ChatGptWebCompactionModel,
} from "../src/chatgpt-web-compaction-policy";
import type { CodexParsedRequest } from "../src/types";

function compactRequest(overrides: Partial<CodexParsedRequest> = {}): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: false,
    context: { messages: [{ role: "user", content: "Compact this task", timestamp: 1 }] },
    options: { reasoning: "max" },
    _compactionRequest: true,
    _rawBody: { marker: "source" },
    ...overrides,
  };
}

test.each([
  ["extra-high", "xhigh", { effort: "xhigh", modelVersion: "5.6" }],
  ["5.6-pro", "max", { effort: "max", modelVersion: "5.6" }],
  ["5.5-pro", "max", { effort: "max", modelVersion: "5.5" }],
] as const)("%s changes only the compaction execution copy", (configuredModel, reasoning, expectedExecution) => {
  const source = compactRequest();
  const before = structuredClone(source);
  const plan = resolveChatGptWebCompactionPlan(source, configuredModel, {
    localToolsEnabled: true,
    solAvailable: true,
    proAvailable: true,
  });

  expect(plan.execution).not.toBe(source);
  expect(plan.execution.options).not.toBe(source.options);
  expect(plan.execution.options.reasoning).toBe(reasoning);
  expect(plan.compactionExecution).toEqual(expectedExecution);
  expect(source).toEqual(before);
  expect(plan.execution.context).toBe(source.context);
  expect(plan.execution._rawBody).toBe(source._rawBody);
});

test("an omitted compaction model follows the main turn without an execution override", () => {
  const source = compactRequest();
  expect(resolveChatGptWebCompactionPlan(source, undefined, {
    localToolsEnabled: false,
    solAvailable: true,
    proAvailable: true,
  })).toEqual({ execution: source });
});

test.each([
  ["normal turn", { _compactionRequest: false }],
  ["non-Pro effort", { options: { reasoning: "high" } }],
  ["Luna backend", { modelId: "gpt-5.6-luna" }],
  ["Zero Risk backend", { modelId: "chatgpt-web-zero-risk" }],
] as const)("explicit compaction policy does not affect a %s", (_label, requestOverrides) => {
  const source = compactRequest(requestOverrides as Partial<CodexParsedRequest>);
  expect(resolveChatGptWebCompactionPlan(source, "extra-high", {
    localToolsEnabled: true,
    solAvailable: true,
    proAvailable: true,
  })).toEqual({ execution: source });
});

test.each([
  [false, true],
  [true, false],
  [false, false],
] as const)("explicit compaction policy requires Sol=%s and Pro=%s eligibility", (solAvailable, proAvailable) => {
  const source = compactRequest();
  expect(resolveChatGptWebCompactionPlan(source, "5.6-pro", {
    localToolsEnabled: true,
    solAvailable,
    proAvailable,
  })).toEqual({ execution: source });
});

test.each([
  [undefined, undefined],
  ["extra-high", "extra-high"],
  ["5.6-pro", "5.6-pro"],
  ["5.5-pro", "5.5-pro"],
] as const)("compaction model parser accepts %p", (value, expected) => {
  expect(parseChatGptWebCompactionModel(value)).toBe(expected as ChatGptWebCompactionModel | undefined);
});

test.each([null, true, "follow", "xhigh", "max", "5.7-pro"]) (
  "invalid compaction model %p is rejected",
  value => expect(() => parseChatGptWebCompactionModel(value)).toThrow("Invalid compactionModel"),
);

test.each([
  [{ effort: "xhigh", modelVersion: "5.6" }, { effort: "xhigh", modelVersion: "5.6" }],
  [{ effort: "max", modelVersion: "5.6" }, { effort: "max", modelVersion: "5.6" }],
  [{ effort: "max", modelVersion: "5.5" }, { effort: "max", modelVersion: "5.5" }],
] as const)("compaction execution parser accepts the exact %p contract", (value, expected) => {
  expect(parseChatGptWebCompactionExecution(value)).toEqual(expected);
});

test.each([
  [undefined],
  [null],
  [{ effort: "max" }],
  [{ effort: "xhigh" }],
  [{ effort: "xhigh", modelVersion: "5.5" }],
  [{ effort: "high" }],
  [{ effort: "max", modelVersion: "6" }],
  [{ effort: "max", modelVersion: "5.6", extra: true }],
])("invalid compaction execution %p is rejected", value => {
  expect(() => parseChatGptWebCompactionExecution(value)).toThrow("Invalid compaction execution");
});
