// Delayed-resource navigation reproduction reported in issue #804 by @xianengqi.
const { app, BrowserWindow, WebContentsView } = require("electron");
const { createServer } = require("node:http");
const { BrowserHost } = require("../../electron/browser-host.cjs");

app.whenReady().then(async () => {
  const pending = new Set();
  const server = createServer((request, response) => {
    if (request.url.startsWith("/delayed")) {
      pending.add(response);
      response.on("close", () => pending.delete(response));
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Cache-Control", "no-store");
    response.end(`
      <form><div id="prompt-textarea" contenteditable="true" role="textbox"
        style="width:300px;height:80px">Synthetic prompt</div>
      <button type="button" aria-haspopup="menu" aria-controls="models" aria-expanded="false"
        style="position:fixed;right:40px;bottom:40px">Models</button></form>
      <div id="models" role="menu" hidden>Model choices</div><img src="/delayed${request.url}">
      <script>
        window.clicks=0;
        document.querySelector('button').onclick=()=>{
          window.clicks++;document.querySelector('[role=menu]').hidden=false;
          document.querySelector('button').setAttribute('aria-expanded','true');
        };
        addEventListener('resize',()=>document.querySelector('[role=menu]').hidden=true);
      </script>`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const window = new BrowserWindow({ width: 1120, height: 760, show: false });
  await window.loadURL("about:blank");
  const view = new WebContentsView();
  window.contentView.addChildView(view);
  await view.webContents.loadURL("about:blank");
  const host = Object.assign(Object.create(BrowserHost.prototype), {
    window, view, boundsReady: true, bounds: { x: 280, y: 64, width: 840, height: 656 },
    visible: true, surfaceActive: true, authView: null, turnTabs: new Map(),
    selectedTabId: "home", closedTurnOwners: new Map(),
    logger: { info() {}, warn() {}, error(...args) { console.error(...args); } },
    syncPowerSaveBlocker() {}, snapshot() { return {}; }, writeDescriptor() {},
  });
  for (const id of ["first", "second"]) {
    const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
    const tab = {
      id, view, status: "running", rendererReady: false, deviceEmulationDirty: true,
      deviceEmulationViewport: null, surfaceId: id, initializingSurface: true,
    };
    host.turnTabs.set(id, tab);
    window.contentView.addChildView(view);
    host.presentTurnView(tab, false);
    host.bindTurnContents(tab);
    await view.webContents.loadURL(`about:blank#${id}`);
  }
  host.syncViewVisibility();
  global.navigationFixture = {
    host, url: `http://127.0.0.1:${server.address().port}/page`,
    release() {
      for (const response of pending) response.end();
      pending.clear();
    },
  };
  app.on("before-quit", () => {
    global.navigationFixture.release();
    server.close();
    server.closeAllConnections();
  });
});
