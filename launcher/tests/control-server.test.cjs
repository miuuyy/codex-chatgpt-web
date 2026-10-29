const test = require("node:test");
const assert = require("node:assert/strict");
const { BrowserHost } = require("../electron/browser-host.cjs");
const { BrowserControlServer } = require("../electron/control-server.cjs");

test("live task progress is owner-bound, preserves elapsed time, and clears on release", async () => {
  const tab = { id: "task-one", traceId: "trace-one", helperPid: process.pid, status: "running", interactionMode: "automatic" };
  const other = { ...tab, id: "task-two", traceId: "trace-two", helperPid: process.pid + 1 };
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab], [other.id, other]]), closedTurnOwners: new Map(),
    selectedTabId: other.id, getBrowserInteractionMode: () => "automatic",
    snapshot() { return { tabs: [...this.turnTabs.values()].map(value => this.tabSnapshot(value)) }; },
  });
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} }, getBrowserHost: () => host, getPreferences: () => ({}),
  }).start();
  const { endpoint, token } = server.descriptor();
  const owner = { traceId: tab.traceId, helperPid: tab.helperPid };
  const send = body => fetch(`${endpoint}/v1/turn/heartbeat`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...owner, ...body }),
  });
  try {
    const progress = { stage: "chatgpt", activeToolCalls: 2 };
    assert.equal((await send({ progress, helperPid: other.helperPid })).status, 400);
    for (const invalid of [null, {}, { ...progress, stage: "safety-blocked" }, { ...progress, activeToolCalls: -1 },
      { ...progress, activeToolCalls: 0.5 }, { ...progress, prompt: "private" }]) {
      assert.equal((await send({ progress: invalid })).status, 400);
    }
    assert.equal(tab.activity, undefined);
    assert.equal((await send({ progress })).status, 200);
    assert.equal(tab.activity.state, "tools");
    const since = tab.activity.since;
    assert.equal((await send({ progress })).status, 200);
    assert.equal(tab.activity.since, since);
    host.setTurnApprovalPending(tab.traceId, tab.helperPid, true);
    assert.equal((await send({ progress })).status, 200);
    assert.equal(tab.activity.state, "approval");
    host.setTurnApprovalPending(tab.traceId, tab.helperPid, false);
    assert.equal(tab.activity.state, "tools");
    assert.equal((await send({ progress: { stage: "chatgpt", activeToolCalls: 0 } })).status, 200);
    assert.equal(tab.activity.state, "chatgpt");
    assert.equal(other.activity, undefined);
    assert.equal(host.selectedTabId, other.id);
    tab.status = "ready";
    assert.equal((await send({ progress })).status, 400);
    assert.equal(host.tabSnapshot(tab).activity, undefined);
    tab.status = "running";
    tab.authenticationRequired = true;
    assert.equal(host.tabSnapshot(tab).authenticationRequired, true);
    assert.equal(host.tabSnapshot(tab).activity, undefined);
  } finally { await server.close(); }
});

test("approval notices require the running tab's helper and never change another tab", async () => {
  const tab = { id: "approval-tab", label: "ChatGPT 1", traceId: "approval-turn", helperPid: process.pid,
    status: "running", interactionMode: "automatic" };
  const other = { ...tab, id: "other-tab", traceId: "another-turn", helperPid: process.pid + 1 };
  const events = [];
  let mode = "automatic";
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab], [other.id, other]]), closedTurnOwners: new Map(),
    selectedTabId: other.id, getBrowserInteractionMode: () => mode,
    snapshot() { return { tabs: [...this.turnTabs.values()].map(value => this.tabSnapshot(value)) }; },
    publishState: state => events.push(state),
  });
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} }, getBrowserHost: () => host, getPreferences: () => ({}),
  }).start();
  const { endpoint, token } = server.descriptor();
  const send = (body, auth = token) => fetch(`${endpoint}/v1/turn/approval`, {
    method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const owner = { traceId: tab.traceId, helperPid: tab.helperPid };
  try {
    assert.equal((await send({ ...owner, pending: true }, "wrong-token")).status, 401);
    assert.equal((await send({ ...owner, pending: true, helperPid: other.helperPid })).status, 400);
    assert.equal((await send({ ...owner, pending: "true" })).status, 400);
    assert.equal((await send(owner)).status, 400);
    assert.equal(events.length, 0);
    assert.equal((await send({ ...owner, pending: true })).status, 200);
    assert.equal(tab.approvalPending, true);
    assert.equal(other.approvalPending, undefined);
    assert.equal(host.selectedTabId, other.id, "a notice must not switch away from the user's selected task");
    assert.equal(events.at(-1).tabs[0].approvalPending, true);
    host.heartbeatTurn(tab.traceId, tab.helperPid);
    assert.equal(tab.approvalPending, true, "normal heartbeats must not erase the notice");
    assert.equal((await send({ ...owner, pending: false })).status, 200);
    assert.equal(events.at(-1).tabs[0].approvalPending, undefined);
    tab.status = "error";
    assert.equal((await send({ ...owner, pending: true })).status, 400);
    tab.approvalPending = true;
    assert.equal(host.tabSnapshot(tab).approvalPending, undefined, "terminal tabs cannot retain an active notice");
    tab.status = "running";
    tab.authenticationRequired = true;
    assert.equal(host.tabSnapshot(tab).approvalPending, undefined);
    mode = "manual";
    assert.equal((await send({ ...owner, pending: true })).status, 400);
  } finally { await server.close(); }
});

