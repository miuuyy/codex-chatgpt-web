const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { WebContentsView, shell } = require("electron");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { verifyConnectorWithBrowserHelper } = require("./browser-helper-verifier.cjs");
const {
  dispatchTrustedKey,
  evaluatePage,
} = require("./cdp-input.cjs");
const {
  browserViewVisible,
  constrainBrowserBounds,
  navigateBrowser,
  readBrowserNavigationState,
} = require("./browser-state.cjs");

const TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const IDLE_BROWSER_URL = "about:blank#codex-web-gpt-browser-host";
const SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const SMOKE_EXPECTED = "CODEX WEB GPT READY";
const SMOKE_SUBMISSION_TIMEOUT_MS = 15_000;
const SMOKE_RESPONSE_TIMEOUT_MS = 120_000;
const SMOKE_COMPLETION_SETTLE_MS = 1_500;
const MAX_BROWSER_VIEW_DIMENSION = 16_384;
const MAX_BROWSER_TABS = 5;
const CHATGPT_PARTITION = "persist:codex-web-gpt-chatgpt";
const COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  '[contenteditable="true"][role="textbox"]',
  "textarea",
].join(", ");
const EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"])',
  '[role="menu"]:has([role="menuitemradio"])',
  '[role="group"]:has([role="menuitemradio"])',
].join(", ");
const COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
const ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
].join(", ");
const USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
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
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
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
  return parsed.protocol === "https:" && (
    parsed.hostname === "chatgpt.com"
    || parsed.hostname.endsWith(".openai.com")
    || parsed.hostname === "accounts.google.com"
    || parsed.hostname === "login.microsoftonline.com"
    || parsed.hostname.endsWith(".apple.com")
  );
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

