import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGptWebAdapterError } from "../src/adapters/chatgpt-web/adapter-error";
import type { BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMessageLimitStore, runWithMessageLimitRecovery } from "../src/adapters/chatgpt-web/message-limit-recovery";
import { compileChatGptWebPrompt } from "../src/adapters/chatgpt-web/prompt";
import { compiledChatGptWebMessages, estimateCompiledChatGptWebInputTokens } from "../src/adapters/chatgpt-web/input-tokens";
import { estimateChatGptWebUsage, resolveBiggerContextMultipartParts } from "../src/adapters/chatgpt-web/usage";
import { parseRequest } from "../src/responses/parser";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web/index";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptTurnSessions, ChatGptTraceFeed, ChatGptTextFeed } from "../src/adapters/chatgpt-web/turn-execution";
import type { AdapterEvent, CodexProviderConfig } from "../src/types";

const rejection = (size = { chars: 174_000, tokens: 46_000 }) => new ChatGptWebAdapterError("Observed size rejection", {
  status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false,
  inputRejected: true, rejectedMessageSize: size,
});
const baseTurn = (): BrowserTurn => ({ traceId: crypto.randomUUID(), modelId: "gpt-5.6-sol", modelFamily: "6",
  reasoning: "high", capabilities: { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false },
  prepare: async () => ({ text: "data", images: [], release() {} }), onTextDelta() {},
});

test("confirmed rejection recompiles before retrying with full history and remembers a smaller budget", async () => {
  const key = crypto.randomUUID();
  const store = new ChatGptMessageLimitStore();
  const turn = { ...baseTurn(), conversationKey: "previous", retainConversation: true,
    prepareResume: async () => ({ text: "suffix", images: [], release() {} }) };
  let compiled = false;
  let starts = 0;
  const result = await runWithMessageLimitRecovery(turn, async next => {
    starts++;
    if (starts === 1) { await next.onSubmitted?.(); throw rejection(); }
    expect(compiled).toBeTrue();
    expect(next.conversationKey).toBeUndefined();
    expect(next.traceId).toBe(`${turn.traceId}_size1`);
    expect(next.prepareResume).toBeUndefined();
    expect((await next.prepare()).text).toBe("data");
    next.onTextDelta("Recovered");
    return "Recovered";
  }, key, limits => { compiled = true; expect(limits.chars).toBeLessThan(174_000); }, store);
  expect(result).toBe("Recovered");
  expect(starts).toBe(2);
  expect(store.get(key)?.tokens).toBeLessThan(46_000);
});

