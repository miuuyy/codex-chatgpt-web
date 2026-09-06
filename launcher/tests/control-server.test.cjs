const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("browser control server authenticates and owns turn visibility", async () => {
  const calls = [];
  const logs = [];
  const host = {
    browserInteractionMode: () => "automatic",
    beginTurn: (...args) => {
      calls.push(["start", ...args]);
      return {
        surfaceId: "launcher_surface_id_0123456789AB",
        tabId: "tab-1",
        reused: false,
        connectorBound: false,
      };
    },
    heartbeatTurn: (...args) => calls.push(["heartbeat", ...args]),
    endTurn: (...args) => {
      calls.push(["end", ...args]);
      return { cancelledByUser: false };
    },
  };
  const server = await new BrowserControlServer({
    logger: {
      info: (event, detail) => logs.push(["info", event, detail]),
      warn: (event, detail) => logs.push(["warn", event, detail]),
    },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: true }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const unauthenticated = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456" }),
    });
    assert.equal(unauthenticated.status, 401);

    const invalidOwner = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "start", traceId: "abcdef123456", helperPid: 0 }),
    });
    assert.equal(invalidOwner.status, 400);

    const start = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "start",
        traceId: "abcdef123456",
        helperPid: process.pid,
        conversationKey: "a".repeat(64),
        connectorIdentity: "Codex Native2",
        requireRetainedConversation: true,
      }),
    });
    assert.equal(start.status, 200);

    const heartbeat = await fetch(`${descriptor.endpoint}/v1/turn/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "heartbeat",
        traceId: "abcdef123456",
        helperPid: process.pid,
        refreshViewport: true,
      }),
    });
    assert.equal(heartbeat.status, 200);

    const invalidRefresh = await fetch(`${descriptor.endpoint}/v1/turn/heartbeat`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "heartbeat",
        traceId: "abcdef123456",
        helperPid: process.pid,
        refreshViewport: "yes",
      }),
    });
    assert.equal(invalidRefresh.status, 400);

    const ownerlessEnd = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ phase: "end", traceId: "abcdef123456", status: "failed" }),
    });
    assert.equal(ownerlessEnd.status, 400);

    const end = await fetch(`${descriptor.endpoint}/v1/turn/end`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "end",
        traceId: "abcdef123456",
        helperPid: process.pid,
        status: "completed",
        retain: true,
        connectorBound: true,
      }),
    });
    assert.equal(end.status, 200);
    assert.deepEqual(calls, [
      [
        "start",
        "abcdef123456",
        true,
        process.pid,
        "a".repeat(64),
        "Codex Native2",
        true,
      ],
      ["heartbeat", "abcdef123456", process.pid, true],
      ["end", "abcdef123456", process.pid, "completed", true, undefined, true, true],
    ]);
    assert.equal(logs.some(([, event]) => event === "browser.turn_started"), true);
    assert.equal(logs.some(([, event]) => event === "browser.turn_ended"), true);
  } finally {
    await server.close();
  }
});

test("browser control server withholds a new turn lease until its browser surface is ready", async () => {
  let releaseSurface;
  let reportBegin;
  const surfaceReady = new Promise((resolve) => { releaseSurface = resolve; });
  const beginCalled = new Promise((resolve) => { reportBegin = resolve; });
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => ({
      browserInteractionMode: () => "automatic",
      beginTurn() {
        reportBegin();
        return surfaceReady;
      },
    }),
    getPreferences: () => ({ showBrowserDuringTurns: false }),
  }).start();
  const descriptor = server.descriptor();
  try {
    let responseSettled = false;
    const responsePromise = fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "start",
        traceId: "surface123456",
        helperPid: process.pid,
      }),
    }).then((response) => {
      responseSettled = true;
      return response;
    });

    await beginCalled;
    await Promise.resolve();
    assert.equal(responseSettled, false);

    releaseSurface({
      surfaceId: "launcher_surface_id_0123456789AB",
      tabId: "tab-ready",
      reused: false,
      connectorBound: false,
    });
    const response = await responsePromise;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).tabId, "tab-ready");
  } finally {
    await server.close();
  }
});

test("manual control keeps start idempotency separate from long Sent observation", async () => {
  const calls = [];
  const prompt = "p".repeat(32 * 1024);
  const host = {
    browserInteractionMode: () => "manual",
    beginManualTurn: (...args) => {
      calls.push(["start", ...args]);
      return {
        tabId: "manual-tab",
        reused: false,
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        state: "awaiting-user",
      };
    },
    waitManualSent: async (...args) => {
      calls.push(["wait", ...args]);
      return { status: "sent", sentAt: "2026-08-30T00:00:00.000Z" };
    },
    waitManualTerminal: async (...args) => {
      calls.push(["wait-terminal", ...args]);
      return { status: "cancelled" };
    },
    markManualTurnStarted: (...args) => calls.push(["started", ...args]),
    endManualTurn: (...args) => {
      calls.push(["end", ...args]);
      return { cancelledByUser: false };
    },
  };
  const logs = [];
  const server = await new BrowserControlServer({
    logger: {
      info: (event, detail) => logs.push([event, detail]),
      warn() {},
      error() {},
    },
    getBrowserHost: () => host,
    getPreferences: () => ({ browserInteractionMode: "manual" }),
  }).start();
  const descriptor = server.descriptor();
  const post = (path, body) => fetch(`${descriptor.endpoint}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const owner = { traceId: "manual123456", helperPid: process.pid };
  try {
    assert.equal((await post("/v1/manual/start", {
      ...owner,
      prompt,
      resumePrompt: "incremental prompt",
      conversationKey: "c".repeat(64),
      compaction: true,
    })).status, 200);
    assert.equal((await post("/v1/manual/wait-sent", owner)).status, 200);
    assert.equal((await post("/v1/manual/wait-terminal", owner)).status, 200);
    assert.equal((await post("/v1/manual/started", owner)).status, 200);
    assert.equal((await post("/v1/manual/end", { ...owner, status: "completed", retain: true })).status, 200);
    assert.equal(calls[0][0], "start");
    assert.equal(calls[0][3], prompt);
    assert.equal(calls[0][5], "incremental prompt");
    assert.equal(calls[0][6], true);
    assert.equal(calls[1][0], "wait");
    assert.equal(calls[2][0], "wait-terminal");
    assert.equal(logs.some(([, detail]) => JSON.stringify(detail).includes(prompt)), false);
  } finally {
    await server.close();
  }
});

