const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { resolve } = require("node:path");
const {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
  scaleBrowserBounds,
  shellZoomActionForInput,
} = require("../electron/browser-state.cjs");
const {
  allowedAuthUrl,
  BrowserHost,
  IDLE_BROWSER_URL,
  isChatGptCloudflareChallengeResponse,
  isTemporaryChatUrl,
  loadCommittedBrowserSurface,
  MANUAL_COMPACTION_SUBMIT_TIMEOUT_MS,
  MANUAL_SUBMIT_TIMEOUT_MS,
  navigationErrorForLog,
  navigationOriginForLog,
} = require("../electron/browser-host.cjs");

test("manual prompt handoff keeps ordinary turns at one minute and compaction at two minutes", () => {
  assert.equal(MANUAL_SUBMIT_TIMEOUT_MS, 60_000);
  assert.equal(MANUAL_COMPACTION_SUBMIT_TIMEOUT_MS, 120_000);
});

test("Electron and Bun agree on the exact launcher idle surface", () => {
  const clientSource = fs.readFileSync(
    resolve(__dirname, "../../src/launcher-browser-host.ts"),
    "utf8",
  );
  assert.ok(clientSource.includes(
    `export const LAUNCHER_BROWSER_IDLE_URL = ${JSON.stringify(IDLE_BROWSER_URL)};`,
  ));
});

test("descriptor publishes native surface identities without inspecting renderers or Zero Risk tabs", () => {
  const dir = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "browser-targets-"));
  const queried = [];
  const contents = id => ({
    isDestroyed: () => false,
    getOrCreateDevToolsTargetId: () => { queried.push(id); return id; },
    executeJavaScript: () => { throw new Error("Descriptor must not inspect renderer content"); },
  });
  const automatic = { surfaceId: "a".repeat(32), interactionMode: "automatic", view: { webContents: contents("auto-target") } };
  const manual = { surfaceId: null, interactionMode: "manual", view: { webContents: contents("manual-target") } };
  const fixture = {
    surfaceId: "h".repeat(32), view: { webContents: contents("home-target") },
    turnTabs: new Map([["automatic", automatic], ["manual", manual]]),
    getBrowserInteractionMode: () => "automatic", profile: "production", cdpPort: 40000,
    partition: "persist:codex-web-gpt-chatgpt", control: {}, helper: {},
    descriptorPath: require("node:path").join(dir, "descriptor.json"),
  };
  try {
    BrowserHost.prototype.writeDescriptor.call(fixture);
    const descriptor = JSON.parse(fs.readFileSync(fixture.descriptorPath, "utf8"));
    assert.equal(descriptor.version, 3);
    assert.deepEqual(descriptor.surfaceTargets, { [fixture.surfaceId]: "home-target", [automatic.surfaceId]: "auto-target" });
    assert.deepEqual(queried, ["home-target", "auto-target"]);
    fixture.getBrowserInteractionMode = () => "manual";
    BrowserHost.prototype.writeDescriptor.call(fixture);
    assert.deepEqual(JSON.parse(fs.readFileSync(fixture.descriptorPath, "utf8")).surfaceTargets, {});
    assert.deepEqual(queried, ["home-target", "auto-target"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("mode transitions publish targets before setup inspection and restore them on rollback", async () => {
  const dir = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "browser-mode-targets-"));
  let savedMode = "manual";
  const announcementModes = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    surfaceId: "h".repeat(32),
    view: { webContents: { isDestroyed: () => false, getOrCreateDevToolsTargetId: () => "home-target" } },
    turnTabs: new Map(), getBrowserInteractionMode: () => savedMode,
    interactionModeOverride: null, manualOperation: null,
    profile: "production", cdpPort: 40000, partition: "persist:codex-web-gpt-chatgpt",
    control: {}, helper: {}, descriptorPath: require("node:path").join(dir, "descriptor.json"),
    markOwnedSurface: async () => {},
    configureAnnouncementDismissal: async enabled => announcementModes.push(enabled),
  });
  const targets = () => JSON.parse(fs.readFileSync(fixture.descriptorPath, "utf8")).surfaceTargets;
  const automaticTargets = { [fixture.surfaceId]: "home-target" };
  try {
    fixture.writeDescriptor();
    assert.deepEqual(targets(), {});
    await assert.rejects(fixture.withInteractionModeChange("automatic", async () => {
      assert.deepEqual(targets(), automaticTargets);
      throw new Error("setup failed");
    }), /setup failed/);
    assert.deepEqual(targets(), {});
    await fixture.withInteractionModeChange("automatic", async commit => {
      assert.deepEqual(targets(), automaticTargets);
      await commit();
    });
    // main.cjs persists the new mode only after the transaction returns.
    assert.deepEqual(targets(), automaticTargets);
    savedMode = "automatic";
    await assert.rejects(fixture.withInteractionModeChange("manual", async () => {
      assert.deepEqual(targets(), {});
      throw new Error("manual setup failed");
    }), /manual setup failed/);
    assert.deepEqual(targets(), automaticTargets);
    await fixture.withInteractionModeChange("manual", async commit => {
      assert.deepEqual(targets(), {});
      await commit();
    });
    savedMode = "manual";
    assert.deepEqual(targets(), {});
    assert.equal(fixture.currentOperation(), null);
    await assert.rejects(fixture.withInteractionModeChange("automatic", async commit => {
      await commit();
      throw new Error("runtime failed after browser commit");
    }), /runtime failed after browser commit/);
    assert.deepEqual(targets(), {});
    assert.deepEqual(announcementModes, [false, true, false, true, false, true, false]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("primary browser bootstrap accepts only the exact committed idle document", async () => {
  const calls = [];
  const contents = new EventEmitter();
  let currentUrl = "about:blank";
  contents.isDestroyed = () => false;
  contents.getURL = () => currentUrl;
  contents.stop = () => calls.push("stop");
  contents.loadURL = async (url) => {
    calls.push(["load", url]);
    currentUrl = url;
  };

  await loadCommittedBrowserSurface(contents, IDLE_BROWSER_URL, 50);

  assert.deepEqual(calls, [["load", IDLE_BROWSER_URL]]);
  assert.equal(contents.listenerCount("did-stop-loading"), 0);
  assert.equal(contents.listenerCount("did-finish-load"), 0);
  assert.equal(contents.listenerCount("did-fail-load"), 0);
  assert.equal(contents.listenerCount("render-process-gone"), 0);
  assert.equal(contents.listenerCount("destroyed"), 0);
});

test("primary browser bootstrap fails closed on navigation, renderer, and timeout boundaries", async () => {
  const keepTestAlive = setTimeout(() => {}, 100);
  try {
    const failureCases = [
      {
        event: ["did-fail-load", {}, -2, "ERR_FAILED", IDLE_BROWSER_URL, true],
        expected: /idle document failed: ERR_FAILED \(-2\)/,
      },
      {
        event: ["render-process-gone", {}, { reason: "crashed", exitCode: -2147483645 }],
        expected: /renderer stopped during idle document bootstrap: crashed/,
      },
    ];
    for (const failure of failureCases) {
      const contents = new EventEmitter();
      contents.isDestroyed = () => false;
      contents.getURL = () => "about:blank";
      contents.stop = () => {};
      contents.loadURL = () => {
        queueMicrotask(() => contents.emit(...failure.event));
        return new Promise(() => {});
      };
      await assert.rejects(
        loadCommittedBrowserSurface(contents, IDLE_BROWSER_URL, 50),
        failure.expected,
      );
    }

    const stalled = new EventEmitter();
    const calls = [];
    stalled.isDestroyed = () => false;
    stalled.getURL = () => "about:blank";
    stalled.stop = () => calls.push("stop");
    stalled.loadURL = () => new Promise(() => {});
    await assert.rejects(
      loadCommittedBrowserSurface(stalled, IDLE_BROWSER_URL, 5),
      /idle document did not commit within 5ms/,
    );
    assert.deepEqual(calls, ["stop"]);
  } finally {
    clearTimeout(keepTestAlive);
  }
});

function manualTabNavigationFixture(remoteError, chatUrl = "https://chatgpt.com/?temporary-chat=true") {
  const calls = [];
  const logs = [];
  const terminal = [];
  let currentUrl = "about:blank";
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.getURL = () => currentUrl;
  contents.stop = () => calls.push("stop");
  contents.loadURL = async (url) => {
    calls.push(["load", url]);
    if (url === IDLE_BROWSER_URL) {
      currentUrl = url;
      tab.url = url;
      return;
    }
    throw remoteError;
  };
  const tab = {
    id: "manual-edit-retry",
    url: chatUrl,
    traceId: "trace-edit-retry",
    manualState: "awaiting-user",
    view: { webContents: contents },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    turnTabs: new Map([[tab.id, tab]]),
    logger: {
      info: (event, detail) => logs.push(["info", event, detail]),
      error: (event, detail) => logs.push(["error", event, detail]),
    },
    signalManualTerminal(_tab, status) { terminal.push(status); },
    removeTurnTab(removed) { this.turnTabs.delete(removed.id); },
  });
  return { calls, fixture, logs, tab, terminal };
}

test("manual edit retry survives Electron superseding the ChatGPT navigation", async () => {
  for (const chatUrl of ["https://chatgpt.com/?temporary-chat=true", "https://chatgpt.com/"]) {
    const observed = manualTabNavigationFixture(
      new Error(`ERR_ABORTED (-3) loading ${chatUrl}`), chatUrl,
    );

    await observed.fixture.initializeManualTurnTab(observed.tab);

    assert.deepEqual(observed.calls, [
      ["load", IDLE_BROWSER_URL],
      ["load", chatUrl],
    ]);
    assert.equal(observed.fixture.turnTabs.has(observed.tab.id), true);
    assert.deepEqual(observed.terminal, []);
    assert.equal(observed.logs.some(([, event]) => event === "browser.manual_tab_navigation_superseded"), true);
  }
});

test("manual ChatGPT navigation still fails closed on a real load failure", async () => {
  const failure = new Error("ERR_FAILED (-2) loading 'https://chatgpt.com/?temporary-chat=true'");
  failure.code = "ERR_FAILED";
  const observed = manualTabNavigationFixture(failure);

  await observed.fixture.initializeManualTurnTab(observed.tab);

  assert.equal(observed.fixture.turnTabs.has(observed.tab.id), false);
  assert.deepEqual(observed.terminal, ["failed"]);
  assert.equal(observed.logs.some(([, event]) => event === "browser.manual_tab_navigation_failed"), true);
});

test("primary browser initialization keeps its view offscreen but visible until ownership is committed", async () => {
  const calls = [];
  let currentUrl = "about:blank";
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.getURL = () => currentUrl;
  contents.stop = () => calls.push("stop");
  contents.loadURL = async (url) => {
    calls.push(["load", url]);
    currentUrl = url;
  };
  const hiddenBounds = { x: 1121, y: 721, width: 1120, height: 720 };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    view: {
      setBounds: bounds => calls.push(["bounds", bounds]),
      setVisible: visible => calls.push(["visible", visible]),
      webContents: contents,
    },
    hiddenTurnBounds: () => hiddenBounds,
    markOwnedSurface: async () => calls.push("owned"),
    syncViewVisibility: () => calls.push("sync"),
    writeDescriptor: () => calls.push("descriptor"),
    logger: { info: (event, detail) => calls.push([event, detail]) },
  });

  await BrowserHost.prototype.initializePrimaryView.call(fixture);

  assert.deepEqual(calls, [
    ["bounds", hiddenBounds],
    ["visible", true],
    ["load", IDLE_BROWSER_URL],
    "owned",
    "sync",
    "descriptor",
    ["browser.initialized", { url: IDLE_BROWSER_URL }],
  ]);
});

test("authentication diagnostics retain only origin and non-sensitive error metadata", () => {
  assert.equal(
    navigationOriginForLog("https://accounts.google.com/o/oauth2/v2/auth?state=secret&login_hint=user@example.com"),
    "https://accounts.google.com",
  );
  assert.equal(navigationOriginForLog("not a URL with user@example.com"), "invalid-url");
  assert.deepEqual(
    navigationErrorForLog(Object.assign(new Error("loading https://chatgpt.com/c/private"), { code: "ERR_ABORTED" })),
    { errorType: "Error", errorCode: "ERR_ABORTED" },
  );
});

test("only an explicit Cloudflare challenge on a ChatGPT backend response triggers recovery", () => {
  assert.equal(isChatGptCloudflareChallengeResponse({
    statusCode: 403,
    url: "https://chatgpt.com/backend-api/subscriptions",
    responseHeaders: {
      "Cf-Mitigated": ["challenge"],
      "Content-Type": ["text/html; charset=UTF-8"],
    },
  }), true);
  assert.equal(isChatGptCloudflareChallengeResponse({
    statusCode: 403,
    url: "https://chatgpt.com/backend-api/subscriptions",
    responseHeaders: { "Content-Type": ["application/json"] },
  }), false);
  assert.equal(isChatGptCloudflareChallengeResponse({
    statusCode: 403,
    url: "https://example.com/backend-api/subscriptions",
    responseHeaders: { "cf-mitigated": ["challenge"] },
  }), false);
});

test("the idle home browser performs one bounded reload for a Cloudflare challenge burst", async () => {
  const calls = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(),
    manualOperation: null,
    cloudflareChallengeRecovery: null,
    cloudflareChallengeRecoveryArmed: true,
    cloudflareChallengeRecoveryDelayMs: 0,
    cloudflareChallengeRecoverySettleMs: 0,
    view: {
      webContents: {
        id: 42,
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        isDestroyed: () => false,
        loadURL: async (url) => calls.push(["loadURL", url]),
      },
    },
    logger: {
      info: (event, detail) => calls.push(["info", event, detail]),
      warn: (event, detail) => calls.push(["warn", event, detail]),
      error: (event, detail) => calls.push(["error", event, detail]),
    },
    setState: (patch) => calls.push(["setState", patch]),
    probeAuthentication: async () => calls.push(["probeAuthentication"]),
  });
  const challenge = {
    statusCode: 403,
    url: "https://chatgpt.com/backend-api/subscriptions",
    webContentsId: 42,
    responseHeaders: { "cf-mitigated": ["challenge"] },
  };

  assert.equal(BrowserHost.prototype.handleChatGptBackendResponse.call(fixture, challenge), true);
  assert.equal(BrowserHost.prototype.handleChatGptBackendResponse.call(fixture, challenge), true);
  await fixture.cloudflareChallengeRecovery;

  assert.deepEqual(calls.filter(([name]) => name === "loadURL"), [
    ["loadURL", "https://chatgpt.com/?temporary-chat=true"],
  ]);
  assert.equal(fixture.cloudflareChallengeRecoveryArmed, false);

  BrowserHost.prototype.handleChatGptBackendResponse.call(fixture, {
    statusCode: 200,
    url: "https://chatgpt.com/backend-api/subscriptions",
    webContentsId: 42,
    responseHeaders: { "content-type": ["application/json"] },
  });
  assert.equal(fixture.cloudflareChallengeRecoveryArmed, true);
});

function createContents() {
  const calls = [];
  let zoomFactor = 1;
  const history = {
    canGoBack: () => true,
    canGoForward: () => false,
    goBack: () => calls.push("back"),
    goForward: () => calls.push("forward"),
  };
  const webContents = {
    navigationHistory: history,
    getURL: () => "https://chatgpt.com/?temporary-chat=true",
    getTitle: () => "ChatGPT",
    isDestroyed: () => false,
    isLoading: () => false,
    focus: () => calls.push("focus"),
    getZoomFactor: () => zoomFactor,
    reload: () => calls.push("reload"),
    setZoomFactor: (next) => {
      zoomFactor = next;
      calls.push(["zoom", next]);
    },
  };
  return { calls, webContents };
}

test("browser surface visibility requires both requested and active state", () => {
  assert.equal(browserViewVisible(false, false, false), false);
  assert.equal(browserViewVisible(true, false, true), false);
  assert.equal(browserViewVisible(false, true, true), false);
  assert.equal(browserViewVisible(true, true, false), false);
  assert.equal(browserViewVisible(true, true, true), true);
});

