const { runBrowserPageScript } = require("./browser-page-script.cjs");

function savedChatUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com" || url.username || url.password
      || !/^\/c\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/?$/i.test(url.pathname)) return null;
    return url.origin + url.pathname.replace(/\/$/, "");
  } catch { return null; }
}

// Observe only the request produced by the normal Archive menu. Do not issue an
// account request, replace fetch, inspect headers, or guess an API endpoint.
// The archive payload's is_archived flag is also used by the installed ChatGPT
// client. Page navigation and sidebar removal happen optimistically before ACK.
async function observeArchiveAcknowledgement(contents, url) {
  const client = contents.debugger;
  if (!client || client.isAttached()) throw new Error("archive_observer_unavailable");
  const conversationId = new URL(url).pathname.split("/").at(-1);
  const requests = new Map();
  const listeners = new Set();
  let attached = false;
  const changed = () => { for (const notify of listeners) notify(); };
  const detached = () => { attached = false; changed(); };
  const message = (_event, method, params) => {
    if (!params || typeof params !== "object") return;
    if (method === "Network.requestWillBeSent") {
      try {
        const request = params.request, target = new URL(request.url);
        if (target.origin !== "https://chatgpt.com" || !["PATCH", "POST", "PUT"].includes(request.method)
          || !target.pathname.split("/").some(part => decodeURIComponent(part) === conversationId)) return;
        const body = JSON.parse(request.postData || "null");
        if (!body || body.is_archived !== true || !Number.isFinite(params.wallTime)) return;
        if (requests.size >= 16) requests.delete(requests.keys().next().value);
        requests.set(params.requestId, { at: params.wallTime * 1000, status: null, finished: false, failed: false });
      } catch {}
    } else {
      const record = requests.get(params.requestId);
      if (!record) return;
      if (method === "Network.responseReceived" && Number.isFinite(params.response?.status)) record.status = params.response.status;
      if (method === "Network.loadingFinished") record.finished = true;
      if (method === "Network.loadingFailed") record.failed = true;
    }
    changed();
  };
  const close = () => {
    client.off("message", message); client.off("detach", detached);
    try { if (attached && client.isAttached()) client.detach(); } catch {}
    attached = false;
  };
  try {
    client.attach("1.3"); attached = true;
    client.on("message", message); client.on("detach", detached);
    await client.sendCommand("Network.enable");
  } catch { close(); throw new Error("archive_observer_unavailable"); }
  return { close, wait: (actionAt, timeoutMs = 10000) => new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer); listeners.delete(read);
      if (error) reject(error); else resolve();
    };
    const read = () => {
      if (!attached) { finish(new Error("archive_observer_lost")); return true; }
      const matching = [...requests.values()].filter(record => record.at >= actionAt);
      if (matching.some(record => record.finished && record.status >= 200 && record.status < 300)) { finish(); return true; }
      if (matching.some(record => record.failed || (record.status !== null && (record.status < 200 || record.status >= 300)))) {
        finish(new Error("archive_request_rejected")); return true;
      }
      return false;
    };
    if (!Number.isFinite(actionAt)) { finish(new Error("archive_acknowledgement_missing")); return; }
    if (read()) return;
    listeners.add(read);
    timer = setTimeout(() => finish(new Error("archive_acknowledgement_timeout")), timeoutMs);
  }) };
}

