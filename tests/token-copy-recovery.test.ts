import { expect, test } from "bun:test";
import { ChatGptTokenCopyObserver, runWithTokenCopyRecovery } from "../src/adapters/chatgpt-web/token-copy-recovery";
import { ChatGptStreamProjection } from "../src/adapters/chatgpt-web/stream-diagnostics";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { compileBiggerContextPrompt } from "../src/adapters/chatgpt-web/usage";
import { parseRequest } from "../src/responses/parser";

const token = `turn_${"A".repeat(31)}Z`;
const connector = "/Codex Native2/link_" + "a".repeat(32);
const user = { id: "user-current", author: { role: "user" }, create_time: 10, content: { content_type: "text", parts: ["task"] } };
const call = (copy: string, extra = {}) => ({ id: "call-current", author: { role: "assistant" }, recipient: "api_tool.call_tool",
  create_time: 11, status: "finished_successfully", content: { content_type: "code", text: JSON.stringify({
    path: connector + "/codex_exec", args: { turn_token: copy, cmd: "printf TEST" },
  }) }, ...extra });
const frame = (event: unknown) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`);

test("the observed 37-to-36 character copy error is detected without accepting a repaired token", () => {
  let rejected = 0;
  const observer = new ChatGptTokenCopyObserver(token, connector, () => { rejected++; });
  const projection = new ChatGptStreamProjection(observer);
  projection.push(frame({ message: user }));
  projection.push(frame({ v: { message: call(token.slice(0, -1)) } }));
  projection.push(frame({ message: call(token.slice(0, -1)) }));
  expect(rejected).toBe(1);
  expect(JSON.stringify(projection.snapshot())).not.toContain(token);
});

test("streamed tool code is checked only after its completed status", () => {
  let rejected = 0;
  const observer = new ChatGptTokenCopyObserver(token, connector, () => { rejected++; });
  observer.accept({ message: user });
  const full = call(token.slice(0, -1));
  observer.accept({ message: { ...full, status: "in_progress", content: { content_type: "code", text: "" } } });
  observer.accept({ p: "/message/content/text", o: "append", v: full.content.text.slice(0, 60) });
  observer.accept({ v: full.content.text.slice(60) });
  expect(rejected).toBe(0);
  observer.accept({ p: "", o: "patch", v: [{ p: "/message/status", o: "replace", v: "finished_successfully" }] });
  expect(rejected).toBe(1);
});

test("nested protocol patches preserve the owned user and tool-call boundaries", () => {
  let rejected = 0;
  const observer = new ChatGptTokenCopyObserver(token, connector, () => { rejected++; });
  observer.accept({ p: "", o: "patch", v: [
    { p: "", o: "add", v: { message: user } },
    { p: "/message", o: "replace", v: call(token.slice(0, -1)) },
  ] });
  expect(rejected).toBe(1);
});

test("correct tokens, old messages, foreign tools and quoted token errors cannot trigger recovery", () => {
  let rejected = 0;
  const observer = new ChatGptTokenCopyObserver(token, connector, () => { rejected++; });
  observer.accept({ message: call(token.slice(0, -1)) }); // No current user boundary.
  observer.accept({ message: user });
  observer.accept({ message: call(token) });
  observer.accept({ message: call(`turn_${"B".repeat(32)}`) });
  observer.accept({ message: call(token.slice(0, -1), { create_time: 1 }) });
  observer.accept({ message: call(token.slice(0, -1), { recipient: "all" }) });
  observer.accept({ message: { ...call(token.slice(0, -1)), content: { content_type: "text", parts: ["invalid token"] } } });
  observer.accept({ message: { ...call(token.slice(0, -1)), content: { content_type: "code",
    text: JSON.stringify({ path: "/other-plugin/search", args: { turn_token: "bad" } }) } } });
  expect(rejected).toBe(0);
});

test.each([
  "/Other Connector/link_" + "a".repeat(32),
  "/Codex Native2/link_" + "b".repeat(32),
  connector + "/extra",
])("a lookalike connector namespace cannot authorize retry (%s)", namespace => {
  let rejected = 0;
  const observer = new ChatGptTokenCopyObserver(token, connector, () => { rejected++; });
  observer.accept({ message: user });
  observer.accept({ message: call(token.slice(0, -1), {
    content: { content_type: "code",
      text: JSON.stringify({ path: namespace + "/codex_exec", args: { turn_token: token.slice(0, -1) } }) },
  }) });
  expect(rejected).toBe(0);
});

test("a valid call observed before broker progress makes a later malformed call unsafe to replay", () => {
  let rejected = 0;
  const observer = new ChatGptTokenCopyObserver(token, connector, () => { rejected++; });
  observer.accept({ message: user });
  observer.accept({ message: call(token, { status: "in_progress" }) });
  observer.accept({ message: call(token.slice(0, -1), { id: "call-later" }) });
  expect(rejected).toBe(0);
});

test("a malformed value unrelated to the supplied token does not authorize replay", () => {
  let rejected = 0;
  const observer = new ChatGptTokenCopyObserver(token, connector, () => { rejected++; });
  observer.accept({ message: user });
  observer.accept({ message: call("turn_short") });
  expect(rejected).toBe(0);
});

const rejected = () => new ChatGptWebAdapterError("Observed mismatched tool capability", {
  status: 400, errorType: "invalid_request_error", code: "chatgpt_token_copy_error", retryable: false, tokenCopyRejected: true,
});
const turn = (): BrowserTurn => {
  const prepared = { text: `Complete original history\nPass turn_token ${token}`, images: [], turnToken: token, release() {} };
  return { traceId: crypto.randomUUID(), modelId: "gpt-5.6-sol",
    capabilities: { localToolsEnabled: true, solAvailable: true, extraHighAvailable: false, proAvailable: false },
    prepare: async () => prepared,
    prepareTokenCopyRetry: async () => ({ ...prepared, text: prepared.text + "\n<codex_token_copy_recovery>" }),
    onTextDelta() {},
  };
};

test.each([false, true])("a malformed copy retries with one exact capability (multipart=%s)", async multipart => {
  let starts = 0;
  const original = turn();
  const prepareRetry = original.prepareTokenCopyRetry!;
  if (multipart) {
    original.prepareTokenCopyRetry = async () => {
      const prepared = await prepareRetry();
      return { ...prepared, multipart: { parts: ["stage"], commit: prepared.text } };
    };
  }
  const result = await runWithTokenCopyRecovery(original, async next => {
    starts++;
    if (starts === 1) throw rejected();
    const prepared = await next.prepare();
    expect(prepared.text).toContain("Complete original history");
    expect(prepared.text.match(new RegExp(token, "g"))).toEqual([token]);
    expect(prepared.text).toContain("<codex_token_copy_recovery>");
    if (multipart) {
      expect(prepared.multipart?.parts).toEqual(["stage"]);
      expect(prepared.multipart?.commit).toBe(prepared.text);
    }
    expect(next.prepareResume).toBeUndefined();
    return "Task completed";
  });
  expect(result).toBe("Task completed");
  expect(starts).toBe(2);
});

test("retry guidance is counted before selecting an upload at the native composer boundary", async () => {
  const original = turn();
  original.capabilities.proAvailable = true;
  const parsed = parseRequest({ model: original.modelId, reasoning: { effort: "high" }, input: "" });
  const empty = compileChatGptWebPrompt(parsed, original.capabilities, token);
  parsed.context.messages.at(-1)!.content = " ".repeat(500_000 - empty.text.length);
  expect(compileChatGptWebPrompt(parsed, original.capabilities, token).text.length).toBe(500_000);
  const transactionId = "ctx_0123456789abcdef0123456789abcdef";
  const prepare = async (multipartTransactionId?: string, tokenCopyRecovery?: true) => ({
    ...compileBiggerContextPrompt(parsed, original.capabilities, token, { tokenCopyRecovery, multipartTransactionId }), release() {},
  });
  original.prepare = id => prepare(id);
  original.prepareTokenCopyRetry = id => prepare(id, true);
  let attempts = 0;
  await runWithTokenCopyRecovery(original, async next => {
    const ready = await next.prepare(transactionId);
    if (++attempts === 1) {
      expect(ready.multipart).toBeUndefined();
      throw rejected();
    }
    expect(ready.multipart?.parts).toHaveLength(2);
    expect(ready.text).toContain("<codex_token_copy_recovery>");
    expect(ready.text.split(token)).toHaveLength(2);
    return "Completed";
  });
  expect(attempts).toBe(2);
}, 15_000);

test("token recovery requires an explicitly budgeted retry prompt", async () => {
  let starts = 0;
  await expect(runWithTokenCopyRecovery({ ...turn(), prepareTokenCopyRetry: undefined }, async () => {
    starts++;
    throw rejected();
  })).rejects.toMatchObject({ code: "chatgpt_token_copy_error" });
  expect(starts).toBe(1);
});

for (const scenario of ["tool-executed", "tool-active", "output", "commentary", "cancelled", "unknown"])
test(`token retry preserves the ${scenario} boundary`, async () => {
  const original = turn();let starts = 0;
  if (scenario === "tool-executed" || scenario === "tool-active") {
    const progress = new ChatGptExternalTurnProgress();progress.recordToolBatch(1);
    if (scenario === "tool-executed") progress.recordToolResult();
    original.externalProgress = progress;
  }
  if (scenario === "cancelled") original.abortSignal = AbortSignal.abort();
  await expect(runWithTokenCopyRecovery(original, async next => {
    starts++;if (scenario === "output") next.onTextDelta("Already shown");
    if (scenario === "commentary") next.onCommentary?.("Already shown");
    if (scenario === "unknown") throw new Error("Unclassified error");
    throw rejected();
  })).rejects.toThrow();
  expect(starts).toBe(1);
});

test("token copying retries are finite", async () => {
  let starts = 0;
  await expect(runWithTokenCopyRecovery(turn(), async () => { starts++;throw rejected(); })).rejects.toThrow();
  expect(starts).toBe(3);
});


test("an earlier native ChatGPT tool prevents automatic capability replay", () => {
  let rejected = 0;
  const observer = new ChatGptTokenCopyObserver(token, connector, () => { rejected++; });
  observer.accept({ message: user });
  observer.accept({ message: {
    id: "native-web-call", author: { role: "assistant" }, create_time: 11,
    recipient: "web.run", status: "finished_successfully",
    content: { content_type: "code", text: '{"search_query":[{"q":"fixture"}]}' },
  } });
  observer.accept({ message: call(token.slice(0, -1)) });
  expect(rejected).toBe(0);
});
