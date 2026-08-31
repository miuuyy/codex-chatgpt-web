const test = require("node:test");
const assert = require("node:assert/strict");
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
  navigationErrorForLog,
  navigationOriginForLog,
} = require("../electron/browser-host.cjs");

test("Electron and Bun agree on the exact launcher idle surface", () => {
  const clientSource = fs.readFileSync(
    resolve(__dirname, "../../src/launcher-browser-host.ts"),
    "utf8",
  );
  assert.ok(clientSource.includes(
    `export const LAUNCHER_BROWSER_IDLE_URL = ${JSON.stringify(IDLE_BROWSER_URL)};`,
  ));
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
          proAvailable: true,
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
    proAvailable: true,
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
    view: { setVisible: visible => events.push(["home", visible]) },
  });

  BrowserHost.prototype.syncViewVisibility.call(fixture);

  assert.deepEqual(events, [
    ["home", false],
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
    view: { setVisible: visible => events.push(["home", visible]) },
  });

  BrowserHost.prototype.syncViewVisibility.call(fixture);

  assert.deepEqual(events, [
    ["home", false],
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
    view: { setVisible: visible => events.push(["home", visible]) },
  });

  BrowserHost.prototype.syncViewVisibility.call(fixture);

  assert.deepEqual(events, [
    ["home", false],
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

  await BrowserHost.prototype.waitForSurfaceReady.call(fixture, 100, 1);

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

test("launcher authentication requires the Temporary Chat composer and complete server session", async () => {
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

test("a live helper retains exclusive ownership of its running turn", () => {
  const tab = {
    id: "tab-live-owner",
    traceId: "trace_live_owner",
    helperPid: process.pid,
    status: "running",
  };
  assert.throws(
    () => BrowserHost.prototype.beginTurn.call({
      manualOperation: null,
      turnTabs: new Map([[tab.id, tab]]),
      userCancelledTurnOwners: new Map(),
    }, tab.traceId, false, process.pid + 1),
    /owned by another helper process/,
  );
});

test("a replacement helper takes over only after the previous owner exited", () => {
  const deadPid = 2_147_483_647;
  const tab = {
    id: "tab-dead-owner",
    surfaceId: "surface-dead-owner",
    traceId: "trace_dead_owner",
    helperPid: deadPid,
    status: "running",
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

  const lease = BrowserHost.prototype.beginTurn.call(fixture, tab.traceId, false, process.pid);

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
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    turnTabs: new Map([[tab.id, tab]]),
    closedTurnOwners: new Map(),
    snapshot: () => ({ activeTabId: tab.id }),
  });

  const before = Date.now();
  const snapshot = BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, tab.helperPid);

  assert.deepEqual(snapshot, { activeTabId: tab.id });
  assert.ok(tab.lastHeartbeatAt >= before);
  assert.throws(
    () => BrowserHost.prototype.heartbeatTurn.call(fixture, tab.traceId, 445),
    /ownership mismatch: expected 444, received 445/,
  );
});

test("an uninitialized browser surface is reaped instead of remaining as a gray orphan tab", () => {
  const closed = [];
  const warnings = [];
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
    closedTurnOwners: new Map(),
    selectedTabId: tab.id,
    window: { contentView: { removeChildView: () => closed.push("view") } },
    syncViewVisibility() {},
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
    logger: { warn: (event, detail) => warnings.push([event, detail]) },
  });

  BrowserHost.prototype.reapExpiredTurnTabs.call(fixture, 101);

  assert.equal(fixture.turnTabs.size, 0);
  assert.equal(fixture.selectedTabId, "home");
  assert.equal(fixture.closedTurnOwners.get(tab.traceId), tab.helperPid);
  assert.deepEqual(closed, ["view", "contents"]);
  assert.deepEqual(warnings, [["browser.orphan_turn_reaped", {
    tabId: tab.id,
    traceId: tab.traceId,
    helperPid: tab.helperPid,
    evidence: "browser_surface_bootstrap_timeout",
  }]]);
});

test("removing the final turn tab hides an uninitialized idle host instead of exposing gray content", () => {
  const calls = [];
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
    window: { contentView: { removeChildView: () => calls.push("view-remove") } },
    view: { webContents: { getURL: () => IDLE_BROWSER_URL } },
    syncViewVisibility() {},
    hide: () => calls.push("hide"),
    snapshot: () => ({ tabs: [] }),
    publishState() {},
    writeDescriptor() {},
  });

  BrowserHost.prototype.removeTurnTab.call(fixture, tab, false);

  assert.deepEqual(calls, ["view-remove", "contents-close", "hide"]);
});

