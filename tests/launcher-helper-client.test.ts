import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherBrowserHelperClient, parseLauncherBrowserHelperMessage } from "../src/adapters/chatgpt-web/launcher-helper-client";
import { validateBrowserHelperPreparedPrompt } from "../src/adapters/chatgpt-web/browser-helper-prompt";
import { isChatGptTransientLimitError, type BrowserTurn, type ResolvedBrowserConfig } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_TASK_CONTEXT_FILENAME } from "../src/adapters/chatgpt-web/prompt";
import { LAUNCHER_BROWSER_HOST_KIND } from "../src/launcher-browser-host";

const roots: string[] = [];
const validContextText = [
  "<codex_context_json>",
  JSON.stringify({ version: 3, system: [], messages: [] }),
  "</codex_context_json>",
].join("\n");
const validContextAttachment = {
  name: CHATGPT_TASK_CONTEXT_FILENAME,
  mimeType: "text/plain" as const,
  text: validContextText,
};
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
    headed: true,
    autoApproveToolCalls: false,
  };
  const reasoning: Array<{ text: string; continuation: boolean }> = [];
  const deltas: string[] = [];
  let released = false;
  const contextText = `<codex_context_json>\n${JSON.stringify({
    version: 3,
    system: ["مرحبا 世界"],
    messages: [{ role: "user", content: "one\ntwo <tag>quoted \\\"value\\\" \\\\ path-like text" }],
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
          name: CHATGPT_TASK_CONTEXT_FILENAME,
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
        name: CHATGPT_TASK_CONTEXT_FILENAME,
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

test("launcher helper preserves transient-limit identity and rejects malformed tagged errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-errors-"));
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
      if (message.id === "transient_wire_1") {
        send({
          type: "error",
          id: message.id,
          name: "ChatGptTransientLimitError",
          message: "wire message",
          code: "CHATGPT_TRANSIENT_LIMIT",
          stage: "response collection",
          dismissals: 3,
        });
      } else if (message.id === "unknown_wire_2") {
        send({ type: "error", id: message.id, message: "generic helper failure", code: "UNKNOWN_HELPER_ERROR" });
      }
    });
  `, { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39011",
    control: {
      endpoint: "http://127.0.0.1:39012",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789CD",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    headed: true,
    autoApproveToolCalls: false,
  });
  const turn = (traceId: string): BrowserTurn => ({
    traceId,
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, proAvailable: false },
    prepare: async () => ({
      text: "inspect",
      images: [],
      contextAttachment: validContextAttachment,
      release() {},
    }),
    onTextDelta() {},
  });

  try {
    let transient: unknown;
    try { await client.run(turn("transient_wire_1")); }
    catch (error) { transient = error; }
    expect(isChatGptTransientLimitError(transient)).toBe(true);
    expect(transient).toMatchObject({
      code: "CHATGPT_TRANSIENT_LIMIT",
      stage: "response collection",
      dismissals: 3,
    });

    let generic: unknown;
    try { await client.run(turn("unknown_wire_2")); }
    catch (error) { generic = error; }
    expect(generic).toBeInstanceOf(Error);
    expect((generic as Error).message).toBe("generic helper failure");
    expect(isChatGptTransientLimitError(generic)).toBe(false);

    expect(() => parseLauncherBrowserHelperMessage(JSON.stringify({
      type: "error",
      id: "malformed_wire_3",
      message: "malformed transient failure",
      code: "CHATGPT_TRANSIENT_LIMIT",
      stage: "response collection",
      dismissals: "3",
    }))).toThrow("Launcher browser helper transient-limit payload is invalid");
  } finally {
    await client.close();
  }
});

test("rebuilt helpers stop accepting new turns while active turns drain", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-rollover-"));
  roots.push(root);
  const helper = join(root, "helper.cjs");
  const helperSource = (version: string) => `
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    const version = ${JSON.stringify(version)};
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "run") return;
      send({ type: "event", id: message.id, event: "heartbeat" });
      setTimeout(() => send({ type: "result", id: message.id, text: version }), 100);
    });
  `;
  writeFileSync(helper, helperSource("v1"), { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39021",
    control: {
      endpoint: "http://127.0.0.1:39022",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789EF",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    headed: true,
    autoApproveToolCalls: false,
  });
  let firstActive!: () => void;
  const firstActivePromise = new Promise<void>(resolveActive => { firstActive = resolveActive; });
  const turn = (traceId: string, onHeartbeat?: () => void): BrowserTurn => ({
    traceId,
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, proAvailable: false },
    prepare: async () => ({
      text: "inspect",
      images: [],
      contextAttachment: validContextAttachment,
      release() {},
    }),
    onHeartbeat,
    onTextDelta() {},
  });

  try {
    const first = client.run(turn("active_turn_1", firstActive));
    await firstActivePromise;
    writeFileSync(helper, helperSource("v2"), { mode: 0o700 });
    const second = client.run(turn("active_turn_2"));
    const third = client.run(turn("active_turn_3"));
    expect(await Promise.all([first, second, third])).toEqual(["v1", "v2", "v2"]);
  } finally {
    await client.close();
  }
});