test("confirmed message limits survive a restart and expire without affecting another route", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-message-limits-"));
  const path = join(root, "limits.json");
  let now = 1_000_000;
  try {
    const store = new ChatGptMessageLimitStore(path, () => now);
    let attempts = 0;
    await runWithMessageLimitRecovery(baseTurn(), async () => {
      if (++attempts === 1) throw rejection();
      return "Recovered";
    }, "6/high", () => {}, store);
    expect(ChatGptMessageLimitStore.forProfile(path)).toBe(ChatGptMessageLimitStore.forProfile(path));
    now += 2 * 60 * 60_000;
    const restarted = new ChatGptMessageLimitStore(path, () => now);
    expect(restarted.get("6/high")).toEqual({ chars: 113_100, tokens: 29_900 });
    expect(restarted.get("5.6/high")).toBeUndefined();
    now += 24 * 60 * 60_000;
    expect(new ChatGptMessageLimitStore(path, () => now).get("6/high")).toBeUndefined();
    writeFileSync(path, "{truncated");
    expect(new ChatGptMessageLimitStore(path, () => now).get("6/high")).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const scenario of ["generic", "preflight", "output", "tools", "cancelled"])
test(`message recovery refuses ${scenario} replay`, async () => {
  const turn = baseTurn();
  if (scenario === "tools") {
    const progress = new ChatGptExternalTurnProgress();
    progress.recordToolBatch(1); progress.recordToolResult();
    turn.externalProgress = progress;
  }
  if (scenario === "cancelled") turn.abortSignal = AbortSignal.abort();
  let starts = 0;
  await expect(runWithMessageLimitRecovery(turn, async next => {
    starts++;
    if (scenario === "output") next.onTextDelta("Already shown");
    if (scenario === "generic") throw new Error("Something went wrong");
    if (scenario === "preflight") throw new ChatGptWebAdapterError("Too large", {
      status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false,
    });
    throw rejection();
  }, crypto.randomUUID(), () => { throw new Error("must not recompile"); }, new ChatGptMessageLimitStore())).rejects.toThrow();
  expect(starts).toBe(1);
});

test("recovery has a finite budget even when the server keeps rejecting", async () => {
  let starts = 0;
  await expect(runWithMessageLimitRecovery(baseTurn(), async () => { starts++; throw rejection(); },
    crypto.randomUUID(), () => {}, new ChatGptMessageLimitStore())).rejects.toThrow("Observed size rejection");
  expect(starts).toBe(4);
});

test("closing a recovery attempt cancels its logical owner and waits for physical settlement", async () => {
  const sessions = new ChatGptTurnSessions();
  const browser = Promise.withResolvers<string>();
  const traceId = crypto.randomUUID();
  let cancelled = false;
  const runtime = { mode: "read-only" as const, browser: browser.promise,
    physicalSettlement: browser.promise.then(() => {}, () => {}),
    browserTraceIds: new Set([traceId, `${traceId}_size1`]),
    trace: new ChatGptTraceFeed(), text: new ChatGptTextFeed(),
    cancel: (reason?: Error) => { cancelled = true; browser.reject(reason); } };
  sessions.getOrCreate("test", () => runtime, traceId);
  expect(await sessions.cancelTrace(`${traceId}_size1`)).toBe(1);
  expect(cancelled).toBeTrue();
  expect(sessions.cancelledError(`${traceId}_size1`)).toBeDefined();
  sessions.clear();
});

test("fragmented transport preserves every byte of oversized records, roles and order", () => {
  const content = 'Unicode 😀 Привет and JSON {"key":"value"} <tag>\\n '.repeat(1600);
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: [
    { role: "developer", content: "Keep instructions" }, { role: "user", content },
  ] });
  const compiled = compileChatGptWebPrompt(parsed, baseTurn().capabilities, undefined, {
    experimentalMultipartParts: 6, messageLimits: { chars: 75_000, tokens: 22_000 },
  });
  const records = compiled.multipart!.parts.flatMap(part => JSON.parse(part).records);
  expect(compiled.preserveContextDuringStaging).toBeTrue();
  const fragments = records.filter(record => record.kind === "record_fragment");
  expect(fragments.length).toBeGreaterThan(1);
  const reconstructed = JSON.parse(fragments.map(record => record.json).join(""));
  expect(reconstructed).toMatchObject({ kind: "message", message_index: 1, message: { role: "user", content } });
  expect(fragments.map(record => record.fragment_index)).toEqual(fragments.map((_, index) => index));
  expect(fragments.every(record => record.total_fragments === fragments.length)).toBeTrue();
  expect(records[0]).toMatchObject({ kind: "message", message_index: 0, message: { role: "developer" } });
  expect(compiledChatGptWebMessages(compiled).every(text => text.length <= 75_000)).toBeTrue();
});

test("learned limits keep small requests inline and usage counts the complete staged transaction", () => {
  const capabilities = baseTurn().capabilities;
  const limits = { chars: 24_000, tokens: 12_000 };
  const small = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: "Hello" });
  expect(resolveBiggerContextMultipartParts(small, capabilities, false, undefined, limits)).toBeUndefined();
  const large = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: "source data ".repeat(3_500) });
  const parts = resolveBiggerContextMultipartParts(large, capabilities, false, undefined, limits);
  expect(parts).toBeGreaterThan(1);
  const compiled = compileChatGptWebPrompt(large, capabilities, undefined, { experimentalMultipartParts: parts, messageLimits: limits });
  const usage = estimateChatGptWebUsage(large, { answer: "OK" }, capabilities, true, false, undefined, limits);
  expect(usage.inputTokens).toBe(estimateCompiledChatGptWebInputTokens(compiled, large.modelId));
  expect(compiledChatGptWebMessages(compiled).every(message => message.length <= limits.chars)).toBeTrue();
});

test("the normal Responses adapter recovers without exposing an intermediate error or losing history", async () => {
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://${crypto.randomUUID()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, experimentalBiggerContext: true } };
  const worker = ChatGptBrowserWorker.forProvider(provider);
  const original = worker.run;
  let starts = 0;
  worker.run = async turn => {
    const prepared = await turn.prepare(); starts++;
    if (starts === 1) { expect(prepared.multipart).toBeUndefined(); throw rejection(); }
    expect(prepared.multipart?.parts.length).toBeGreaterThan(1);
    expect(JSON.stringify(prepared.multipart!.parts.flatMap(part => JSON.parse(part).records))).toContain("PRESERVE_THIS_RECORD");
    turn.onTextDelta("Recovered answer");
    return "Recovered answer";
  };
  try {
    const events: AdapterEvent[] = [];
    const turnId = crypto.randomUUID();
    const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: crypto.randomUUID(), turn_id: turnId }) },
      input: [{ type: "message", role: "user", content: "PRESERVE_THIS_RECORD " + "padding ".repeat(16000),
        internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["user.text"] } }] });
    parsed._chatgptModelFamily = "6";
    await createChatGptWebAdapter(provider).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    expect(starts).toBe(2);
    expect(events.some(event => event.type === "error")).toBeFalse();
    expect(events.at(-1)?.type).toBe("done");
  } finally { worker.run = original; }
});

