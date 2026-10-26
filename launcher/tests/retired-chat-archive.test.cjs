const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { savedChatUrl, archiveChatUi, archiveDocument, RetiredChatArchiver } = require("../electron/retired-chat-archive.cjs");
const URL = "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555";

function tab(overrides = {}) {
  let closed = false;
  const contents = { isDestroyed: () => closed, getURL: () => URL, close() { closed = true; } };
  return { id: "owned", traceId: "trace123", surfaceId: "surface", status: "ready", interactionMode: "automatic",
    archiveConversationUrl: URL, view: { webContents: contents }, ...overrides };
}
function fixture(options = {}) {
  const events = [], calls = [];
  const archiver = new RetiredChatArchiver({ enabled: () => true, conflicts: () => false,
    logger: { info: (event, detail) => events.push({ event, detail }), warn: (event, detail) => events.push({ event, detail }) },
    archive: async item => calls.push(item.id), ...options });
  return { archiver, events, calls };
}

test("archive targets are canonical exact ChatGPT saved URLs", () => {
  assert.equal(savedChatUrl(URL + "/?x=1#tail"), URL);
  for (const value of [undefined, "https://chatgpt.com/", URL.replace("chatgpt.com", "example.com"),
    URL.replace("https://", "https://user@"), URL.replace("/c/", "/g/"), URL + "/other"]) assert.equal(savedChatUrl(value), null);
});

test("retirement schedules bounded cleanup without waiting for it or invoking a model", async () => {
  let finish;
  const { archiver, calls } = fixture({ archive: async item => { calls.push(item.id); await new Promise(resolve => { finish = resolve; }); } });
  const item = tab();
  assert.equal(archiver.retire(item), true);
  assert.equal(item.view.webContents.isDestroyed(), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [item.id]);
  finish(); await archiver.tail;
  assert.equal(item.view.webContents.isDestroyed(), true);
  assert.equal(archiver.jobs.size, 0);
});

test("disabled, foreign, failed, manual, active, ambiguous and navigated documents never archive", async () => {
  const { archiver, calls } = fixture();
  for (const override of [{ status: "running" }, { status: "error" }, { failedAt: 1 }, { interactionMode: "manual" },
    { authenticationRequired: true }, { archiveOwnershipLost: true }, { archiveConversationUrl: undefined },
    { archiveConversationUrl: URL.replace("11111111", "99999999") }]) assert.equal(archiver.retire(tab(override)), false);
  assert.equal(fixture({ enabled: () => false }).archiver.retire(tab()), false);
  assert.equal(fixture({ conflicts: () => true }).archiver.retire(tab()), false);
  assert.deepEqual(calls, []);
  assert.equal(archiver.jobs.size, 0);
});

test("cleanup failure only suppresses future retirement attempts; it starts no retry timer", async () => {
  let time = 1000, attempts = 0;
  const { archiver, events } = fixture({ now: () => time, archive: async () => { attempts++; throw Error("private account data"); } });
  const first = tab();
  assert.equal(archiver.retire(first), true); await archiver.tail;
  assert.equal(first.view.webContents.isDestroyed(), true);
  assert.equal(archiver.retire(tab()), false);
  time += 600000;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1, "time passing alone does not run cleanup");
  assert.equal(archiver.retire(tab()), true); await archiver.tail;
  assert.equal(attempts, 2);
  assert.equal(events[0].detail.code, "archive_ui_unavailable");
  assert.equal(JSON.stringify(events).includes("private account data"), false);
});

test("at most two retired documents survive and shutdown cancels queued cleanup", async () => {
  let finish;
  const { archiver, calls } = fixture({ archive: async item => { calls.push(item.id); await new Promise(resolve => { finish = resolve; }); } });
  const first = tab({ id: "first" }), second = tab({ id: "second" });
  assert.equal(archiver.retire(first), true);
  assert.equal(archiver.retire(second), true);
  assert.equal(archiver.retire(tab({ id: "third" })), false);
  await new Promise(resolve => setImmediate(resolve));
  archiver.destroy(); finish(); await archiver.tail;
  assert.deepEqual(calls, ["first"]);
  assert.equal(first.view.webContents.isDestroyed(), true);
  assert.equal(second.view.webContents.isDestroyed(), true);
});

test("archive UI uses only the owned header and verifies persistence after reloading the exact chat", { skip: !process.env.CHATGPT_DOM_TEST_BROWSER }, async () => {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    for (const [persist, replaceVerificationDocument] of [[true, false], [false, false], [true, true]]) {
      const page = await browser.newPage();
      let loads = 0, replaceAfterNextCheck = false;
      await page.route("https://chatgpt.com/**", async route => {
        const archived = (route.request().headers().cookie || "").includes("fixtureArchived=yes");
        await route.fulfill({ contentType: "text/html", body: '<main></main><script>setTimeout(()=>{document.querySelector("main").innerHTML='
          + JSON.stringify('<header data-testid="app-shell-header-context-menu-surface"><button aria-label="Chat actions">Actions</button></header>') + ';'
          + 'document.querySelector("button").addEventListener("keydown",e=>{if(e.key!=="Enter")return;const m=document.createElement("div");m.role="menu";const a=document.createElement("button");a.role="menuitem";a.textContent='
          + JSON.stringify(archived ? "Unarchive" : "Archive") + ';a.onclick=()=>{' + (persist ? 'document.cookie="fixtureArchived=yes;path=/";' : '')
          + 'history.pushState(null,"","/");m.remove()};m.append(a);document.body.append(m)});},30);</script>' });
      });
      await page.goto(URL);
      await page.evaluate(() => { globalThis.__CODEX_WEB_GPT_SURFACE_ID__ = "surface"; });
      const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, isCrashed: () => false,
        getURL: () => page.url(), executeJavaScript: async script => {
          const result = await page.evaluate(script);
          // A late navigation can replace the document between two IPC checks.
          // Ownership establishment and the persisted-state check must be one operation.
          if (replaceAfterNextCheck) { replaceAfterNextCheck = false; await page.reload(); }
          return result;
        },
        loadURL: async url => { loads++; assert.equal(url, URL); await page.goto(url); replaceAfterNextCheck = replaceVerificationDocument; } });
      const item = tab({ view: { webContents: contents } });
      if (persist) await archiveDocument(item);
      else await assert.rejects(archiveDocument(item), /archive_not_persisted/);
      assert.equal(loads, 1);
      // A foreign surface is rejected before any menu action.
      await page.evaluate(() => { Object.defineProperty(globalThis, "__CODEX_WEB_GPT_SURFACE_ID__", { value: "foreign", configurable: true }); });
      await assert.rejects(page.evaluate(archiveChatUi, { url: URL, surfaceId: "surface" }), /archive_document_changed/);
      await page.close();
    }
  } finally { await browser.close(); }
});
