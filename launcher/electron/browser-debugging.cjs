const fs = require("node:fs");
const path = require("node:path");

// Chromium owns the ephemeral port. Configure it synchronously before any startup await:
// runtime verification can yield long enough for Electron's ready event to have fired.
function configureBrowserDebugging(app) {
  if (app.isReady()) throw new Error("Browser debugging must be configured before Electron is ready");
  const startedAt = Date.now();
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", "0");
  return { file: path.join(app.getPath("sessionData"), "DevToolsActivePort"), startedAt };
}

function browserSocketPath(value) {
  return /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(value);
}

async function waitForBrowserDebugging(startup, { timeoutMs = 10_000, readFile = fs.promises.readFile,
  stat = fs.promises.stat, fetchImpl = fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deadline = now() + timeoutMs;
  do {
    try {
      const metadata = await stat(startup.file);
      if (metadata.mtimeMs < startup.startedAt || metadata.size > 4096) throw new Error("Stale debugging port record");
      const record = await readFile(startup.file, "utf8");
      const [rawPort, socketPath] = record.trim().split(/\r?\n/);
      const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : 0;
      if (port < 1 || port > 65535 || !browserSocketPath(socketPath)) throw new Error("Invalid debugging port record");
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - now()))),
      });
      if (!response.ok) throw new Error("Debugging endpoint is not ready");
      const version = await response.json();
      const socket = new URL(version.webSocketDebuggerUrl);
      if (socket.protocol !== "ws:" || socket.hostname !== "127.0.0.1" || Number(socket.port) !== port
        || socket.pathname !== socketPath || socket.username || socket.password || socket.search || socket.hash) {
        throw new Error("Debugging endpoint does not match this launch");
      }
      return port;
    } catch {}
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(50, remaining));
  } while (now() < deadline);
  throw new Error("Launcher browser CDP endpoint did not become ready for this launch");
}

async function ownedDebuggingTarget(port, targetId, { fetchImpl = fetch } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9-]+$/.test(targetId)) {
    throw new Error("Invalid owned browser debugging target");
  }
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error("Browser debugging target inventory is unavailable");
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error("Browser debugging target inventory is invalid");
  const matches = targets.filter(target => target?.id === targetId && target.type === "page");
  if (matches.length !== 1) throw new Error("Owned browser surface is not available over CDP");
  const target = matches[0];
  const socket = new URL(target.webSocketDebuggerUrl);
  if (socket.protocol !== "ws:" || socket.hostname !== "127.0.0.1" || Number(socket.port) !== port
    || socket.pathname !== `/devtools/page/${targetId}` || socket.username || socket.password || socket.search || socket.hash) {
    throw new Error("Owned browser surface debugging endpoint is invalid");
  }
  return target;
}

// Package smoke exercises a real renderer through CDP without opening ChatGPT or sending a prompt.
async function smokeBrowserDebugging(port, targetId) {
  const target = await ownedDebuggingTarget(port, targetId);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const deadline = Date.now() + 10_000;
  const pending = new Map();
  const fail = error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const timer = setTimeout(() => fail(new Error("Browser CDP smoke exceeded its ten-second budget")), 10_000);
  const ready = new Promise((resolve, reject) => {
    pending.set(0, { resolve, reject });
    socket.addEventListener("open", () => { pending.delete(0); resolve(); }, { once: true });
  });
  socket.addEventListener("error", () => fail(new Error("Browser CDP smoke connection failed")));
  socket.addEventListener("close", () => fail(new Error("Browser CDP smoke connection closed")));
  socket.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error ? request.reject(new Error("Browser CDP smoke command failed")) : request.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await ready;
    const url = "data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ctitle%3ECDP%20smoke%3C%2Ftitle%3E%3Cdiv%20id%3D%22cdp-smoke%22%3ECDP_READY%3C%2Fdiv%3E";
    const navigation = await call("Page.navigate", { url });
    if (navigation.errorText) throw new Error("Browser CDP smoke navigation failed");
    let content;
    do {
      content = await call("Runtime.evaluate", { expression: "document.getElementById('cdp-smoke')?.textContent", returnByValue: true });
      if (content.result?.value === "CDP_READY") return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    throw new Error("Browser CDP smoke document did not become ready");
  } finally {
    clearTimeout(timer);
    socket.close();
    fail(new Error("Browser CDP smoke finished"));
  }
}

module.exports = { configureBrowserDebugging, waitForBrowserDebugging, ownedDebuggingTarget, smokeBrowserDebugging };
