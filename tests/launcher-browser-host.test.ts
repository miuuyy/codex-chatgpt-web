import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHER_BROWSER_HOST_KIND,
  LAUNCHER_BROWSER_IDLE_URL,
  LauncherManualTurnTimedOutError,
  LauncherRetainedConversationUnavailableError,
  LauncherBrowserTurnCancelledError,
  endLauncherManualTurn,
  inspectLauncherBrowserHost,
  inspectLauncherBrowserHostLiveness,
  notifyLauncherTurn,
  markLauncherManualTurnStarted,
  readLauncherBrowserHostDescriptor,
  releaseLauncherRetainedConversation,
  selectLauncherPage,
  startLauncherManualTurn,
  waitForLauncherManualSent,
  waitForLauncherManualTerminal,
} from "../src/launcher-browser-host";
import type { Browser, BrowserContext, Page } from "playwright-core";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function descriptorFile(
  controlEndpoint = "http://127.0.0.1:39111",
  profile: "production" | "development" = "production",
  endpoint = "http://127.0.0.1:39110",
): string {
  const root = mkdtempSync(join(tmpdir(), "codex-launcher-descriptor-"));
  roots.push(root);
  const path = join(root, "launcher-browser.json");
  writeFileSync(path, `${JSON.stringify({
    version: 2,
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile,
    pid: process.pid,
    endpoint,
    control: {
      endpoint: controlEndpoint,
      token: "launcher-control-token-0123456789abcdefghijklmnop",
    },
    helper: {
      executable: process.execPath,
      script: import.meta.path,
    },
    partition: profile === "development"
      ? "persist:codex-web-gpt-dev-chatgpt"
      : "persist:codex-web-gpt-chatgpt",
    idleUrl: LAUNCHER_BROWSER_IDLE_URL,
    surfaceId: "launcher_surface_id_0123456789AB",
    createdAt: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  return path;
}

test("launcher descriptor is owner-only, loopback-only, and process-bound", () => {
  const path = descriptorFile();
  expect(readLauncherBrowserHostDescriptor(path)).toMatchObject({
    kind: LAUNCHER_BROWSER_HOST_KIND,
    profile: "production",
    pid: process.pid,
    endpoint: "http://127.0.0.1:39110",
    surfaceId: "launcher_surface_id_0123456789AB",
  });
  if (process.platform !== "win32") {
    chmodSync(path, 0o644);
    expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("unsafe permissions");
  }
});

test("launcher turn control sends authenticated lifecycle events", async () => {
  let received: { authorization?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/v1/turn/start"
      ? '{"ok":true,"surfaceId":"launcher_surface_id_0123456789AB","reused":true,"connectorBound":true}\n'
      : request.url === "/v1/turn/end"
        ? '{"ok":true,"cancelledByUser":false}\n'
        : '{"ok":true}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(notifyLauncherTurn(path, {
      phase: "start",
      traceId: "abc123def456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      connectorIdentity: "Codex Native2",
      requireRetainedConversation: true,
    })).resolves.toEqual({
      surfaceId: "launcher_surface_id_0123456789AB",
      reused: true,
      connectorBound: true,
    });
    expect(received.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(received.body).toEqual({
      phase: "start",
      traceId: "abc123def456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      connectorIdentity: "Codex Native2",
      requireRetainedConversation: true,
    });
    await notifyLauncherTurn(path, {
      phase: "heartbeat",
      traceId: "abc123def456",
      helperPid: process.pid,
      refreshViewport: true,
    });
    expect(received.body).toEqual({
      phase: "heartbeat",
      traceId: "abc123def456",
      helperPid: process.pid,
      refreshViewport: true,
    });
    await expect(notifyLauncherTurn(path, {
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
      retain: true,
      connectorBound: true,
    })).resolves.toEqual({ cancelledByUser: false });
    expect(received.body).toEqual({
      phase: "end",
      traceId: "abc123def456",
      helperPid: process.pid,
      status: "completed",
      retain: true,
      connectorBound: true,
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher retained-conversation release uses its authenticated exact-key endpoint", async () => {
  let received: { url?: string; authorization?: string; body?: unknown } = {};
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true,"released":1}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(releaseLauncherRetainedConversation(path, "b".repeat(64))).resolves.toBe(1);
    expect(received).toEqual({
      url: "/v1/turn/release",
      authorization: "Bearer launcher-control-token-0123456789abcdefghijklmnop",
      body: { conversationKey: "b".repeat(64) },
    });
    await expect(releaseLauncherRetainedConversation(path, "not-a-key"))
      .rejects.toThrow("retained conversation key is invalid");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher turn control preserves explicit user cancellation as a terminal signal", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    response.writeHead(409, { "content-type": "application/json" });
    response.end('{"error":"turn closed by user","code":"turn_cancelled"}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const error = await notifyLauncherTurn(path, {
      phase: "start",
      traceId: "cancelled123",
      helperPid: process.pid,
    }).catch(cause => cause);
    expect(error).toBeInstanceOf(LauncherBrowserTurnCancelledError);
    expect((error as Error).message).toBe("turn closed by user");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher turn control preserves a missing retained conversation as a typed signal", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain request */ }
    response.writeHead(409, { "content-type": "application/json" });
    response.end('{"error":"retained source missing","code":"retained_conversation_unavailable"}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const error = await notifyLauncherTurn(path, {
      phase: "start",
      traceId: "missing123456",
      helperPid: process.pid,
      conversationKey: "a".repeat(64),
      requireRetainedConversation: true,
    }).catch(caught => caught);
    expect(error).toBeInstanceOf(LauncherRetainedConversationUnavailableError);
    expect(error.message).toContain("retained source missing");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher session verification uses the authenticated control channel instead of Bun CDP", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(request.url).toBe("/v1/session/inspect");
    expect(request.headers.authorization).toBe("Bearer launcher-control-token-0123456789abcdefghijklmnop");
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({ detectCapabilities: true });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      authenticated: true,
      temporary: true,
      solAvailable: true,
      proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    expect(await inspectLauncherBrowserHost(path, { detectCapabilities: true })).toEqual({
      solAvailable: true,
      extraHighAvailable: true,
      proAvailable: true,
      url: "https://chatgpt.com/?temporary-chat=true",
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("launcher liveness verification checks only owned process and loopback CDP metadata", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    expect(request.url).toBe("/json/version");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      webSocketDebuggerUrl: "ws://127.0.0.1:39120/devtools/browser/test",
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(
      "http://127.0.0.1:39111",
      "development",
      `http://127.0.0.1:${address.port}`,
    );
    await expect(inspectLauncherBrowserHostLiveness(path, {
      expectedProfile: "development",
    })).resolves.toMatchObject({
      profile: "development",
      endpoint: `http://127.0.0.1:${address.port}`,
    });
    expect(requests).toBe(1);
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("launcher session verification reports its own deadline instead of a generic abort", async () => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 30));
    if (!response.destroyed) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"late"}\n');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    await expect(inspectLauncherBrowserHost(path, { detectCapabilities: true, timeoutMs: 5 }))
      .rejects.toThrow("session inspection timed out after 5ms");
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("launcher descriptor rejects non-loopback browser ownership", () => {
  const path = descriptorFile();
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.endpoint = "https://example.com:443";
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  expect(() => readLauncherBrowserHostDescriptor(path)).toThrow("http://127.0.0.1");
});

