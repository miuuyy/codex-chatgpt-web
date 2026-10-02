import { expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";
import { PreparedChatGptTurnStore } from "../src/adapters/chatgpt-web/prepared-turn";

function fixture() {
  const parsed = parseRequest({ model: "chatgpt-web/gpt-5.6-sol", input: "Continue", reasoning: { effort: "high" } });
  const environment = { cwd: "/workspace", roots: ["/workspace"], writableRoots: ["/workspace"], sandboxPolicy: { type: "dangerFullAccess" as const }, tools: [] };
  const store = new PreparedChatGptTurnStore();
  store.prepare(parsed, environment);
  return { parsed, environment, store };
}

test("prepared authority is isolated from caller mutation", () => {
  const f = fixture();
  f.environment.cwd = "/changed";
  const received = f.store.get(f.parsed)!;
  expect(received.cwd).toBe("/workspace");
  received.roots.push("/other");
  expect(f.store.get(f.parsed)!.roots).toEqual(["/workspace"]);
});

for (const field of ["body", "model", "effort", "tools"] as const) test(`prepared authority rejects changed ${field}`, () => {
  const f = fixture();
  if (field === "body") (f.parsed._rawBody as any).input = "Different request";
  if (field === "model") f.parsed.modelId = "different-model";
  if (field === "effort") f.parsed.options.reasoning = "medium";
  if (field === "tools") f.parsed.context.tools = [{ name: "unexpected_tool", description: "", parameters: {} }];
  expect(() => f.store.get(f.parsed)).toThrow("changed after execution admission");
});
