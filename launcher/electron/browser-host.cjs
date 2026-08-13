const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { WebContentsView, shell } = require("electron");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const {
  runBrowserHelperOperation,
  verifyConnectorWithBrowserHelper,
} = require("./browser-helper-verifier.cjs");
const { validateConnectorName } = require("./connector-identity.cjs");
const { processRunning } = require("./process-tree.cjs");
const {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
} = require("./browser-state.cjs");

const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const IDLE_BROWSER_URL = "about:blank#codex-web-gpt-browser-host";
const MAX_BROWSER_VIEW_DIMENSION = 16_384;
const MAX_BROWSER_TABS = 5;
// These are lease/initialization guards only. They do not limit a live ChatGPT turn: active turns
// stay alive as long as the helper keeps heartbeating. They only reclaim a blank surface or a turn
// whose helper disappeared without delivering the normal /v1/turn/end event.
const TURN_HEARTBEAT_SWEEP_MS = 5_000;
const TURN_HEARTBEAT_TIMEOUT_MS = 60_000;
const TURN_TAB_BOOTSTRAP_TIMEOUT_MS = 120_000;
const BROWSER_NAVIGATION_TIMEOUT_MS = 60_000;
const CHATGPT_PARTITION = "persist:codex-web-gpt-chatgpt";
const CHATGPT_BACKEND_REQUEST_FILTER = { urls: [`${CHATGPT_ORIGIN}/backend-api/*`] };
const ZOOM_FACTORS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const MAX_LOGIN_COOKIES = 4_096;
const MAX_LOGIN_ORIGINS = 128;
const MAX_LOGIN_LOCAL_STORAGE_ENTRIES = 4_096;
const MAX_LOGIN_STATE_STRING_CHARS = 2 * 1024 * 1024;
const AUTH_PROVIDER_HOSTS = new Set([
  "auth.openai.com",
  "auth0.openai.com",
  "login.openai.com",
  "accounts.openai.com",
  "accounts.google.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
  "idmsa.apple.com",
]);
const CLOUDFLARE_CHALLENGE_RECOVERY_DELAY_MS = 500;
const CLOUDFLARE_CHALLENGE_RECOVERY_SETTLE_MS = 1_000;
const COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"][role="textbox"]',
  "textarea",
].join(", ");
const CHATGPT_VIEWPORT_CSS = `
  html,
  body {
    width: 100% !important;
    max-width: 100% !important;
    overflow-x: hidden !important;
    overscroll-behavior-x: none !important;
  }

  #__next {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    overflow-x: hidden !important;
  }
`;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function visibleElementScript(selector) {
  return `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find((element) => {
    const style = getComputedStyle(element);
    return element.isConnected
      && style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0";
  })`;
}

function normalizeBounds(bounds) {
  const read = (value) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return {
    x: Math.min(MAX_BROWSER_VIEW_DIMENSION, read(bounds?.x)),
    y: Math.min(MAX_BROWSER_VIEW_DIMENSION, read(bounds?.y)),
    width: Math.min(MAX_BROWSER_VIEW_DIMENSION, Math.max(1, read(bounds?.width))),
    height: Math.min(MAX_BROWSER_VIEW_DIMENSION, Math.max(1, read(bounds?.height))),
  };
}

function allowedAuthUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname === "chatgpt.com") {
    return parsed.pathname === "/auth"
      || parsed.pathname.startsWith("/auth/")
      || parsed.pathname === "/login";
  }
  return AUTH_PROVIDER_HOSTS.has(parsed.hostname);
}

function isTemporaryChatUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.origin === CHATGPT_ORIGIN
    && parsed.pathname === "/"
    && parsed.searchParams.get("temporary-chat") === "true";
}

function isChatGptBackendUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.origin === CHATGPT_ORIGIN && parsed.pathname.startsWith("/backend-api/");
}

function responseHeaderIncludes(responseHeaders, name, expectedValue) {
  const expected = expectedValue.toLowerCase();
  return Object.entries(responseHeaders || {}).some(([headerName, rawValues]) => {
    if (headerName.toLowerCase() !== name.toLowerCase()) return false;
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    return values.some(value => String(value)
      .split(",")
      .some(candidate => candidate.trim().toLowerCase() === expected));
  });
}

function isChatGptCloudflareChallengeResponse(details) {
  return details?.statusCode === 403
    && isChatGptBackendUrl(details.url)
    && responseHeaderIncludes(details.responseHeaders, "cf-mitigated", "challenge");
}

function isAllowedLoginCookieDomain(domain) {
  const hostname = domain.replace(/^\./, "").toLowerCase();
  return hostname === "chatgpt.com"
    || hostname.endsWith(".chatgpt.com")
    || hostname === "openai.com"
    || hostname.endsWith(".openai.com");
}

function boundedLoginStateString(value, label, { allowEmpty = true } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value)) {
    throw new Error(`System-browser login state has an invalid ${label}`);
  }
  if (value.length > MAX_LOGIN_STATE_STRING_CHARS) {
    throw new Error(`System-browser login state ${label} is too large`);
  }
  return value;
}

