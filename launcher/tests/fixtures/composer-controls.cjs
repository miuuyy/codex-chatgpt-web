const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false });
  await window.loadURL("about:blank");
});