test("descriptor-owned home surface stays attached offscreen while another launcher surface is active", () => {
  const calls = [];
  const hiddenBounds = { x: 1201, y: 801, width: 1200, height: 800 };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    window: {
      isVisible: () => true,
      isMinimized: () => false,
    },
    visible: false,
    surfaceActive: false,
    boundsReady: true,
    bounds: { x: 200, y: 100, width: 900, height: 650 },
    hiddenTurnBounds: () => hiddenBounds,
    view: {
      setBounds: bounds => calls.push(["bounds", bounds]),
      setVisible: visible => calls.push(["visible", visible]),
    },
    authView: null,
    turnTabs: new Map(),
    selectedTurnTab: () => null,
  });

  BrowserHost.prototype.syncViewVisibility.call(fixture);

  assert.deepEqual(calls, [
    ["bounds", hiddenBounds],
    ["visible", true],
  ]);
});

test("smoke preserves an already-hydrated Temporary Chat page", () => {
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/?temporary-chat=true"), true);
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/?temporary-chat=false"), false);
  assert.equal(isTemporaryChatUrl("https://chatgpt.com/c/abc?temporary-chat=true"), false);
  assert.equal(isTemporaryChatUrl("not a url"), false);
});

test("session inspection delegates navigation and capability detection to the shared browser helper", async () => {
  const calls = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    helper: { executable: "/runtime/electron", script: "/runtime/browser-helper.cjs" },
    descriptorPath: "/runtime/launcher-browser.json",
    getConnectorName: () => "Codex Native2",
    logger: { info() {} },
    view: { webContents: { getURL: () => "https://chatgpt.com/" } },
    refreshChatGptHomeDocument: async () => calls.push({ operation: "refresh" }),
    runBrowserHelperOperation: async options => {
      calls.push(options);
      return {
        type: "result",
        value: {
          authenticated: true,
          temporary: true,
          url: "https://chatgpt.com/?temporary-chat=true",
          solAvailable: true,
          extraHighAvailable: true, proAvailable: true,
        },
      };
    },
  });

  const inspected = await BrowserHost.prototype.runSessionInspection.call(fixture, true);

  assert.deepEqual(inspected, {
    authenticated: true,
    temporary: true,
    url: "https://chatgpt.com/?temporary-chat=true",
    solAvailable: true,
    extraHighAvailable: true, proAvailable: true,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].operation, "refresh");
  assert.equal(calls[1].operation, "inspect");
  assert.equal(calls[1].appName, "Codex Native2");
  assert.deepEqual(calls[1].payload, { detectCapabilities: true });
});

test("session inspection fails closed on incomplete shared-helper capability evidence", async () => {
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    helper: {},
    descriptorPath: "/runtime/launcher-browser.json",
    getConnectorName: () => "Codex Native",
    logger: { info() {} },
    view: { webContents: { getURL: () => "https://chatgpt.com/?temporary-chat=true" } },
    refreshChatGptHomeDocument: async () => {},
    runBrowserHelperOperation: async () => ({
      type: "result",
      value: { authenticated: true, temporary: true, url: "https://chatgpt.com/?temporary-chat=true" },
    }),
  });
  await assert.rejects(
    BrowserHost.prototype.runSessionInspection.call(fixture, true),
    /incomplete ChatGPT capability evidence/,
  );
});

test("browser surface reactivation preserves its last measured bounds", () => {
  const visibility = [];
  const fixture = {
    surfaceActive: true,
    boundsReady: true,
    syncViewVisibility() {
      visibility.push({ active: this.surfaceActive, boundsReady: this.boundsReady });
    },
    setState() {},
    snapshot() {
      return { surfaceActive: this.surfaceActive, boundsReady: this.boundsReady };
    },
  };

  BrowserHost.prototype.setSurfaceActive.call(fixture, false);
  BrowserHost.prototype.setSurfaceActive.call(fixture, true);

  assert.deepEqual(visibility, [
    { active: false, boundsReady: true },
    { active: true, boundsReady: true },
  ]);
  assert.equal(fixture.boundsReady, true);
});

test("hidden turn tabs receive an explicit renderer viewport before moving offscreen", () => {
  const events = [];
  const tab = {
    id: "tab-hidden-viewport",
    status: "running",
    rendererReady: true,
    deviceEmulationViewport: null,
    deviceEmulationDirty: true,
    view: {
      setBounds: bounds => events.push(["bounds", bounds]),
      setVisible: visible => events.push(["visible", visible]),
      webContents: {
        enableDeviceEmulation: options => events.push(["emulate", options]),
        disableDeviceEmulation: () => events.push(["disable-emulation"]),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    visible: false,
    surfaceActive: false,
    boundsReady: false,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    selectedTabId: tab.id,
    turnTabs: new Map([[tab.id, tab]]),
    authView: null,
    window: {
      getContentSize: () => [1120, 720],
      isMinimized: () => false,
      isVisible: () => true,
    },
    view: {
      setBounds: bounds => events.push(["home-bounds", bounds]),
      setVisible: visible => events.push(["home-visible", visible]),
    },
  });

  BrowserHost.prototype.syncViewVisibility.call(fixture);

  assert.deepEqual(events, [
    ["home-bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["home-visible", true],
    ["emulate", {
      screenPosition: "desktop",
      screenSize: { width: 1120, height: 720 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width: 1120, height: 720 },
      scale: 1,
    }],
    ["bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["visible", true],
  ]);
  assert.deepEqual(tab.deviceEmulationViewport, { width: 1120, height: 720 });
  assert.equal(tab.deviceEmulationDirty, false);
});

test("hidden primary checks retain a renderer viewport across resize and navigation, then restore native bounds", () => {
  const calls = [];
  let size = [1120, 720];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    primaryRendererReady: false, primaryDeviceEmulationDirty: true,
    primaryDeviceEmulationViewport: null,
    bounds: { x: 280, y: 64, width: 840, height: 656 },
    window: { getContentSize: () => size },
    view: {
      setBounds: value => calls.push(["bounds", value]), setVisible: value => calls.push(["visible", value]),
      webContents: {
        enableDeviceEmulation: value => calls.push(["emulate", value.viewSize]),
        disableDeviceEmulation: () => calls.push(["disable"]),
      },
    },
  });
  fixture.presentPrimaryView(false);
  assert.equal(calls.some(([event]) => event === "emulate"), false);
  fixture.primaryRendererReady = true;
  fixture.presentPrimaryView(false);
  assert.deepEqual(calls.slice(-3), [["emulate", { width: 1120, height: 720 }],
    ["bounds", { x: 1121, y: 721, width: 1120, height: 720 }], ["visible", true]]);
  fixture.presentPrimaryView(false);
  assert.equal(calls.filter(([event]) => event === "emulate").length, 1);
  fixture.primaryDeviceEmulationDirty = true;
  fixture.presentPrimaryView(false);
  size = [1280, 800];
  fixture.presentPrimaryView(false);
  assert.deepEqual(fixture.primaryDeviceEmulationViewport, { width: 1280, height: 800 });
  assert.equal(calls.filter(([event]) => event === "emulate").length, 3);
  fixture.presentPrimaryView(true);
  assert.deepEqual(calls.slice(-3), [["bounds", fixture.bounds], ["disable"], ["visible", true]]);
  assert.equal(fixture.primaryDeviceEmulationViewport, null);
  fixture.getBrowserInteractionMode = () => "manual";
  fixture.presentPrimaryView(false);
  assert.equal(calls.filter(([event]) => event === "emulate").length, 3);
});

test("turn tabs use the hidden viewport when the launcher window is hidden", () => {
  const events = [];
  const tab = {
    id: "tab-hidden-window",
    status: "running",
    rendererReady: true,
    deviceEmulationViewport: null,
    deviceEmulationDirty: true,
    view: {
      setBounds: bounds => events.push(["bounds", bounds]),
      setVisible: visible => events.push(["visible", visible]),
      webContents: {
        enableDeviceEmulation: options => events.push(["emulate", options]),
        disableDeviceEmulation: () => events.push(["disable-emulation"]),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    visible: true,
    surfaceActive: true,
    boundsReady: true,
    bounds: { x: 280, y: 64, width: 840, height: 656 },
    selectedTabId: tab.id,
    turnTabs: new Map([[tab.id, tab]]),
    authView: null,
    window: {
      getContentSize: () => [1120, 720],
      isMinimized: () => false,
      isVisible: () => false,
    },
    view: {
      setBounds: bounds => events.push(["home-bounds", bounds]),
      setVisible: visible => events.push(["home-visible", visible]),
    },
  });

  BrowserHost.prototype.syncViewVisibility.call(fixture);

  assert.deepEqual(events, [
    ["home-bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["home-visible", true],
    ["emulate", {
      screenPosition: "desktop",
      screenSize: { width: 1120, height: 720 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: { width: 1120, height: 720 },
      scale: 1,
    }],
    ["bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["visible", true],
  ]);
  assert.deepEqual(tab.deviceEmulationViewport, { width: 1120, height: 720 });
});

test("new turn tabs defer device emulation until their renderer finishes loading", () => {
  const events = [];
  const tab = {
    id: "tab-loading-viewport",
    status: "running",
    rendererReady: false,
    deviceEmulationViewport: null,
    deviceEmulationDirty: true,
    view: {
      setBounds: bounds => events.push(["bounds", bounds]),
      setVisible: visible => events.push(["visible", visible]),
      webContents: {
        enableDeviceEmulation: () => assert.fail("emulation started before did-finish-load"),
        disableDeviceEmulation: () => assert.fail("emulation cleared before did-finish-load"),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    window: {
      getContentSize: () => [1120, 720],
      isMinimized: () => false,
      isVisible: () => true,
    },
  });

  BrowserHost.prototype.presentTurnView.call(fixture, tab, false);

  assert.deepEqual(events, [
    ["bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["visible", true],
  ]);
  assert.equal(tab.deviceEmulationViewport, null);
  assert.equal(tab.deviceEmulationDirty, true);
});

test("visible turn tabs establish native bounds before clearing background emulation", () => {
  const events = [];
  const tab = {
    id: "tab-visible-viewport",
    status: "running",
    rendererReady: true,
    deviceEmulationViewport: { width: 1120, height: 720 },
    deviceEmulationDirty: true,
    view: {
      setBounds: bounds => events.push(["bounds", bounds]),
      setVisible: visible => events.push(["visible", visible]),
      webContents: {
        enableDeviceEmulation: options => events.push(["emulate", options]),
        disableDeviceEmulation: () => events.push(["disable-emulation"]),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    visible: true,
    surfaceActive: true,
    boundsReady: true,
    bounds: { x: 280, y: 64, width: 840, height: 656 },
    selectedTabId: tab.id,
    turnTabs: new Map([[tab.id, tab]]),
    authView: null,
    window: {
      getContentSize: () => [1120, 720],
      isMinimized: () => false,
      isVisible: () => true,
    },
    view: {
      setBounds: bounds => events.push(["home-bounds", bounds]),
      setVisible: visible => events.push(["home-visible", visible]),
    },
  });

  BrowserHost.prototype.syncViewVisibility.call(fixture);

  assert.deepEqual(events, [
    ["home-bounds", { x: 1121, y: 721, width: 1120, height: 720 }],
    ["home-visible", true],
    ["bounds", { x: 280, y: 64, width: 840, height: 656 }],
    ["disable-emulation"],
    ["visible", true],
  ]);
  assert.equal(tab.deviceEmulationViewport, null);
  assert.equal(tab.deviceEmulationDirty, false);
});

test("manual browser operations wait for the first measured surface", async () => {
  let readinessReads = 0;
  const fixture = {
    surfaceActive: true,
    get boundsReady() {
      readinessReads += 1;
      return readinessReads >= 3;
    },
  };

  await BrowserHost.prototype.waitForSurfaceReady.call(fixture, 1_000, 1);

  assert.equal(readinessReads, 3);
});

test("manual browser operations fail closed without measured surface bounds", async () => {
  await assert.rejects(
    BrowserHost.prototype.waitForSurfaceReady.call(
      { surfaceActive: true, boundsReady: false },
      2,
      1,
    ),
    /did not receive measured bounds/,
  );
});

test("browser bounds are clipped to the launcher content area", () => {
  assert.deepEqual(
    constrainBrowserBounds({ x: 260, y: 78, width: 1000, height: 900 }, { width: 1200, height: 800 }),
    { x: 260, y: 78, width: 940, height: 722 },
  );
  assert.deepEqual(
    constrainBrowserBounds({ x: -20, y: -10, width: 0, height: 0 }, { width: 1200, height: 800 }),
    { x: 0, y: 0, width: 1, height: 1 },
  );
});

test("zoomed renderer bounds are converted back to native window coordinates", () => {
  assert.deepEqual(
    scaleBrowserBounds({ x: 200, y: 60, width: 800, height: 500 }, 1.25),
    { x: 250, y: 75, width: 1000, height: 625 },
  );
  assert.throws(
    () => scaleBrowserBounds({ x: 1, y: 1, width: 1, height: 1 }, 0),
    /zoom factor must be positive/,
  );
});

test("shell zoom shortcuts recognize native CommandOrControl keys only", () => {
  const keyDown = { type: "keyDown", key: "=", meta: true, control: false, alt: false };

  assert.equal(shellZoomActionForInput(keyDown, "darwin"), "in");
  assert.equal(shellZoomActionForInput({ ...keyDown, key: "-" }, "darwin"), "out");
  assert.equal(shellZoomActionForInput({ ...keyDown, key: "0" }, "darwin"), "reset");
  assert.equal(
    shellZoomActionForInput({ ...keyDown, meta: false, control: true }, "win32"),
    "in",
  );
  assert.equal(shellZoomActionForInput({ ...keyDown, meta: false }, "darwin"), null);
  assert.equal(shellZoomActionForInput({ ...keyDown, key: "r" }, "darwin"), null);
  assert.equal(shellZoomActionForInput({ ...keyDown, type: "keyUp" }, "darwin"), null);
  assert.equal(shellZoomActionForInput({ ...keyDown, alt: true }, "darwin"), null);
});

test("guest and incomplete server sessions do not prove launcher authentication", async () => {
  const fixture = {
    state: { authenticated: true },
    activeTraceId: null,
    manualOperation: null,
    view: {
      webContents: {
        isDestroyed: () => false,
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        executeJavaScript: async () => ({
          composer: true,
          temporary: true,
          sessionAuthenticated: false,
          readyState: "complete",
        }),
      },
    },
    setState(patch) { this.state = { ...this.state, ...patch }; },
    snapshot() { return { ...this.state }; },
    logger: { info() {} },
  };

  const result = await BrowserHost.prototype.probeAuthentication.call(fixture);
  assert.equal(result.authenticated, false);
  assert.equal(result.status, "signed-out");
});

test("launcher authentication is established by the complete server session", async () => {
  const fixture = {
    state: { authenticated: false },
    activeTraceId: null,
    manualOperation: null,
    view: {
      webContents: {
        isDestroyed: () => false,
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        executeJavaScript: async () => ({
          composer: true,
          temporary: true,
          sessionAuthenticated: true,
          readyState: "complete",
        }),
      },
    },
    setState(patch) { this.state = { ...this.state, ...patch }; },
    snapshot() { return { ...this.state }; },
    logger: { info() {} },
  };

  const result = await BrowserHost.prototype.probeAuthentication.call(fixture);
  assert.equal(result.authenticated, true);
  assert.equal(result.status, "ready");
});

test("a verified session stays signed in while its composer is unavailable", async () => {
  const vm = require("node:vm");
  const { createDocument } = require("@mixmark-io/domino");
  const url = "https://chatgpt.com/?temporary-chat=true";
  for (const owned of [true, false]) {
    const document = createDocument(`<form ${owned ? "data-chatgpt-composer" : ""}>
      <div data-composer-markdown contenteditable="true" role="textbox"></div></form>`);
    const editor = document.querySelector("[data-composer-markdown]");
    Object.defineProperties(editor, {
      isConnected: { value: true },
      getBoundingClientRect: { value: () => ({ width: 300, height: 60 }) },
    });
    const fixture = {
      state: { authenticated: false }, activeTraceId: null, manualOperation: null,
      view: { webContents: {
        isDestroyed: () => false, getURL: () => url,
        executeJavaScript: script => vm.runInNewContext(script, {
          location: { href: url },
          document: { readyState: "complete", querySelectorAll: selector => document.querySelectorAll(selector) },
          getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
          URL, AbortController, setTimeout, clearTimeout,
          fetch: async () => ({ ok: true, status: 200, url: "https://chatgpt.com/api/auth/session",
            headers: { get: () => "application/json" },
            json: async () => ({ user: { id: "fixture" }, expires: "2099-01-01T00:00:00Z" }),
          }),
        }),
      } },
      setState(patch) { this.state = { ...this.state, ...patch }; },
      snapshot() { return { ...this.state }; }, logger: { info() {} },
    };
    const result = await BrowserHost.prototype.probeAuthentication.call(fixture);
    assert.equal(result.authenticated, true);
  }
});

test("session verification distinguishes a missing login from network and invalid-response failures", async () => {
  const vm = require("node:vm");
  const url = "https://chatgpt.com/?temporary-chat=true";
  const sessionUrl = "https://chatgpt.com/api/auth/session";
  const response = (payload, overrides = {}) => ({
    ok: true, status: 200, url: sessionUrl,
    headers: { get: () => "application/json" }, json: async () => payload, ...overrides,
  });
  const validSession = { user: { id: "fixture" }, expires: "2099-01-01T00:00:00Z" };
  const cases = [
    { name: "valid", fetch: async () => response(validSession), status: "ready", authenticated: true },
    { name: "guest", fetch: async () => response({}), status: "signed-out" },
    { name: "expired", fetch: async () => response({ ...validSession, expires: "2000-01-01T00:00:00Z" }), status: "signed-out" },
    { name: "unauthorized", fetch: async () => response(null, { ok: false, status: 401 }), status: "signed-out" },
    { name: "network", fetch: async () => { throw new Error("private-proxy-secret"); }, status: "error", message: /connection|network/i },
    { name: "deadline", timeout: true, fetch: async (_url, { signal }) => {
      await new Promise(resolve => setImmediate(resolve));
      signal.throwIfAborted();
      throw new Error("Expected the session deadline to abort");
    }, status: "error", message: /timed out/i },
    { name: "server", fetch: async () => response(null, { ok: false, status: 503 }), status: "error", message: /503/ },
    { name: "html", fetch: async () => response(null, { headers: { get: () => "text/html" } }), status: "error" },
    { name: "redirect", fetch: async (_url, options) => {
      assert.equal(options.redirect, "error");
      throw new TypeError("Redirect rejected");
    }, status: "error" },
    { name: "invalid JSON", fetch: async () => response(null, { json: async () => { throw new SyntaxError("private-response"); } }), status: "error" },
    { name: "renderer", rendererError: true, status: "error", message: /browser/i },
  ];
  for (const item of cases) {
    const fixture = {
      state: { authenticated: true }, activeTraceId: null, manualOperation: null,
      view: { webContents: {
        isDestroyed: () => false, getURL: () => url,
        executeJavaScript: async script => {
          if (item.rendererError) throw new Error("private-renderer-error");
          return await vm.runInNewContext(script, {
            location: { href: url }, document: { readyState: "complete", querySelectorAll: () => [{
              isConnected: true, getBoundingClientRect: () => ({ width: 100, height: 30 }),
            }] }, getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
            URL, AbortController, fetch: item.fetch,
            setTimeout: callback => item.timeout ? setImmediate(callback) : null,
            clearTimeout: handle => handle && clearImmediate(handle),
          });
        },
      } },
      setState(patch) { this.state = { ...this.state, ...patch }; },
      snapshot() { return { ...this.state }; }, logger: { info() {} },
    };
    const result = await BrowserHost.prototype.probeAuthentication.call(fixture);
    assert.equal(result.status, item.status, item.name);
    assert.equal(result.authenticated, item.authenticated === true, item.name);
    if (item.message) assert.match(result.message, item.message, item.name);
    assert.doesNotMatch(JSON.stringify(result), /private-/);
  }
});

test("authentication windows stay inside the launcher-owned browser partition", () => {
  assert.equal(allowedAuthUrl("https://accounts.google.com/o/oauth2/v2/auth"), true);
  assert.equal(allowedAuthUrl("https://chatgpt.com/auth/login"), true);
  assert.equal(allowedAuthUrl("https://platform.openai.com/settings/organization/tunnels"), false);
  assert.equal(allowedAuthUrl("https://example.com/login"), false);
  const source = fs.readFileSync(require.resolve("../electron/browser-host.cjs"), "utf8");
  assert.match(source, /createWindow:\s*\(options\)\s*=>\s*this\.createAuthView\(options,\s*url\)/);
  assert.match(source, /webContents:\s*options\.webContents/);
  assert.doesNotMatch(source, /loginWithSystemBrowser|captureSystemBrowserLogin|system_login_started/);
});

test("concurrent authentication probes share the same navigation and allow the next refresh", async () => {
  let probes = 0;
  let navigations = 0;
  let release;
  let temporary = false;
  const ready = new Promise(resolve => { release = resolve; });
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(),
    state: { authenticated: false }, manualOperation: "ChatGPT login",
    view: { webContents: {
      isDestroyed: () => false,
      getURL: () => "https://chatgpt.com/",
      executeJavaScript: async () => {
        probes += 1;
        await ready;
        return { composer: true, temporary, sessionAuthenticated: true, url: "https://chatgpt.com/", readyState: "complete" };
      },
      loadURL: async () => { navigations += 1; temporary = true; },
    } },
    setState(patch) { this.state = { ...this.state, ...patch }; },
    snapshot() { return this.state; }, logger: { info() {} },
  });
  const first = fixture.probeAuthentication();
  const second = fixture.probeAuthentication();
  release();
  await Promise.all([first, second]);
  assert.equal(navigations, 1);
  assert.equal(probes, 2); // initial surface, then the one navigated temporary surface
  await fixture.probeAuthentication();
  assert.equal(probes, 3); // the settled operation must not cache stale authentication
});

test("shared session changes refresh hidden sign-in state without navigating any tab", async () => {
  const cookies = new EventEmitter();
  const requests = [];
  let payload = {};
  let mode = "automatic";
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    state: { authenticated: true, status: "ready" },
    turnTabs: new Map(),
    getBrowserInteractionMode: () => mode,
    view: { webContents: { session: {
      cookies,
      fetch: async (url, options) => {
        requests.push({ url, options });
        await new Promise(resolve => setImmediate(resolve));
        cookies.emit("changed", {}, { httpOnly: true, domain: "chatgpt.com" }, "overwrite", true);
        cookies.emit("changed", {}, { httpOnly: true, domain: "chatgpt.com" }, "inserted", false);
        // Electron net.fetch returns an empty Response.url, unlike renderer fetch.
        return { url: "", ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => payload };
      },
    } } },
    setState(patch) { this.state = { ...this.state, ...patch }; },
    logger: { warn() { assert.fail("Session refresh failed"); } },
  });
  fixture.bindAuthenticationChanges();
  const notify = cookie => cookies.emit("changed", {}, cookie, "explicit", true);
  notify({ httpOnly: false, domain: ".chatgpt.com" });
  notify({ httpOnly: true, domain: "example.com" });
  assert.equal(requests.length, 0);
  notify({ httpOnly: true, domain: ".chatgpt.com" });
  await fixture.authenticationRefresh;
  assert.equal(fixture.state.authenticated, false);
  assert.equal(fixture.state.status, "signed-out");
  payload = { user: { id: "test" }, expires: "2099-01-01T00:00:00Z" };
  notify({ httpOnly: true, domain: "chatgpt.com" });
  await fixture.authenticationRefresh;
  assert.equal(fixture.state.authenticated, true);
  assert.equal(fixture.state.status, "ready");
  assert.equal(requests[0].url, "https://chatgpt.com/api/auth/session");
  assert.equal(requests[0].options.credentials, "include");
  assert.equal(requests[0].options.redirect, "error");
  mode = "manual";
  notify({ httpOnly: true, domain: "chatgpt.com" });
  assert.equal(requests.length, 2);
  mode = "automatic";
  fixture.destroyed = true;
  notify({ httpOnly: true, domain: "chatgpt.com" });
  assert.equal(requests.length, 2);
});

test("a later sign-out wins over pending native and page authentication probes", async () => {
  let finishNative;
  let finishPage;
  let requests = 0;
  const updates = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    authenticationRevision: 0, state: { authenticated: false },
    turnTabs: new Map(),
    view: { webContents: {
      getURL: () => "https://chatgpt.com/?temporary-chat=true", isDestroyed: () => false,
      executeJavaScript: () => new Promise(resolve => { finishPage = resolve; }),
      session: { fetch: async url => {
        requests += 1;
        const payload = requests === 1 ? await new Promise(resolve => { finishNative = resolve; }) : {};
        return { url, ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => payload };
      } },
    } },
    setState(patch) { updates.push(patch); this.state = { ...this.state, ...patch }; },
    snapshot() { return this.state; }, logger: { info() {}, warn() {} },
  });
  const page = fixture.probeAuthentication();
  const first = fixture.refreshAuthenticationFromSession();
  const second = fixture.refreshAuthenticationFromSession();
  assert.equal(first, second);
  finishNative({ user: { id: "previous-account" } });
  await second;
  finishPage({ composer: true, temporary: true, sessionAuthenticated: true });
  await page;
  assert.equal(requests, 2);
  assert.equal(updates.length, 1);
  assert.equal(fixture.state.authenticated, false);
  assert.equal(updates.some(update => update.authenticated === true), false);
});

test("in-page account navigation schedules authentication refresh only for the main frame", async () => {
  const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {} });
  let checks = 0;
  const fixture = { view: { webContents: contents }, setState() {},
    refreshAuthenticationFromSession: async () => { checks += 1; },
  };
  BrowserHost.prototype.bindWebContents.call(fixture);
  contents.emit("did-navigate-in-page", {}, "https://chatgpt.com/", false);
  assert.equal(checks, 0);
  contents.emit("did-navigate-in-page", {}, "https://chatgpt.com/", true);
  assert.equal(checks, 1);
});

