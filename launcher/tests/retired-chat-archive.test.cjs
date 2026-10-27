const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { savedChatUrl, archiveChatUi, archiveDocument, observeArchiveAcknowledgement, RetiredChatArchiver } = require("../electron/retired-chat-archive.cjs");
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

test("archive ACK observes only this UI mutation and never detaches another debugger", async () => {
  function protocol(busy = false) {
    let active = busy;
    const client = Object.assign(new EventEmitter(), { isAttached: () => active,
      attach() { active = true; }, async sendCommand(method) { assert.equal(method, "Network.enable"); },
      detach() { client.detachCount++; active = false; }, externalAttach() { active = true; },
      detachCount: 0 });
    const send = (method, params) => client.emit("message", {}, method, params);
    const request = (id, at, changes = {}) => send("Network.requestWillBeSent", {
      requestId: id, wallTime: at / 1000,
      request: { method: "PATCH", url: URL.replace("/c/", "/fixture/"), postData: JSON.stringify({ is_archived: true }), ...changes },
    });
    return { client, send, request };
  }
  const busy = protocol(true);
  await assert.rejects(observeArchiveAcknowledgement({ debugger: busy.client }, URL), /archive_observer_unavailable/);
  assert.equal(busy.client.detachCount, 0);
  const p = protocol(), actionAt = Date.now();
  const observation = await observeArchiveAcknowledgement({ debugger: p.client }, URL);
  let resolved = false;
  const acknowledged = observation.wait(actionAt, 500).then(() => { resolved = true; });
  for (const [id, at, change] of [
    ["old", actionAt - 100, {}], ["foreign", actionAt + 1, { url: URL.replace("chatgpt.com", "example.com") }],
    ["wrong", actionAt + 1, { url: URL.replace("11111111", "99999999") }],
    ["read", actionAt + 1, { method: "GET" }], ["unarchive", actionAt + 1, { postData: '{"is_archived":false}' }],
  ]) {
    p.request(id, at, change); p.send("Network.responseReceived", { requestId: id, response: { status: 200 } });
    p.send("Network.loadingFinished", { requestId: id });
  }
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false);
  p.request("actual", actionAt + 1); p.send("Network.responseReceived", { requestId: "actual", response: { status: 200 } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(resolved, false, "headers alone are not committed response completion");
  p.send("Network.loadingFinished", { requestId: "actual" }); await acknowledged;
  observation.close(); assert.equal(p.client.detachCount, 1);
  const rejected = protocol(), rejectedObservation = await observeArchiveAcknowledgement({ debugger: rejected.client }, URL);
  const failure = rejectedObservation.wait(actionAt, 500);
  rejected.request("bad", actionAt + 1); rejected.send("Network.responseReceived", { requestId: "bad", response: { status: 500 } });
  await assert.rejects(failure, /archive_request_rejected/); rejectedObservation.close();
  const lost = protocol(), lostObservation = await observeArchiveAcknowledgement({ debugger: lost.client }, URL);
  const lostWait = lostObservation.wait(actionAt, 500);
  lost.send("irrelevant", {}); lost.client.emit("detach");
  await assert.rejects(lostWait, /archive_observer_lost/);
  lost.client.externalAttach(); lostObservation.close(); assert.equal(lost.client.detachCount, 0);
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

test("a still-generating retired page skips without cooling down later retirements", async () => {
  const { archiver, events } = fixture({ archive: async () => ({ status: "skipped", code: "archive_generation_active" }) });
  const item = tab(); assert.equal(archiver.retire(item), true); await archiver.tail;
  assert.equal(item.view.webContents.isDestroyed(), true);
  assert.equal(archiver.cooldownUntil, 0);
  assert.equal(events[0].event, "browser.retired_chat_archive_skipped");
  assert.equal(archiver.retire(tab({ id: "next" })), true); await archiver.tail;
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
    for (const [persist, replaceVerificationDocument, lateNavigation, delayedArchiveMetadata] of [[true, false, false], [false, false, false], [true, true, false], [true, false, true], [true, false, false, true]]) {
      const page = await browser.newPage();
      let loads = 0, replaceAfterNextCheck = false, reportedUrl;
      function renderFixture({ archived, persist, delayedArchiveMetadata }) {
        // A saved chat's header can hydrate before its archived metadata. The
        // first menu must not be treated as a settled server-state readback.
        let metadataReady = !delayedArchiveMetadata;
        setTimeout(() => {
          metadataReady = true;
          const choice = document.querySelector('[data-archive-choice]');
          if (choice && archived) choice.textContent = "Unarchive";
        }, 500);
        const stopControl = document.createElement("button");
        stopControl.dataset.testid = "stop-button"; stopControl.textContent = "Stop";
        document.querySelector("main").append(stopControl);
        setTimeout(() => {
          const user = document.createElement("article"); user.dataset.messageAuthorRole = "user";
          user.textContent = "existing saved user turn"; document.querySelector("main").append(user);
        }, 80);
        setTimeout(() => stopControl.remove(), 150);
        setTimeout(() => {
          const header = document.createElement("header");
          header.dataset.testid = "app-shell-header-context-menu-surface";
          const trigger = document.createElement("button");
          trigger.setAttribute("aria-label", "Chat actions"); trigger.textContent = "Actions";
          trigger.addEventListener("keydown", event => {
            if (event.key !== "Enter") return;
            const menu = document.createElement("div"); menu.role = "menu";
            const choice = document.createElement("button"); choice.role = "menuitem";
            choice.dataset.archiveChoice = "true";
            choice.textContent = archived && metadataReady ? "Unarchive" : "Archive";
            choice.onclick = () => {
              if (document.querySelector('[data-testid="stop-button"]')) throw Error("generation active");
              void fetch("/fixture/11111111-2222-3333-4444-555555555555", {
                method: "PATCH", headers: { "content-type": "application/json" },
                body: JSON.stringify({ is_archived: true }),
              }).catch(() => {});
              // The UI removes the conversation before the request is committed.
              history.pushState(null, "", "/"); menu.remove();
            };
            menu.append(choice); document.body.append(menu);
          });
          header.append(trigger); document.querySelector("main").append(header);
        }, 30);
      }
      await page.route("https://chatgpt.com/**", async route => {
        if (new globalThis.URL(route.request().url()).pathname.startsWith("/fixture/")) {
          await new Promise(resolve => setTimeout(resolve, 60));
          await route.fulfill({ status: 200, body: "ok", headers: persist ? { "set-cookie": "fixtureArchived=yes;path=/" } : {} }).catch(() => {});
          return;
        }
        const archived = (route.request().headers().cookie || "").includes("fixtureArchived=yes");
        await route.fulfill({ contentType: "text/html", body: "<main></main><script>(" + renderFixture.toString()
          + ")(" + JSON.stringify({ archived, persist, delayedArchiveMetadata }) + ");</script>" });
      });
      await page.goto(URL);
      await page.waitForSelector('[data-message-author-role="user"]');
      await page.evaluate(() => { globalThis.__CODEX_WEB_GPT_SURFACE_ID__ = "surface"; });
      const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, isCrashed: () => false,
        setBackgroundThrottling: allowed => assert.equal(allowed, false),
        getURL: () => reportedUrl || page.url(), executeJavaScript: async script => {
          const result = await page.evaluate(script);
          // A late navigation can replace the document between two IPC checks.
          // Ownership establishment and the persisted-state check must be one operation.
          if (replaceAfterNextCheck) { replaceAfterNextCheck = false; await page.reload(); }
          return result;
        },
        loadURL: async url => { loads++; assert.equal(url, URL); await page.goto(url); replaceAfterNextCheck = replaceVerificationDocument;
          if (lateNavigation) { reportedUrl = "https://chatgpt.com/"; setTimeout(() => { reportedUrl = page.url(); contents.emit("did-stop-loading"); }, 20); } } });
      const protocol = await page.context().newCDPSession(page);
      let debugging = false;
      contents.debugger = Object.assign(new EventEmitter(), {
        isAttached: () => debugging,
        attach() { if (debugging) throw Error("already attached"); debugging = true; },
        sendCommand: (method, params) => protocol.send(method, params),
        detach() { debugging = false; void protocol.detach().catch(() => {}); },
      });
      for (const method of ["Network.requestWillBeSent", "Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"]) {
        protocol.on(method, params => contents.debugger.emit("message", {}, method, params));
      }
      const item = tab({ view: { webContents: contents } });
      const verificationOptions = { createVerificationWindow: () => ({ webContents: contents, destroy() {} }) };
      if (persist) await archiveDocument(item, verificationOptions);
      else await assert.rejects(archiveDocument(item, verificationOptions), /archive_not_persisted/);
      assert.equal(loads, 1);
      // A foreign surface is rejected before any menu action.
      await page.evaluate(() => { Object.defineProperty(globalThis, "__CODEX_WEB_GPT_SURFACE_ID__", { value: "foreign", configurable: true }); });
      await assert.rejects(page.evaluate(archiveChatUi, { url: URL, surfaceId: "surface" }), /archive_document_changed/);
      await page.goto(URL);
      await page.evaluate(() => { globalThis.__CODEX_WEB_GPT_SURFACE_ID__ = "surface"; });
      assert.deepEqual(await page.evaluate(archiveChatUi, { url: URL, surfaceId: "surface", settleTimeoutMs: 5 }),
        { status: "skipped", code: "archive_generation_active" });
      await page.close();
    }
  } finally { await browser.close(); }
});

test("detached Electron cleanup hydrates archive metadata without showing a window", { skip: !process.env.CHATGPT_ELECTRON_TEST_BINARY }, async () => {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const path = require("node:path");
  const result = await promisify(execFile)(process.env.CHATGPT_ELECTRON_TEST_BINARY,
    [path.join(__dirname, "fixtures/retired-chat-archive-electron.cjs")], { timeout: 25000 });
  const report = result.stdout.split("\n").filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).find(value => value?.fixture === "retired-chat-archive");
  assert.equal(report?.initialVisibility, "hidden");
  assert.equal(report?.archived, true);
  assert.equal(report?.passed, true);
  assert.equal(report?.windowShown, false);
  assert.equal(report?.mutations, 1, "verification never repeats the archive mutation");
});