test("switching Plus accounts in one profile isolates learned limits and restores each account after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-account-limits-"));
  const path = join(root, "limits.json");
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://${crypto.randomUUID()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, experimentalBiggerContext: true, messageLimitStatePath: path } };
  const worker = ChatGptBrowserWorker.forProvider(provider), original = worker.run;
  const accountA = "a".repeat(64), accountB = "b".repeat(64);
  let account: string | undefined = accountA, rejectNext = true;
  let rejectedSize = { chars: 174_000, tokens: 46_000 };
  const prepared: boolean[] = [];
  worker.run = async turn => {
    // The browser/helper supplies this identity before the daemon compiles the selected prompt.
    expect(turn.accountScopedMessageLimits).toBeTrue();
    await turn.onPreparedSelected?.(false, undefined, account);
    const prompt = await turn.prepare(); prepared.push(prompt.multipart !== undefined);
    if (rejectNext) { rejectNext = false; throw rejection(rejectedSize); }
    turn.onTextDelta("Recovered answer"); return "Recovered answer";
  };
  const run = async () => {
    const turnId = crypto.randomUUID();
    const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "high" },
      client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: crypto.randomUUID(), turn_id: turnId }) },
      input: [{ type: "message", role: "user", content: "KEEP_ACCOUNT_HISTORY " + "padding ".repeat(16000),
        internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["user.text"] } }] });
    parsed._chatgptModelFamily = "6";
    await createChatGptWebAdapter(provider).runTurn!(parsed, { headers: new Headers() }, () => {});
  };
  try {
    await run(); // A learns a binding fresh-message limit, then recovers.
    await run(); // A's next task uses it.
    account = accountB; await run(); // Same Plus/model/effort/profile, no inherited A limit.
    account = accountA; await run(); // Switching back restores A's own limit.
    account = undefined; await run(); // An unidentified account must not inherit either.
    account = accountB; rejectNext = true; rejectedSize = { chars: 200_000, tokens: 56_000 };
    await run(); // B learns its own, different limit without narrowing A.
    expect(prepared).toEqual([false, true, true, false, true, false, false, true]);
    const state = JSON.parse(readFileSync(path, "utf8"));
    expect(state.entries).toHaveLength(2);
    const restarted = new ChatGptMessageLimitStore(path);
    const keyA = state.entries.find((entry: { key: string }) => entry.key.includes(accountA)).key;
    const keyB = state.entries.find((entry: { key: string }) => entry.key.includes(accountB)).key;
    expect(restarted.get(keyA)).toEqual({ chars: 113_100, tokens: 29_900 });
    expect(restarted.get(keyB)).toEqual({ chars: 130_000, tokens: 36_400 });
    expect(keyA).not.toBe(keyB);
  } finally { worker.run = original; rmSync(root, { recursive: true, force: true }); }
});

test("unidentified-account recovery is operation-local and never persists unscoped limits", async () => {
  const root = mkdtempSync(join(tmpdir(), "cgw-unidentified-limits-"));
  const path = join(root, "limits.json"), store = new ChatGptMessageLimitStore(path);
  let attempts = 0;
  try {
    const result = await runWithMessageLimitRecovery(baseTurn(), async () => {
      if (++attempts === 1) throw rejection();
      return "Recovered";
    }, () => undefined, () => {}, store);
    expect(result).toBe("Recovered");
    expect(attempts).toBe(2);
    expect(store.get("unidentified")).toBeUndefined();
    expect(() => readFileSync(path)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("GPT-6 Instant does not repeat a size rejection when its transport cannot be changed", async () => {
  const provider: CodexProviderConfig = { adapter: "chatgpt-web", baseUrl: `browser://${crypto.randomUUID()}`,
    chatgptWeb: { localToolsEnabled: false, solAvailable: true, experimentalBiggerContext: true } };
  const worker = ChatGptBrowserWorker.forProvider(provider), original = worker.run;
  let starts = 0;
  worker.run = async turn => { starts++; await turn.prepare(); throw rejection(); };
  const turnId = crypto.randomUUID();
  const parsed = parseRequest({ model: "gpt-5.6-sol", reasoning: { effort: "low" },
    client_metadata: { "x-codex-turn-metadata": JSON.stringify({ thread_id: crypto.randomUUID(), turn_id: turnId }) },
    input: [{ type: "message", role: "user", content: "Instant control",
      internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["user.text"] } }] });
  parsed._chatgptModelFamily = "6";
  try {
    const events: AdapterEvent[] = [];
    await createChatGptWebAdapter(provider).runTurn!(parsed, { headers: new Headers() }, event => events.push(event));
    expect(starts).toBe(1);
    expect(events.filter(event => event.type === "error")).toHaveLength(1);
  } finally { worker.run = original; }
});