test("concurrent embedded login requests share one authentication operation", async () => {
  let resolveLogin;
  let waits = 0;
  let inspections = 0;
  const fixture = {
    state: { authenticated: false },
    authNavigationError: null,
    loginOperation: null,
    show() {},
    snapshot() { return { authenticated: false }; },
    logger: { info() {} },
    view: {
      webContents: {
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        loadURL: async () => {},
      },
    },
    probeAuthentication: async () => {},
    waitForAuthenticated: async () => {
      waits += 1;
      return await new Promise((resolve) => { resolveLogin = resolve; });
    },
    runSessionInspection: async (detectCapabilities) => {
      assert.equal(detectCapabilities, false);
      inspections += 1;
    },
    activateHomeSurface() {},
    withManualOperation: async (_name, action) => await action(),
  };
  const first = BrowserHost.prototype.openLogin.call(fixture);
  const second = BrowserHost.prototype.openLogin.call(fixture);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(waits, 1);
  resolveLogin({ authenticated: true });
  assert.deepEqual(await first, { authenticated: true });
  assert.equal(inspections, 1);
});

test("explicit login waits for an in-flight saved-session refresh before taking browser ownership", async () => {
  const calls = [];
  let finishRefresh;
  const sessionRefreshOperation = new Promise((resolve) => { finishRefresh = resolve; });
  const fixture = {
    state: { authenticated: false },
    sessionRefreshOperation,
    loginOperation: null,
    authNavigationError: null,
    activateHomeSurface() {},
    show() {},
    snapshot: () => ({ authenticated: true }),
    logger: { info() {} },
    view: { webContents: {
      getURL: () => "https://chatgpt.com/?temporary-chat=true",
      loadURL: async () => {},
    } },
    probeAuthentication: async () => calls.push("probe"),
    waitForAuthenticated: async () => ({ authenticated: true }),
    runSessionInspection: async () => calls.push("inspect"),
    withManualOperation: async (name, action) => {
      calls.push(name);
      return await action();
    },
  };

  const login = BrowserHost.prototype.openLogin.call(fixture);
  await Promise.resolve();
  assert.deepEqual(calls, []);
  finishRefresh();
  await login;
  assert.deepEqual(calls, ["ChatGPT login", "probe", "inspect"]);
});