test("hard refresh accepts Chromium's completed loading cycle even without did-finish-load", async () => {
  const calls = [];
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.reloadIgnoringCache = () => {
    calls.push("reload");
    queueMicrotask(() => {
      contents.emit("did-start-loading");
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
  assert.equal(contents.listenerCount("did-start-loading"), 0);
  assert.equal(contents.listenerCount("did-stop-loading"), 0);
  assert.equal(contents.listenerCount("did-finish-load"), 0);
});

test("hard refresh timeout cannot become success when stopping emits did-stop-loading", async () => {
  const contents = new EventEmitter();
  contents.isDestroyed = () => false;
  contents.reloadIgnoringCache = () => queueMicrotask(() => contents.emit("did-start-loading"));
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
    ["home", false],
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
  assert.throws(
    () => BrowserHost.prototype.beginTurn.call(fixture, tab.traceId, false, 444),
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

test("a later provider round reuses only its exact connector-bound conversation", () => {
  const throttling = [];
  const conversationKey = "a".repeat(64);
  const tab = {
    id: "tab-reused",
    surfaceId: "surface-reused",
    traceId: "trace_previous",
    conversationKey,
    connectorIdentity: "Codex Native2",
    connectorBound: true,
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

  const lease = BrowserHost.prototype.beginTurn.call(
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

test("a destroyed retained browser surface is discarded before a later provider round", () => {
  const conversationKey = "9".repeat(64);
  const stale = {
    id: "tab-stale",
    surfaceId: "surface-stale",
    traceId: "trace_previous",
    conversationKey,
    connectorIdentity: "Codex Native2",
    connectorBound: true,
    helperPid: 111,
    status: "ready",
    view: { webContents: { isDestroyed: () => true } },
  };
  const fresh = {
    id: "tab-fresh",
    surfaceId: "surface-fresh",
    connectorBound: false,
  };
  const events = [];
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[stale.id, stale]]),
    userCancelledTurnOwners: new Map(),
    removeTurnTab: (tab, abortRunning) => {
      events.push(["removed", tab.id, abortRunning]);
      fixture.turnTabs.delete(tab.id);
    },
    createTurnTab: (...args) => {
      assert.deepEqual(args, ["trace_next", 222, conversationKey, "Codex Native2"]);
      fixture.turnTabs.set(fresh.id, fresh);
      return fresh;
    },
    syncViewVisibility() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    logger: {
      warn: (event) => events.push(event),
      info() {},
    },
  });

  const lease = BrowserHost.prototype.beginTurn.call(
    fixture,
    "trace_next",
    false,
    222,
    conversationKey,
    "Codex Native2",
  );

  assert.deepEqual(lease, {
    surfaceId: "surface-fresh",
    tabId: "tab-fresh",
    reused: false,
    connectorBound: false,
  });
  assert.equal(fixture.turnTabs.has(stale.id), false);
  assert.deepEqual(events, [
    "browser.stale_retained_tab_discarded",
    ["removed", "tab-stale", false],
  ]);
});

test("destroying a retained browser surface removes its ownership record immediately", () => {
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  const tab = {
    id: "tab-destroyed",
    traceId: "trace_destroyed",
    status: "ready",
    view: { webContents: contents },
  };
  const removed = [];
  const fixture = {
    turnTabs: new Map([[tab.id, tab]]),
    logger: { warn() {}, error() {}, info() {} },
    removeTurnTab(candidate, abortRunning) {
      removed.push([candidate.id, abortRunning]);
      this.turnTabs.delete(candidate.id);
    },
  };

  BrowserHost.prototype.bindTurnContents.call(fixture, tab);
  contents.emit("destroyed");

  assert.deepEqual(removed, [[tab.id, false]]);
  assert.equal(fixture.turnTabs.size, 0);
});

test("a retained conversation is not reused for a different connector identity", () => {
  const conversationKey = "b".repeat(64);
  const retained = {
    id: "retained",
    traceId: "trace_old",
    status: "ready",
    conversationKey,
    connectorIdentity: "Codex Native2",
    connectorBound: true,
  };
  const created = { id: "fresh", surfaceId: "surface-fresh" };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[retained.id, retained]]),
    userCancelledTurnOwners: new Map(),
    createTurnTab: (...args) => {
      assert.deepEqual(args, ["trace_next", 222, conversationKey, "Other Connector"]);
      return created;
    },
    syncViewVisibility() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    logger: { info() {} },
  });

  const lease = BrowserHost.prototype.beginTurn.call(
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

test("a connector conversation is not reused until its connector was bound", () => {
  const conversationKey = "c".repeat(64);
  const retained = {
    id: "retained",
    traceId: "trace_old",
    status: "ready",
    conversationKey,
    connectorIdentity: "Codex Native2",
    connectorBound: false,
  };
  const fixture = Object.assign(Object.create(BrowserHost.prototype), {
    manualOperation: null,
    turnTabs: new Map([[retained.id, retained]]),
    userCancelledTurnOwners: new Map(),
    createTurnTab: () => ({ id: "fresh", surfaceId: "surface-fresh" }),
    syncViewVisibility() {},
    publishState() {},
    snapshot: () => ({ tabs: [] }),
    logger: { info() {} },
  });

  assert.deepEqual(
    BrowserHost.prototype.beginTurn.call(
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

test("a required retained conversation fails before creating a browser tab", () => {
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

  assert.throws(
    () => BrowserHost.prototype.beginTurn.call(
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

test("five browser tabs are a hard account-safety limit", () => {
  const turnTabs = new Map(Array.from({ length: 5 }, (_unused, index) => [
    `tab-${index + 1}`,
    { ordinal: index + 1 },
  ]));

  assert.throws(
    () => BrowserHost.prototype.createTurnTab.call({ turnTabs }, "trace_six", 444),
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