test("launcher profile checks reject cross-profile browser ownership", async () => {
  const path = descriptorFile("http://127.0.0.1:39111", "development");
  expect(readLauncherBrowserHostDescriptor(path)).toMatchObject({
    profile: "development",
    partition: "persist:codex-web-gpt-dev-chatgpt",
  });
  await expect(inspectLauncherBrowserHost(path, { expectedProfile: "production", timeoutMs: 5 }))
    .rejects.toThrow("belongs to development");
});

test("launcher page selection uses the owned surface marker instead of URL order", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const hiddenPage = {
    url: () => "https://chatgpt.com/?temporary-chat=true",
    evaluate: async () => "another_surface_id_0123456789ABC",
  } as unknown as Page;
  const ownedPage = {
    url: () => LAUNCHER_BROWSER_IDLE_URL,
    evaluate: async () => descriptor.surfaceId,
  } as unknown as Page;
  const context = {
    pages: () => [hiddenPage, ownedPage],
  } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
  } as unknown as Browser;

  expect(await selectLauncherPage(browser, descriptor, 20)).toEqual({
    context,
    page: ownedPage,
  });
});

test("launcher page selection rejects duplicated ownership markers", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const page = () => ({
    evaluate: async () => descriptor.surfaceId,
  }) as unknown as Page;
  const context = {
    pages: () => [page(), page()],
  } as unknown as BrowserContext;
  const browser = {
    contexts: () => [context],
  } as unknown as Browser;

  expect(selectLauncherPage(browser, descriptor, 20)).rejects.toThrow(
    "2 surfaces with the same ownership id",
  );
});