function validateChatGptStorageState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("System-browser login returned an invalid storage-state object");
  }
  if (!Array.isArray(value.cookies) || value.cookies.length > MAX_LOGIN_COOKIES) {
    throw new Error("System-browser login returned an invalid cookie collection");
  }
  if (!Array.isArray(value.origins) || value.origins.length > MAX_LOGIN_ORIGINS) {
    throw new Error("System-browser login returned an invalid origin collection");
  }

  const sameSiteValues = new Map([
    ["Strict", "strict"],
    ["Lax", "lax"],
    ["None", "no_restriction"],
  ]);
  const cookies = [];
  for (const raw of value.cookies) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("System-browser login returned an invalid cookie");
    }
    const domain = boundedLoginStateString(raw.domain, "cookie domain", { allowEmpty: false });
    if (!isAllowedLoginCookieDomain(domain)) continue;
    // Electron cannot represent CHIPS; never flatten one into an unpartitioned cookie.
    if (raw.partitionKey !== undefined) continue;
    const name = boundedLoginStateString(raw.name, "cookie name", { allowEmpty: false });
    const cookieValue = boundedLoginStateString(raw.value, "cookie value");
    const cookiePath = boundedLoginStateString(raw.path, "cookie path", { allowEmpty: false });
    if (!cookiePath.startsWith("/")) throw new Error("System-browser login state has an invalid cookie path");
    if (typeof raw.secure !== "boolean" || typeof raw.httpOnly !== "boolean") {
      throw new Error("System-browser login state has invalid cookie security attributes");
    }
    const sameSite = sameSiteValues.get(raw.sameSite);
    if (!sameSite) throw new Error("System-browser login state has an invalid cookie SameSite value");
    if (typeof raw.expires !== "number" || !Number.isFinite(raw.expires)) {
      throw new Error("System-browser login state has an invalid cookie expiry");
    }
    const hostname = domain.replace(/^\./, "").toLowerCase();
    const normalizedDomain = `${domain.startsWith(".") ? "." : ""}${hostname}`;
    const url = new URL(`https://${hostname}${cookiePath}`).toString();
    cookies.push({
      url,
      name,
      value: cookieValue,
      ...(domain.startsWith(".") ? { domain: normalizedDomain } : {}),
      path: cookiePath,
      secure: raw.secure,
      httpOnly: raw.httpOnly,
      sameSite,
      ...(raw.expires > 0 ? { expirationDate: raw.expires } : {}),
    });
  }
  if (cookies.length === 0) {
    throw new Error("System-browser login state contains no ChatGPT/OpenAI cookies");
  }

  const localStorage = [];
  for (const raw of value.origins) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.origin !== "string") {
      throw new Error("System-browser login returned an invalid origin state");
    }
    if (raw.origin !== CHATGPT_ORIGIN) continue;
    if (!Array.isArray(raw.localStorage) || raw.localStorage.length > MAX_LOGIN_LOCAL_STORAGE_ENTRIES) {
      throw new Error("System-browser login returned invalid ChatGPT local storage");
    }
    for (const entry of raw.localStorage) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("System-browser login returned an invalid ChatGPT local-storage entry");
      }
      localStorage.push({
        name: boundedLoginStateString(entry.name, "local-storage name"),
        value: boundedLoginStateString(entry.value, "local-storage value"),
      });
    }
  }
  if (localStorage.length > MAX_LOGIN_LOCAL_STORAGE_ENTRIES) {
    throw new Error("System-browser login returned too many ChatGPT local-storage entries");
  }
  return { cookies, localStorage };
}