test("passkey login imports only validated state and re-proves the Launcher session", async () => {
  const calls = [];
  const browserSession = {
    clearStorageData: async () => calls.push("clear"),
    flushStorageData: () => calls.push("flush-storage"),
    cookies: {
      set: async cookie => calls.push(["cookie", cookie]),
      flushStore: async () => calls.push("flush-cookies"),
    },
  };
  const contents = {
    session: browserSession,
    isDestroyed: () => false,
    loadURL: async url => calls.push(["load", url]),
    executeJavaScript: async script => calls.push(["script", script]),
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    authView: null,
    turnTabs: new Map(),
    view: { webContents: contents },
    state: { authenticated: false },
    waitForAuthenticated: async () => {
      calls.push("prove-session");
      fixture.state.authenticated = true;
      return { authenticated: true };
    },
    runSessionInspection: async detectCapabilities => calls.push(["inspect", detectCapabilities]),
    activateHomeSurface: () => calls.push("activate"),
    show: () => calls.push("show"),
    logger: { info: event => calls.push(["log", event]) },
    snapshot: () => ({ ...fixture.state }),
  });
  let cleaned = false;
  const result = await BrowserHost.prototype.installPasskeyLogin.call(fixture, {
    storageState: {
      cookies: [{
        name: "session",
        value: "private",
        domain: ".chatgpt.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      }],
      origins: [{ origin: "https://chatgpt.com", localStorage: [{ name: "setting", value: "value" }] }],
    },
    cleanup: async () => { cleaned = true; },
  });

  assert.equal(result.authenticated, true);
  assert.equal(cleaned, true);
  assert.equal(calls[0][0], "load");
  assert.match(calls[0][1], /^data:text\/html/);
  assert.equal(calls[1], "clear");
  assert.ok(calls.some(value => Array.isArray(value) && value[0] === "cookie"));
  assert.ok(calls.some(value => Array.isArray(value) && value[0] === "script" && value[1].includes("localStorage.setItem")));
  assert.ok(calls.includes("prove-session"));
  assert.ok(calls.some(value => Array.isArray(value) && value[0] === "inspect" && value[1] === false));
});

test("invalid passkey transfer is removed without mutating the embedded session", async () => {
  let cleared = false;
  let cleaned = false;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(),
    view: { webContents: {
      isDestroyed: () => false,
      session: { clearStorageData: async () => { cleared = true; } },
    } },
  });
  await assert.rejects(
    BrowserHost.prototype.installPasskeyLogin.call(fixture, {
      storageState: {
        cookies: [{
          name: "identity-provider",
          value: "private",
          domain: ".accounts.google.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        }],
        origins: [],
      },
      cleanup: async () => { cleaned = true; },
    }),
    /no ChatGPT\/OpenAI cookies/,
  );
  assert.equal(cleared, false);
  assert.equal(cleaned, true);
});

test("failed private-transfer cleanup also discards an otherwise imported passkey session", async () => {
  let resets = 0;
  const browserSession = {
    cookies: { set: async () => {}, flushStore: async () => {} },
    flushStorageData() {},
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    view: { webContents: {
      session: browserSession,
      isDestroyed: () => false,
      loadURL: async () => {},
    } },
    clearOwnedSessionForPasskey: async () => {},
    resetFailedPasskeyLogin: async () => { resets += 1; },
    waitForAuthenticated: async () => ({ authenticated: true }),
    runSessionInspection: async () => {},
    activateHomeSurface() {},
    show() {},
    logger: { info() {} },
    snapshot: () => ({ authenticated: true }),
  });
  await assert.rejects(
    BrowserHost.prototype.installPasskeyLogin.call(fixture, {
      storageState: {
        cookies: [{
          name: "session",
          value: "private",
          domain: ".chatgpt.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        }],
        origins: [],
      },
      cleanup: async () => { throw new Error("synthetic private-file lock"); },
    }),
    /Removing temporary passkey state failed/,
  );
  assert.equal(resets, 1);
});

test("launcher quit remains gated through an active embedded-browser operation", () => {
  const source = fs.readFileSync(require.resolve("../electron/main.cjs"), "utf8");
  assert.match(
    source,
    /runtimeHost\?\.currentOperation\(\) \|\| browserHost\?\.currentOperation\(\)/,
  );
});

test("logout clears only the owned ChatGPT session and returns to the sign-in surface", async () => {
  const calls = [];
  let currentUrl = "https://chatgpt.com/?temporary-chat=true";
  const authView = { webContents: { isDestroyed: () => false } };
  const fixture = {
    authView,
    state: { authenticated: true, status: "ready" },
    view: {
      webContents: {
        getURL: () => currentUrl,
        loadURL: async (url) => {
          calls.push(["loadURL", url]);
          currentUrl = url;
        },
        session: {
          clearStorageData: async () => calls.push(["clearStorageData"]),
        },
      },
    },
    closeAuthView(view, closeContents, refreshMain) {
      calls.push(["closeAuthView", view, closeContents, refreshMain]);
      this.authView = null;
    },
    setState(patch) {
      this.state = { ...this.state, ...patch };
      calls.push(["setState", patch]);
    },
    probeAuthentication: async function () {
      this.state = { ...this.state, authenticated: false, status: "signed-out" };
      calls.push(["probeAuthentication"]);
      return this.snapshot();
    },
    activateHomeSurface() { calls.push(["activateHomeSurface"]); },
    show() { calls.push(["show"]); },
    snapshot() { return { ...this.state, url: currentUrl }; },
    logger: { info(event) { calls.push(["log", event]); } },
    withManualOperation: async (name, action) => {
      calls.push(["manualOperation", name]);
      return await action();
    },
  };

  const result = await BrowserHost.prototype.logout.call(fixture);

  assert.equal(result.authenticated, false);
  assert.equal(result.status, "signed-out");
  assert.deepEqual(calls[0], ["manualOperation", "ChatGPT logout"]);
  assert.deepEqual(calls[1], ["closeAuthView", authView, true, false]);
  assert.deepEqual(calls[2], ["clearStorageData"]);
  assert.deepEqual(calls[4], ["loadURL", "https://chatgpt.com/?temporary-chat=true"]);
  assert.ok(calls.some(([name]) => name === "activateHomeSurface"));
  assert.ok(calls.some(([name]) => name === "show"));
});

test("launcher shutdown persists ChatGPT DOM storage and cookies before browser destruction", async () => {
  const calls = [];
  const fixture = {
    view: {
      webContents: {
        isDestroyed: () => false,
        session: {
          flushStorageData: () => calls.push("storage"),
          cookies: { flushStore: async () => calls.push("cookies") },
        },
      },
    },
  };

  await BrowserHost.prototype.persistSession.call(fixture);

  assert.deepEqual(calls, ["storage", "cookies"]);
});

test("OAuth completion is re-proved on the primary Temporary Chat surface before login succeeds", async () => {
  let primaryReady = false;
  const completedAuthView = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async () => ({
        composer: true,
        temporary: false,
        sessionAuthenticated: true,
        readyState: "complete",
      }),
    },
  };
  const fixture = {
    activeTraceId: null,
    manualOperation: "ChatGPT login",
    authView: completedAuthView,
    state: { authenticated: false },
    logger: { info() {} },
    view: {
      webContents: {
        getURL: () => primaryReady
          ? "https://chatgpt.com/?temporary-chat=true"
          : "https://chatgpt.com/auth/login",
        isDestroyed: () => false,
        executeJavaScript: async () => ({
          composer: primaryReady,
          temporary: primaryReady,
          sessionAuthenticated: primaryReady,
          readyState: "complete",
          url: primaryReady
            ? "https://chatgpt.com/?temporary-chat=true"
            : "https://chatgpt.com/auth/login",
        }),
        loadURL: async (url) => {
          assert.equal(url, "https://chatgpt.com/?temporary-chat=true");
          primaryReady = true;
        },
      },
    },
    closeAuthView(view, closeContents, refreshMain) {
      assert.equal(view, completedAuthView);
      assert.equal(closeContents, true);
      assert.equal(refreshMain, false);
      this.authView = null;
    },
    setState(patch) { this.state = { ...this.state, ...patch }; },
    snapshot() { return this.state; },
  };

  const result = await BrowserHost.prototype.probeAuthentication.call(fixture);
  assert.equal(result.authenticated, true);
  assert.equal(fixture.authView, null);
  assert.equal(result.url, "https://chatgpt.com/?temporary-chat=true");
});

test("a successful primary login redirect is re-proved on Temporary Chat before login completes", async () => {
  let currentUrl = "https://chatgpt.com/";
  const loadedUrls = [];
  const fixture = {
    activeTraceId: null,
    manualOperation: "ChatGPT login",
    authView: null,
    state: { authenticated: false },
    logger: { info() {} },
    view: {
      webContents: {
        getURL: () => currentUrl,
        isDestroyed: () => false,
        executeJavaScript: async () => ({
          composer: true,
          temporary: currentUrl === "https://chatgpt.com/?temporary-chat=true",
          sessionAuthenticated: true,
          readyState: "complete",
          url: currentUrl,
        }),
        loadURL: async (url) => {
          loadedUrls.push(url);
          currentUrl = url;
        },
      },
    },
    setState(patch) { this.state = { ...this.state, ...patch }; },
    snapshot() { return this.state; },
  };

  const result = await BrowserHost.prototype.probeAuthentication.call(fixture);

  assert.deepEqual(loadedUrls, ["https://chatgpt.com/?temporary-chat=true"]);
  assert.equal(result.authenticated, true);
  assert.equal(result.url, "https://chatgpt.com/?temporary-chat=true");
});

test("an authenticated primary surface closes a stale embedded auth popup", async () => {
  const staleAuthView = {
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async () => ({
        composer: false,
        temporary: false,
        sessionAuthenticated: false,
        readyState: "complete",
      }),
    },
  };
  const closed = [];
  const fixture = {
    activeTraceId: null,
    manualOperation: "connector verification",
    authView: staleAuthView,
    state: { authenticated: true },
    logger: { info() {} },
    view: {
      webContents: {
        getURL: () => "https://chatgpt.com/?temporary-chat=true",
        isDestroyed: () => false,
        executeJavaScript: async () => ({
          composer: true,
          temporary: true,
          sessionAuthenticated: true,
          readyState: "complete",
          url: "https://chatgpt.com/?temporary-chat=true",
        }),
      },
    },
    closeAuthView(view, closeContents, refreshMain) {
      closed.push([view, closeContents, refreshMain]);
      this.authView = null;
    },
    setState(patch) { this.state = { ...this.state, ...patch }; },
    snapshot() { return this.state; },
  };

  const result = await BrowserHost.prototype.probeAuthentication.call(fixture);
  assert.equal(result.authenticated, true);
  assert.equal(fixture.authView, null);
  assert.deepEqual(closed, [[staleAuthView, true, false]]);
});

test("browser chrome navigation delegates to WebContents navigation history", () => {
  const { calls, webContents } = createContents();
  navigateBrowser(webContents, "back");
  navigateBrowser(webContents, "forward");
  navigateBrowser(webContents, "reload");

  assert.deepEqual(calls, ["back", "reload"]);
  assert.throws(() => navigateBrowser(webContents, "unknown"), /Unknown browser navigation action/);
});

test("browser zoom in, out, and reset are symmetric across owned views", () => {
  const home = createContents();
  const turn = createContents();
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    state: { zoomFactor: 1 },
    view: { webContents: home.webContents },
    turnTabs: new Map([["turn", { view: { webContents: turn.webContents } }]]),
    snapshot() { return { zoomFactor: this.state.zoomFactor }; },
    setState(patch) { this.state = { ...this.state, ...patch }; },
    publishState() {},
  });

  assert.equal(BrowserHost.prototype.zoom.call(fixture, "in").zoomFactor, 1.1);
  assert.equal(BrowserHost.prototype.zoom.call(fixture, "out").zoomFactor, 1);
  BrowserHost.prototype.zoom.call(fixture, "in");
  assert.equal(BrowserHost.prototype.zoom.call(fixture, "reset").zoomFactor, 1);
  assert.deepEqual(home.calls.filter((call) => Array.isArray(call) && call[0] === "zoom"), [
    ["zoom", 1.1],
    ["zoom", 1],
    ["zoom", 1.1],
    ["zoom", 1],
  ]);
  assert.deepEqual(turn.calls.filter((call) => Array.isArray(call) && call[0] === "zoom"), [
    ["zoom", 1.1],
    ["zoom", 1],
    ["zoom", 1.1],
    ["zoom", 1],
  ]);
  assert.throws(() => BrowserHost.prototype.zoom.call(fixture, "fit"), /Unknown browser zoom action/);
});

test("Command zoom changes only the launcher shell while browser zoom stays independent", () => {
  const focusedBrowserContents = new EventEmitter();
  focusedBrowserContents.isDestroyed = () => false;
  let shellZoomLevel = 0;
  const shellContents = {
    getZoomLevel: () => shellZoomLevel,
    isDestroyed: () => false,
    setZoomLevel: (next) => { shellZoomLevel = next; },
  };
  const originalBounds = { x: 280, y: 76, width: 840, height: 644 };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    state: { zoomFactor: 1 },
    bounds: originalBounds,
    window: { webContents: shellContents },
    shellZoomShortcutBindings: new Map(),
    logger: { error() {} },
  });
  let prevented = 0;

  BrowserHost.prototype.bindShellZoomShortcuts.call(fixture, focusedBrowserContents);
  focusedBrowserContents.emit(
    "before-input-event",
    { preventDefault: () => { prevented += 1; } },
    {
      type: "keyDown",
      key: "=",
      meta: process.platform === "darwin",
      control: process.platform !== "darwin",
      alt: false,
    },
  );

  assert.equal(prevented, 1);
  assert.equal(shellZoomLevel, 0.5);
  assert.equal(fixture.state.zoomFactor, 1);
  assert.deepEqual(fixture.bounds, originalBounds);
});

test("browser chrome state is read from the owned WebContents", () => {
  const { webContents } = createContents();
  const state = readBrowserNavigationState(webContents, {
    title: "Fallback",
    url: "about:blank",
    loading: true,
    canGoBack: false,
    canGoForward: true,
  });
  assert.deepEqual(state, {
    title: "ChatGPT",
    url: "https://chatgpt.com/?temporary-chat=true",
    loading: false,
    canGoBack: true,
    canGoForward: false,
  });
  assert.equal(readBrowserNavigationState(webContents, {
    title: "Zero Risk tab",
    url: "about:blank",
    loading: true,
    canGoBack: false,
    canGoForward: true,
  }, { readPageTitle: false }).title, "Zero Risk tab");
});

test("launcher delegates every ChatGPT model and turn operation to the shared browser worker", async () => {
  const calls = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    helper: { executable: "/runtime/electron", script: "/runtime/browser-helper.cjs" },
    descriptorPath: "/runtime/launcher-browser.json",
    getConnectorName: () => "Codex Native2",
    logger: { info: (...args) => calls.push(["log", ...args]) },
    show: () => calls.push(["show"]),
    waitForSurfaceReady: async () => calls.push(["ready"]),
    setState: patch => calls.push(["state", patch]),
    runBrowserHelperOperation: async options => {
      calls.push(["helper", options]);
      return { type: "result", value: { effort: "High", response: "CODEX WEB GPT READY" } };
    },
  });

  assert.deepEqual(await BrowserHost.prototype.runSmokeTest.call(fixture), {
    ok: true,
    effort: "High",
    response: "CODEX WEB GPT READY",
  });
  const helperCall = calls.find(call => call[0] === "helper")[1];
  assert.equal(helperCall.operation, "smoke");
  assert.equal(helperCall.appName, "Codex Native2");
});

test("browser helper operations fail closed when the configured connector name is invalid", async () => {
  let helperCalls = 0;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getConnectorName: () => "   ",
    runBrowserHelperOperation: async () => { helperCalls += 1; },
  });

  await assert.rejects(
    BrowserHost.prototype.runSmokeTest.call(fixture),
    /Connector name is invalid/,
  );
  assert.equal(helperCalls, 0);
});

test("connector verification is effort-independent and works while the browser surface is hidden", async () => {
  const calls = [];
  const fixture = {
    helper: { executable: "/runtime/electron", script: "/runtime/browser-helper.cjs" },
    descriptorPath: "/runtime/launcher-browser.json",
    logger: { info: (event, detail) => calls.push(["log", event, detail]) },
    setState: (patch) => calls.push(["state", patch]),
    show: () => calls.push(["show"]),
    refreshChatGptHomeDocument: async () => calls.push(["refresh"]),
    selectHighEffort: async () => {
      throw new Error("connector verification must not select an effort");
    },
    verifyConnectorWithBrowserHelper: async (options) => {
      calls.push(["helper", options]);
      return { ok: true, appName: options.appName };
    },
  };

  const result = await BrowserHost.prototype.runConnectorVerification.call(fixture, "Codex Native2");

  assert.deepEqual(result, { ok: true, appName: "Codex Native2" });
  assert.equal(calls.some(([type]) => type === "show"), false);
  assert.deepEqual(
    calls.filter(([type]) => ["refresh", "helper"].includes(type)),
    [
      ["refresh"],
      ["helper", {
        helper: fixture.helper,
        descriptorPath: fixture.descriptorPath,
        appName: "Codex Native2",
        logger: fixture.logger,
      }],
    ],
  );
});

test("connector verification records the helper failure in launcher diagnostics", async () => {
  const calls = [];
  const failure = new Error("ChatGPT connector proof did not leave a verified empty composer");
  failure.name = "ChatGptPersistentBrowserStateError";
  failure.operationId = "verify-contract-trace";
  const fixture = {
    helper: { executable: "/runtime/electron", script: "/runtime/browser-helper.cjs" },
    descriptorPath: "/runtime/launcher-browser.json",
    logger: {
      info: (event, detail) => calls.push(["info", event, detail]),
      error: (event, detail) => calls.push(["error", event, detail]),
    },
    setState: (patch) => calls.push(["state", patch]),
    refreshChatGptHomeDocument: async () => calls.push(["refresh"]),
    verifyConnectorWithBrowserHelper: async () => { throw failure; },
  };

  await assert.rejects(
    BrowserHost.prototype.runConnectorVerification.call(fixture, "Codex Native2"),
    failure,
  );
  assert.deepEqual(calls.find(call => call[1] === "connector.verification_failed"), [
    "error",
    "connector.verification_failed",
    {
      appName: "Codex Native2",
      traceId: "verify-contract-trace",
      errorName: "ChatGptPersistentBrowserStateError",
      message: "ChatGPT connector proof did not leave a verified empty composer",
    },
  ]);
});

test("a live helper retains exclusive ownership of its running turn", async () => {
  const tab = {
    id: "tab-live-owner",
    traceId: "trace_live_owner",
    helperPid: process.pid,
    status: "running",
    interactionMode: "automatic",
  };
  await assert.rejects(
    BrowserHost.prototype.beginTurn.call({
      manualOperation: null,
      turnTabs: new Map([[tab.id, tab]]),
      userCancelledTurnOwners: new Map(),
    }, tab.traceId, false, process.pid + 1),
    /owned by another helper process/,
  );
});

test("a replacement helper takes over only after the previous owner exited", async () => {
  const deadPid = 2_147_483_647;
  const tab = {
    id: "tab-dead-owner",
    surfaceId: "surface-dead-owner",
    traceId: "trace_dead_owner",
    helperPid: deadPid,
    status: "running",
    interactionMode: "automatic",
    loading: true,
    message: "ChatGPT is working",
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling() {},
      },
    },
  };
  const warnings = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[tab.id, tab]]),
    userCancelledTurnOwners: new Map(),
    selectedTabId: "home",
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    logger: { info() {}, warn: (event, detail) => warnings.push([event, detail]) },
  });

  const lease = await BrowserHost.prototype.beginTurn.call(fixture, tab.traceId, false, process.pid);

  assert.deepEqual(lease, {
    surfaceId: tab.surfaceId,
    tabId: tab.id,
    reused: false,
    connectorBound: false,
  });
  assert.equal(tab.helperPid, process.pid);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], "browser.stale_turn_owner_replaced");
  assert.equal(warnings[0][1].previousHelperPid, deadPid);
});