// Runs only in an exact, retired launcher document. No account API or history scan.
async function archiveChatUi({ url, surfaceId, verifyOnly, settleTimeoutMs = 30000 }) {
  const ownsDocument = () => location.origin + location.pathname.replace(/\/$/, "") === url
    && globalThis.__CODEX_WEB_GPT_SURFACE_ID__ === surfaceId;
  if (!ownsDocument()) throw new Error("archive_document_changed_before_header");
  const visible = node => node.getClientRects().length > 0
    && getComputedStyle(node).visibility !== "hidden"
    && !node.disabled && node.getAttribute("aria-disabled") !== "true";
  if ([...document.querySelectorAll('[role="menu"]')].some(visible)) throw new Error("archive_menu_already_open");
  const waitFor = (readValue, timeout) => new Promise((resolve, reject) => {
    let observer, timer;
    const finish = (error, value) => {
      observer?.disconnect(); clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const read = () => {
      try {
        const found = readValue();
        if (found) { finish(null, found); return true; }
      } catch (error) { finish(error); return true; }
      return false;
    };
    if (read()) return;
    observer = new MutationObserver(read);
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    timer = setTimeout(() => finish(null, null), timeout);
  });
  // Native handoff acceptance is durable before ChatGPT necessarily finishes
  // rendering the old response. Never operate its menu while generation is active.
  // Match the composer's observed Stop glyph as in src/chatgpt-session.ts;
  // some ChatGPT layouts omit the stop-button test ID.
  const stopGlyph = "M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z";
  const stopSelector = '[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"], '
    + 'form[data-chatgpt-composer] button[type="button"].size-token-button-composer:has(svg.icon-primary-action > path[d="' + stopGlyph + '"])';
  const userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
  const single = nodes => {
    if (nodes.length > 1) throw new Error("archive_controls_ambiguous");
    return nodes[0];
  };
  // Full navigation can complete before ChatGPT hydrates its conversation header.
  const trigger = await waitFor(() => single([...document.querySelectorAll('main [data-testid="app-shell-header-context-menu-surface"] button[aria-label="Chat actions"]')].filter(visible)), 2000);
  if (!ownsDocument()) throw new Error("archive_document_changed_after_header");
  if (!trigger) throw new Error("archive_controls_unavailable");
  const quiet = await waitFor(() => {
    if (!ownsDocument()) throw new Error("archive_document_changed_while_settling");
    if (!verifyOnly && document.querySelectorAll('[data-message-author-role="user"]').length !== userCount) throw new Error("archive_user_turn_changed");
    return ![...document.querySelectorAll(stopSelector)].some(visible);
  }, settleTimeoutMs);
  if (!quiet) return { status: "skipped", code: "archive_generation_active" };
  const readChoice = () => single([...document.querySelectorAll('[role="menuitem"]')]
    .filter(visible).filter(node => ["Archive", "Unarchive"].includes(node.textContent.trim())));
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  let choice = await waitFor(readChoice, 150);
  if (!choice) { trigger.click(); choice = await waitFor(readChoice, 2000); }
  if (!ownsDocument()) throw new Error("archive_document_changed_after_menu");
  if (!choice) throw new Error("archive_controls_unavailable");
  if (choice.textContent.trim() === "Unarchive") return { status: "archived" };
  if (verifyOnly) {
    // The header/menu can render with default archive metadata before the
    // saved conversation hydrates. Read only: never click Archive again or
    // treat a successful mutation ACK as proof of persisted account state.
    const persisted = await waitFor(() => {
      if (!ownsDocument()) throw new Error("archive_document_changed_while_verifying");
      return readChoice()?.textContent.trim() === "Unarchive";
    }, 10000);
    if (!persisted) throw new Error("archive_not_persisted");
    return { status: "archived" };
  }
  if ([...document.querySelectorAll(stopSelector)].some(visible)) return { status: "skipped", code: "archive_generation_active" };
  if (!verifyOnly && document.querySelectorAll('[data-message-author-role="user"]').length !== userCount) throw new Error("archive_user_turn_changed");
  // This is the only mutation. Never choose Delete or a sidebar conversation.
  const actionAt = Date.now();
  choice.click();
  return { status: "submitted", actionAt };
}

async function archiveDocument(tab) {
  const contents = tab.view.webContents;
  const url = tab.archiveConversationUrl;
  const locationKind = () => {
    try {
      const current = new URL(contents.getURL());
      if (current.origin !== "https://chatgpt.com") return "foreign";
      if (current.pathname === "/") return "home";
      if (current.pathname.startsWith("/c/local-chatgpt")) return "local";
      return savedChatUrl(current.href) ? "saved" : "other";
    } catch { return "unavailable"; }
  };
  const check = phase => {
    if (!contents || contents.isDestroyed() || savedChatUrl(contents.getURL()) !== url) throw new Error("archive_location_" + locationKind() + "_" + phase);
  };
  check("before_action");
  const script = verifyOnly => "(" + archiveChatUi.toString() + ")(" + JSON.stringify({ url, surfaceId: tab.surfaceId, verifyOnly }) + ")";
  const acknowledgement = await observeArchiveAcknowledgement(contents, url);
  let first;
  try {
    first = await runBrowserPageScript(contents, script(false), 35000);
    if (first?.status === "archived" || first?.status === "skipped") return first;
    // Home is an optimistic transition. Reloading before this matching mutation
    // finishes can abort the UI's request and discard an otherwise valid archive.
    await acknowledgement.wait(first?.actionAt);
  } finally { acknowledgement.close(); }
  // Reopen the exact saved URL to verify server-persisted Unarchive state. An
  // optimistic menu update or disappearing sidebar row alone is not success.
  await new Promise((resolve, reject) => {
    let settled = false, loadSettled = false;
    const done = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      contents.off("destroyed", gone);
      for (const name of ["did-navigate", "did-navigate-in-page", "did-stop-loading"]) contents.off(name, ready);
      if (error) reject(error); else resolve();
    };
    const gone = () => done(new Error("archive_browser_closed"));
    const ready = () => {
      if (loadSettled && savedChatUrl(contents.getURL()) === url
        && (typeof contents.isLoadingMainFrame !== "function" || !contents.isLoadingMainFrame())) done();
    };
    const timer = setTimeout(() => done(new Error("archive_location_" + locationKind() + "_after_reopen")), 5000);
    contents.once("destroyed", gone);
    for (const name of ["did-navigate", "did-navigate-in-page", "did-stop-loading"]) contents.on(name, ready);
    Promise.resolve().then(() => contents.loadURL(url)).then(() => { loadSettled = true; ready(); }, done);
  });
  check("after_reopen");
  // Navigation replaces the document marker. The view remains privately owned
  // by this cleanup job and cannot be acquired by a helper or selected in the UI.
  // Keep ownership establishment and verification in one renderer operation.
  // A late navigation between separate IPC calls can otherwise discard the
  // marker after it was installed, falsely reporting a successful archive as a failure.
  const verified = await runBrowserPageScript(contents, "(() => {"
    + "if(location.origin+location.pathname.replace(/\\/$/,'')!==" + JSON.stringify(url)
    + ")throw new Error('archive_document_changed_before_verification');"
    + "Object.defineProperty(globalThis,'__CODEX_WEB_GPT_SURFACE_ID__',{value:"
    + JSON.stringify(tab.surfaceId) + ",configurable:true});return " + script(true) + ";})()", 15000);
  if (verified?.status !== "archived") throw new Error("archive_not_verified");
}