test("manual start has one explicit bounded body allowance and automatic turns stay disabled", async () => {
  let started = 0;
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => ({
      browserInteractionMode: () => "manual",
      beginManualTurn() {
        started += 1;
        return { tabId: "manual-tab", reused: false, deadlineAt: null, state: "awaiting-user" };
      },
      beginTurn() { throw new Error("must not start automatic turn"); },
    }),
    getPreferences: () => ({ browserInteractionMode: "manual" }),
  }).start();
  const descriptor = server.descriptor();
  const headers = { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" };
  try {
    const tooLarge = await fetch(`${descriptor.endpoint}/v1/manual/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ traceId: "manual123456", helperPid: process.pid, prompt: "x".repeat((3 * 1024 * 1024) + 1) }),
    });
    assert.equal(tooLarge.status, 400);
    assert.equal(started, 0);
    const automatic = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ traceId: "automatic123", helperPid: process.pid }),
    });
    assert.equal(automatic.status, 400);
  } finally {
    await server.close();
  }
});

test("manual control rejects session inspection before any browser helper can run", async () => {
  let inspected = false;
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => ({
      browserInteractionMode: () => "manual",
      inspectSession() {
        inspected = true;
        const error = new Error("ChatGPT session and capability inspection is disabled in Zero Risk mode");
        error.code = "manual_browser_inspection_disabled";
        throw error;
      },
    }),
    getPreferences: () => ({ browserInteractionMode: "manual" }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const response = await fetch(`${descriptor.endpoint}/v1/session/inspect`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ detectCapabilities: true }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "ChatGPT session and capability inspection is disabled in Zero Risk mode",
      code: "manual_browser_inspection_disabled",
    });
    assert.equal(inspected, false);
  } finally {
    await server.close();
  }
});

test("manual-to-automatic transaction exposes capability inspection and preserves tabs on rollback", async () => {
  const retained = { id: "manual-ready", status: "ready", interactionMode: "manual" };
  const removed = [];
  let inspections = 0;
  let ownershipMarks = 0;
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    interactionModeOverride: null,
    manualOperation: null,
    turnTabs: new Map([[retained.id, retained]]),
    selectedTabId: retained.id,
    runSessionInspection: async (detectCapabilities) => {
      inspections += 1;
      assert.equal(detectCapabilities, true);
      assert.equal(host.browserInteractionMode(), "automatic");
      return { authenticated: true, temporary: true, url: "https://chatgpt.com/" };
    },
    removeTurnTab(tab, abortRunning) {
      assert.equal(abortRunning, false);
      removed.push(tab.id);
      this.turnTabs.delete(tab.id);
    },
    markOwnedSurface: async () => { ownershipMarks += 1; },
    snapshot: () => ({ activeTabId: "home" }),
  });
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({ browserInteractionMode: "manual" }),
  }).start();
  const descriptor = server.descriptor();
  const inspect = () => fetch(`${descriptor.endpoint}/v1/session/inspect`, {
    method: "POST",
    headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
    body: JSON.stringify({ detectCapabilities: true }),
  });
  try {
    await assert.rejects(
      host.withInteractionModeChange("automatic", async () => {
        const response = await inspect();
        assert.equal(response.status, 200);
        assert.equal(host.turnTabs.size, 1);
        throw new Error("runtime setup failed");
      }),
      /runtime setup failed/,
    );
    assert.equal(host.browserInteractionMode(), "manual");
    assert.deepEqual([...host.turnTabs.keys()], [retained.id]);
    assert.deepEqual(removed, []);

    const result = await host.withInteractionModeChange("automatic", async commit => {
      const response = await inspect();
      assert.equal(response.status, 200);
      await commit();
      return "configured";
    });
    assert.equal(result, "configured");
    assert.equal(host.browserInteractionMode(), "manual");
    assert.equal(host.turnTabs.size, 1);
    assert.deepEqual(removed, []);
    assert.equal(inspections, 2);
    assert.equal(ownershipMarks, 1);
  } finally {
    await server.close();
  }
});

test("browser control server reports a missing retained conversation as a typed conflict", async () => {
  const host = {
    browserInteractionMode: () => "automatic",
    beginTurn: () => {
      const error = new Error("The retained ChatGPT conversation is no longer available");
      error.code = "retained_conversation_unavailable";
      throw error;
    },
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: false }),
  }).start();
  const descriptor = server.descriptor();
  try {
    const response = await fetch(`${descriptor.endpoint}/v1/turn/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        phase: "start",
        traceId: "missing123456",
        helperPid: process.pid,
        conversationKey: "a".repeat(64),
        requireRetainedConversation: true,
      }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "The retained ChatGPT conversation is no longer available",
      code: "retained_conversation_unavailable",
    });
  } finally {
    await server.close();
  }
});

