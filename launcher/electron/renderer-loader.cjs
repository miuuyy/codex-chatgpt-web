const { pathToFileURL } = require("node:url");

async function loadPackagedRenderer(window, filePath, {
  timeoutMs = 15_000,
  pollMs = 100,
} = {}) {
  const expectedUrl = pathToFileURL(filePath).href;
  let settled = false;
  let timer;
  let interval;
  const cleanup = () => {
    clearTimeout(timer);
    clearInterval(interval);
  };
  const ready = new Promise((resolve, reject) => {
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const check = async () => {
      if (settled) return;
      if (window.isDestroyed?.()) return fail(new Error("Launcher window closed while loading its renderer"));
      if (window.webContents.getURL() !== expectedUrl) return;
      try {
        const state = await window.webContents.executeJavaScript("document.readyState", true);
        if (state !== "complete") return;
        settled = true;
        cleanup();
        resolve();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    timer = setTimeout(() => fail(new Error(`Launcher renderer did not become ready: ${expectedUrl}`)), timeoutMs);
    interval = setInterval(() => { void check(); }, pollMs);
    void check();
  });
  const load = Promise.resolve(window.loadFile(filePath));
  load.then(() => {
    if (settled) return;
    settled = true;
    cleanup();
  }).catch(() => {});
  try {
    await Promise.race([load, ready]);
  } finally {
    cleanup();
  }
}

module.exports = { loadPackagedRenderer };
