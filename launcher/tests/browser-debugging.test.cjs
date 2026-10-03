const assert = require("node:assert/strict");
const { test } = require("node:test");
const { configureBrowserDebugging, waitForBrowserDebugging, ownedDebuggingTarget } = require("../electron/browser-debugging.cjs");

function fixture(overrides = {}) {
  let time = 100;
  const options = {
    timeoutMs: 100,
    now: () => time,
    sleep: async ms => { time += ms; },
    stat: async () => ({ mtimeMs: 100, size: 50 }),
    readFile: async () => "43821\n/devtools/browser/current-browser\n",
    fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:43821/devtools/browser/current-browser" }) }),
    ...overrides,
  };
  return { startup: { file: "/isolated/DevToolsActivePort", startedAt: 100 }, options };
}

test("CDP configuration remains effective when verification yields through Electron ready", async () => {
  const switches = [];
  let ready = false;
  const app = { isReady: () => ready, getPath: name => { assert.equal(name, "sessionData"); return "/isolated"; },
    commandLine: { appendSwitch: (...args) => { assert.equal(ready, false); switches.push(args); } } };
  const startup = configureBrowserDebugging(app);
  await new Promise(resolve => setImmediate(() => { ready = true; resolve(); }));
  assert.deepEqual(switches, [["remote-debugging-address", "127.0.0.1"], ["remote-debugging-port", "0"]]);
  const data = fixture({ stat: async () => ({ mtimeMs: startup.startedAt, size: 50 }) });
  assert.equal(await waitForBrowserDebugging(startup, data.options), 43821);
  assert.throws(() => configureBrowserDebugging(app), /before Electron is ready/);
});

test("CDP readiness waits through a partial port file and endpoint startup", async () => {
  let reads = 0, probes = 0;
  const data = fixture({ readFile: async () => ++reads === 1 ? "43821\n" : "43821\n/devtools/browser/current-browser\n",
    fetchImpl: async () => { if (++probes === 1) throw new Error("connection refused"); return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:43821/devtools/browser/current-browser" }) }; },
    timeoutMs: 200 });
  assert.equal(await waitForBrowserDebugging(data.startup, data.options), 43821);
  assert.equal(reads, 3);
  assert.equal(probes, 2);
});

test("stale and excessive port records never authorize a browser", async () => {
  for (const metadata of [{ mtimeMs: 99, size: 50 }, { mtimeMs: 100, size: 4097 }]) {
    let fetched = false;
    const data = fixture({ stat: async () => metadata, fetchImpl: async () => { fetched = true; throw new Error(); } });
    await assert.rejects(waitForBrowserDebugging(data.startup, data.options), /did not become ready/);
    assert.equal(fetched, false);
  }
});

test("missing or invalid port records fail within the readiness budget", async () => {
  for (const record of ["0\n/devtools/browser/current-browser", "65536\n/devtools/browser/current-browser", "43821\n/devtools/page/foreign", "https://example.com"]) {
    let fetched = false;
    const data = fixture({ readFile: async () => record, fetchImpl: async () => { fetched = true; throw new Error(); } });
    await assert.rejects(waitForBrowserDebugging(data.startup, data.options), /did not become ready/);
    assert.equal(fetched, false);
  }
  const absent = fixture({ stat: async () => { throw new Error("ENOENT"); } });
  await assert.rejects(waitForBrowserDebugging(absent.startup, absent.options), /did not become ready/);
});

test("a foreign browser, origin, port or credential-bearing endpoint cannot pass readiness", async () => {
  for (const socket of ["ws://127.0.0.1:43821/devtools/browser/old-browser", "ws://example.com:43821/devtools/browser/current-browser",
    "ws://127.0.0.1:43822/devtools/browser/current-browser", "ws://user:secret@127.0.0.1:43821/devtools/browser/current-browser",
    "ws://127.0.0.1:43821/devtools/browser/current-browser?secret=1", "http://127.0.0.1:43821/devtools/browser/current-browser"]) {
    const data = fixture({ fetchImpl: async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: socket }) }) });
    await assert.rejects(waitForBrowserDebugging(data.startup, data.options), /did not become ready/);
  }
});

test("owned surface readiness requires an exact unique page and its loopback socket", async () => {
  const page = { id: "owned-page", type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:43821/devtools/page/owned-page" };
  const check = list => ownedDebuggingTarget(43821, "owned-page", { fetchImpl: async () => ({ ok: true, json: async () => list }) });
  assert.deepEqual(await check([page]), page);
  for (const list of [[], [page, page], [{ ...page, type: "browser" }], [{ ...page, id: "foreign-page" }],
    [{ ...page, webSocketDebuggerUrl: "ws://127.0.0.1:43821/devtools/page/foreign-page" }],
    [{ ...page, webSocketDebuggerUrl: "ws://example.com:43821/devtools/page/owned-page" }]]) {
    await assert.rejects(check(list));
  }
  await assert.rejects(ownedDebuggingTarget(0, "owned-page"), /Invalid owned/);
});