test("closing rejects turns waiting behind a stale-helper recycle barrier", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-close-barrier-"));
  roots.push(root);
  const helper = join(root, "helper.cjs");
  const helperSource = (version: string) => `
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    const version = ${JSON.stringify(version)};
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "run") return;
      send({ type: "event", id: message.id, event: "heartbeat" });
      if (version === "v2") send({ type: "result", id: message.id, text: version });
    });
  `;
  writeFileSync(helper, helperSource("v1"), { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39031",
    control: {
      endpoint: "http://127.0.0.1:39032",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789GH",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    headed: true,
    autoApproveToolCalls: false,
  });
  const heartbeat = (traceId: string, onHeartbeat: () => void): BrowserTurn => ({
    traceId,
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, proAvailable: false },
    prepare: async () => ({
      text: "inspect",
      images: [],
      contextAttachment: validContextAttachment,
      release() {},
    }),
    onHeartbeat,
    onTextDelta() {},
  });
  let firstActive!: () => void;
  const firstActivePromise = new Promise<void>(resolveActive => { firstActive = resolveActive; });
  let secondHeartbeat = false;

  const first = client.run(heartbeat("close_barrier_1", firstActive));
  await firstActivePromise;
  writeFileSync(helper, helperSource("v2"), { mode: 0o700 });
  const second = client.run(heartbeat("close_barrier_2", () => { secondHeartbeat = true; }));
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(secondHeartbeat).toBe(false);

  const settled = Promise.allSettled([first, second]);
  await client.close();
  const results = await settled;
  expect(results).toEqual([
    expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) }),
    expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) }),
  ]);
}, 5_000);