test("launcher page selection stops immediately when acquisition is aborted", async () => {
  const descriptor = readLauncherBrowserHostDescriptor(descriptorFile());
  const browser = {
    contexts: () => [],
  } as unknown as Browser;
  const controller = new AbortController();
  controller.abort();

  expect(selectLauncherPage(
    browser,
    descriptor,
    60_000,
    descriptor.surfaceId,
    controller.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
});

test("manual launcher control separates idempotent start from reconnectable Sent observation", async () => {
  const requests: Array<{ url: string | undefined; body: unknown }> = [];
  let sentPolls = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/manual/start") {
      response.end(JSON.stringify({
        ok: true,
        tabId: "manual-tab",
        reused: false,
        deadlineAt: "2026-08-30T00:01:00.000Z",
        state: "awaiting-user",
      }));
      return;
    }
    if (request.url === "/v1/manual/wait-sent" && sentPolls++ === 0) {
      response.statusCode = 202;
      response.end('{"ok":true,"status":"pending"}');
      return;
    }
    if (request.url === "/v1/manual/wait-sent") {
      response.end('{"ok":true,"status":"sent","sentAt":"2026-08-30T00:00:30.000Z"}');
      return;
    }
    if (request.url === "/v1/manual/started") {
      response.end('{"ok":true}');
      return;
    }
    if (request.url === "/v1/manual/wait-terminal") {
      response.end('{"ok":true,"status":"cancelled"}');
      return;
    }
    response.end('{"ok":true,"cancelledByUser":false}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const owner = { traceId: "manual123456", helperPid: process.pid };
    await expect(startLauncherManualTurn(path, {
      ...owner,
      prompt: "private prompt",
      compaction: true,
    })).resolves.toMatchObject({
      tabId: "manual-tab",
      reused: false,
      state: "awaiting-user",
    });
    await expect(waitForLauncherManualSent(path, owner)).resolves.toEqual({
      sentAt: "2026-08-30T00:00:30.000Z",
    });
    await expect(markLauncherManualTurnStarted(path, owner)).resolves.toBeUndefined();
    await expect(waitForLauncherManualTerminal(path, owner)).resolves.toEqual({ status: "cancelled" });
    await expect(endLauncherManualTurn(path, { ...owner, status: "completed", retain: true }))
      .resolves.toEqual({ cancelledByUser: false });
    expect(requests.map(request => request.url)).toEqual([
      "/v1/manual/start",
      "/v1/manual/wait-sent",
      "/v1/manual/wait-sent",
      "/v1/manual/started",
      "/v1/manual/wait-terminal",
      "/v1/manual/end",
    ]);
    expect(requests[0]?.body).toEqual({ ...owner, prompt: "private prompt", compaction: true });
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("manual launcher mutations reconcile one lost local response with the same turn owner", async () => {
  const attempts = new Map<string, number>();
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    const url = request.url ?? "";
    const attempt = (attempts.get(url) ?? 0) + 1;
    attempts.set(url, attempt);
    if (attempt === 1) {
      response.destroy();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (url === "/v1/manual/start") {
      response.end(JSON.stringify({
        ok: true,
        tabId: "manual-tab",
        reused: true,
        deadlineAt: "2026-08-30T00:01:00.000Z",
        state: "awaiting-user",
      }));
      return;
    }
    if (url === "/v1/manual/started") {
      response.end('{"ok":true}');
      return;
    }
    response.end('{"ok":true,"cancelledByUser":false}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const path = descriptorFile(`http://127.0.0.1:${address.port}`);
    const owner = { traceId: "manual_reconcile", helperPid: process.pid };
    await expect(startLauncherManualTurn(path, { ...owner, prompt: "private prompt" }, 500))
      .resolves.toMatchObject({ tabId: "manual-tab", reused: true });
    await expect(markLauncherManualTurnStarted(path, owner, 500)).resolves.toBeUndefined();
    await expect(endLauncherManualTurn(path, { ...owner, status: "completed" }, 500))
      .resolves.toEqual({ cancelledByUser: false });
    expect(Object.fromEntries(attempts)).toEqual({
      "/v1/manual/start": 2,
      "/v1/manual/started": 2,
      "/v1/manual/end": 2,
    });
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test("manual Sent wait preserves typed timeout and cancellation signals", async () => {
  for (const reply of [
    { status: 408, body: { error: "too slow", code: "manual_turn_timed_out" } },
    { status: 409, body: { error: "closed", code: "turn_cancelled" } },
  ]) {
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server has no port");
      const path = descriptorFile(`http://127.0.0.1:${address.port}`);
      const error = await waitForLauncherManualSent(path, {
        traceId: "manual123456",
        helperPid: process.pid,
      }).catch(caught => caught);
      expect(error).toBeInstanceOf(reply.status === 408
        ? LauncherManualTurnTimedOutError
        : LauncherBrowserTurnCancelledError);
    } finally {
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
  }
});