class BrowserHost {
  constructor({ window, descriptorPath, cdpPort, control, helper, logger, publishState }) {
    this.window = window;
    this.descriptorPath = descriptorPath;
    this.cdpPort = cdpPort;
    this.control = control;
    this.helper = helper;
    this.logger = logger;
    this.publishState = publishState;
    this.dispatchTrustedKey = dispatchTrustedKey;
    this.evaluatePage = evaluatePage;
    this.verifyConnectorWithBrowserHelper = verifyConnectorWithBrowserHelper;
    this.surfaceId = randomBytes(24).toString("base64url");
    this.visible = false;
    this.surfaceActive = true;
    this.turnTabs = new Map();
    this.closedTurnOwners = new Map();
    this.selectedTabId = "home";
    this.manualOperation = null;
    this.loginOperation = null;
    this.viewportCssKey = null;
    this.authView = null;
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
    this.bindWebContents();
    void this.view.webContents.loadURL(IDLE_BROWSER_URL).catch((error) => {
      this.logger.error("browser.initialization_failed", { message: error instanceof Error ? error.message : String(error) });
      this.setState({ status: "error", message: "Embedded browser failed to initialize" });
    });
    this.writeDescriptor();
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
    };
    this.turnTabs.set(id, tab);
    this.window.contentView.addChildView(view);
    view.setBounds(this.bounds);
    view.setVisible(false);
    this.bindTurnContents(tab);
    void view.webContents.loadURL(IDLE_BROWSER_URL).catch((error) => {
      tab.status = "error";
      tab.loading = false;
      tab.message = error instanceof Error ? error.message : String(error);
      this.publishState?.(this.snapshot());
    });
    return tab;
  }

  bindTurnContents(tab) {
    const contents = tab.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(parsed.toString());
      return { action: "deny" };
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
      tab.status = "error";
      tab.loading = false;
      tab.url = url;
      tab.message = errorDescription;
      this.logger.error("browser.tab_navigation_failed", {
        tabId: tab.id,
        traceId: tab.traceId,
        errorCode,
        errorDescription,
        url,
      });
      this.publishState?.(this.snapshot());
    });
    contents.on("render-process-gone", (_event, details) => {
      tab.status = "error";
      tab.loading = false;
      tab.message = `Browser renderer stopped: ${details.reason}`;
      this.publishState?.(this.snapshot());
    });
  }

  bindWebContents() {
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthUrl(url)) {
        return {
          action: "allow",
          createWindow: (options) => this.createAuthView(options),
        };
      }
      let parsed;
      try { parsed = new URL(url); } catch { return { action: "deny" }; }
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        void shell.openExternal(parsed.toString());
      } else {
        this.logger.warn("browser.external_url_rejected", { protocol: parsed.protocol });
      }
      return { action: "deny" };
    });
    contents.on("did-start-navigation", (_event, url, _inPlace, mainFrame) => {
      if (!mainFrame) return;
      this.setState(this.activeTraceId || this.manualOperation
        ? { url, loading: true }
        : { status: "loading", message: "Opening ChatGPT", url, loading: true });
    });
    contents.on("did-finish-load", () => {
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
    contents.on("did-stop-loading", () => this.setState({ loading: false }));
    contents.on("page-title-updated", (_event, title) => {
      this.setState({ title: typeof title === "string" && title.trim() ? title.trim() : "ChatGPT" });
    });
    contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) this.setState({ url });
    });
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      this.logger.error("browser.navigation_failed", { errorCode, errorDescription, url });
      this.setState({ status: "error", message: errorDescription, url });
    });
    contents.on("render-process-gone", (_event, details) => {
      this.logger.error("browser.renderer_gone", { reason: details.reason, exitCode: details.exitCode });
      this.setState({ status: "error", message: `Browser renderer stopped: ${details.reason}` });
    });
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

  setBounds(bounds) {
    const [width, height] = this.window.getContentSize();
    this.bounds = constrainBrowserBounds(normalizeBounds(bounds), { width, height });
    this.boundsReady = true;
    this.view.setBounds(this.bounds);
    for (const tab of this.turnTabs.values()) tab.view.setBounds(this.bounds);
    this.authView?.setBounds(this.bounds);
    this.syncViewVisibility();
    void this.view.webContents.executeJavaScript("window.dispatchEvent(new Event('resize'))", true).catch(() => {});
    if (this.authView && !this.authView.webContents.isDestroyed()) {
      void this.authView.webContents.executeJavaScript("window.dispatchEvent(new Event('resize'))", true).catch(() => {});
    }
  }

  activeView() {
    return this.authView || this.selectedTurnTab()?.view || this.view;
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
    this.view.setVisible(visible && !this.authView && !selected);
    for (const tab of this.turnTabs.values()) {
      tab.view.setVisible(visible && !this.authView && selected?.id === tab.id);
    }
    this.authView?.setVisible(visible);
  }

  selectTab(tabId) {
    if (tabId !== "home" && !this.turnTabs.has(tabId)) throw new Error("Browser tab does not exist");
    if (this.authView) this.closeAuthView(this.authView, true);
    this.selectedTabId = tabId;
    this.syncViewVisibility();
    if (this.visible && this.surfaceActive) this.activeView().webContents.focus();
    this.publishState?.(this.snapshot());
    this.writeDescriptor();
    return this.snapshot();
  }

  removeTurnTab(tab, abortRunning) {
    this.turnTabs.delete(tab.id);
    if (abortRunning && tab.status === "running") {
      this.closedTurnOwners.set(tab.traceId, tab.helperPid);
      tab.status = "aborted";
    }
    try { this.window.contentView.removeChildView(tab.view); } catch {}
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.selectedTabId === tab.id) {
      this.selectedTabId = [...this.turnTabs.keys()].at(-1) || "home";
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

  createAuthView(options = {}) {
    this.closeAuthView(this.authView, true);
    const authView = new WebContentsView({
      webPreferences: {
        ...(options.webPreferences || {}),
        partition: CHATGPT_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.authView = authView;
    this.window.contentView.addChildView(authView);
    authView.setBounds(this.bounds);
    authView.setVisible(false);
    const contents = authView.webContents;
    contents.on("did-start-loading", () => this.setState({ loading: true }));
    contents.on("did-stop-loading", () => this.setState({ loading: false }));
    contents.on("did-finish-load", () => {
      this.setState({ url: contents.getURL(), loading: false });
      void this.probeAuthentication();
    });
    contents.on("page-title-updated", (_event, title) => {
      this.setState({ title: typeof title === "string" && title.trim() ? title.trim() : "ChatGPT" });
    });
    contents.on("close", () => this.closeAuthView(authView, true));
    contents.on("destroyed", () => this.closeAuthView(authView, false));
    contents.on("did-fail-load", (_event, errorCode, errorDescription, url, mainFrame) => {
      if (!mainFrame || errorCode === -3) return;
      this.logger.error("browser.auth_navigation_failed", { errorCode, errorDescription, url });
      this.setState({ status: "error", message: errorDescription, url });
    });
    contents.on("render-process-gone", (_event, details) => {
      this.logger.error("browser.auth_renderer_gone", { reason: details.reason, exitCode: details.exitCode });
      this.closeAuthView(authView, false);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (allowedAuthUrl(url)) {
        void contents.loadURL(url);
      } else {
        let parsed;
        try { parsed = new URL(url); } catch { return { action: "deny" }; }
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          void shell.openExternal(parsed.toString());
        }
      }
      return { action: "deny" };
    });
    this.syncViewVisibility();
    this.logger.info("browser.auth_surface_opened");
    return contents;
  }

  closeAuthView(authView, closeContents, refreshMain = true) {
    if (!authView || this.authView !== authView) return;
    this.authView = null;
    try { this.window.contentView.removeChildView(authView); } catch {}
    if (closeContents && !authView.webContents.isDestroyed()) {
      authView.webContents.close();
    }
    this.syncViewVisibility();
    this.logger.info("browser.auth_surface_closed");
    if (refreshMain && this.manualOperation === "ChatGPT login" && !this.view.webContents.isDestroyed()) {
      void this.view.webContents.loadURL(TEMPORARY_CHAT_URL).catch((error) => {
        this.logger.error("browser.auth_refresh_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
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

  beginTurn(traceId, reveal, helperPid) {
    if (this.manualOperation) {
      throw new Error(`ChatGPT browser is busy with ${this.manualOperation}`);
    }
    const existing = [...this.turnTabs.values()].find((tab) => tab.traceId === traceId);
    if (existing) {
      if (existing.status === "running" && existing.helperPid !== helperPid) {
        throw new Error(`ChatGPT browser turn ${traceId} is owned by another helper process`);
      }
      existing.helperPid = helperPid;
      existing.status = "running";
      existing.loading = true;
      existing.message = "ChatGPT is working";
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

  openLogin() {
    if (this.state.authenticated) {
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
      this.logger.info("browser.login_opened");
      const current = this.view.webContents.getURL();
      if (!current.startsWith(CHATGPT_ORIGIN)) {
        await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
      }
      await this.probeAuthentication();
      return await this.waitForAuthenticated();
    });
    const tracked = operation.finally(() => {
      if (this.loginOperation === tracked) this.loginOperation = null;
    });
    this.loginOperation = tracked;
    return tracked;
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
    let result = await probe(this.view.webContents);
    if (!result.composer && this.authView && !this.authView.webContents.isDestroyed()) {
      const authResult = await probe(this.authView.webContents);
      if (authResult.composer) {
        const completedAuthView = this.authView;
        this.closeAuthView(completedAuthView, true, false);
        await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
        url = this.view.webContents.getURL();
        result = await probe(this.view.webContents);
      }
    }
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

  async runSmokeTest() {
    this.show();
    await this.waitForSurfaceReady();
    this.setState({ status: "testing", message: "Running browser smoke test" });
    this.logger.info("smoke.started");
    if (!isTemporaryChatUrl(this.view.webContents.getURL())) {
      await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
    }
    await this.waitForAuthenticated(60_000);

    const effortResult = await this.selectHighEffort();
    this.logger.info("smoke.effort_selected", effortResult);
    const beforeAssistantCount = await this.assistantTurnCount();
    const beforeUserCount = await this.userTurnCount();
    if (!await this.focusComposer()) {
      throw new Error("ChatGPT composer was not available for the smoke test");
    }
    await this.clearFocusedComposer();
    this.view.webContents.focus();
    this.view.webContents.insertText(SMOKE_TEXT);
    await this.waitForComposerText(SMOKE_TEXT);
    await this.waitForSmokeSendButton();
    if (!await this.focusSmokeSendButton()) {
      throw new Error("ChatGPT send button could not receive focus for the smoke test");
    }
    await this.pressTrustedBrowserKey("Enter");
    const submitted = await this.waitForSmokeSubmissionAccepted(beforeUserCount);
    this.logger.info("smoke.submitted", submitted);

    const deadline = Date.now() + SMOKE_RESPONSE_TIMEOUT_MS;
    let completionCandidate = null;
    while (Date.now() < deadline) {
      const outcome = await this.view.webContents.executeJavaScript(`(() => {
        const turns = Array.from(document.querySelectorAll(${JSON.stringify(ASSISTANT_TURN_SELECTOR)}));
        const latest = turns.at(-1);
        const rendered = latest?.querySelector('.markdown');
        const text = rendered ? (rendered.innerText || rendered.textContent || '').trim() : '';
        const completionActionVisible = latest
          ? Array.from(latest.querySelectorAll(${JSON.stringify(COMPLETION_ACTION_SELECTOR)})).some((button) => {
              const style = getComputedStyle(button);
              const rect = button.getBoundingClientRect();
              return style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0;
            })
          : false;
        const stopVisible = Array.from(document.querySelectorAll('[data-testid="stop-button"]')).some((button) => {
          const style = getComputedStyle(button);
          const rect = button.getBoundingClientRect();
          return style.display !== 'none'
            && style.visibility !== 'hidden'
            && rect.width > 0
            && rect.height > 0;
        });
        return { count: turns.length, text, stopVisible, completionActionVisible };
      })()`, true);
      const complete = outcome.count > beforeAssistantCount
        && outcome.text === SMOKE_EXPECTED
        && !outcome.stopVisible
        && outcome.completionActionVisible;
      if (!complete) {
        completionCandidate = null;
      } else if (completionCandidate?.text !== outcome.text) {
        completionCandidate = { text: outcome.text, since: Date.now() };
      } else if (Date.now() - completionCandidate.since >= SMOKE_COMPLETION_SETTLE_MS) {
        this.logger.info("smoke.completed", { responseChars: outcome.text.length });
        this.setState({ status: "ready", message: "Smoke test passed", authenticated: true });
        return { ok: true, effort: effortResult.effort, response: SMOKE_EXPECTED };
      }
      await sleep(500);
    }
    this.logger.error("smoke.timed_out");
    this.setState({ status: "error", message: "Smoke test timed out" });
    throw new Error("ChatGPT smoke test timed out before the expected answer appeared");
  }

  async pressTrustedBrowserKey(key) {
    try {
      await this.dispatchTrustedKey({
        debuggerClient: this.view.webContents.debugger,
        key,
      });
    } catch (error) {
      throw new Error(
        `ChatGPT trusted browser key failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async evaluateBrowserPage(expression) {
    const contents = this.view.webContents;
    try {
      return await this.evaluatePage({
        debuggerClient: contents.debugger,
        expression,
      });
    } catch (error) {
      throw new Error(
        `ChatGPT page inspection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  pressBrowserKey(keyCode) {
    const contents = this.view.webContents;
    contents.sendInputEvent({ type: "keyDown", keyCode });
    contents.sendInputEvent({ type: "keyUp", keyCode });
  }

  pressBrowserShortcut(keyCode, modifiers) {
    const contents = this.view.webContents;
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  }

  async focusComposer() {
    return await this.view.webContents.executeJavaScript(`(() => {
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      if (!composer) return false;
      composer.focus({ preventScroll: true });
      return document.activeElement === composer || composer.contains(document.activeElement);
    })()`, true);
  }

  async readComposerText() {
    return await this.view.webContents.executeJavaScript(`(() => {
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      if (!composer) return null;
      const text = String('value' in composer ? composer.value : composer.innerText || composer.textContent || '')
        .replace(/\\r\\n/g, '\\n');
      return /^\\s*$/.test(text) ? '' : text;
    })()`, true);
  }

  async waitForComposerText(expected, timeoutMs = 10_000, pollMs = 50) {
    const deadline = Date.now() + timeoutMs;
    let actual = null;
    do {
      actual = await this.readComposerText();
      if (actual === expected) return;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT composer did not preserve the expected text`
      + ` (expectedChars=${expected.length}; actualChars=${typeof actual === "string" ? actual.length : "missing"})`,
    );
  }

  async clearFocusedComposer() {
    this.view.webContents.focus();
    this.pressBrowserShortcut("A", [process.platform === "darwin" ? "meta" : "control"]);
    this.pressBrowserKey("Backspace");
    await this.waitForComposerText("");
  }

  async readSmokeSendButton() {
    return await this.evaluateBrowserPage(`(() => {
      /* smoke-send-button-read */
      const button = ${visibleElementScript('[data-testid="send-button"]')};
      if (!button) return { ready: false, reason: 'missing' };
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
        return { ready: false, reason: 'disabled' };
      }
      return { ready: true };
    })()`);
  }

  async waitForSmokeSendButton(timeoutMs = 10_000, pollMs = 100) {
    const deadline = Date.now() + timeoutMs;
    let state;
    do {
      state = await this.readSmokeSendButton();
      if (state.ready) return state;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT send button did not become available for the smoke test`
      + ` (state=${state?.reason || "unknown"})`,
    );
  }

  async focusSmokeSendButton() {
    return await this.evaluateBrowserPage(`(() => {
      /* smoke-send-button-focus */
      const button = ${visibleElementScript('[data-testid="send-button"]')};
      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
      button.focus({ preventScroll: true });
      return document.activeElement === button;
    })()`);
  }

  async readSmokeSubmissionState(beforeUserCount) {
    return await this.evaluateBrowserPage(`(() => {
      /* smoke-submission-read */
      const beforeUserCount = ${beforeUserCount};
      const userTurnCount = document.querySelectorAll(${JSON.stringify(USER_TURN_SELECTOR)}).length;
      const stopVisible = Array.from(document.querySelectorAll('[data-testid="stop-button"]')).some((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return {
        accepted: userTurnCount > beforeUserCount,
        userTurnCount,
        stopVisible,
      };
    })()`);
  }

  async waitForSmokeSubmissionAccepted(
    beforeUserCount,
    timeoutMs = SMOKE_SUBMISSION_TIMEOUT_MS,
    pollMs = 100,
  ) {
    const deadline = Date.now() + timeoutMs;
    let state;
    do {
      state = await this.readSmokeSubmissionState(beforeUserCount);
      if (state.accepted) return state;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT did not accept the smoke-test message after activating the send button`
      + ` (userTurnsBefore=${beforeUserCount}; userTurnsNow=${state?.userTurnCount ?? "unknown"};`
      + ` stopVisible=${state?.stopVisible === true})`,
    );
  }

  async readEffortControl() {
    return this.evaluateBrowserPage(`(() => {
      /* effort-control-read */
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      const form = composer?.closest('form');
      const controls = Array.from(form?.querySelectorAll(
        'button[aria-haspopup="menu"][data-tone="neutral"]'
      ) || []).filter(visible);
      const control = controls.at(-1);
      if (!control) {
        return {
          found: false,
          composer: Boolean(composer),
          form: Boolean(form),
          readyState: document.readyState,
          url: location.href,
        };
      }
      return {
        found: true,
        label: normalize(control.innerText || control.textContent),
        expanded: control.getAttribute('aria-expanded'),
        composer: Boolean(composer),
        form: true,
        readyState: document.readyState,
        url: location.href,
      };
    })()`);
  }

  async focusEffortControl() {
    return await this.evaluateBrowserPage(`(() => {
      /* effort-control-focus */
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      const form = composer?.closest('form');
      const controls = Array.from(form?.querySelectorAll(
        'button[aria-haspopup="menu"][data-tone="neutral"]'
      ) || []).filter(visible);
      const control = controls.at(-1);
      if (!control) return false;
      control.focus({ preventScroll: true });
      return document.activeElement === control;
    })()`);
  }

  async waitForEffortControl(timeoutMs, pollMs) {
    const deadline = Date.now() + timeoutMs;
    let control;
    do {
      control = await this.readEffortControl();
      if (control.found) return control;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT effort control did not become ready`
      + ` (url=${control?.url || this.view.webContents.getURL()};`
      + ` document=${control?.readyState || "unknown"}; composer=${control?.composer ? "ready" : "missing"};`
      + ` composerForm=${control?.form ? "ready" : "missing"})`,
    );
  }

  async readEffortMenu(targetIndex) {
    return await this.evaluateBrowserPage(`(() => {
        /* effort-menu-read */
        const targetIndex = ${targetIndex};
        const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
        const control = Array.from(composer?.closest('form')?.querySelectorAll(
          'button[aria-haspopup="menu"][data-tone="neutral"]'
        ) || []).filter(visible).at(-1);
        const controlledId = control?.getAttribute('aria-controls');
        const controlled = controlledId ? document.getElementById(controlledId) : null;
        const roots = [
          ...(controlled ? [controlled] : []),
          ...Array.from(document.querySelectorAll(${JSON.stringify(EFFORT_MENU_SELECTOR)})),
        ];
        const candidates = [...new Set(roots)].filter(visible).map((menu) => ({
          menu,
          items: Array.from(menu.querySelectorAll('[role="menuitemradio"]')).filter(visible),
        })).filter(candidate => candidate.items.length > 0)
          .sort((left, right) => right.items.length - left.items.length);
        const candidate = candidates[0];
        const target = candidate?.items[targetIndex];
        if (!candidate || !target) {
          return { open: Boolean(candidate), count: candidate?.items.length || 0, target: null };
        }
        return {
          open: true,
          count: candidate.items.length,
          target: {
            label: normalize(target.innerText || target.textContent),
            checked: target.getAttribute('aria-checked'),
          },
        };
      })()`);
  }

  async focusEffortMenuItem(targetIndex) {
    return await this.evaluateBrowserPage(`(() => {
      /* effort-menu-focus */
      const targetIndex = ${targetIndex};
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const composer = ${visibleElementScript(COMPOSER_SELECTOR)};
      const control = Array.from(composer?.closest('form')?.querySelectorAll(
        'button[aria-haspopup="menu"][data-tone="neutral"]'
      ) || []).filter(visible).at(-1);
      const controlledId = control?.getAttribute('aria-controls');
      const controlled = controlledId ? document.getElementById(controlledId) : null;
      const roots = [
        ...(controlled ? [controlled] : []),
        ...Array.from(document.querySelectorAll(${JSON.stringify(EFFORT_MENU_SELECTOR)})),
      ];
      const candidates = [...new Set(roots)].filter(visible).map((menu) => (
        Array.from(menu.querySelectorAll('[role="menuitemradio"]')).filter(visible)
      )).filter(items => items.length > 0)
        .sort((left, right) => right.length - left.length);
      const target = candidates[0]?.[targetIndex];
      if (!target) return false;
      target.focus({ preventScroll: true });
      return document.activeElement === target;
    })()`);
  }

  async openEffortMenu(targetIndex, timeoutMs, pollMs, knownControl) {
    const control = knownControl?.found ? knownControl : await this.readEffortControl();
    if (!control.found) {
      throw new Error("ChatGPT effort control disappeared before its menu could open");
    }
    if (control.expanded !== "true") {
      if (!await this.focusEffortControl()) {
        throw new Error("ChatGPT effort control could not receive focus");
      }
      await this.pressTrustedBrowserKey("Enter");
    }
    return await this.waitForEffortMenu(targetIndex, timeoutMs, pollMs);
  }

  async chooseEffortMenuItem(targetIndex) {
    if (!await this.focusEffortMenuItem(targetIndex)) {
      throw new Error(`ChatGPT effort item index ${targetIndex} could not receive focus`);
    }
    await this.pressTrustedBrowserKey("Enter");
  }

  async waitForEffortMenu(targetIndex, timeoutMs, pollMs) {
    const deadline = Date.now() + timeoutMs;
    let menu;
    do {
      menu = await this.readEffortMenu(targetIndex);
      if (menu.target) return menu;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT effort menu did not expose item index ${targetIndex}`
      + ` (open=${menu?.open === true}; itemCount=${menu?.count || 0})`,
    );
  }

  async selectHighEffort({
    readyTimeoutMs = 70_000,
    optionTimeoutMs = 70_000,
    confirmTimeoutMs = 40_000,
    pollMs = 200,
  } = {}) {
    const targetIndex = 2;
    const control = await this.waitForEffortControl(readyTimeoutMs, pollMs);
    let menu = await this.readEffortMenu(targetIndex);
    if (!menu.target) {
      menu = menu.open || control.expanded === "true"
        ? await this.waitForEffortMenu(targetIndex, optionTimeoutMs, pollMs)
        : await this.openEffortMenu(targetIndex, optionTimeoutMs, pollMs, control);
    }
    if (menu.target.checked !== "true" && menu.target.checked !== "false") {
      throw new Error(`ChatGPT effort item index ${targetIndex} has no semantic checked state`);
    }
    if (menu.target.checked === "true") {
      this.pressBrowserKey("Escape");
      return { effort: "High", changed: false };
    }
    await this.chooseEffortMenuItem(targetIndex);

    const deadline = Date.now() + confirmTimeoutMs;
    let confirmed = menu;
    do {
      confirmed = await this.readEffortMenu(targetIndex);
      if (!confirmed.target) {
        const current = await this.readEffortControl();
        if (current.found) {
          confirmed = await this.openEffortMenu(
            targetIndex,
            Math.max(1, Math.min(5_000, deadline - Date.now())),
            pollMs,
            current,
          );
        }
      }
      if (confirmed.target?.checked === "true") {
        this.pressBrowserKey("Escape");
        return { effort: "High", changed: true };
      }
      if (confirmed.target && confirmed.target.checked !== "false") {
        throw new Error(`ChatGPT effort item index ${targetIndex} lost its semantic checked state`);
      }
      await sleep(pollMs);
    } while (Date.now() < deadline);
    throw new Error(
      `ChatGPT did not confirm effort item index ${targetIndex}`
      + ` (aria-checked=${JSON.stringify(confirmed?.target?.checked ?? null)})`,
    );
  }

  async assistantTurnCount() {
    return this.view.webContents.executeJavaScript(
      `document.querySelectorAll(${JSON.stringify(ASSISTANT_TURN_SELECTOR)}).length`,
      true,
    );
  }

  async userTurnCount() {
    return this.view.webContents.executeJavaScript(
      `document.querySelectorAll(${JSON.stringify(USER_TURN_SELECTOR)}).length`,
      true,
    );
  }

  async verifyConnector(appName) {
    return await this.withManualOperation("connector verification", () => this.runConnectorVerification(appName));
  }

  async runConnectorVerification(appName) {
    if (typeof appName !== "string" || !appName.trim() || appName.length > 80) {
      throw new Error("Connector name is invalid");
    }
    const connectorName = appName.trim();
    this.setState({ status: "testing", message: "Checking ChatGPT connector" });
    if (!isTemporaryChatUrl(this.view.webContents.getURL())) {
      await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
    }
    await this.waitForAuthenticated(60_000);
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

  async inspectSession(detectPro = false) {
    return await this.withManualOperation("session inspection", () => this.runSessionInspection(detectPro));
  }

  async runSessionInspection(detectPro = false) {
    const initialUrl = this.view.webContents.getURL();
    const startedIdle = initialUrl === IDLE_BROWSER_URL;
    if (!isTemporaryChatUrl(initialUrl)) await this.view.webContents.loadURL(TEMPORARY_CHAT_URL);
    const state = await this.probeAuthentication();
    if (!state.authenticated) {
      throw new Error("The embedded ChatGPT session is not authenticated");
    }
    const url = this.view.webContents.getURL();
    const parsed = new URL(url);
    if (parsed.origin !== CHATGPT_ORIGIN || parsed.searchParams.get("temporary-chat") !== "true") {
      throw new Error(`The embedded browser is not on Temporary Chat (${url})`);
    }
    let proAvailable;
    if (detectPro) {
      const control = await this.waitForEffortControl(30_000, 200);
      let menu = await this.readEffortMenu(0);
      if (!menu.target) {
        menu = menu.open || control.expanded === "true"
          ? await this.waitForEffortMenu(0, 70_000, 200)
          : await this.openEffortMenu(0, 70_000, 200, control);
      }
      proAvailable = menu.count >= 5;
      this.pressBrowserKey("Escape");
    }
    if (startedIdle) await this.returnToIdle();
    return { authenticated: true, temporary: true, url, ...(detectPro ? { proAvailable } : {}) };
  }

  async withManualOperation(name, action) {
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

  destroy() {
    try {
      const current = JSON.parse(fs.readFileSync(this.descriptorPath, "utf8"));
      if (current.pid === process.pid) fs.rmSync(this.descriptorPath, { force: true });
    } catch {}
    this.closeAuthView(this.authView, true);
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
  isTemporaryChatUrl,
  TEMPORARY_CHAT_URL,
};