test("browser control server releases only ready tabs for an authenticated conversation key", async () => {
  const removed = [];
  const releaseEvents = [];
  const ready = {
    id: "ready-tab",
    traceId: "ready-trace",
    status: "ready",
    conversationKey: "b".repeat(64),
  };
  const running = {
    id: "running-tab",
    traceId: "running-trace",
    status: "running",
    conversationKey: "b".repeat(64),
  };
  const host = {
    turnTabs: new Map([[ready.id, ready], [running.id, running]]),
    logger: { info: (event, detail) => releaseEvents.push([event, detail]) },
    removeTurnTab(tab, abortRunning) {
      assert.equal(abortRunning, false);
      removed.push(tab.id);
      this.turnTabs.delete(tab.id);
    },
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({}),
  }).start();
  const descriptor = server.descriptor();
  try {
    const unauthenticated = await fetch(`${descriptor.endpoint}/v1/turn/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationKey: "b".repeat(64) }),
    });
    assert.equal(unauthenticated.status, 401);

    const response = await fetch(`${descriptor.endpoint}/v1/turn/release`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ conversationKey: "b".repeat(64) }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, released: 1 });
    assert.deepEqual(removed, ["ready-tab"]);
    assert.deepEqual([...host.turnTabs.keys()], ["running-tab"]);
    assert.deepEqual(releaseEvents, [["browser.tab_released", {
      tabId: "ready-tab",
      traceId: "ready-trace",
      status: "ready",
      reason: "retained_conversation_superseded",
    }]]);
  } finally {
    await server.close();
  }
});

test("browser control server rejects malformed retained-conversation contracts", async () => {
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {} },
    getBrowserHost: () => ({ beginTurn: () => assert.fail("invalid request reached browser host") }),
    getPreferences: () => ({}),
  }).start();
  const descriptor = server.descriptor();
  const post = (body) => fetch(`${descriptor.endpoint}/v1/turn/start`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${descriptor.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ traceId: "abcdef123456", helperPid: process.pid, ...body }),
  });
  try {
    assert.equal((await post({ conversationKey: "ABC" })).status, 400);
    assert.equal((await post({ requireRetainedConversation: true })).status, 400);
    assert.equal((await post({ connectorIdentity: "Codex Native2" })).status, 400);
  } finally {
    await server.close();
  }
});

test("browser control server routes every heavy-phase lock call the helper can post", async () => {
  // The heavy-phase branches are dispatched far below the request guard. When the guard did not
  // list them, every automatic turn died on its first heavy stage with HTTP 404: not_found, so
  // this exercises the real HTTP surface rather than the host methods directly.
  const calls = [];
  const host = {
    browserInteractionMode: () => "automatic",
    acquireHeavyPhase: (...args) => {
      calls.push(["heavy-acquire", ...args]);
      return { acquired: true };
    },
    releaseHeavyPhase: (...args) => {
      calls.push(["heavy-release", ...args]);
      return { released: true };
    },
  };
  const server = await new BrowserControlServer({
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    getBrowserHost: () => host,
    getPreferences: () => ({ showBrowserDuringTurns: false }),
  }).start();
  const descriptor = server.descriptor();
  const post = (phase) => fetch(`${descriptor.endpoint}/v1/turn/${phase}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${descriptor.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ phase, traceId: "abcdef123456", helperPid: process.pid }),
  });
  try {
    const acquire = await post("heavy-acquire");
    assert.equal(acquire.status, 200);
    assert.deepEqual(await acquire.json(), { ok: true, acquired: true });

    const release = await post("heavy-release");
    assert.equal(release.status, 200);
    assert.deepEqual(await release.json(), { ok: true, released: true });

    assert.deepEqual(calls, [
      ["heavy-acquire", "abcdef123456", process.pid],
      ["heavy-release", "abcdef123456"],
    ]);
  } finally {
    await server.close();
  }
});