test("a stale helper exit rejects its active turn and releases waiting turns to the rebuilt helper", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-helper-exit-barrier-"));
  roots.push(root);
  const helper = join(root, "helper.cjs");
  const helperSource = (version: string) => `
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
    const version = ${JSON.stringify(version)};
    send({ type: "ready" });
    readline.on("line", line => {
      const message = JSON.parse(line);
      if (message.type === "shutdown") process.exit(0);
      if (message.type !== "run") return;
      send({ type: "event", id: message.id, event: "heartbeat" });
      if (version === "v1") setTimeout(() => process.exit(7), 50);
      else send({ type: "result", id: message.id, text: version });
    });
  `;
  writeFileSync(helper, helperSource("v1"), { mode: 0o700 });
  const descriptorPath = join(root, "launcher.json");
  writeFileSync(descriptorPath, `${JSON.stringify({
    version: 1,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    pid: process.pid,
    endpoint: "http://127.0.0.1:39041",
    control: {
      endpoint: "http://127.0.0.1:39042",
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: { executable: process.execPath, script: helper },
    partition: "persist:codex-web-gpt-chatgpt",
    idleUrl: "about:blank#codex-web-gpt-browser-host",
    surfaceId: "launcher_surface_id_0123456789IJ",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    storageStatePath: join(root, "unused-state.json"),
    chromeExecutablePath: join(root, "unused-chrome"),
    headed: true,
    autoApproveToolCalls: false,
  });
  const turn = (traceId: string, onHeartbeat?: () => void): BrowserTurn => ({
    traceId,
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    capabilities: { localToolsEnabled: false, proAvailable: false },
    prepare: async () => ({
      text: "inspect",
      images: [],
      contextAttachment: validContextAttachment,
      release() {},
    }),
    onHeartbeat,
    onTextDelta() {},
  });
  let firstActive!: () => void;
  const firstActivePromise = new Promise<void>(resolveActive => { firstActive = resolveActive; });
  let secondHeartbeat = false;

  try {
    const first = client.run(turn("exit_barrier_1", firstActive));
    await firstActivePromise;
    writeFileSync(helper, helperSource("v2"), { mode: 0o700 });
    const second = client.run(turn("exit_barrier_2", () => { secondHeartbeat = true; }));
    await expect(first).rejects.toThrow("with status 7");
    expect(await second).toBe("v2");
    expect(secondHeartbeat).toBe(true);
  } finally {
    await client.close();
  }
}, 5_000);

test("failed idle helper retirement retains process ownership for cleanup", async () => {
  const client = new LauncherBrowserHelperClient({
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: "/durable/launcher.json",
    storageStatePath: "/durable/unused-state.json",
    chromeExecutablePath: "/durable/unused-chrome",
    headed: true,
    autoApproveToolCalls: false,
  });
  const child = {};
  const internal = client as unknown as {
    child?: unknown;
    childFingerprint?: string;
    requestedFingerprint?: string;
    ready?: Promise<void>;
    sendTo(child: unknown, message: unknown): Promise<void>;
    terminateChild(child: unknown, timeoutMs: number): Promise<void>;
    recycleIdleChild(child: unknown): Promise<void>;
  };
  internal.child = child;
  internal.childFingerprint = "old";
  internal.requestedFingerprint = "new";
  internal.ready = Promise.resolve();
  internal.sendTo = async () => {};
  internal.terminateChild = async () => { throw new Error("termination failed"); };

  await expect(internal.recycleIdleChild(child)).rejects.toThrow("termination failed");
  expect(internal.child).toBe(child);
  expect(internal.childFingerprint).toBe("old");
  expect(internal.requestedFingerprint).toBe("new");
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
      contextAttachment: validContextAttachment,
      release: () => { released = true; },
    }),
    onTextDelta: () => {},
  })).rejects.toMatchObject({ name: "AbortError" });

  expect(messages).toEqual(["run", "abort"]);
  expect(released).toBe(true);
});

test("launcher helper protocol carries no complete-turn wall-clock timeout", () => {
  const clientSource = readFileSync(new URL("../src/adapters/chatgpt-web/launcher-helper-client.ts", import.meta.url), "utf8");
  const helperSource = readFileSync(new URL("../src/adapters/chatgpt-web/browser-helper-main.ts", import.meta.url), "utf8");
  expect(clientSource).not.toContain("turnTimeoutMs");
  expect(helperSource).not.toContain("turnTimeoutMs");
});

test("browser helper accepts only the exact mandatory task-context shape", () => {
  const valid = {
    text: "summarize",
    images: [],
    contextAttachment: validContextAttachment,
  };
  expect(validateBrowserHelperPreparedPrompt(valid)).toBe(valid);
  expect(() => validateBrowserHelperPreparedPrompt({
    text: "summarize",
    images: [],
  })).toThrow("unexpected fields");

  const invalidAttachments: unknown[] = [
    null,
    undefined,
    [],
    { mimeType: "text/plain", text: "context" },
    { name: CHATGPT_TASK_CONTEXT_FILENAME, mimeType: "application/json", text: validContextText },
    { name: CHATGPT_TASK_CONTEXT_FILENAME, mimeType: "text/plain" },
    { name: CHATGPT_TASK_CONTEXT_FILENAME, mimeType: "text/plain", text: 42 },
    { name: CHATGPT_TASK_CONTEXT_FILENAME, mimeType: "text/plain", text: "" },
    { name: CHATGPT_TASK_CONTEXT_FILENAME, mimeType: "text/plain", text: "<codex_context_json>\nnot-json\n</codex_context_json>" },
    { name: CHATGPT_TASK_CONTEXT_FILENAME, mimeType: "text/plain", text: "<codex_context_json>\n{\"version\":2,\"system\":[],\"messages\":[]}\n</codex_context_json>" },
    {
      ...validContextAttachment,
      path: "C:\\temp\\context.txt",
    },
  ];
  for (const contextAttachment of invalidAttachments) {
    expect(() => validateBrowserHelperPreparedPrompt({
      text: "summarize",
      images: [],
      contextAttachment,
    })).toThrow("missing or invalid");
  }

  expect(() => validateBrowserHelperPreparedPrompt({
    ...valid,
    text: `${valid.text}\n${validContextText}`,
  })).toThrow("only in its attachment");
  expect(() => validateBrowserHelperPreparedPrompt({
    ...valid,
    secondContext: validContextAttachment,
  })).toThrow("unexpected fields");
});
