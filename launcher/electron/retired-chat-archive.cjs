const { runBrowserPageScript } = require("./browser-page-script.cjs");

function savedChatUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com" || url.username || url.password
      || !/^\/c\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/?$/i.test(url.pathname)) return null;
    return url.origin + url.pathname.replace(/\/$/, "");
  } catch { return null; }
}

// Runs only in an exact, retired launcher document. No account API or history scan.
async function archiveChatUi({ url, surfaceId, verifyOnly }) {
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
  const single = nodes => {
    if (nodes.length > 1) throw new Error("archive_controls_ambiguous");
    return nodes[0];
  };
  // Full navigation can complete before ChatGPT hydrates its conversation header.
  const trigger = await waitFor(() => single([...document.querySelectorAll('main [data-testid="app-shell-header-context-menu-surface"] button[aria-label="Chat actions"]')].filter(visible)), 2000);
  if (!ownsDocument()) throw new Error("archive_document_changed_after_header");
  if (!trigger) throw new Error("archive_controls_unavailable");
  const readChoice = () => single([...document.querySelectorAll('[role="menuitem"]')]
    .filter(visible).filter(node => ["Archive", "Unarchive"].includes(node.textContent.trim())));
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  let choice = await waitFor(readChoice, 150);
  if (!choice) { trigger.click(); choice = await waitFor(readChoice, 2000); }
  if (!ownsDocument()) throw new Error("archive_document_changed_after_menu");
  if (!choice) throw new Error("archive_controls_unavailable");
  if (choice.textContent.trim() === "Unarchive") return { status: "archived" };
  if (verifyOnly) throw new Error("archive_not_persisted");
  // This is the only mutation. Never choose Delete or a sidebar conversation.
  choice.click();
  // The observed interface returns to Home after the mutation is acknowledged.
  // Navigating immediately could abort the archive request before it is saved.
  await new Promise((resolve, reject) => {
    let observer, timer;
    const finish = error => {
      observer?.disconnect(); clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const read = () => {
      if (location.origin === "https://chatgpt.com" && location.pathname === "/") { finish(); return true; }
      return false;
    };
    if (read()) return;
    observer = new MutationObserver(read);
    observer.observe(document.documentElement, { subtree: true, childList: true });
    timer = setTimeout(() => {
      if (!read()) finish(new Error("archive_acknowledgement_timeout"));
    }, 3000);
  });
  return { status: "submitted" };
}

async function archiveDocument(tab) {
  const contents = tab.view.webContents;
  const url = tab.archiveConversationUrl;
  const check = () => {
    if (!contents || contents.isDestroyed() || savedChatUrl(contents.getURL()) !== url) throw new Error("archive_document_changed");
  };
  check();
  const script = verifyOnly => "(" + archiveChatUi.toString() + ")(" + JSON.stringify({ url, surfaceId: tab.surfaceId, verifyOnly }) + ")";
  const first = await runBrowserPageScript(contents, script(false), 8000);
  if (first?.status === "archived") return;
  // Reopen the exact saved URL to verify server-persisted Unarchive state. An
  // optimistic menu update or disappearing sidebar row alone is not success.
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      contents.off("destroyed", gone);
      if (error) reject(error); else resolve();
    };
    const gone = () => done(new Error("archive_browser_closed"));
    const timer = setTimeout(() => done(new Error("archive_verification_timeout")), 5000);
    contents.once("destroyed", gone);
    Promise.resolve(contents.loadURL(url)).then(() => done(), done);
  });
  check();
  // Navigation replaces the document marker. The view remains privately owned
  // by this cleanup job and cannot be acquired by a helper or selected in the UI.
  // Keep ownership establishment and verification in one renderer operation.
  // A late navigation between separate IPC calls can otherwise discard the
  // marker after it was installed, falsely reporting a successful archive as a failure.
  const verified = await runBrowserPageScript(contents, "(() => {"
    + "if(location.origin+location.pathname.replace(/\\/$/,'')!==" + JSON.stringify(url)
    + ")throw new Error('archive_document_changed_before_verification');"
    + "Object.defineProperty(globalThis,'__CODEX_WEB_GPT_SURFACE_ID__',{value:"
    + JSON.stringify(tab.surfaceId) + ",configurable:true});return " + script(true) + ";})()", 5000);
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
        await this.archive(tab);
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

module.exports = { savedChatUrl, archiveChatUi, archiveDocument, RetiredChatArchiver };