test("disconnect cancels pending browser initialization and destroys only its owned document", async () => {
  const { EventEmitter } = require("node:events");
  for (const stalledAt of ["load", "mark"]) {
    let ready;
    const stalled = new Promise(resolve => { ready = resolve; });
    let settled;
    const finished = new Promise(resolve => { settled = resolve; });
    let pendingTab;
    let marks = 0;
    let closes = 0;
    const unrelated = { id: "unrelated", traceId: "other", status: "running", interactionMode: "automatic" };
    const host = Object.assign(Object.create(BrowserHost.prototype), {
      turnTabs: new Map([[unrelated.id, unrelated]]), userCancelledTurnOwners: new Map(), closedTurnOwners: new Map(),
      getBrowserInteractionMode: () => "automatic", logger: { info() {}, error() {} },
      window: { contentView: { removeChildView() {} } },
      syncPowerSaveBlocker() {}, syncViewVisibility() {}, writeDescriptor() {}, snapshot: () => ({}),
      async createTurnTab(traceId, helperPid, _conversation, _connector, signal) {
        let destroyed = false;
        let url = "about:blank";
        const contents = Object.assign(new EventEmitter(), {
          isDestroyed: () => destroyed, getURL: () => url, stop() {}, insertCSS: async () => {},
          loadURL: async target => {
            if (stalledAt === "load") { ready(); await new Promise(() => {}); }
            url = target;
          },
          executeJavaScript: async () => { marks++; ready(); await new Promise(() => {}); },
          close: () => { closes++; destroyed = true; contents.emit("destroyed"); },
        });
        pendingTab = { id: `pending-${stalledAt}`, traceId, helperPid, surfaceId: "a".repeat(32),
          status: "running", interactionMode: "automatic", initializingSurface: true, view: { webContents: contents } };
        this.turnTabs.set(pendingTab.id, pendingTab);
        try { await this.initializeTurnTab(pendingTab, signal); return pendingTab; }
        finally { settled(); }
      },
    });
    const server = await new BrowserControlServer({
      logger: { info() {}, warn() {}, error() {} }, getPreferences: () => ({}), getBrowserHost: () => host,
    }).start();
    const { endpoint, token } = server.descriptor();
    const controller = new AbortController();
    try {
      const response = fetch(`${endpoint}/v1/turn/start`, {
        method: "POST", signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ traceId: "pending-start", helperPid: process.pid }),
      });
      const rejected = assert.rejects(response, { name: "AbortError" });
      await stalled;
      controller.abort();
      await rejected;
      await finished;
      assert.equal(closes, 1);
      assert.equal(marks, stalledAt === "mark" ? 1 : 0);
      assert.equal(pendingTab.initializingSurface, true);
      assert.equal(pendingTab.view.webContents.listenerCount("destroyed"), 0);
      assert.deepEqual([...host.turnTabs.values()], [unrelated]);
    } finally { controller.abort(); await server.close(); }
  }
});

