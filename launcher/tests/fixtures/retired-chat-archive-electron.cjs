// Fully synthetic HTTPS session; no account, credentials, or external network.
const { app, session, WebContentsView, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { archiveDocument } = require("../../electron/retired-chat-archive.cjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "archive-visibility-fixture-"));
app.setPath("userData", scratch);
let windowShown = false;
app.on("browser-window-created", (_event, window) => window.on("show", () => { windowShown = true; }));
app.whenReady().then(async () => {
  let archived = false, mutations = 0;
  const url = "https://chatgpt.com/c/11111111-2222-3333-4444-555555555555";
  const isolated = session.fromPartition("archive-visibility-fixture");
  // A wrong session must fail locally rather than reach the real service.
  session.defaultSession.protocol.handle("https", () => new Response("wrong fixture session", { status: 403 }));
  isolated.protocol.handle("https", async request => {
    if (new URL(request.url).pathname.startsWith("/fixture/")) {
      await new Promise(resolve => setTimeout(resolve, 100));
      archived = true; mutations++;
      return new Response("ok");
    }
    function render(isArchived) {
      let hydrated = false;
      const hydrate = () => {
        if (document.visibilityState !== "visible") return;
        hydrated = true;
        const choice = document.querySelector('[role="menuitem"]');
        if (choice && isArchived) choice.textContent = "Unarchive";
      };
      document.addEventListener("visibilitychange", hydrate);
      setTimeout(hydrate, 100);
      document.querySelector("button").addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        const menu = document.createElement("div"); menu.role = "menu";
        const choice = document.createElement("button"); choice.role = "menuitem";
        choice.textContent = hydrated && isArchived ? "Unarchive" : "Archive";
        choice.onclick = () => {
          void fetch("/fixture/11111111-2222-3333-4444-555555555555", {
            method: "PATCH", headers: { "content-type": "application/json" }, body: '{"is_archived":true}',
          });
          history.pushState(null, "", "/"); menu.remove();
        };
        menu.append(choice); document.body.append(menu);
      });
      if (isArchived) {
        const header = document.querySelector("header"); header.remove();
        setTimeout(() => document.querySelector("main").append(header), 2500);
      }
    }
    return new Response('<main><header data-testid="app-shell-header-context-menu-surface"><button aria-label="Chat actions">Actions</button></header></main><script>('
      + render.toString() + ")(" + JSON.stringify(archived) + ");</script>", { headers: { "content-type": "text/html" } });
  });
  const window = new BrowserWindow({ show: false });
  const view = new WebContentsView({ webPreferences: { session: isolated, contextIsolation: true, nodeIntegration: false } });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1200, height: 900 });
  const contents = view.webContents;
  await contents.loadURL(url);
  await contents.executeJavaScript('globalThis.__CODEX_WEB_GPT_SURFACE_ID__="surface"');
  window.contentView.removeChildView(view);
  contents.setBackgroundThrottling(true);
  const initialVisibility = await contents.executeJavaScript("document.visibilityState");
  let error;
  try { await archiveDocument({ surfaceId: "surface", archiveConversationUrl: url, view }); }
  catch (failure) { error = failure.message; }
  console.log(JSON.stringify({ fixture: "retired-chat-archive", passed: !error, archived, mutations, initialVisibility, windowShown, error }));
  contents.close(); window.destroy();
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  app.exit(error ? 1 : 0);
}).catch(error => { console.error(error.message); app.exit(1); });
