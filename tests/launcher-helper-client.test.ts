import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { validateBrowserHelperPreparedPrompt } from "../src/adapters/chatgpt-web/browser-helper-prompt";
import type { ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_COMPACTION_CONTEXT_FILENAME } from "../src/adapters/chatgpt-web/prompt";
import { LAUNCHER_BROWSER_HOST_KIND } from "../src/launcher-browser-host";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Bun daemon streams a prepared browser turn through the persistent Node helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-client-"));
  roots.push(root);
  const helper = join(root, "helper.cjs");
  writeFileSync(helper, `
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "run") return;
      send({ type: "event", id: message.id, event: "reasoning", text: "Reading project" });
      send({ type: "event", id: message.id, event: "reasoning", text: " files", continuation: true });
      send({ type: "event", id: message.id, event: "text", text: "done" });
      send({ type: "result", id: message.id, text: JSON.stringify(message.turn.prepared) });
    });
  `, { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39001",
    control: {
      endpoint: "http://127.0.0.1:39002",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const config: ResolvedBrowserConfig = {
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  };
  const reasoning: Array<{ text: string; continuation: boolean }> = [];
  const deltas: string[] = [];
  let released = false;
  const contextText = `<codex_context_json>\n${JSON.stringify({
    unicode: "مرحبا 世界",
    lines: "one\ntwo",
    delimiters: "<tag>quoted \\\"value\\\" \\\\ path-like text",
  })}\n</codex_context_json>`;
  const client = new LauncherBrowserHelperClient(config);
  try {
    const result = await client.run({
      traceId: "abcdef123456",
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      capabilities: { localToolsEnabled: false, proAvailable: false },
      prepare: async () => ({
        text: "inspect",
        images: [],
        contextAttachment: {
          name: CHATGPT_COMPACTION_CONTEXT_FILENAME,
          mimeType: "text/plain",
          text: contextText,
        },
        release: () => { released = true; },
      }),
      onReasoningSummary: (text, continuation) => reasoning.push({ text, continuation: continuation === true }),
      onTextDelta: text => deltas.push(text),
    });
    expect(JSON.parse(result)).toEqual({
      text: "inspect",
      images: [],
      contextAttachment: {
        name: CHATGPT_COMPACTION_CONTEXT_FILENAME,
        mimeType: "text/plain",
        text: contextText,
      },
    });
    expect(reasoning).toEqual([
      { text: "Reading project", continuation: false },
      { text: " files", continuation: true },
    ]);
    expect(deltas).toEqual(["done"]);
    expect(released).toBe(true);
  } finally {
    await client.close();
  }
});

test("an abort dispatched during run submission cannot overtake the run frame", async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  let released = false;
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    turnTimeoutMs: 60_000,
    headed: true,
    autoApproveToolCalls: false,
  });
  const internal = client as unknown as {
    ensureChild(): Promise<void>;
    send(message: { type: string; id?: string }): Promise<void>;
    finishWithError(id: string, error: Error): void;
  };
  internal.ensureChild = async () => {};
  internal.send = async message => {
    messages.push(message.type);
    if (message.type === "run") controller.abort();
    if (message.type === "abort" && message.id) {
      queueMicrotask(() => internal.finishWithError(
        message.id!,
        new DOMException("ChatGPT web turn aborted", "AbortError"),
      ));
    }
  };

  await expect(client.run({
    traceId: "abort-order-123",
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, proAvailable: false },
    abortSignal: controller.signal,
    prepare: async () => ({
      text: "inspect",
      images: [],
      contextAttachment: null,
      release: () => { released = true; },
    }),
    onTextDelta: () => {},
  })).rejects.toMatchObject({ name: "AbortError" });

  expect(messages).toEqual(["run", "abort"]);
  expect(released).toBe(true);
});

test("browser helper accepts only the exact in-memory compaction attachment shape", () => {
  const valid = {
    text: "summarize",
    images: [],
    contextAttachment: {
      name: CHATGPT_COMPACTION_CONTEXT_FILENAME,
      mimeType: "text/plain" as const,
      text: "<codex_context_json>\n{}\n</codex_context_json>",
    },
  };
  expect(validateBrowserHelperPreparedPrompt(valid)).toBe(valid);
  expect(() => validateBrowserHelperPreparedPrompt({
    text: "summarize",
    images: [],
  })).toThrow("Browser helper context attachment is invalid");

  const invalidAttachments: unknown[] = [
    [],
    { mimeType: "text/plain", text: "context" },
    { name: CHATGPT_COMPACTION_CONTEXT_FILENAME, mimeType: "application/json", text: "context" },
    { name: CHATGPT_COMPACTION_CONTEXT_FILENAME, mimeType: "text/plain" },
    { name: CHATGPT_COMPACTION_CONTEXT_FILENAME, mimeType: "text/plain", text: 42 },
    { name: CHATGPT_COMPACTION_CONTEXT_FILENAME, mimeType: "text/plain", text: "" },
    {
      name: CHATGPT_COMPACTION_CONTEXT_FILENAME,
      mimeType: "text/plain",
      text: "<codex_context_json>\n{}\n</codex_context_json>",
      path: "C:\\temp\\context.txt",
    },
  ];
  for (const contextAttachment of invalidAttachments) {
    expect(() => validateBrowserHelperPreparedPrompt({
      text: "summarize",
      images: [],
      contextAttachment,
    })).toThrow("Browser helper context attachment is invalid");
  }
});