test("a live turn heartbeat refreshes its lease and rejects another helper", () => {
  const tab = {
    id: "tab-heartbeat",
    traceId: "trace_heartbeat",
    helperPid: 444,
    status: "running",
    lastHeartbeatAt: 1,
    deviceEmulationDirty: false,
  };
  let visibilitySyncs = 0;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    syncViewVisibility: () => { visibilitySyncs += 1; },
    snapshot: () => ({ activeTabId: tab.id }),
  });

  const before = Date.now();
  const snapshot = BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, tab.helperPid, true);

  assert.deepEqual(snapshot, { activeTabId: tab.id });
  assert.ok(tab.lastHeartbeatAt >= before);
  assert.equal(tab.deviceEmulationDirty, true);
  assert.equal(visibilitySyncs, 1);
  assert.throws(
    () => BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, 445),
    /ownership mismatch: expected 444, received 445/,
  );
  assert.throws(
    () => BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, tab.helperPid, "yes"),
    /refreshViewport is invalid/,
  );
});

test("a viewport-refresh heartbeat reapplies hidden emulation before CDP reconnect", () => {
  const events = [];
  const tab = {
    id: "tab-refresh-viewport",
    traceId: "trace_refresh_viewport",
    helperPid: 446,
    status: "running",
    lastHeartbeatAt: 1,
    rendererReady: true,
    deviceEmulationViewport: { width: 1120, height: 720 },
    deviceEmulationDirty: false,
    view: {
      setBounds: bounds => events.push(["bounds", bounds]),
      setVisible: visible => events.push(["visible", visible]),
      webContents: {
        enableDeviceEmulation: options => events.push(["emulate", options]),
        disableDeviceEmulation: () => events.push(["disable-emulation"]),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    visible: false,
    surfaceActive: true,
    boundsReady: true,
    bounds: { x: 280, y: 64, width: 840, height: 656 },
    selectedTabId: tab.id,
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    authView: null,
    window: {
      getContentSize: () => [1120, 720],
      isMinimized: () => false,
      isVisible: () => false,
    },
    view: {
      setBounds: bounds => events.push(["home-bounds", bounds]),
      setVisible: visible => events.push(["home-visible", visible]),
    },
    snapshot: () => ({ activeTabId: tab.id }),
  });

  BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, tab.helperPid, true);

  assert.equal(events.filter(([kind]) => kind === "emulate").length, 1);
  assert.deepEqual(tab.deviceEmulationViewport, { width: 1120, height: 720 });
  assert.equal(tab.deviceEmulationDirty, false);
});

test("an expired browser surface cancels its runtime before releasing the tab", async () => {
  const closed = [];
  const warnings = [];
  const cancellations = [];
  let acknowledge;
  const cancelled = new Promise(resolve => { acknowledge = resolve; });
  const tab = {
    id: "tab-orphan",
    traceId: "trace_orphan",
    helperPid: 555,
    status: "running",
    loading: true,
    bootstrapReady: false,
    bootstrapDeadlineAt: 100,
    lastHeartbeatAt: 100,
    view: {
      webContents: {
        isDestroyed: () => false,
        close: () => closed.push("contents"),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    cancelTurn: (traceId, reason) => { cancellations.push({ traceId, reason }); return cancelled; },
    closedTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView: () => closed.push("view") } },
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    logger: { warn: (event, detail) => warnings.push([event, detail]) },
  });

  const cleanup = BrowserHost.prototype.reapExpiredTurnTabs.call(fixture, 101);
  BrowserHost.prototype.reapExpiredTurnTabs.call(fixture, 102);
  await Promise.resolve();
  assert.deepEqual(cancellations, [{ traceId: tab.traceId, reason: "browser_surface_bootstrap_timeout" }]);
  assert.equal(fixture.turnTabs.has(tab.id), true);
  assert.deepEqual(closed, []);
  acknowledge();
  await cleanup;

  assert.equal(fixture.turnTabs.size, 0);
  assert.equal(fixture.selectedTabId, "home");
  assert.equal(fixture.closedTurnOwners.get(tab.traceId), tab.helperPid);
  assert.deepEqual(closed, ["view", "contents"]);
  assert.deepEqual(warnings, ["browser.orphan_turn_expired", "browser.orphan_turn_reaped"].map(event => [event, {
    tabId: tab.id,
    traceId: tab.traceId,
    helperPid: tab.helperPid,
    evidence: "browser_surface_bootstrap_timeout",
  }]));
});

test("expiry cancellation preserves a changed owner and keeps failed cleanup visible", async () => {
  for (const outcome of ["reused", "failed"]) {
    const removed = [], warnings = [];
    const tab = { id: "expiry-race", traceId: "trace_expiry", helperPid: 123,
      status: "running", bootstrapReady: true, lastHeartbeatAt: 0 };
    const fixture = Object.assign(Object.create(BrowserHost.prototype), {
      turnTabs: new Map([[tab.id, tab]]),
      cancelTurn: async () => {
        if (outcome === "failed") throw new Error("control unavailable");
        tab.traceId = "trace_replacement";
      },
      removeTurnTab: () => removed.push(tab.id),
      logger: { warn: event => warnings.push(event) },
    });
    await fixture.reapExpiredTurnTabs(120_000);
    assert.deepEqual(removed, []);
    assert.equal(fixture.turnTabs.get(tab.id), tab);
    assert.equal(tab.expiryCancellation, undefined);
    assert.equal(warnings.includes("browser.orphan_turn_cancel_failed"), outcome === "failed");
    assert.equal(warnings.includes("browser.orphan_turn_reaped"), outcome !== "failed");
  }
});

test("removing the final turn tab keeps the descriptor-owned idle host attached offscreen", () => {
  const calls = [];
  const hiddenBounds = { x: 1201, y: 801, width: 1200, height: 800 };
  const tab = {
    id: "tab-gray-host",
    traceId: "trace_gray_host",
    helperPid: 666,
    status: "aborted",
    view: {
      webContents: {
        isDestroyed: () => false,
        close: () => calls.push("contents-close"),
      },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    selectedTabId: tab.id,
    visible: true,
    surfaceActive: true,
    boundsReady: true,
    bounds: { x: 200, y: 100, width: 900, height: 650 },
    window: {
      contentView: { removeChildView: () => calls.push("view-remove") },
      isVisible: () => true,
      isMinimized: () => false,
    },
    view: {
      setBounds: bounds => calls.push(["home-bounds", bounds]),
      setVisible: visible => calls.push(["home-visible", visible]),
      webContents: { getURL: () => IDLE_BROWSER_URL },
    },
    hiddenTurnBounds: () => hiddenBounds,
    authView: null,
    syncPowerSaveBlocker() {},
    setState() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
  });

  BrowserHost.prototype.removeTurnTab.call(fixture, tab, false);

  assert.equal(fixture.selectedTabId, "home");
  assert.equal(fixture.visible, false);
  assert.deepEqual(calls, [
    "view-remove",
    "contents-close",
    ["home-bounds", hiddenBounds],
    ["home-visible", true],
    ["home-bounds", hiddenBounds],
    ["home-visible", true],
  ]);
});

test("hard refresh accepts Chromium's completed loading cycle even without did-finish-load", async () => {
  const calls = [];
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.reloadIgnoringCache = () => {
    calls.push("reload");
    queueMicrotask(() => {
      contents.emit("did-start-navigation", {
        url: "https://chatgpt.com/?temporary-chat=true",
        isMainFrame: true,
        isSameDocument: false,
      });
      contents.emit("did-stop-loading");
    });
  };
  contents.stop = () => calls.push("stop");
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    view: { webContents: contents },
    setState: patch => calls.push(["state", patch]),
  });

  await fixture.hardRefreshHome(100);

  assert.deepEqual(calls.filter(call => call === "reload" || call === "stop"), ["reload"]);
  assert.equal(contents.listenerCount("did-start-navigation"), 0);
  assert.equal(contents.listenerCount("did-stop-loading"), 0);
  assert.equal(contents.listenerCount("did-finish-load"), 0);
});

test("hard refresh ignores an old loading stop before its own main-frame navigation", async () => {
  const calls = [];
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.reloadIgnoringCache = () => {
    calls.push("reload");
    queueMicrotask(() => {
      contents.emit("did-stop-loading");
      contents.emit("did-start-navigation", {
        url: "https://chatgpt.com/?temporary-chat=true",
        isMainFrame: false,
        isSameDocument: false,
      });
      contents.emit("did-finish-load");
      contents.emit("did-start-navigation", {
        url: "https://chatgpt.com/?temporary-chat=true",
        isMainFrame: true,
        isSameDocument: false,
      });
      contents.emit("did-stop-loading");
    });
  };
  contents.stop = () => calls.push("stop");
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    view: { webContents: contents },
    setState: patch => calls.push(["state", patch]),
  });

  await fixture.hardRefreshHome(100);

  assert.deepEqual(calls.filter(call => call === "reload" || call === "stop"), ["reload"]);
  assert.equal(contents.listenerCount("did-start-navigation"), 0);
  assert.equal(contents.listenerCount("did-stop-loading"), 0);
  assert.equal(contents.listenerCount("did-finish-load"), 0);
});

test("hard refresh timeout cannot become success when stopping emits did-stop-loading", async () => {
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.reloadIgnoringCache = () => {};
  contents.stop = () => contents.emit("did-stop-loading");
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    view: { webContents: contents },
    setState() {},
  });

  const keepTestAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(
      fixture.hardRefreshHome(5),
      /ChatGPT hard refresh did not finish within 60 seconds/,
    );
  } finally {
    clearTimeout(keepTestAlive);
  }
});

test("launcher session refresh resolves persisted authentication before setup actions", async () => {
  const calls = [];
  const fixture = {
    state: { authenticated: false },
    snapshot: () => ({ authenticated: true }),
    setState: (patch) => calls.push(["state", patch]),
    probeAuthentication: async () => {
      calls.push(["probe"]);
      return { authenticated: true };
    },
    withManualOperation: async (name, action) => {
      calls.push(["operation", name]);
      return await action();
    },
    view: {
      webContents: {
        getURL: () => IDLE_BROWSER_URL,
        loadURL: async (url) => calls.push(["load", url]),
      },
    },
  };

  const state = await BrowserHost.prototype.refreshAuthentication.call(fixture);

  assert.deepEqual(state, { authenticated: true });
  assert.deepEqual(calls, [
    ["operation", "session refresh"],
    ["state", { status: "loading", message: "Checking saved ChatGPT session" }],
    ["load", "https://chatgpt.com/?temporary-chat=true"],
    ["probe"],
    ["state", { status: "ready", message: "ChatGPT is ready" }],
  ]);
});

test("concurrent launcher session refresh requests share one browser operation", async () => {
  let finishProbe;
  let operations = 0;
  const fixture = {
    sessionRefreshOperation: null,
    state: { authenticated: false },
    snapshot: () => ({ authenticated: true }),
    setState() {},
    probeAuthentication: async () => await new Promise((resolve) => { finishProbe = resolve; }),
    withManualOperation: async (_name, action) => {
      operations += 1;
      return await action();
    },
    view: { webContents: {
      getURL: () => "https://chatgpt.com/?temporary-chat=true",
      loadURL: async () => {},
    } },
  };

  const first = BrowserHost.prototype.refreshAuthentication.call(fixture);
  const second = BrowserHost.prototype.refreshAuthentication.call(fixture);
  assert.equal(first, second);
  assert.equal(operations, 1);
  finishProbe({ authenticated: true });
  await first;
  assert.equal(fixture.sessionRefreshOperation, null);
});

test("manual browser operations disable background throttling until completion", async () => {
  const throttling = [];
  const surfaces = [];
  const fixture = {
    ready: async () => surfaces.push("ready"),
    activeTraceId: null,
    manualOperation: null,
    activateHomeSurface: () => surfaces.push("home"),
    setState() {},
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: (enabled) => throttling.push(enabled),
      },
    },
  };

  const result = await BrowserHost.prototype.withManualOperation.call(fixture, "hidden check", async () => "ok");

  assert.equal(result, "ok");
  assert.deepEqual(surfaces, ["ready", "home"]);
  assert.deepEqual(throttling, [false, true]);
  assert.equal(fixture.manualOperation, null);
});

test("manual operations show the home surface without discarding retained task tabs", () => {
  const events = [];
  const taskTab = { id: "tab-ready", status: "ready" };
  const fixture = {
    selectedTabId: taskTab.id,
    turnTabs: new Map([[taskTab.id, taskTab]]),
    visible: true,
    surfaceActive: true,
    activeView: () => ({ webContents: { focus: () => events.push("focus") } }),
    syncViewVisibility: () => events.push("visibility"),
    snapshot: () => ({ activeTabId: "home" }),
    publishState: () => events.push("publish"),
    writeDescriptor: () => events.push("descriptor"),
  };

  BrowserHost.prototype.activateHomeSurface.call(fixture);

  assert.equal(fixture.selectedTabId, "home");
  assert.equal(fixture.turnTabs.size, 1);
  assert.deepEqual(events, ["visibility", "focus", "publish", "descriptor"]);
});

test("selected home surface remains represented while task tabs are retained", () => {
  const { webContents } = createContents();
  const taskTab = { id: "tab-ready", traceId: "trace_ready" };
  const fixture = {
    selectedTabId: "home",
    turnTabs: new Map([[taskTab.id, taskTab]]),
    state: {
      title: "ChatGPT",
      status: "signed-out",
      loading: false,
      visible: true,
      surfaceActive: true,
    },
    visible: true,
    surfaceActive: true,
    activeView: () => ({ webContents }),
    selectedTurnTab: () => null,
    tabSnapshot: (tab) => ({ id: tab.id, traceId: tab.traceId, active: false }),
  };

  const snapshot = BrowserHost.prototype.snapshot.call(fixture);

  assert.equal(snapshot.activeTabId, "home");
  assert.deepEqual(snapshot.tabs.map((tab) => tab.id), ["home", "tab-ready"]);
  assert.equal(snapshot.tabs[0].active, true);
});

test("selecting a task tab shows and focuses its owned Playwright surface", () => {
  const visibility = [];
  const focused = [];
  const makeView = (id) => ({
    setBounds() {},
    setVisible: (visible) => visibility.push([id, visible]),
    webContents: {
      disableDeviceEmulation() {},
      enableDeviceEmulation() {},
      focus: () => focused.push(id),
    },
  });
  const first = { id: "tab-first", status: "running", view: makeView("first") };
  const second = { id: "tab-second", status: "running", view: makeView("second") };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    view: makeView("home"),
    turnTabs: new Map([[first.id, first], [second.id, second]]),
    selectedTabId: first.id,
    visible: true,
    surfaceActive: true,
    boundsReady: true,
    bounds: { x: 260, y: 78, width: 800, height: 600 },
    authView: null,
    window: {
      getContentSize: () => [1120, 720],
      isMinimized: () => false,
      isVisible: () => true,
    },
    snapshot: () => ({ activeTabId: fixture.selectedTabId }),
    publishState() {},
    writeDescriptor() {},
  });

  const state = BrowserHost.prototype.selectTab.call(fixture, second.id);

  assert.equal(fixture.selectedTabId, second.id);
  assert.deepEqual(visibility, [
    ["home", true],
    ["first", true],
    ["second", true],
  ]);
  assert.deepEqual(focused, ["second"]);
  assert.equal(state.activeTabId, second.id);
});

test("a stale helper cannot end a replacement turn with the same trace id", async () => {
  const turnTabs = new Map([["tab-1", {
    id: "tab-1",
    traceId: "trace_same_retry",
    helperPid: 222,
  }]]);
  await assert.rejects(
    BrowserHost.prototype.endTurn.call(
      { turnTabs, closedTurnOwners: new Map() },
      "trace_same_retry",
      111,
      "failed",
      false,
      "stale helper exited",
    ),
    /Browser helper ownership mismatch: expected 222, received 111/,
  );
});