class RetiredChatArchiver {
  constructor({ enabled, conflicts, logger, archive = archiveDocument, now = Date.now }) {
    Object.assign(this, { enabled, conflicts, logger, archive, now });
    this.jobs = new Set();
    this.tail = Promise.resolve();
    this.cooldownUntil = 0;
    this.destroyed = false;
  }

  retire(tab) {
    const contents = tab.view?.webContents;
    const url = savedChatUrl(tab.archiveConversationUrl);
    if (this.destroyed || !this.enabled() || tab.interactionMode !== "automatic"
      || tab.status !== "ready" || tab.failedAt !== undefined || tab.authenticationRequired
      || tab.archiveOwnershipLost || !url || contents?.isDestroyed() !== false
      || savedChatUrl(contents.getURL()) !== url || this.conflicts(url)) return false;
    if (this.jobs.size >= 2 || this.now() < this.cooldownUntil) {
      this.logger.info("browser.retired_chat_archive_skipped", {
        tabId: tab.id, traceId: tab.traceId,
        code: this.jobs.size >= 2 ? "archive_queue_full" : "archive_cooldown",
      });
      return false;
    }
    const job = { tab, url };
    this.jobs.add(job);
    this.tail = this.tail.catch(() => {}).then(async () => {
      try {
        if (this.destroyed || !this.enabled() || this.conflicts(url) || this.now() < this.cooldownUntil) return;
        const result = await this.archive(tab);
        if (result?.status === "skipped") {
          this.logger.info("browser.retired_chat_archive_skipped", { tabId: tab.id, traceId: tab.traceId, code: result.code });
          return;
        }
        this.logger.info("browser.retired_chat_archived", { tabId: tab.id, traceId: tab.traceId });
      } catch (error) {
        // This timestamp is checked only by future retirement events. No retry
        // timer, model invocation, account-wide archive request, or wakeup exists.
        this.cooldownUntil = this.now() + 5 * 60_000;
        this.logger.warn("browser.retired_chat_archive_failed", {
          tabId: tab.id, traceId: tab.traceId,
          code: /^archive_[a-z_]+$/.test(error?.message) ? error.message : "archive_ui_unavailable",
        });
      } finally {
        this.jobs.delete(job);
        try { if (!contents.isDestroyed()) contents.close(); } catch {}
      }
    });
    return true;
  }

  destroy() {
    this.destroyed = true;
    for (const { tab } of this.jobs) {
      try { tab.view.webContents.close(); } catch {}
    }
  }
}

module.exports = { savedChatUrl, archiveChatUi, archiveDocument, observeArchiveAcknowledgement, RetiredChatArchiver };