test("Limits receipts require the active automatic owner and survive reconnect without duplicate usage", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { LimitsController } = require("../electron/limits-controller.cjs");
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "limits-control-"));
  const file = path.join(directory, "limits.json");
  const accountKey = "a".repeat(64);
  let mode = "automatic";
  const limits = new LimitsController(file, { getInteractionMode: () => mode });
  await limits.setup(async () => ({ accountKey, plan: "pro_200" }));
  const host = {
    browserInteractionMode: () => mode,
    turnTabs: new Map([["tab", { traceId: "limits-turn", helperPid: process.pid, status: "running" }]]),
    heartbeatTurn: BrowserHost.prototype.heartbeatTurn,
    snapshot: () => ({}),
    beginTurn: () => ({ surfaceId: "a".repeat(32), reused: false, connectorBound: false }),
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => host, getPreferences: () => ({}), limits,
  }).start();
  const { endpoint, token } = server.descriptor();
  const send = (body, auth = token, route = "usage") => fetch(`${endpoint}/v1/turn/${route}`, {
    method: "POST", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const owner = { traceId: "limits-turn", helperPid: process.pid };
  const body = { ...owner, receipt: { id: "one-accepted-send", accountKey, model: "gpt-6-pro", at: Date.now() } };
  try {
    assert.equal((await (await send(owner, token, "start")).json()).trackUsage, true);
    assert.equal((await send(body, "wrong-token")).status, 401);
    assert.equal((await send({ ...body, helperPid: process.pid + 1 })).status, 400);
    assert.equal(limits.snapshot().totalMessages, 0);
    assert.equal((await (await send(body)).json()).recorded, true);
    assert.equal((await (await send(body)).json()).recorded, false);
    const restored = new LimitsController(file, { getInteractionMode: () => mode });
    assert.equal(restored.snapshot().windows.find(window => window.model === "gpt-6-pro").used, 1);
    mode = "manual";
    assert.equal((await send({ ...body, receipt: { ...body.receipt, id: "manual-send" } })).status, 400);
    assert.equal(limits.snapshot().disabledReason, "zero-risk");
    assert.equal(limits.snapshot().totalMessages, 1);
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("native proxy resolution requires owner auth, restricts targets, and works without browser automation", async () => {
  const resolved = [];
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => { throw new Error("proxy resolution must not inspect browser contents"); },
    getPreferences: () => { throw new Error("proxy resolution must not depend on integration mode"); },
    resolveProxy: async url => { resolved.push(url); return "PROXY 127.0.0.1:7897"; },
  }).start();
  const { endpoint, token } = server.descriptor();
  const send = (url, authorization = `Bearer ${token}`) => fetch(`${endpoint}/v1/network/resolve-proxy`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ url }),
  });
  try {
    const url = "https://chatgpt.com/backend-api/codex/models?client_version=0.153.4";
    assert.equal((await send(url, "Bearer wrong")).status, 401);
    for (const target of ["http://chatgpt.com/backend-api/codex/models", "https://example.com/", "https://secret@chatgpt.com/backend-api/codex/models", "https://chatgpt.com/backend-api/me"]) {
      assert.equal((await send(target)).status, 400);
    }
    const response = await send(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { proxy: "PROXY 127.0.0.1:7897" });
    assert.deepEqual(resolved, [url]);
    server.resolveProxy = async () => { throw new Error("private PAC address"); };
    const failure = await send(url);
    assert.equal(failure.status, 400);
    assert.deepEqual(await failure.json(), { error: "System proxy resolution failed" });
  } finally { await server.close(); }
});

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
    const acquisitionSignal = calls[0].pop();
    assert.ok(acquisitionSignal instanceof AbortSignal);
    assert.equal(acquisitionSignal.aborted, false);
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
      ["heartbeat", "abcdef123456", process.pid, true, undefined],
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

test("browser control server accepts a large owner-bound automatic clipboard paste", async () => {
  const calls = [];
  const host = {
    browserInteractionMode: () => "automatic",
    pasteTurnPrompt: async (...args) => { calls.push(["paste", ...args]); return { pasteId: "paste_abcdefghijklmnop" }; },
    releaseTurnPromptPaste: (...args) => { calls.push(["release", ...args]); return { restored: true }; },
  };
  const server = await new BrowserControlServer({
    logger: { info() {}, warn() {}, error() {} },
    getBrowserHost: () => host,
    getPreferences: () => ({}),
  }).start();
  const descriptor = server.descriptor();
  const prompt = "x".repeat(128 * 1024);
  try {
    const response = await fetch(`${descriptor.endpoint}/v1/turn/paste`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ traceId: "paste123456", helperPid: process.pid, prompt }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, pasteId: "paste_abcdefghijklmnop" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 3), ["paste", "paste123456", process.pid]);
    assert.equal(calls[0][3], prompt);

    const release = await fetch(`${descriptor.endpoint}/v1/turn/paste/release`, {
      method: "POST",
      headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ traceId: "paste123456", helperPid: process.pid, pasteId: "paste_abcdefghijklmnop" }),
    });
    assert.equal(release.status, 200);
    assert.deepEqual(await release.json(), { ok: true, restored: true });
    assert.deepEqual(calls[1], ["release", "paste123456", process.pid, "paste_abcdefghijklmnop"]);
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
      return { authenticated: true, newChat: true, url: "https://chatgpt.com/" };
    },
    removeTurnTab(tab, abortRunning) {
      assert.equal(abortRunning, false);
      removed.push(tab.id);
      this.turnTabs.delete(tab.id);
    },
    markOwnedSurface: async () => { ownershipMarks += 1; },
    writeDescriptor: () => {},
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

test("browser control server reports a lost running helper as a typed conflict", async () => {
  const host = {
    browserInteractionMode: () => "automatic",
    beginTurn: () => {
      const error = new Error("The running ChatGPT turn lost its helper");
      error.code = "turn_owner_lost";
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
      error: "The running ChatGPT turn lost its helper",
      code: "turn_owner_lost",
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