test("closing a running browser tab reports terminal user cancellation to its helper", async () => {
  const closed = [];
  const tab = {
    id: "tab-running",
    traceId: "trace_running",
    helperPid: 333,
    status: "running",
    view: {
      webContents: { isDestroyed: () => false, close: () => closed.push("contents") },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView: () => closed.push("view") } },
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    cancelTurn: async (traceId) => closed.push(`cancel:${traceId}`),
    logger: { info() {} },
  });

  await BrowserHost.prototype.closeTab.call(fixture, tab.id);

  assert.deepEqual(closed, ["cancel:trace_running", "view", "contents"]);
  assert.equal(fixture.closedTurnOwners.get("trace_running"), 333);
  assert.equal(fixture.userCancelledTurnOwners.get("trace_running"), 333);
  assert.equal(fixture.selectedTabId, "home");
  await assert.rejects(
    BrowserHost.prototype.beginTurn.call(fixture, tab.traceId, false, 444),
    error => error?.code === "turn_cancelled",
  );

  assert.deepEqual(
    await BrowserHost.prototype.endTurn.call(
      fixture,
      tab.traceId,
      tab.helperPid,
      "failed",
      false,
      "page closed",
    ),
    { cancelledByUser: true },
  );
  assert.equal(fixture.closedTurnOwners.has("trace_running"), false);
  assert.equal(fixture.userCancelledTurnOwners.get("trace_running"), 333);
});

test("a failed runtime cancellation keeps the running DOM attached", async () => {
  const closed = [];
  const tab = {
    id: "tab-cancel-failed",
    traceId: "trace_cancel_failed",
    helperPid: 334,
    status: "running",
    view: {
      webContents: { isDestroyed: () => false, close: () => closed.push("contents") },
    },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView: () => closed.push("view") } },
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    cancelTurn: async () => { throw new Error("runtime cancellation unavailable"); },
    logger: { info() {} },
  });

  await assert.rejects(
    BrowserHost.prototype.closeTab.call(fixture, tab.id),
    /runtime cancellation unavailable/,
  );

  assert.equal(fixture.turnTabs.get(tab.id), tab);
  assert.equal(tab.status, "running");
  assert.deepEqual(closed, []);
});

test("a later provider round reuses only its exact connector-bound conversation", async () => {
  const throttling = [];
  const conversationKey = "a".repeat(64);
  const tab = {
    id: "tab-reused",
    surfaceId: "surface-reused",
    traceId: "trace_previous",
    conversationKey,
    connectorIdentity: "Codex Native2",
    connectorBound: true,
    interactionMode: "automatic",
    helperPid: 111,
    status: "ready",
    loading: false,
    message: "Task completed",
    bootstrapReady: true,
    view: {
      webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling: (enabled) => throttling.push(enabled),
      },
    },
  };
  const events = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[tab.id, tab]]),
    userCancelledTurnOwners: new Map(),
    selectedTabId: "home",
    syncViewVisibility: () => events.push("visible"),
    snapshot: () => ({ tabs: [] }),
    publishState: () => events.push("published"),
    writeDescriptor: () => events.push("descriptor"),
    logger: { info: (event) => events.push(event) },
  });

  const lease = await BrowserHost.prototype.beginTurn.call(
    fixture,
    "trace_next",
    false,
    222,
    conversationKey,
    "Codex Native2",
  );

  assert.deepEqual(lease, {
    surfaceId: "surface-reused",
    tabId: "tab-reused",
    reused: true,
    connectorBound: true,
  });
  assert.equal(tab.traceId, "trace_next");
  assert.equal(tab.helperPid, 222);
  assert.equal(tab.status, "running");
  assert.equal(tab.loading, true);
  assert.equal(tab.message, "ChatGPT is working");
  assert.equal(tab.bootstrapReady, true);
  assert.equal(fixture.selectedTabId, tab.id);
  assert.deepEqual(throttling, [false]);
  assert.deepEqual(events, ["visible", "published", "descriptor", "browser.tab_reused"]);
});

test("a retained conversation is not reused for a different connector identity", async () => {
  const conversationKey = "b".repeat(64);
  const retained = {
    id: "retained",
    traceId: "trace_old",
    status: "ready",
    conversationKey,
    connectorIdentity: "Codex Native2",
    connectorBound: true,
    interactionMode: "automatic",
  };
  const created = { id: "fresh", surfaceId: "surface-fresh" };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[retained.id, retained]]),
    userCancelledTurnOwners: new Map(),
    createTurnTab: (...args) => {
      assert.deepEqual(args, ["trace_next", 222, conversationKey, "Other Connector", undefined]);
      return created;
    },
    writeDescriptor() {},
    syncViewVisibility() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    logger: { info() {} },
  });

  const lease = await BrowserHost.prototype.beginTurn.call(
    fixture,
    "trace_next",
    false,
    222,
    conversationKey,
    "Other Connector",
  );

  assert.deepEqual(lease, {
    surfaceId: "surface-fresh",
    tabId: "fresh",
    reused: false,
    connectorBound: false,
  });
  assert.equal(retained.status, "ready");
});

test("an Automatic turn never reuses a retained Zero Risk conversation", async () => {
  const conversationKey = "m".repeat(64);
  const retained = {
    id: "manual-retained",
    traceId: "trace_manual",
    status: "ready",
    interactionMode: "manual",
    conversationKey,
    connectorIdentity: "Codex Native2",
    connectorBound: true,
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[retained.id, retained]]),
    userCancelledTurnOwners: new Map(),
    createTurnTab: () => ({ id: "automatic-fresh", surfaceId: "surface-fresh" }),
    writeDescriptor() {},
    syncViewVisibility() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    logger: { info() {} },
  });

  assert.deepEqual(
    await BrowserHost.prototype.beginTurn.call(
      fixture,
      "trace_automatic",
      false,
      222,
      conversationKey,
      "Codex Native2",
    ),
    {
      surfaceId: "surface-fresh",
      tabId: "automatic-fresh",
      reused: false,
      connectorBound: false,
    },
  );
  assert.equal(retained.status, "ready");
  await assert.rejects(
    BrowserHost.prototype.beginTurn.call(
      fixture,
      "trace_manual",
      false,
      222,
      conversationKey,
      "Codex Native2",
    ),
    /already belongs to Zero Risk interaction/,
  );
});

test("a connector conversation is not reused until its connector was bound", async () => {
  const conversationKey = "c".repeat(64);
  const retained = {
    id: "retained",
    traceId: "trace_old",
    status: "ready",
    conversationKey,
    connectorIdentity: "Codex Native2",
    connectorBound: false,
    interactionMode: "automatic",
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[retained.id, retained]]),
    userCancelledTurnOwners: new Map(),
    createTurnTab: () => ({ id: "fresh", surfaceId: "surface-fresh" }),
    writeDescriptor() {},
    syncViewVisibility() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    logger: { info() {} },
  });

  assert.deepEqual(
    await BrowserHost.prototype.beginTurn.call(
      fixture,
      "trace_next",
      false,
      222,
      conversationKey,
      "Codex Native2",
    ),
    {
      surfaceId: "surface-fresh",
      tabId: "fresh",
      reused: false,
      connectorBound: false,
    },
  );
});

test("a required retained conversation fails before creating a browser tab", async () => {
  let created = false;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map(),
    userCancelledTurnOwners: new Map(),
    createTurnTab: () => {
      created = true;
      throw new Error("must not allocate a replacement tab");
    },
  });

  await assert.rejects(
    BrowserHost.prototype.beginTurn.call(
      fixture,
      "trace_next",
      false,
      222,
      "d".repeat(64),
      undefined,
      true,
    ),
    (error) => error?.code === "retained_conversation_unavailable"
      && /retained ChatGPT conversation is no longer available/.test(error.message),
  );
  assert.equal(created, false);
});

test("five browser tabs are a hard account-safety limit", async () => {
  const turnTabs = new Map(Array.from({ length: 5 }, (_unused, index) => [
    `tab-${index + 1}`,
    { ordinal: index + 1 },
  ]));

  await assert.rejects(
    BrowserHost.prototype.createTurnTab.call({ turnTabs }, "trace_six", 444),
    /already has 5 browser tabs.*avoid excessive parallel traffic/,
  );
});

test("a full browser host evicts only its oldest ready tab", () => {
  const oldest = { id: "oldest", ordinal: 1, status: "ready", lastHeartbeatAt: 10 };
  const newer = { id: "newer", ordinal: 2, status: "ready", lastHeartbeatAt: 20 };
  const running = [3, 4, 5].map((ordinal) => ({
    id: `running-${ordinal}`,
    ordinal,
    status: "running",
    lastHeartbeatAt: 1,
  }));
  const removed = [];
  const fixture = {
    turnTabs: new Map([oldest, newer, ...running].map(tab => [tab.id, tab])),
    removeTurnTab(tab, abortRunning) {
      removed.push([tab.id, abortRunning]);
      this.turnTabs.delete(tab.id);
    },
    window: {
      contentView: { addChildView() {} },
    },
  };

  assert.equal(BrowserHost.prototype.evictOldestRetainedTurnTab.call(fixture), true);
  assert.deepEqual(removed, [["oldest", false]]);
  assert.equal(fixture.turnTabs.has("running-3"), true);
});

test("ending one browser turn does not stop another running tab", async () => {
  let closedViews = 0;
  let removedViews = 0;
  const ended = {
    id: "tab-ended",
    traceId: "trace_ended",
    helperPid: 555,
    status: "running",
    loading: true,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {}, close: () => { closedViews += 1; } } },
  };
  const active = {
    id: "tab-active",
    traceId: "trace_active",
    helperPid: 666,
    status: "running",
    loading: true,
    view: { webContents: { isDestroyed: () => false, setBackgroundThrottling() {} } },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[ended.id, ended], [active.id, active]]),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    selectedTabId: ended.id,
    window: { contentView: { removeChildView: (view) => {
      assert.equal(view, ended.view);
      removedViews += 1;
    } } },
    syncViewVisibility() {},
    writeDescriptor() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    hide: () => assert.fail("a second running tab must keep the browser host active"),
    logger: { info() {} },
  });

  await BrowserHost.prototype.endTurn.call(
    fixture,
    ended.traceId,
    ended.helperPid,
    "completed",
    true,
  );

  assert.equal(ended.status, "ready");
  assert.equal(fixture.turnTabs.has(ended.id), false);
  assert.equal(fixture.turnTabs.has(active.id), true);
  assert.equal(fixture.selectedTabId, active.id);
  assert.equal(closedViews, 1);
  assert.equal(removedViews, 1);
  assert.equal(active.status, "running");
  assert.equal(fixture.activeTraceId, active.traceId);
});

test("a completed keyed turn is retained for thirty minutes and preserves its acknowledgement", async () => {
  const throttling = [];
  const tab = {
    id: "tab-retained",
    surfaceId: "surface-retained",
    traceId: "trace_retained",
    conversationKey: "e".repeat(64),
    connectorIdentity: "Codex Native2",
    connectorBound: false,
    helperPid: 777,
    status: "running",
    loading: true,
    view: { webContents: {
      isDestroyed: () => false,
      setBackgroundThrottling: (enabled) => throttling.push(enabled),
    } },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    selectedTabId: tab.id,
    syncViewVisibility() {},
    writeDescriptor() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    hide() {},
    logger: { info() {} },
  });

  const result = await BrowserHost.prototype.endTurn.call(
    fixture,
    tab.traceId,
    tab.helperPid,
    "completed",
    true,
    undefined,
    true,
    true,
  );

  assert.deepEqual(result, { cancelledByUser: false });
  assert.equal(fixture.turnTabs.get(tab.id), tab);
  assert.equal(tab.status, "ready");
  assert.equal(tab.connectorBound, true);
  assert.equal(Number.isFinite(tab.lastHeartbeatAt), true);
  assert.deepEqual(throttling, [true]);

  const retainedAt = tab.lastHeartbeatAt;
  BrowserHost.prototype.reapExpiredTurnTabs.call(fixture, retainedAt + (30 * 60 * 1000) - 1);
  assert.equal(fixture.turnTabs.has(tab.id), true);
});

test("a retained browser tab expires at thirty minutes", () => {
  const removed = [];
  const tab = {
    id: "tab-expired",
    traceId: "trace_expired",
    status: "ready",
    lastHeartbeatAt: 100,
  };
  const fixture = {
    turnTabs: new Map([[tab.id, tab]]),
    logger: { info() {} },
    removeTurnTab(candidate, abortRunning) {
      removed.push([candidate.id, abortRunning]);
      this.turnTabs.delete(candidate.id);
    },
  };

  BrowserHost.prototype.reapExpiredTurnTabs.call(fixture, 100 + (30 * 60 * 1000));

  assert.deepEqual(removed, [[tab.id, false]]);
  assert.equal(fixture.turnTabs.size, 0);
});

test("a completed connector turn without binding is released instead of retained", async () => {
  let closed = false;
  const tab = {
    id: "tab-unbound",
    traceId: "trace_unbound",
    conversationKey: "f".repeat(64),
    connectorIdentity: "Codex Native2",
    helperPid: 777,
    status: "running",
    loading: true,
    view: { webContents: {
      isDestroyed: () => false,
      setBackgroundThrottling() {},
      close: () => { closed = true; },
    } },
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    userCancelledTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView() {} } },
    syncViewVisibility() {},
    writeDescriptor() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    hide() {},
    logger: { info() {} },
  });

  assert.deepEqual(await BrowserHost.prototype.endTurn.call(
    fixture,
    tab.traceId,
    tab.helperPid,
    "completed",
    true,
    undefined,
    true,
    false,
  ), { cancelledByUser: false });

  assert.equal(fixture.turnTabs.size, 0);
  assert.equal(closed, true);
});

test("failed and aborted browser turns release their tab slots", async () => {
  for (const status of ["failed", "aborted"]) {
    let closed = false;
    const tab = {
      id: `tab-${status}`,
      traceId: `trace_${status}`,
      helperPid: 777,
      status: "running",
      loading: true,
      view: { webContents: {
        isDestroyed: () => false,
        setBackgroundThrottling() {},
        close: () => { closed = true; },
      } },
    };
    const fixture = Object.assign(Object.create(BrowserHost.prototype), {
      turnTabs: new Map([[tab.id, tab]]),
      closedTurnOwners: new Map(),
      userCancelledTurnOwners: new Map(),
      selectedTabId: tab.id,
      window: { contentView: { removeChildView() {} } },
      syncViewVisibility() {},
      writeDescriptor() {},
      publishState() {},
      snapshot: () => ({ tabs: [] }),
      hide() {},
      logger: { info() {} },
    });

    await BrowserHost.prototype.endTurn.call(
      fixture,
      tab.traceId,
      tab.helperPid,
      status,
      true,
      `turn ${status}`,
    );

    assert.equal(fixture.turnTabs.size, 0);
    assert.equal(fixture.selectedTabId, "home");
    assert.equal(tab.status, status === "aborted" ? "aborted" : "error");
    assert.equal(closed, true);
  }
});

function manualTurnFixture() {
  const clipboardWrites = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map(),
    manualTerminalSignals: new Map(),
    manualCompletionSignals: new Map(),
    manualOperation: null,
    selectedTabId: "home",
    clipboard: { writeText: value => clipboardWrites.push(value) },
    logger: { info() {}, warn() {}, error() {} },
    publishState() {},
    snapshot() {
      return {
        tabs: [...this.turnTabs.values()].map(tab => BrowserHost.prototype.tabSnapshot.call(this, tab)),
      };
    },
    showWindow() {},
    show() {},
    writeDescriptor() {},
    createManualTurnTab(traceId, helperPid, conversationKey, prompt, manualSubmitTimeoutMs) {
      const tab = {
        id: `manual-${this.turnTabs.size + 1}`,
        traceId,
        helperPid,
        conversationKey,
        interactionMode: "manual",
        status: "running",
        loading: false,
        label: `ChatGPT ${this.turnTabs.size + 1}`,
        manualState: "awaiting-user",
        manualSubmitTimeoutMs,
        manualDeadlineAt: Date.now() + manualSubmitTimeoutMs,
        manualDeadlineTimer: null,
        manualWaiters: new Set(),
        manualTerminalWaiters: new Set(),
        prompt,
        promptDigest: createHash("sha256").update(prompt, "utf8").digest("hex"),
        manualConversationReused: false,
        sentAt: null,
      };
      this.turnTabs.set(tab.id, tab);
      return tab;
    },
    removeTurnTab(tab) {
      if (tab.manualDeadlineTimer) clearTimeout(tab.manualDeadlineTimer);
      tab.prompt = null;
      this.turnTabs.delete(tab.id);
    },
  });
  return { fixture, clipboardWrites };
}