function javaScriptLiteral(value) {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function appendFailure(primary, label, secondary) {
  const first = primary instanceof Error ? primary.message : String(primary);
  const second = secondary instanceof Error ? secondary.message : String(secondary);
  return new Error(`${first}; ${label}: ${second}`);
}

class BrowserHost {
  constructor({
    window,
    descriptorPath,
    cdpPort,
    control,
    getConnectorName,
    helper,
    logger,
    loginWithSystemBrowser,
    publishState,
  }) {
    if (typeof getConnectorName !== "function") {
      throw new Error("Browser host connector-name resolver is unavailable");
    }
    if (typeof loginWithSystemBrowser !== "function") {
      throw new Error("Browser host system-browser login operation is unavailable");
    }
    this.window = window;
    this.descriptorPath = descriptorPath;
    this.cdpPort = cdpPort;
    this.control = control;
    this.getConnectorName = getConnectorName;
    this.helper = helper;
    this.logger = logger;
    this.loginWithSystemBrowser = loginWithSystemBrowser;
    this.publishState = publishState;
    this.runBrowserHelperOperation = runBrowserHelperOperation;
    this.verifyConnectorWithBrowserHelper = verifyConnectorWithBrowserHelper;
    this.surfaceId = randomBytes(24).toString("base64url");
    this.visible = false;
    this.surfaceActive = true;
    this.turnTabs = new Map();
    this.closedTurnOwners = new Map();
    this.selectedTabId = "home";
    this.manualOperation = null;
    this.loginOperation = null;
    // During storage-state import, the first navigation may legitimately redirect to ChatGPT's
    // same-origin /auth surface before captured localStorage has been restored. Allow only that
    // bootstrap redirect; external identity-provider navigation remains routed to system Chrome.
    this.systemBrowserLoginStorageBootstrap = false;
    this.cloudflareChallengeRecovery = null;
    this.cloudflareChallengeRecoveryArmed = true;
    this.cloudflareChallengeRecoveryDelayMs = CLOUDFLARE_CHALLENGE_RECOVERY_DELAY_MS;
    this.cloudflareChallengeRecoverySettleMs = CLOUDFLARE_CHALLENGE_RECOVERY_SETTLE_MS;
    this.viewportCssKey = null;
    this.homeNavigationTimeout = null;
    this.turnLeaseSweep = setInterval(() => this.reapExpiredTurnTabs(), TURN_HEARTBEAT_SWEEP_MS);
    this.turnLeaseSweep.unref?.();
    this.boundsReady = false;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
    this.state = {
      status: "idle",
      message: "No active task",
      url: "about:blank",
      title: "ChatGPT",
      authenticated: false,
      visible: false,
      surfaceActive: true,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
    };
    this.view = new WebContentsView({
      webPreferences: {
        partition: CHATGPT_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: true,
      },
    });
    window.contentView.addChildView(this.view);
    this.view.setBounds(this.bounds);
    this.view.setVisible(false);
    this.view.webContents.setZoomFactor(this.state.zoomFactor);
    this.bindChatGptBackendRecovery();
    this.bindWebContents();
    this.initializationReady = this.view.webContents.loadURL(IDLE_BROWSER_URL).then(async () => {
      await this.markOwnedSurface();
      this.writeDescriptor();
      this.logger.info("browser.initialized", { url: this.view.webContents.getURL() });
    }).catch((error) => {
      this.logger.error("browser.initialization_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      this.setState({ status: "error", message: "Embedded browser failed to initialize" });
      throw error;
    });
  }

  async ready() {
    await this.initializationReady;
  }

  currentOperation() {
    return this.manualOperation || (this.loginOperation ? "ChatGPT login" : null);
  }

  get activeTraceId() {
    return [...this.turnTabs.values()].find((tab) => tab.status === "running")?.traceId || null;
  }

  tabSnapshot(tab) {
    return {
      id: tab.id,
      traceId: tab.traceId,
      title: tab.label,
      status: tab.status,
      loading: tab.loading === true,
      active: this.selectedTabId === tab.id,
      closable: true,
    };
  }

  selectedTurnTab() {
    return this.turnTabs.get(this.selectedTabId) || null;
  }

  createTurnTab(traceId, helperPid) {
    if (this.turnTabs.size >= MAX_BROWSER_TABS) {
      throw new Error(
        `ChatGPT Web already has ${MAX_BROWSER_TABS} browser tabs; close one before starting another turn to avoid excessive parallel traffic on the ChatGPT account`,
      );
    }
    const id = randomBytes(12).toString("base64url");
    const surfaceId = randomBytes(24).toString("base64url");
    const ordinal = Array.from({ length: MAX_BROWSER_TABS }, (_unused, index) => index + 1)
      .find(candidate => ![...this.turnTabs.values()].some(tab => tab.ordinal === candidate));
    if (!ordinal) throw new Error("ChatGPT Web browser tab allocation is inconsistent");
    const view = new WebContentsView({
      webPreferences: {
        partition: CHATGPT_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: false,
      },
    });
    const tab = {
      id,
      surfaceId,
      traceId,
      helperPid,
      view,
      status: "running",
      ordinal,
      label: `ChatGPT ${ordinal}`,
      pageTitle: "ChatGPT",
      url: IDLE_BROWSER_URL,
      loading: true,
      message: "ChatGPT is working",
      bootstrapReady: false,
      bootstrapDeadlineAt: Date.now() + TURN_TAB_BOOTSTRAP_TIMEOUT_MS,
      lastHeartbeatAt: Date.now(),
    };
    this.turnTabs.set(id, tab);
    this.window.contentView.addChildView(view);
    view.setBounds(this.bounds);
    view.setVisible(false);
    view.webContents.setZoomFactor(this.state.zoomFactor);
    this.bindTurnContents(tab);
    void view.webContents.loadURL(IDLE_BROWSER_URL).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("browser.tab_initialization_failed", {
        tabId: tab.id,
        traceId: tab.traceId,
        message,
      });
      this.removeTurnTab(tab, true);
    });
    return tab;
  }

  bindTurnContents(tab) {
    const contents = tab.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthUrl(url)) {
        this.logger.warn("browser.turn_authentication_blocked", { tabId: tab.id, traceId: tab.traceId });
        return { action: "deny" };
      }
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString());
      return { action: "deny" };
    });
    const blockAuthenticationNavigation = (event, url) => {
      if (!allowedAuthUrl(url)) return;
      event.preventDefault();
      tab.message = "ChatGPT requires a fresh sign-in; finish this turn, then sign in from Setup";
      this.logger.warn("browser.turn_authentication_blocked", { tabId: tab.id, traceId: tab.traceId });
      this.publishState?.(this.snapshot());
    };
    contents.on("will-navigate", blockAuthenticationNavigation);
    contents.on("will-redirect", blockAuthenticationNavigation);
    contents.on("did-start-navigation", (_event, url, _inPlace, mainFrame) => {
      if (!mainFrame) return;
      tab.url = url;
      tab.loading = true;
      this.publishState?.(this.snapshot());
    });
    contents.on("did-start-loading", () => {
      tab.loading = true;
      this.publishState?.(this.snapshot());
    });
    contents.on("did-stop-loading", () => {
      tab.loading = false;
      tab.url = contents.getURL();
      this.publishState?.(this.snapshot());
    });
    contents.on("did-finish-load", () => {
      tab.url = contents.getURL();
      tab.loading = false;
      if (tab.url.startsWith(CHATGPT_ORIGIN)) tab.bootstrapReady = true;
      void contents.insertCSS(CHATGPT_VIEWPORT_CSS).catch(() => {});
      const encoded = JSON.stringify(tab.surfaceId);
      void contents.executeJavaScript(`(() => {
        Object.defineProperty(globalThis, "__CODEX_WEB_GPT_SURFACE_ID__", {
          value: ${encoded}, configurable: true, enumerable: false, writable: false,
        });
        document.documentElement.dataset.codexWebGptSurface = ${encoded};
      })()`, true).then(
        () => this.publishState?.(this.snapshot()),
        (error) => {
          tab.status = "error";
          tab.message = `Browser ownership failed: ${error instanceof Error ? error.message : String(error)}`;
          this.publishState?.(this.snapshot());
        },
      );
    });
    contents.on("page-title-updated", (_event, title) => {
      if (typeof title === "string" && title.trim()) tab.pageTitle = title.trim();
      this.publishState?.(this.snapshot());
    });
    contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) tab.url = url;
      this.publishState?.(this.snapshot());
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      tab.url = url;
      tab.message = errorDescription;
      this.logger.error("browser.tab_navigation_failed", {
        tabId: tab.id,
        traceId: tab.traceId,
        errorCode,
        errorDescription,
        url,
      });
      this.removeTurnTab(tab, true);
    });
    contents.on("render-process-gone", (_event, details) => {
      tab.message = `Browser renderer stopped: ${details.reason}`;
      this.logger.error("browser.tab_renderer_gone", {
        tabId: tab.id,
        traceId: tab.traceId,
        reason: details.reason,
        exitCode: details.exitCode,
      });
      this.removeTurnTab(tab, true);
    });
  }

  bindWebContents() {
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthUrl(url)) {
        this.routeAuthenticationToSystemBrowser(url);
        return { action: "deny" };
      }
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        void shell.openExternal(parsed.toString()).catch((error) => {
          const message = `Could not open the external link: ${error instanceof Error ? error.message : String(error)}`;
          this.logger.error("browser.external_url_open_failed", { url: parsed.toString(), message });
          this.setState({ status: "error", message, loading: false });
        });
      } else {
        this.logger.warn("browser.external_url_rejected", { protocol: parsed.protocol });
      }
      return { action: "deny" };
    });
    const routeNavigation = (event, url) => {
      if (this.routeAuthenticationToSystemBrowser(url)) event.preventDefault();
    };
    contents.on("will-navigate", routeNavigation);
    contents.on("will-redirect", routeNavigation);
    contents.on("did-start-navigation", (_event, url, _inPlace, mainFrame) => {
      if (!mainFrame) return;
      this.armHomeNavigationTimeout(contents, url);
      this.setState(this.activeTraceId || this.manualOperation
        ? { url, loading: true }
        : { status: "loading", message: "Opening ChatGPT", url, loading: true });
    });
    contents.on("did-finish-load", () => {
      this.clearHomeNavigationTimeout();
      this.setState({ url: contents.getURL(), loading: false });
      void this.applyViewportCss();
      void this.markOwnedSurface()
        .then(() => this.probeAuthentication())
        .catch((error) => {
          this.logger.error("browser.surface_mark_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
          this.setState({ status: "error", message: "Embedded browser ownership could not be established" });
        });
    });
    contents.on("did-start-loading", () => this.setState({ loading: true }));
    contents.on("did-stop-loading", () => {
      this.clearHomeNavigationTimeout();
      this.setState({ loading: false });
    });
    contents.on("page-title-updated", (_event, title) => {
      this.setState({ title: typeof title === "string" && title.trim() ? title.trim() : "ChatGPT" });
    });
    contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) this.setState({ url });
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      this.clearHomeNavigationTimeout();
      this.logger.error("browser.navigation_failed", { errorCode, errorDescription, url });
      this.setState({ status: "error", message: errorDescription, url, loading: false });
    });
    contents.on("render-process-gone", (_event, details) => {
      this.clearHomeNavigationTimeout();
      this.logger.error("browser.renderer_gone", { reason: details.reason, exitCode: details.exitCode });
      this.setState({ status: "error", message: `Browser renderer stopped: ${details.reason}`, loading: false });
    });
  }

  routeAuthenticationToSystemBrowser(url) {
    if (!allowedAuthUrl(url)) return false;
    if (this.systemBrowserLoginStorageBootstrap) {
      let parsed;
      try { parsed = new URL(url); } catch {}
      if (parsed?.origin === CHATGPT_ORIGIN) {
        this.logger.info("browser.system_login_storage_bootstrap_redirect", {
          pathname: parsed.pathname,
        });
        return false;
      }
    }
    void this.openLogin({ force: true }).catch((error) => {
      this.logger.error("browser.system_login_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return true;
  }

  armHomeNavigationTimeout(contents, url) {
    this.clearHomeNavigationTimeout();
    this.homeNavigationTimeout = setTimeout(() => {
      this.homeNavigationTimeout = null;
      if (contents.isDestroyed() || !contents.isLoadingMainFrame()) return;
      contents.stop();
      const message = "ChatGPT did not finish loading within 60 seconds. Check your connection and retry.";
      this.logger.error("browser.navigation_timeout", { url });
      this.setState({ status: "error", message, url, loading: false });
    }, BROWSER_NAVIGATION_TIMEOUT_MS);
    this.homeNavigationTimeout.unref?.();
  }

  clearHomeNavigationTimeout() {
    if (!this.homeNavigationTimeout) return;
    clearTimeout(this.homeNavigationTimeout);
    this.homeNavigationTimeout = null;
  }

  async hardRefreshHome(timeoutMs = BROWSER_NAVIGATION_TIMEOUT_MS) {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) {
      throw new Error("The managed ChatGPT page is not available for connector verification");
    }
    this.setState({
      status: "loading",
      message: "Refreshing the ChatGPT connector catalog",
      loading: true,
    });
    await new Promise((resolve, reject) => {
      let settled = false;
      let reloadStarted = false;
      const cleanup = () => {
        clearTimeout(timeout);
        contents.off("did-start-loading", onStarted);
        contents.off("did-stop-loading", onStopped);
        contents.off("did-finish-load", onFinished);
        contents.off("did-fail-load", onFailed);
        contents.off("render-process-gone", onRendererGone);
        contents.off("destroyed", onDestroyed);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onStarted = () => { reloadStarted = true; };
      const onStopped = () => { if (reloadStarted) finish(); };
      const onFinished = () => { if (reloadStarted) finish(); };
      const onFailed = (_event, errorCode, errorDescription, url, mainFrame) => {
        if (!mainFrame || errorCode === -3) return;
        finish(new Error(`ChatGPT hard refresh failed: ${errorDescription} (${url})`));
      };
      const onRendererGone = (_event, details) => {
        finish(new Error(`ChatGPT renderer stopped during hard refresh: ${details.reason}`));
      };
      const onDestroyed = () => finish(new Error("ChatGPT closed during hard refresh"));
      const timeout = setTimeout(() => {
        finish(new Error("ChatGPT hard refresh did not finish within 60 seconds"));
        if (!contents.isDestroyed()) contents.stop();
      }, timeoutMs);
      timeout.unref?.();
      contents.on("did-start-loading", onStarted);
      contents.on("did-stop-loading", onStopped);
      contents.on("did-finish-load", onFinished);
      contents.on("did-fail-load", onFailed);
      contents.on("render-process-gone", onRendererGone);
      contents.on("destroyed", onDestroyed);
      try {
        contents.reloadIgnoringCache();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async refreshChatGptHomeDocument() {
    // A navigation from the idle host already creates a fresh ChatGPT document. Reload only an
    // existing Temporary Chat document; doing both back-to-back races the helper against a second
    // SPA bootstrap and is why first setup/verification attempts timed out while the retry worked.
    if (isTemporaryChatUrl(this.view.webContents.getURL())) {
      await this.hardRefreshHome();
    } else {
      await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
    }
    await this.waitForAuthenticated(60_000);
  }

  bindChatGptBackendRecovery() {
    this.view.webContents.session.webRequest.onCompleted(
      CHATGPT_BACKEND_REQUEST_FILTER,
      details => this.handleChatGptBackendResponse(details),
    );
  }

  handleChatGptBackendResponse(details) {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed() || details?.webContentsId !== contents.id) return false;
    if (!isChatGptBackendUrl(details.url)) return false;

    if (details.statusCode >= 200 && details.statusCode < 400) {
      this.cloudflareChallengeRecoveryArmed = true;
      return false;
    }
    if (!isChatGptCloudflareChallengeResponse(details)) return false;
    if (this.cloudflareChallengeRecovery) {
      this.cloudflareChallengeRecoveryArmed = false;
      return true;
    }
    if (this.activeTraceId || this.manualOperation) {
      this.logger.warn("browser.cloudflare_challenge_not_reloaded", {
        reason: this.activeTraceId ? "turn-active" : "manual-operation-active",
        url: details.url,
      });
      return true;
    }
    if (!this.cloudflareChallengeRecoveryArmed) {
      this.logger.warn("browser.cloudflare_challenge_persisted", { url: details.url });
      return true;
    }
    this.cloudflareChallengeRecoveryArmed = false;
    this.logger.warn("browser.cloudflare_challenge_detected", { url: details.url });
    const recovery = this.reloadHomeAfterCloudflareChallenge();
    const tracked = recovery
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("browser.cloudflare_challenge_recovery_failed", { message });
        this.setState({ status: "error", message, loading: false });
      })
      .finally(() => {
        if (this.cloudflareChallengeRecovery === tracked) this.cloudflareChallengeRecovery = null;
      });
    this.cloudflareChallengeRecovery = tracked;
    return true;
  }

  async reloadHomeAfterCloudflareChallenge() {
    const contents = this.view.webContents;
    this.setState({
      status: "loading",
      message: "Refreshing ChatGPT security check",
      loading: true,
    });
    await sleep(this.cloudflareChallengeRecoveryDelayMs);
    if (contents.isDestroyed()) throw new Error("ChatGPT browser closed during security-check recovery");
    const url = contents.getURL();
    if (!url.startsWith(CHATGPT_ORIGIN)) {
      throw new Error("ChatGPT security-check recovery lost its owned browser page");
    }

    // Only responses from this new document may prove that the challenge cleared.
    this.cloudflareChallengeRecoveryArmed = false;
    await contents.loadURL(url);
    await sleep(this.cloudflareChallengeRecoverySettleMs);
    if (!this.cloudflareChallengeRecoveryArmed) {
      throw new Error("ChatGPT security check is still blocking backend requests. Reload ChatGPT and retry.");
    }
    await this.probeAuthentication();
    this.logger.info("browser.cloudflare_challenge_recovered", { url });
  }

  snapshot() {
    const contents = this.activeView()?.webContents;
    const selected = this.selectedTurnTab();
    const homeTab = {
      id: "home",
      traceId: null,
      title: this.state.title || "ChatGPT",
      status: this.state.status,
      loading: this.state.loading === true,
      active: this.selectedTabId === "home",
      closable: false,
    };
    const state = selected
      ? {
          ...this.state,
          status: selected.status,
          message: selected.message,
          url: selected.url,
          title: selected.pageTitle,
          loading: selected.loading,
        }
      : this.state;
    return {
      ...readBrowserNavigationState(contents, {
      ...state,
      visible: this.visible,
      surfaceActive: this.surfaceActive,
      }),
      activeTabId: this.selectedTabId,
      tabs: this.turnTabs.size > 0
        ? [
            ...(this.selectedTabId === "home" ? [homeTab] : []),
            ...[...this.turnTabs.values()].map((tab) => this.tabSnapshot(tab)),
          ]
        : [homeTab],
      maxTabs: MAX_BROWSER_TABS,
    };
  }

  setState(patch) {
    this.state = {
      ...this.state,
      ...patch,
      visible: this.visible,
      surfaceActive: this.surfaceActive,
    };
    this.publishState?.(this.snapshot());
  }

  heartbeatTurn(traceId, helperPid) {
    const tab = [...this.turnTabs.values()].find(candidate => candidate.traceId === traceId);
    if (!tab) {
      const closedOwner = this.closedTurnOwners.get(traceId);
      if (closedOwner === helperPid) throw new Error(`Browser turn ${traceId} was already released`);
      throw new Error(`Browser turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    if (tab.helperPid !== helperPid) {
      throw new Error(`Browser helper ownership mismatch: expected ${tab.helperPid}, received ${helperPid}`);
    }
    if (tab.status !== "running") throw new Error(`Browser turn ${traceId} is no longer running`);
    tab.lastHeartbeatAt = Date.now();
    return this.snapshot();
  }

  reapExpiredTurnTabs(now = Date.now()) {
    for (const tab of [...this.turnTabs.values()]) {
      if (tab.status !== "running") continue;
      const bootstrapExpired = tab.bootstrapReady !== true
        && now >= (tab.bootstrapDeadlineAt ?? Number.POSITIVE_INFINITY);
      const heartbeatExpired = tab.bootstrapReady === true
        && now - (tab.lastHeartbeatAt ?? 0) >= TURN_HEARTBEAT_TIMEOUT_MS;
      if (!bootstrapExpired && !heartbeatExpired) continue;
      const evidence = bootstrapExpired ? "browser_surface_bootstrap_timeout" : "helper_heartbeat_expired";
      this.logger.warn("browser.orphan_turn_reaped", {
        tabId: tab.id,
        traceId: tab.traceId,
        helperPid: tab.helperPid,
        evidence,
      });
      this.removeTurnTab(tab, true);
    }
  }

  setBounds(bounds) {
    const [width, height] = this.window.getContentSize();
    this.bounds = constrainBrowserBounds(normalizeBounds(bounds), { width, height });
    this.boundsReady = true;
    this.view.setBounds(this.bounds);
    for (const tab of this.turnTabs.values()) tab.view.setBounds(this.bounds);
    this.syncViewVisibility();
    void this.view.webContents.executeJavaScript("window.dispatchEvent(new Event('resize'))", true).catch(() => {});
  }

  activeView() {
    return this.selectedTurnTab()?.view || this.view;
  }

  activateHomeSurface() {
    this.selectedTabId = "home";
    this.syncViewVisibility();
    if (this.visible && this.surfaceActive) this.activeView().webContents.focus();
    this.publishState?.(this.snapshot());
    this.writeDescriptor();
  }

  syncViewVisibility() {
    const visible = browserViewVisible(this.visible, this.surfaceActive, this.boundsReady);
    const selected = this.selectedTurnTab();
    this.view.setVisible(visible && !selected);
    for (const tab of this.turnTabs.values()) {
      tab.view.setVisible(visible && selected?.id === tab.id);
    }
  }

  selectTab(tabId) {
    if (tabId !== "home" && !this.turnTabs.has(tabId)) throw new Error("Browser tab does not exist");
    this.selectedTabId = tabId;
    this.syncViewVisibility();
    if (this.visible && this.surfaceActive) this.activeView().webContents.focus();
    this.publishState?.(this.snapshot());
    this.writeDescriptor();
    return this.snapshot();
  }

  removeTurnTab(tab, abortRunning) {
    if (!this.turnTabs.has(tab.id)) return;
    this.turnTabs.delete(tab.id);
    if (abortRunning && tab.status === "running") {
      this.closedTurnOwners.set(tab.traceId, tab.helperPid);
      tab.status = "aborted";
    }
    try { this.window.contentView.removeChildView(tab.view); } catch {}
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.selectedTabId === tab.id) {
      this.selectedTabId = [...this.turnTabs.keys()].at(-1) || "home";
      const homeContents = this.view?.webContents;
      if (this.selectedTabId === "home"
        && !this.activeTraceId
        && homeContents
        && typeof homeContents.getURL === "function"
        && homeContents.getURL() === IDLE_BROWSER_URL) {
        // Never reveal the unhydrated about:blank host after a turn tab disappears. It renders as a
        // gray, apparently frozen ChatGPT tab even though there is no browser turn left to show.
        this.hide?.();
      }
    }
    this.syncViewVisibility();
    this.publishState?.(this.snapshot());
    this.writeDescriptor();
  }

  closeTab(tabId) {
    const tab = this.turnTabs.get(tabId);
    if (!tab) throw new Error("Browser tab does not exist");
    this.removeTurnTab(tab, true);
    this.logger.info("browser.tab_closed", { tabId, traceId: tab.traceId, status: tab.status });
    return this.snapshot();
  }

  async applyViewportCss() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    if (this.viewportCssKey) {
      await contents.removeInsertedCSS(this.viewportCssKey).catch(() => {});
      this.viewportCssKey = null;
    }
    this.viewportCssKey = await contents.insertCSS(CHATGPT_VIEWPORT_CSS).catch(() => null);
  }

  async markOwnedSurface() {
    const surfaceId = JSON.stringify(this.surfaceId);
    await this.view.webContents.executeJavaScript(`(() => {
      Object.defineProperty(globalThis, "__CODEX_WEB_GPT_SURFACE_ID__", {
        value: ${surfaceId},
        configurable: true,
        enumerable: false,
        writable: false,
      });
      document.documentElement.dataset.codexWebGptSurface = ${surfaceId};
    })()`, true);
  }

  show() {
    this.visible = true;
    this.syncViewVisibility();
    this.setState({ visible: true });
    if (this.surfaceActive && this.boundsReady) this.activeView().webContents.focus();
  }

  async reveal() {
    this.show();
    if (!this.selectedTurnTab() && this.view.webContents.getURL() === IDLE_BROWSER_URL) {
      await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
      await this.probeAuthentication();
    }
    return this.snapshot();
  }

  hide() {
    this.visible = false;
    this.syncViewVisibility();
    this.setState({ visible: false });
  }

  setSurfaceActive(active) {
    this.surfaceActive = active === true;
    this.syncViewVisibility();
    this.setState({ surfaceActive: this.surfaceActive });
    return this.snapshot();
  }

  async waitForSurfaceReady(timeoutMs = 15_000, pollMs = 50) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.surfaceActive && this.boundsReady) return;
      await sleep(pollMs);
    }
    throw new Error(
      "Embedded browser surface did not receive measured bounds before the operation",
    );
  }

  navigate(action) {
    if (this.activeTraceId) {
      throw new Error("Browser navigation is locked while ChatGPT is running a Codex turn");
    }
    if (this.manualOperation) {
      throw new Error(`Browser navigation is locked during ${this.manualOperation}`);
    }
    const contents = this.activeView().webContents;
    navigateBrowser(contents, action);
    return this.snapshot();
  }

  zoom(action) {
    if (action !== "in" && action !== "out" && action !== "reset") {
      throw new Error(`Unknown browser zoom action: ${action}`);
    }
    const current = this.state.zoomFactor;
    const currentIndex = ZOOM_FACTORS.indexOf(current);
    if (currentIndex < 0) throw new Error(`Browser zoom state is invalid: ${current}`);
    const next = action === "reset"
      ? 1
      : action === "in"
        ? ZOOM_FACTORS[Math.min(currentIndex + 1, ZOOM_FACTORS.length - 1)]
        : ZOOM_FACTORS[Math.max(currentIndex - 1, 0)];
    const contents = [this.view, ...[...this.turnTabs.values()].map((tab) => tab.view)]
      .map((view) => view?.webContents)
      .filter((candidate) => candidate && !candidate.isDestroyed());
    if (contents.length === 0) throw new Error("ChatGPT browser is unavailable for zoom");
    for (const candidate of contents) candidate.setZoomFactor(next);
    this.setState({ zoomFactor: next });
    return this.snapshot();
  }

  beginTurn(traceId, reveal, helperPid) {
    if (this.manualOperation) {
      throw new Error(`ChatGPT browser is busy with ${this.manualOperation}`);
    }
    const existing = [...this.turnTabs.values()].find((tab) => tab.traceId === traceId);
    if (existing) {
      if (existing.status === "running" && existing.helperPid !== helperPid) {
        if (processRunning(existing.helperPid)) {
          throw new Error(`ChatGPT browser turn ${traceId} is owned by another helper process`);
        }
        this.logger.warn("browser.stale_turn_owner_replaced", {
          tabId: existing.id,
          traceId,
          previousHelperPid: existing.helperPid,
          helperPid,
          evidence: "previous helper exited",
        });
      }
      existing.helperPid = helperPid;
      existing.status = "running";
      existing.loading = true;
      existing.message = "ChatGPT is working";
      existing.bootstrapReady = false;
      existing.bootstrapDeadlineAt = Date.now() + TURN_TAB_BOOTSTRAP_TIMEOUT_MS;
      existing.lastHeartbeatAt = Date.now();
      if (!existing.view.webContents.isDestroyed()) {
        existing.view.webContents.setBackgroundThrottling(false);
      }
      this.selectedTabId = existing.id;
      if (reveal) this.show();
      else this.syncViewVisibility();
      this.publishState?.(this.snapshot());
      this.writeDescriptor();
      this.logger.info("browser.tab_reused", { tabId: existing.id, traceId });
      return { surfaceId: existing.surfaceId, tabId: existing.id };
    }
    const tab = this.createTurnTab(traceId, helperPid);
    this.selectedTabId = tab.id;
    if (reveal) this.show();
    else this.syncViewVisibility();
    this.publishState?.(this.snapshot());
    this.logger.info("browser.tab_created", { tabId: tab.id, traceId, tabCount: this.turnTabs.size });
    return { surfaceId: tab.surfaceId, tabId: tab.id };
  }

  async endTurn(traceId, helperPid, status, hideAfterTurn, message) {
    const tab = [...this.turnTabs.values()].find((candidate) => candidate.traceId === traceId);
    if (!tab) {
      const closedOwner = this.closedTurnOwners.get(traceId);
      if (closedOwner === helperPid) {
        this.closedTurnOwners.delete(traceId);
        return;
      }
      throw new Error(`Browser turn ownership mismatch: no browser tab owns ${traceId}`);
    }
    if (tab.helperPid !== helperPid) {
      throw new Error(
        `Browser helper ownership mismatch: expected ${tab.helperPid}, received ${helperPid}`,
      );
    }
    tab.status = status === "completed" ? "ready" : status === "aborted" ? "aborted" : "error";
    tab.message = status === "completed" ? "Task completed" : message || `ChatGPT turn ${status}`;
    tab.loading = false;
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.setBackgroundThrottling(true);
    if (status === "completed") {
      this.logger.info("browser.tab_completed", { tabId: tab.id, traceId });
    }
    // A browser tab represents an active Codex turn, not durable task history. Retaining terminal
    // tabs leaked one slot per response/compaction until the five-tab safety limit made later
    // turns fail. The result already lives in Codex; release the browser document on every
    // terminal path while leaving other concurrently running tabs untouched.
    this.removeTurnTab(tab, false);
    if (hideAfterTurn && !this.activeTraceId) this.hide();
    this.logger.info("browser.tab_released", { tabId: tab.id, traceId, status: tab.status });
  }

  async returnToIdle() {
    this.hide();
    this.view.webContents.setBackgroundThrottling(true);
    if (this.view.webContents.getURL() !== IDLE_BROWSER_URL) {
      await this.view.webContents.loadURL(IDLE_BROWSER_URL);
    }
    this.setState({
      status: this.state.authenticated ? "ready" : "signed-out",
      message: this.state.authenticated ? "No active task" : "Sign in to ChatGPT",
    });
  }

  openLogin({ force = false } = {}) {
    if (this.state.authenticated && !force) {
      this.activateHomeSurface();
      this.show();
      return Promise.resolve(this.snapshot());
    }
    if (this.loginOperation) {
      this.activateHomeSurface();
      this.show();
      return this.loginOperation;
    }
    const operation = this.withManualOperation("ChatGPT login", async () => {
      this.show();
      this.setState({
        authenticated: false,
        status: "loading",
        message: "Waiting for sign-in in system Chrome/Chromium",
        loading: true,
      });
      this.logger.info("browser.system_login_started");
      const transfer = await this.loginWithSystemBrowser();
      return await this.installSystemBrowserLogin(transfer);
    });
    const tracked = operation.finally(() => {
      if (this.loginOperation === tracked) this.loginOperation = null;
    });
    this.loginOperation = tracked;
    return tracked;
  }

  async clearOwnedChatGptSession() {
    if (!(this.turnTabs instanceof Map)) throw new Error("Owned ChatGPT browser tab registry is unavailable");
    const ownedContents = [this.view, ...[...this.turnTabs.values()].map((tab) => tab.view)]
      .map((view) => view?.webContents)
      .filter((contents) => contents && !contents.isDestroyed());
    if (ownedContents.length === 0) throw new Error("Owned ChatGPT browser session is unavailable");
    const parked = await Promise.allSettled(
      ownedContents.map((contents) => contents.loadURL(IDLE_BROWSER_URL)),
    );
    const parkFailures = parked
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (parkFailures.length > 0) {
      throw new Error(`Could not isolate every owned ChatGPT renderer before clearing login state: ${parkFailures.join("; ")}`);
    }
    const browserSession = ownedContents[0].session;
    await browserSession.clearStorageData();
    browserSession.flushStorageData();
    await browserSession.cookies.flushStore();
  }

  async discardImportedChatGptSession() {
    let failure = null;
    try {
      await this.clearOwnedChatGptSession();
    } catch (error) {
      failure = error;
    }
    this.setState({ authenticated: false, loading: false, url: IDLE_BROWSER_URL });
    if (failure) throw failure;
  }

  async installSystemBrowserLogin(transfer) {
    if (!transfer || typeof transfer !== "object" || typeof transfer.cleanup !== "function") {
      throw new Error("System-browser login returned an invalid transfer handle");
    }
    let primaryError = null;
    let browser = null;
    let sessionMutated = false;
    let sessionDiscarded = false;
    let state;
    try {
      state = validateChatGptStorageState(transfer.storageState);
    } catch (error) {
      primaryError = error;
    }

    const contents = this.view?.webContents;
    if (!primaryError) {
      try {
        if (!contents || contents.isDestroyed()) throw new Error("Owned ChatGPT browser session is unavailable");
        sessionMutated = true;
        await this.clearOwnedChatGptSession();
        for (const cookie of state.cookies) await contents.session.cookies.set(cookie);
        contents.session.flushStorageData();
        await contents.session.cookies.flushStore();
        if (state.localStorage.length > 0) {
          // A newly captured account can redirect the first Electron navigation to ChatGPT /auth
          // until its captured localStorage is restored. The normal navigation guard used to
          // prevent that same-origin redirect, which cancelled loadURL with ERR_FAILED (-2) before
          // the storage import could run. Permit only the bootstrap redirect while localStorage is
          // restored, then immediately restore normal auth routing before the authoritative reload.
          this.systemBrowserLoginStorageBootstrap = true;
          try {
            await contents.loadURL(TEMPORARY_CHAT_URL);
            const entries = javaScriptLiteral(state.localStorage);
            await contents.executeJavaScript(`(() => {
              if (location.origin !== ${JSON.stringify(CHATGPT_ORIGIN)}) {
                throw new Error("ChatGPT storage import reached an unexpected origin");
              }
              for (const entry of ${entries}) localStorage.setItem(entry.name, entry.value);
            })()`, true);
            await contents.loadURL(TEMPORARY_CHAT_URL);
            browser = await this.waitForAuthenticated(60_000);
          } finally {
            this.systemBrowserLoginStorageBootstrap = false;
          }
        } else {
          await contents.loadURL(TEMPORARY_CHAT_URL);
          browser = await this.waitForAuthenticated(60_000);
        }
        if (browser?.authenticated !== true) {
          throw new Error("Imported ChatGPT session did not produce an authenticated Electron composer");
        }
        await this.persistSession();
        this.activateHomeSurface();
        this.show();
        this.logger.info("browser.system_login_imported");
      } catch (error) {
        primaryError = error;
      }
    }

    if (primaryError && sessionMutated) {
      try {
        sessionDiscarded = true;
        await this.discardImportedChatGptSession();
      } catch (error) {
        primaryError = appendFailure(primaryError, "clearing the partial Electron login failed", error);
      }
    }
    try {
      await transfer.cleanup();
    } catch (error) {
      primaryError = primaryError
        ? appendFailure(primaryError, "removing temporary system-browser login state failed", error)
        : new Error(`Removing temporary system-browser login state failed: ${error instanceof Error ? error.message : String(error)}`);
      if (sessionMutated && !sessionDiscarded) {
        try {
          sessionDiscarded = true;
          await this.discardImportedChatGptSession();
        } catch (clearError) {
          primaryError = appendFailure(primaryError, "clearing Electron login after cleanup failure failed", clearError);
        }
      }
    }
    if (primaryError) throw primaryError;
    return browser;
  }

  async logout() {
    return await this.withManualOperation("ChatGPT logout", async () => {
      const contents = this.view.webContents;
      await contents.session.clearStorageData();
      this.setState({
        authenticated: false,
        loading: true,
        message: "Signing out of ChatGPT",
        status: "loading",
      });
      await contents.loadURL(TEMPORARY_CHAT_URL);
      const browser = await this.probeAuthentication();
      if (browser.authenticated) {
        throw new Error("ChatGPT session remained authenticated after local session data was cleared");
      }
      this.activateHomeSurface();
      this.show();
      this.logger.info("browser.logout_completed");
      return this.snapshot();
    });
  }

  async refreshAuthentication() {
    return await this.withManualOperation("session refresh", async () => {
      this.setState({ status: "loading", message: "Checking saved ChatGPT session" });
      if (!isTemporaryChatUrl(this.view.webContents.getURL())) {
        await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
      }
      return await this.probeAuthentication();
    });
  }

  async probeAuthentication() {
    if (!this.view || this.view.webContents.isDestroyed()) return this.snapshot();
    let url = this.view.webContents.getURL();
    if (url === IDLE_BROWSER_URL) {
      this.setState({
        status: this.state.authenticated ? "ready" : "signed-out",
        message: this.state.authenticated ? "No active task" : "Sign in to ChatGPT",
        url,
      });
      return this.snapshot();
    }
    if (!url.startsWith(CHATGPT_ORIGIN)) {
      this.setState({ status: "signed-out", message: "Sign in to ChatGPT", authenticated: false, url });
      return this.snapshot();
    }
    const probe = (contents) => contents.executeJavaScript(`(() => {
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      return { composer: Boolean(composer), readyState: document.readyState };
    })()`, true).catch(() => ({ composer: false, readyState: "unknown" }));
    const result = await probe(this.view.webContents);
    if (result.composer) {
      const wasAuthenticated = this.state.authenticated;
      const availability = this.activeTraceId
        ? { status: "running", message: "ChatGPT is working" }
        : this.manualOperation
          ? {}
          : { status: "ready", message: "ChatGPT is ready" };
      this.setState({ ...availability, authenticated: true, url });
      if (!wasAuthenticated) this.logger.info("browser.authenticated", { url });
    } else {
      const loaded = result.readyState === "complete";
      this.setState({
        status: loaded ? "signed-out" : "loading",
        message: loaded ? "Sign in to ChatGPT" : "Waiting for ChatGPT",
        authenticated: false,
        url,
      });
    }
    return this.snapshot();
  }

  async waitForAuthenticated(timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.probeAuthentication();
      if (state.authenticated) return state;
      await sleep(750);
    }
    throw new Error("ChatGPT login was not completed before the timeout");
  }

  async smokeTest() {
    return await this.withManualOperation("browser smoke test", () => this.runSmokeTest());
  }

  connectorName() {
    if (typeof this.getConnectorName !== "function") {
      throw new Error("Browser host connector-name resolver is unavailable");
    }
    return validateConnectorName(this.getConnectorName());
  }

  async runSmokeTest() {
    const connectorName = this.connectorName();
    this.show();
    await this.waitForSurfaceReady();
    this.setState({ status: "testing", message: "Running browser smoke test" });
    this.logger.info("smoke.started");
    const result = await this.runBrowserHelperOperation({
      helper: this.helper,
      descriptorPath: this.descriptorPath,
      appName: connectorName,
      operation: "smoke",
      logger: this.logger,
    });
    const evidence = result?.value;
    if (!evidence
      || typeof evidence.effort !== "string"
      || !evidence.effort
      || evidence.response !== "CODEX WEB GPT READY") {
      throw new Error("Browser helper returned invalid smoke-test evidence");
    }
    this.logger.info("smoke.completed", { effort: evidence.effort, responseChars: evidence.response.length });
    this.setState({ status: "ready", message: "Smoke test passed", authenticated: true });
    return { ok: true, ...evidence };
  }

  async verifyConnector(appName) {
    return await this.withManualOperation("connector verification", () => this.runConnectorVerification(appName));
  }

  async runConnectorVerification(appName) {
    const connectorName = validateConnectorName(appName);
    this.setState({ status: "testing", message: "Checking ChatGPT connector" });
    await this.refreshChatGptHomeDocument();
    const result = await this.verifyConnectorWithBrowserHelper({
      helper: this.helper,
      descriptorPath: this.descriptorPath,
      appName: connectorName,
      logger: this.logger,
    });
    this.logger.info("connector.verified", { appName: connectorName });
    this.setState({ status: "ready", message: "ChatGPT connector is available", authenticated: true });
    return result;
  }

  async inspectSession(detectCapabilities = false) {
    return await this.withManualOperation("session inspection", () => this.runSessionInspection(detectCapabilities));
  }

  async runSessionInspection(detectCapabilities = false) {
    const connectorName = this.connectorName();
    const initialUrl = this.view.webContents.getURL();
    const startedIdle = initialUrl === IDLE_BROWSER_URL;
    if (detectCapabilities) await this.refreshChatGptHomeDocument();
    const result = await this.runBrowserHelperOperation({
      helper: this.helper,
      descriptorPath: this.descriptorPath,
      appName: connectorName,
      operation: "inspect",
      payload: { detectCapabilities },
      logger: this.logger,
    });
    const inspected = result?.value;
    if (!inspected || inspected.authenticated !== true || inspected.temporary !== true || typeof inspected.url !== "string") {
      throw new Error("Browser helper returned invalid ChatGPT session evidence");
    }
    if (detectCapabilities
      && (typeof inspected.solAvailable !== "boolean" || typeof inspected.proAvailable !== "boolean")) {
      throw new Error("Browser helper returned incomplete ChatGPT capability evidence");
    }
    if (detectCapabilities && inspected.proAvailable && !inspected.solAvailable) {
      throw new Error("Browser helper returned contradictory ChatGPT capability evidence");
    }
    if (startedIdle) await this.returnToIdle();
    return inspected;
  }

  async withManualOperation(name, action) {
    await this.ready();
    if (this.activeTraceId) {
      throw new Error(`ChatGPT browser is running Codex turn ${this.activeTraceId}`);
    }
    if (this.manualOperation) {
      throw new Error(`ChatGPT browser is already busy with ${this.manualOperation}`);
    }
    this.activateHomeSurface();
    this.manualOperation = name;
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.setBackgroundThrottling(false);
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setState({ status: "error", message });
      throw error;
    } finally {
      if (contents && !contents.isDestroyed()) contents.setBackgroundThrottling(true);
      this.manualOperation = null;
    }
  }

  writeDescriptor() {
    const descriptor = {
      version: 1,
      kind: "codex-web-gpt-launcher",
      pid: process.pid,
      endpoint: `http://127.0.0.1:${this.cdpPort}`,
      control: this.control,
      helper: this.helper,
      partition: "persist:codex-web-gpt-chatgpt",
      idleUrl: IDLE_BROWSER_URL,
      surfaceId: this.surfaceId,
      createdAt: new Date().toISOString(),
    };
    writePrivateFileAtomic(this.descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  }

  async persistSession() {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    const browserSession = contents.session;
    browserSession.flushStorageData();
    await browserSession.cookies.flushStore();
  }

  destroy() {
    try {
      const current = JSON.parse(fs.readFileSync(this.descriptorPath, "utf8"));
      if (current.pid === process.pid) fs.rmSync(this.descriptorPath, { force: true });
    } catch {}
    this.clearHomeNavigationTimeout();
    if (this.turnLeaseSweep) clearInterval(this.turnLeaseSweep);
    for (const tab of this.turnTabs.values()) {
      try { this.window.contentView.removeChildView(tab.view); } catch {}
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.turnTabs.clear();
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
  }
}

module.exports = {
  allowedAuthUrl,
  BrowserHost,
  CHATGPT_VIEWPORT_CSS,
  IDLE_BROWSER_URL,
  isChatGptCloudflareChallengeResponse,
  isTemporaryChatUrl,
  TEMPORARY_CHAT_URL,
  validateChatGptStorageState,
};
