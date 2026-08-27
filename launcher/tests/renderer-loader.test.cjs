const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { loadPackagedRenderer } = require("../electron/renderer-loader.cjs");

test("packaged renderer accepts an exact complete document when Electron leaves loadFile pending", async () => {
  const filePath = path.resolve("launcher", "dist", "index.html");
  const window = {
    isDestroyed: () => false,
    loadFile: () => new Promise(() => {}),
    webContents: {
      getURL: () => pathToFileURL(filePath).href,
      executeJavaScript: async () => "complete",
    },
  };
  await loadPackagedRenderer(window, filePath, { timeoutMs: 100, pollMs: 1 });
});

test("packaged renderer does not accept a complete document at a different URL", async () => {
  const filePath = path.resolve("launcher", "dist", "index.html");
  const window = {
    isDestroyed: () => false,
    loadFile: () => new Promise(() => {}),
    webContents: {
      getURL: () => "file:///unexpected.html",
      executeJavaScript: async () => "complete",
    },
  };
  await assert.rejects(
    loadPackagedRenderer(window, filePath, { timeoutMs: 20, pollMs: 1 }),
    /did not become ready/,
  );
});