test("manual start is idempotent and never exposes its private prompt in snapshots", () => {
  const { fixture, clipboardWrites } = manualTurnFixture();
  const first = fixture.beginManualTurn("manual_trace_1", process.pid, "private prompt", "a".repeat(64));
  const second = fixture.beginManualTurn("manual_trace_1", process.pid, "private prompt", "a".repeat(64));
  assert.equal(first.tabId, second.tabId);
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.deepEqual(clipboardWrites, ["private prompt"]);
  assert.equal(JSON.stringify(fixture.snapshot()).includes("private prompt"), false);
  for (const tab of fixture.turnTabs.values()) clearTimeout(tab.manualDeadlineTimer);
});

test("manual confirmation deadlines end at Sent so slow model startup can still complete", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { fixture } = manualTurnFixture();
  const ordinary = fixture.beginManualTurn("manual_ordinary", process.pid, "ordinary prompt");
  const compaction = fixture.beginManualTurn(
    "manual_compaction",
    process.pid,
    "compaction prompt",
    undefined,
    undefined,
    true,
  );
  const ordinaryTab = fixture.turnTabs.get(ordinary.tabId);
  const compactionTab = fixture.turnTabs.get(compaction.tabId);
  assert.equal(ordinaryTab.manualSubmitTimeoutMs, 60_000);
  assert.equal(compactionTab.manualSubmitTimeoutMs, 120_000);
  t.mock.timers.tick(31_000);
  assert.equal(ordinaryTab.manualState, "awaiting-user");
  t.mock.timers.tick(29_000);
  assert.equal(ordinaryTab.manualState, "timed-out");
  assert.equal(compactionTab.manualState, "awaiting-user");

  const slow = fixture.beginManualTurn("manual_slow_model", process.pid, "slow model prompt");
  fixture.confirmManualSent(slow.tabId);
  fixture.confirmManualSent(compaction.tabId);
  t.mock.timers.tick(180_000);
  for (const lease of [slow, compaction]) {
    const tab = fixture.turnTabs.get(lease.tabId);
    assert.equal(tab.manualState, "sent");
    assert.equal(tab.manualDeadlineAt, null);
    assert.equal(tab.manualDeadlineTimer, null);
    assert.equal((await fixture.waitManualSent(tab.traceId, process.pid)).status, "sent");
    fixture.markManualTurnStarted(tab.traceId, process.pid);
    fixture.endManualTurn(tab.traceId, process.pid, "completed");
    assert.equal(fixture.manualCompletionSignals.has(tab.traceId), true);
  }
});

test("manual completion is idempotent and cannot be downgraded after a lost acknowledgement", () => {
  const { fixture } = manualTurnFixture();
  const logs = [];
  fixture.logger.info = (event, detail) => logs.push([event, detail]);
  const retained = fixture.beginManualTurn(
    "manual_completed_retained",
    process.pid,
    "private prompt",
    "a".repeat(64),
  );
  assert.throws(
    () => fixture.endManualTurn("manual_completed_retained", process.pid, "completed", true),
    /cannot complete before Sent confirmation/,
  );
  assert.equal(logs.some(([event]) => event === "browser.manual_turn_completed"), false);
  fixture.confirmManualSent(retained.tabId);
  fixture.markManualTurnStarted("manual_completed_retained", process.pid);
  assert.deepEqual(
    fixture.endManualTurn("manual_completed_retained", process.pid, "completed", true),
    { cancelledByUser: false },
  );
  assert.deepEqual(
    fixture.endManualTurn("manual_completed_retained", process.pid, "failed", false),
    { cancelledByUser: false },
  );
  assert.equal(fixture.turnTabs.get(retained.tabId).status, "ready");
  assert.equal(fixture.turnTabs.get(retained.tabId).manualState, "completed");

  const released = fixture.beginManualTurn(
    "manual_completed_released",
    process.pid,
    "another private prompt",
  );
  fixture.confirmManualSent(released.tabId);
  fixture.markManualTurnStarted("manual_completed_released", process.pid);
  fixture.endManualTurn("manual_completed_released", process.pid, "completed", false);
  assert.equal(fixture.turnTabs.has(released.tabId), false);
  assert.deepEqual(
    fixture.endManualTurn("manual_completed_released", process.pid, "failed", false),
    { cancelledByUser: false },
  );
  assert.deepEqual(logs.filter(([event]) => event === "browser.manual_turn_completed"), [
    ["browser.manual_turn_completed", {
      tabId: retained.tabId, traceId: "manual_completed_retained", status: "completed", retained: true,
    }],
    ["browser.manual_turn_completed", {
      tabId: released.tabId, traceId: "manual_completed_released", status: "completed", retained: false,
    }],
  ]);
  assert.equal(JSON.stringify(logs).includes("private prompt"), false);
  assert.equal(JSON.stringify(logs).includes("a".repeat(64)), false);
});

test("terminal Zero Risk tabs are reclaimed before retained conversations", () => {
  const { fixture } = manualTurnFixture();
  fixture.turnTabs.set("manual-timeout", {
    id: "manual-timeout",
    interactionMode: "manual",
    status: "error",
    manualState: "timed-out",
    lastHeartbeatAt: 1,
  });
  fixture.turnTabs.set("manual-retained", {
    id: "manual-retained",
    interactionMode: "manual",
    status: "ready",
    manualState: "completed",
    lastHeartbeatAt: 0,
  });

  assert.equal(fixture.evictOldestReclaimableTurnTab(), true);
  assert.equal(fixture.turnTabs.has("manual-timeout"), false);
  assert.equal(fixture.turnTabs.has("manual-retained"), true);
});

test("a retained manual chat copies only its incremental resume prompt", () => {
  const { fixture, clipboardWrites } = manualTurnFixture();
  const first = fixture.beginManualTurn(
    "manual_trace_initial",
    process.pid,
    "full initial context",
    "a".repeat(64),
  );
  fixture.confirmManualSent(first.tabId);
  fixture.markManualTurnStarted("manual_trace_initial", process.pid);
  fixture.endManualTurn("manual_trace_initial", process.pid, "completed", true);

  const second = fixture.beginManualTurn(
    "manual_trace_next",
    process.pid,
    "full history that must not be copied again",
    "a".repeat(64),
    "only the new request",
  );
  assert.equal(second.tabId, first.tabId);
  assert.equal(second.reused, true);
  assert.deepEqual(clipboardWrites, ["full initial context", "only the new request"]);
  assert.equal(fixture.turnTabs.get(second.tabId).prompt, "only the new request");
  clearTimeout(fixture.turnTabs.get(second.tabId).manualDeadlineTimer);
});

test("manual navigation preserves initial setup but retires a completed page's continuation", () => {
  for (const inPlace of [false, true]) {
    const { fixture, clipboardWrites } = manualTurnFixture();
    const key = "a".repeat(64);
    const first = fixture.beginManualTurn("manual_initial", process.pid, "original context", key);
    const tab = fixture.turnTabs.get(first.tabId);
    const contents = new EventEmitter();
    contents.setWindowOpenHandler = () => {};
    tab.view = { webContents: contents };
    fixture.bindManualTurnContents(tab);
    const navigate = (url, mainFrame = true) => inPlace
      ? contents.emit("did-navigate-in-page", {}, url, mainFrame)
      : contents.emit("did-start-navigation", {}, url, false, mainFrame);
    navigate("https://chatgpt.com/?temporary-chat=true");
    assert.equal(tab.conversationKey, key);
    fixture.confirmManualSent(tab.id);
    fixture.markManualTurnStarted("manual_initial", process.pid);
    fixture.endManualTurn("manual_initial", process.pid, "completed", true);
    navigate("https://example.com/frame", false);
    assert.equal(tab.conversationKey, key);
    navigate("https://chatgpt.com/c/another-conversation");
    const next = fixture.beginManualTurn("manual_next", process.pid, "full history plus request", key, "delta only");
    assert.equal(next.reused, false);
    assert.notEqual(next.tabId, first.tabId);
    assert.deepEqual(clipboardWrites, ["original context", "full history plus request"]);
    fixture.cancelManualTurn("manual_next", process.pid);
  }
});

test("navigation cannot silently continue a resumed manual turn with only its delta", async () => {
  for (const state of ["awaiting-user", "sent", "running"]) {
    const { fixture } = manualTurnFixture();
    const key = "a".repeat(64);
    const first = fixture.beginManualTurn("manual_initial", process.pid, "original context", key);
    fixture.confirmManualSent(first.tabId);
    fixture.endManualTurn("manual_initial", process.pid, "completed", true);
    const next = fixture.beginManualTurn("manual_next", process.pid, "full history plus request", key, "delta only");
    const tab = fixture.turnTabs.get(next.tabId);
    const contents = new EventEmitter();
    contents.setWindowOpenHandler = () => {};
    tab.view = { webContents: contents };
    fixture.bindManualTurnContents(tab);
    if (state !== "awaiting-user") fixture.confirmManualSent(tab.id);
    if (state === "running") fixture.markManualTurnStarted("manual_next", process.pid);
    tab.url = "https://chatgpt.com/c/retained";
    for (const url of [tab.url, `${tab.url}#answer`]) {
      contents.emit("did-start-navigation", {}, url, true, true);
      contents.emit("did-navigate-in-page", {}, url, true);
      assert.equal(tab.status, "running");
      assert.equal(tab.manualState, state);
      assert.equal(tab.conversationKey, key);
    }
    const terminal = fixture.waitManualTerminal("manual_next", process.pid, 1_000);
    // Even reloading the same URL replaces the document; it is not a history-state update.
    contents.emit("did-start-navigation", {}, tab.url, false, true);
    assert.equal(tab.status, "error");
    assert.equal((await terminal).status, "failed");
    assert.match(tab.message, /full context/);
    assert.throws(() => fixture.confirmManualSent(tab.id), /no longer/);
    assert.throws(() => fixture.endManualTurn("manual_next", process.pid, "completed", true), /cannot complete/);
    fixture.endManualTurn("manual_next", process.pid, "failed");
    const fresh = fixture.beginManualTurn("manual_recovery", process.pid, "full history plus request", key, "delta only");
    assert.equal(fresh.reused, false);
    fixture.cancelManualTurn("manual_recovery", process.pid);
  }
});

test("navigation after the first manual submission prevents retaining the changed page", () => {
  const { fixture } = manualTurnFixture();
  const first = fixture.beginManualTurn("manual_initial", process.pid, "original context", "a".repeat(64));
  const tab = fixture.turnTabs.get(first.tabId);
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  tab.view = { webContents: contents };
  fixture.bindManualTurnContents(tab);
  fixture.confirmManualSent(tab.id);
  contents.emit("did-navigate-in-page", {}, "https://chatgpt.com/c/created-chat", true);
  fixture.markManualTurnStarted("manual_initial", process.pid);
  fixture.endManualTurn("manual_initial", process.pid, "completed", true);
  assert.equal(fixture.turnTabs.has(tab.id), false);
  assert.equal(fixture.manualCompletionSignals.has("manual_initial"), true);
});

test("manual start rejects a different prompt after Sent instead of replaying a trace", () => {
  const { fixture, clipboardWrites } = manualTurnFixture();
  const lease = fixture.beginManualTurn("manual_trace_mismatch", process.pid, "original prompt");
  fixture.confirmManualSent(lease.tabId);
  assert.throws(
    () => fixture.beginManualTurn("manual_trace_mismatch", process.pid, "replacement prompt"),
    /retried with a different prompt/,
  );
  assert.deepEqual(clipboardWrites, ["original prompt"]);
});

test("manual Copy and Sent confirmation remain isolated across concurrent tabs", async () => {
  const { fixture, clipboardWrites } = manualTurnFixture();
  const one = fixture.beginManualTurn("manual_trace_1", process.pid, "first prompt", "a".repeat(64));
  const two = fixture.beginManualTurn("manual_trace_2", process.pid, "second prompt", "b".repeat(64));
  const firstWait = fixture.waitManualSent("manual_trace_1", process.pid, 1_000);
  fixture.copyManualPrompt(one.tabId);
  fixture.confirmManualSent(one.tabId);
  assert.equal((await firstWait).status, "sent");
  assert.equal(fixture.turnTabs.get(one.tabId).manualState, "sent");
  assert.equal(fixture.turnTabs.get(two.tabId).manualState, "awaiting-user");
  assert.deepEqual(clipboardWrites, ["first prompt", "second prompt", "first prompt"]);
  for (const tab of fixture.turnTabs.values()) clearTimeout(tab.manualDeadlineTimer);
});

test("copyManualPrompt refreshes manual send deadline and re-arms deadline timer while awaiting-user", async () => {
  const { fixture, clipboardWrites } = manualTurnFixture();
  const lease = fixture.beginManualTurn("manual_refresh_deadline", process.pid, "model-retry prompt");
  const tab = fixture.turnTabs.get(lease.tabId);
  const initialDeadlineAt = tab.manualDeadlineAt;

  // Simulate time passing: set deadline into the past so it would fire immediately if not refreshed
  clearTimeout(tab.manualDeadlineTimer);
  tab.manualDeadlineAt = Date.now() - 100;

  // User copies prompt again (e.g. after switching models due to quota)
  const snapshot = fixture.copyManualPrompt(lease.tabId);

  // Assert deadline was refreshed into the future
  assert.ok(tab.manualDeadlineAt > initialDeadlineAt || tab.manualDeadlineAt > Date.now());
  assert.equal(snapshot.tabs.find(t => t.id === lease.tabId).manualDeadlineAt, new Date(tab.manualDeadlineAt).toISOString());
  assert.deepEqual(clipboardWrites, ["model-retry prompt", "model-retry prompt"]);

  // Tab remains awaiting-user and timer is active (does not time out immediately)
  assert.equal(tab.manualState, "awaiting-user");
  assert.ok(tab.manualDeadlineTimer !== null);

  clearTimeout(tab.manualDeadlineTimer);
});

test("premature Sent keeps prompt copyable until connector starts, then clears on running", () => {
  const { fixture, clipboardWrites } = manualTurnFixture();
  const lease = fixture.beginManualTurn("manual_premature_sent", process.pid, "safe-recovery prompt");
  const tab = fixture.turnTabs.get(lease.tabId);

  // User confirms Sent before ChatGPT actually accepts the prompt
  const sentSnapshot = fixture.confirmManualSent(lease.tabId);
  assert.equal(tab.manualState, "sent");
  const sentTabSnapshot = sentSnapshot.tabs.find(t => t.id === lease.tabId);
  assert.equal(sentTabSnapshot.canConfirmSent, false);
  // Prompt remains copyable while in sent state before connector binds
  assert.equal(sentTabSnapshot.canCopyPrompt, true);
  assert.equal(typeof tab.prompt, "string");

  // User realizes ChatGPT rejected sending (e.g. quota exhausted), switches model, and copies prompt again
  const copiedSnapshot = fixture.copyManualPrompt(lease.tabId);
  assert.deepEqual(clipboardWrites, ["safe-recovery prompt", "safe-recovery prompt"]);
  assert.equal(copiedSnapshot.tabs.find(t => t.id === lease.tabId).canCopyPrompt, true);
  assert.equal(tab.manualDeadlineAt, null);
  assert.equal(tab.manualDeadlineTimer, null);

  // Duplicate confirmManualSent remains idempotent
  const dupSnapshot = fixture.confirmManualSent(lease.tabId);
  assert.equal(dupSnapshot.tabs.find(t => t.id === lease.tabId).manualState, "sent");

  // ChatGPT finally accepts message and connects: markManualTurnStarted transitions to running and clears prompt
  const runningSnapshot = fixture.markManualTurnStarted("manual_premature_sent", process.pid);
  assert.equal(tab.manualState, "running");
  assert.equal(tab.prompt, null);
  assert.equal(tab.promptDigest, null);
  assert.equal(runningSnapshot.tabs.find(t => t.id === lease.tabId).canCopyPrompt, false);

  // After starting, copying prompt is cleanly rejected as prompt is no longer available
  assert.throws(() => fixture.copyManualPrompt(lease.tabId), /no longer available/);
});

test("manual Sent timeout and explicit cancellation are terminal", async () => {
  const { fixture } = manualTurnFixture();
  const timed = fixture.beginManualTurn("manual_timeout", process.pid, "timeout prompt");
  const timedTab = fixture.turnTabs.get(timed.tabId);
  clearTimeout(timedTab.manualDeadlineTimer);
  timedTab.manualDeadlineAt = Date.now();
  fixture.armManualTurnDeadline(timedTab);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(await fixture.waitManualSent("manual_timeout", process.pid, 10), { status: "timeout" });

  const cancelled = fixture.beginManualTurn("manual_cancel", process.pid, "cancel prompt");
  fixture.confirmManualSent(cancelled.tabId);
  const terminalWait = fixture.waitManualTerminal("manual_cancel", process.pid, 1_000);
  assert.deepEqual(fixture.cancelManualTurn("manual_cancel", process.pid), { cancelledByUser: true });
  assert.equal(fixture.turnTabs.has(cancelled.tabId), false);
  assert.deepEqual(await fixture.waitManualSent("manual_cancel", process.pid, 10), { status: "cancelled" });
  assert.deepEqual(await terminalWait, { status: "cancelled" });
});

test("closing a sent manual tab remains an authoritative terminal cancellation", async () => {
  const { fixture } = manualTurnFixture();
  let cancelledTrace = null;
  fixture.cancelTurn = async traceId => { cancelledTrace = traceId; };
  const lease = fixture.beginManualTurn("manual_close", process.pid, "close prompt");
  fixture.confirmManualSent(lease.tabId);
  const terminalWait = fixture.waitManualTerminal("manual_close", process.pid, 1_000);
  await fixture.closeTab(lease.tabId);
  assert.equal(cancelledTrace, "manual_close");
  assert.equal(fixture.turnTabs.has(lease.tabId), false);
  assert.deepEqual(await terminalWait, { status: "cancelled" });
});

test("manual turns never resume across a dead runtime owner", () => {
  const { fixture } = manualTurnFixture();
  const deadPid = 2_000_000_000;
  const lease = fixture.beginManualTurn("manual_owner_lost", deadPid, "old-token prompt");
  fixture.confirmManualSent(lease.tabId);
  assert.throws(
    () => fixture.beginManualTurn("manual_owner_lost", process.pid, "old-token prompt"),
    /lost its original runtime owner and cannot be resumed/,
  );
  assert.equal(fixture.turnTabs.has(lease.tabId), false);
  assert.deepEqual(fixture.manualTerminalSignals.get("manual_owner_lost"), {
    helperPid: process.pid,
    status: "failed",
  });
});

test("manual hidden tabs use native view placement without DOM or device-emulation hooks", () => {
  assert.doesNotMatch(
    BrowserHost.prototype.bindManualTurnContents.toString(),
    /page-title-updated|getTitle\(/,
  );
  const calls = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    bounds: { x: 1, y: 2, width: 640, height: 480 },
    hiddenTurnBounds: () => ({ x: 1000, y: 1000, width: 800, height: 600 }),
    enableHiddenTurnViewport: () => { throw new Error("manual tabs must not enable device emulation"); },
  });
  const tab = {
    interactionMode: "manual",
    status: "running",
    view: {
      setBounds: bounds => calls.push(["bounds", bounds]),
      setVisible: visible => calls.push(["visible", visible]),
    },
  };
  fixture.presentTurnView(tab, false);
  assert.deepEqual(calls, [
    ["bounds", { x: 1000, y: 1000, width: 800, height: 600 }],
    ["visible", true],
  ]);
});

test("manual browser snapshots never read or expose page-controlled titles", () => {
  let pageTitleReads = 0;
  const contents = {
    isDestroyed: () => false,
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
    },
    getURL: () => "https://chatgpt.com/?temporary-chat=true",
    getTitle: () => {
      pageTitleReads += 1;
      return "prompt-controlled title";
    },
    isLoading: () => false,
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    activeView: () => ({ webContents: contents }),
    selectedTurnTab: () => null,
    selectedTabId: "home",
    state: {
      title: "stale automatic title",
      status: "ready",
      message: "",
      url: "https://chatgpt.com/?temporary-chat=true",
      loading: false,
    },
    visible: true,
    surfaceActive: true,
    turnTabs: new Map(),
  });

  const snapshot = fixture.snapshot();
  assert.equal(snapshot.title, "ChatGPT");
  assert.equal(snapshot.tabs[0].title, "ChatGPT");
  assert.equal(pageTitleReads, 0);
});

test("interaction-mode changes preserve mode-bound retained tabs on failure and after commit", async () => {
  const retainedAutomatic = { id: "automatic-ready", status: "ready" };
  const retainedManual = { id: "manual-ready", status: "ready", interactionMode: "manual" };
  let ownershipMarks = 0;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    interactionModeOverride: null,
    writeDescriptor: () => {},
    manualOperation: null,
    turnTabs: new Map([
      [retainedAutomatic.id, retainedAutomatic],
      [retainedManual.id, retainedManual],
    ]),
    selectedTabId: retainedAutomatic.id,
    markOwnedSurface: async () => { ownershipMarks += 1; },
    snapshot: () => ({ activeTabId: "home" }),
  });

  await assert.rejects(
    fixture.withInteractionModeChange("automatic", async () => {
      assert.equal(fixture.currentOperation(), "browser interaction mode change");
      assert.equal(fixture.browserInteractionMode(), "automatic");
      throw new Error("runtime setup failed");
    }),
    /runtime setup failed/,
  );
  assert.equal(fixture.turnTabs.size, 2);
  assert.equal(fixture.currentOperation(), null);
  assert.equal(fixture.browserInteractionMode(), "manual");
  assert.equal(ownershipMarks, 0);

  const result = await fixture.withInteractionModeChange("automatic", async commit => {
    await commit();
    return "configured";
  });
  assert.equal(result, "configured");
  assert.deepEqual([...fixture.turnTabs.keys()], [retainedAutomatic.id, retainedManual.id]);
  assert.equal(fixture.selectedTabId, retainedAutomatic.id);
  assert.equal(fixture.currentOperation(), null);
  assert.equal(ownershipMarks, 1);

  const live = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([["running", { id: "running", status: "running" }]]),
    removeTurnTab: () => { throw new Error("live tab must not be removed"); },
  });
  assert.throws(
    () => live.assertTurnTabsCanResetForInteractionModeChange(),
    /Finish or cancel active ChatGPT turns/,
  );
});

test("switching from Zero Risk to Automatic marks the already-loaded primary surface", async () => {
  const scripts = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    interactionModeOverride: null,
    writeDescriptor: () => {},
    manualOperation: null,
    turnTabs: new Map(),
    selectedTabId: "home",
    surfaceId: "automatic-primary-surface",
    view: { webContents: {
      executeJavaScript: async script => { scripts.push(script); },
      isDestroyed: () => false,
    } },
    snapshot: () => ({ activeTabId: "home" }),
  });

  assert.equal(await fixture.withInteractionModeChange("automatic", async commit => {
    await commit();
    return "configured";
  }), "configured");
  assert.equal(scripts.length, 2);
  assert.match(scripts[0], /__CODEX_WEB_GPT_SURFACE_ID__/);
  assert.match(scripts[0], /automatic-primary-surface/);
  assert.match(scripts[1], /configureChatGptAnnouncementDismissal/);
});

test("a failed Automatic ownership proof stays inside the runtime rollback boundary", async () => {
  const retained = { id: "retained-before-failed-switch", status: "ready" };
  let rollbackBoundaryObserved = false;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    interactionModeOverride: null,
    writeDescriptor: () => {},
    manualOperation: null,
    turnTabs: new Map([[retained.id, retained]]),
    selectedTabId: retained.id,
    markOwnedSurface: async () => { throw new Error("surface ownership failed"); },
  });

  await assert.rejects(
    fixture.withInteractionModeChange("automatic", async commit => {
      try {
        await commit();
      } catch (error) {
        // RuntimeHost executes this callback before leaving runSetup's rollback-protected try.
        rollbackBoundaryObserved = true;
        throw error;
      }
    }),
    /surface ownership failed/,
  );
  assert.equal(rollbackBoundaryObserved, true);
  assert.deepEqual([...fixture.turnTabs.keys()], [retained.id]);
  assert.equal(fixture.browserInteractionMode(), "manual");
});

test("Zero Risk reveal navigates without inspecting the ChatGPT DOM", async () => {
  const calls = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    show: () => calls.push("show"),
    selectedTurnTab: () => null,
    view: { webContents: {
      getURL: () => IDLE_BROWSER_URL,
      loadURL: async url => calls.push(["loadURL", url]),
    } },
    probeAuthentication: async () => { throw new Error("manual reveal must not inspect the DOM"); },
    snapshot: () => ({ visible: true }),
  });
  assert.deepEqual(await fixture.reveal(false), { visible: true });
  assert.deepEqual(calls, ["show", ["loadURL", "https://chatgpt.com/?temporary-chat=true"]]);
});

test("Zero Risk fails closed at every primary-surface inspection boundary", async () => {
  let domOperations = 0;
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    getBrowserInteractionMode: () => "manual",
    view: { webContents: {
      isDestroyed: () => false,
      getURL: () => "https://chatgpt.com/?temporary-chat=true",
      executeJavaScript: async () => { domOperations += 1; },
      insertCSS: async () => { domOperations += 1; return "css-key"; },
      removeInsertedCSS: async () => { domOperations += 1; },
    } },
    viewportCssKey: null,
    surfaceId: "manual-surface",
  });
  await assert.rejects(fixture.applyViewportCss(), /disabled in Zero Risk mode/);
  await assert.rejects(fixture.markOwnedSurface(), /disabled in Zero Risk mode/);
  await assert.rejects(fixture.configureAnnouncementDismissal(true), /disabled in Zero Risk mode/);
  await assert.rejects(fixture.probeAuthentication(), /disabled in Zero Risk mode/);
  await assert.rejects(fixture.inspectSession(true), /disabled in Zero Risk mode/);
  await assert.rejects(fixture.inspectLimitsPlan(), /disabled in Zero Risk mode/);
  assert.equal(domOperations, 0);
});

test("manual turns have no live-session TTL but are revoked when their owner process exits", () => {
  const removed = [];
  const live = {
    id: "manual-live",
    traceId: "manual_live",
    helperPid: process.pid,
    interactionMode: "manual",
    manualState: "running",
    manualWaiters: new Set(),
    status: "running",
    lastHeartbeatAt: 1,
  };
  const dead = {
    ...live,
    id: "manual-dead",
    traceId: "manual_dead",
    helperPid: 2_000_000_000,
    manualWaiters: new Set(),
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[live.id, live], [dead.id, dead]]),
    manualTerminalSignals: new Map(),
    logger: { info() {}, warn() {} },
    removeTurnTab(tab) {
      removed.push(tab.id);
      this.turnTabs.delete(tab.id);
    },
  });
  fixture.reapExpiredTurnTabs(Number.MAX_SAFE_INTEGER);
  assert.equal(fixture.turnTabs.has(live.id), true);
  assert.equal(fixture.turnTabs.has(dead.id), false);
  assert.deepEqual(removed, [dead.id]);
  assert.deepEqual(fixture.manualTerminalSignals.get(dead.traceId), {
    helperPid: dead.helperPid,
    status: "failed",
  });
});

test("off-on-off fresh conversation changes retire completed history before it can be reused", async () => {
  const vm = require("node:vm");
  const { releaseRetainedConversation } = require("../electron/retained-turn-release.cjs");
  const main = fs.readFileSync(resolve(__dirname, "../electron/main.cjs"), "utf8");
  for (const savedChats of [false, true]) {
    const property = savedChats ? "useSavedChats" : "experimentalFreshConversationPerTurn";
    const method = savedChats ? "setUseSavedChats" : "setFreshConversationPerTurn";
    const channel = savedChats ? "launcher:use-saved-chats" : "launcher:fresh-conversation-per-turn";
    const nextChannel = savedChats ? "launcher:zero-risk-pro" : "launcher:use-saved-chats";
    const key = "a".repeat(64);
    const stale = { id: "old-chat", traceId: "old-turn", status: "ready", interactionMode: "automatic",
      conversationKey: key, connectorIdentity: "Codex Native2", connectorBound: true };
    const manual = { id: "manual-chat", status: "ready", interactionMode: "manual", conversationKey: "b".repeat(64) };
    const state = { experimentalFreshConversationPerTurn: false, useSavedChats: false };
    const config = { experimentalFreshConversationPerTurn: false, useSavedChats: false };
    let handler, failSetup = true, commit;
    const removed = [];
    const fixture = Object.assign(Object.create(BrowserHost.prototype), {
      manualOperation: null, turnTabs: new Map([[stale.id, stale], [manual.id, manual]]),
      userCancelledTurnOwners: new Map(), selectedTabId: "home", logger: { info() {} },
      syncViewVisibility() {}, snapshot: () => ({}), publishState() {}, writeDescriptor() {},
      removeTurnTab(tab, abortRunning) {
        assert.equal(abortRunning, false);
        assert.equal(tab.status, "ready");
        removed.push(tab.id);
        this.turnTabs.delete(tab.id);
      },
      createTurnTab: async () => ({ id: "new-chat", surfaceId: "new-surface" }),
    });
    vm.runInNewContext(main.slice(main.indexOf("function syncFreshConversationPreference("), main.indexOf("function registerIpc(")) +
      main.slice(main.indexOf(`handle("${channel}",`),
      main.indexOf(`handle("${nextChannel}",`)), {
      handle: (_channel, callback) => { handler = callback; }, browserHost: fixture, releaseRetainedConversation,
      runtimeHost: { currentOperation: () => null, runtimeConfigSnapshot: () => ({ config }), [method]: async enabled => {
        if (failSetup) throw new Error("setup rejected");
        await new Promise(resolve => { commit = resolve; });
        config[property] = enabled;
        return { enabled };
      } },
      stateStore: { read: () => ({ ...state }), update: patch => Object.assign(state, patch) }, send() {},
    });
    await assert.rejects(() => handler(null, true), /setup rejected/);
    assert.equal(fixture.turnTabs.get(stale.id), stale, "failed setup preserves prior history");
    failSetup = false;
    const enabling = handler(null, true);
    assert.equal(fixture.turnTabs.has(stale.id), true, "pending setup must not release history");
    // A concurrent running lease must not be cancelled, even if it shares the released key.
    const running = { id: "concurrent", traceId: "concurrent-turn", status: "running", interactionMode: "automatic", conversationKey: key };
    fixture.turnTabs.set(running.id, running);
    commit();
    await enabling;
    assert.deepEqual(removed, savedChats ? [stale.id, manual.id] : [stale.id]);
    assert.equal(fixture.turnTabs.get(running.id), running);
    assert.equal(fixture.turnTabs.get(manual.id), savedChats ? undefined : manual);
    fixture.turnTabs.delete(running.id);
    const disabling = handler(null, false);
    commit();
    await disabling;
    const lease = await fixture.beginTurn("new-turn", false, 123, key, "Codex Native2");
    assert.equal(lease.reused, false);
    assert.equal(lease.tabId, "new-chat");
    assert.equal(state[property], false);
    assert.equal(fixture.turnTabs.get(manual.id), savedChats ? undefined : manual);
  }
});
