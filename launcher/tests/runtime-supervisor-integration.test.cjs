const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { packagedRuntimePaths } = require("../electron/runtime-command.cjs");
const { linuxDesktopEntry, requireAutostartState } = require("../electron/autostart.cjs");
const {
  MAX_RESTARTS_PER_WINDOW,
  RuntimeSupervisor,
  managedTunnelConnectArgs,
  validateConfig,
} = require("../electron/runtime-supervisor.cjs");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function localHealthServer(statusForPath = () => 200) {
  const server = http.createServer((request, response) => {
    response.writeHead(statusForPath(request.url || "/"));
    response.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function launcherConfig(descriptorPath, overrides = {}) {
  const root = path.dirname(descriptorPath);
  return {
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath,
    chromeExecutablePath: process.execPath,
    storageStatePath: path.join(root, "storage-state.json"),
    brokerSocketPath: process.platform === "win32"
      ? "\\\\.\\pipe\\codex-chatgpt-web-runtime-supervisor-test"
      : path.join(root, "turn-broker.sock"),
    headed: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    useEnhancedWebSessionMode: false,
    controlToken: "runtime-supervisor-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
    ...overrides,
  };
}

test("a failed full-runtime marker with no child evidence cannot block removal on a stalled tunnel probe", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-dead-runtime-removal-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "runtime", "launcher-supervisor.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(configPath, `${JSON.stringify(launcherConfig(descriptorPath, {
    mode: "full",
    tunnel: {
      binaryPath: path.join(root, "tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: path.join(root, "runtime.key"),
      profileDir: path.join(root, "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  }))}\n`);
  fs.writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    ownerPid: process.pid,
    daemonPid: null,
    tunnelPid: null,
    status: "external",
    updatedAt: new Date().toISOString(),
  })}\n`);
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
  });
  let tunnelProbes = 0;
  supervisor.proxyHealth = async () => false;
  supervisor.readTunnelHealth = async () => {
    tunnelProbes += 1;
    throw new Error("Tunnel health probe timed out after 5000ms");
  };
  try {
    assert.deepEqual(await supervisor.stopForSetup(), { status: "stopped" });
    assert.equal(tunnelProbes, 0);
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external migration clears only stale launcher ownership evidence", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-external-migration-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  const state = (ownerPid) => ({
    version: 1,
    ownerPid,
    daemonPid: null,
    tunnelPid: null,
    status: "failed",
    updatedAt: new Date().toISOString(),
  });
  try {
    fs.writeFileSync(supervisor.statePath, `${JSON.stringify(state(process.pid))}\n`);
    assert.throws(
      () => supervisor.prepareExternalMigration(),
      /ownership processes are still alive/,
    );
    fs.writeFileSync(supervisor.statePath, `${JSON.stringify(state(999_999_999))}\n`);
    supervisor.prepareExternalMigration();
    assert.equal(fs.existsSync(supervisor.statePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher supervisor starts, health-checks, drains, and stops its daemon", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-supervisor-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const configPath = path.join(root, "config.json");
  const serverPath = path.join(root, "fake-runtime.cjs");
  const port = await freePort();
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(configPath, `${JSON.stringify(launcherConfig(descriptorPath, {
    port,
    controlToken: "runtime-supervisor-control-token-0123456789abcdef",
  }))}\n`);
  fs.writeFileSync(serverPath, `
const fs = require("node:fs");
const http = require("node:http");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let draining = false;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/healthz") {
    response.end(JSON.stringify({
      status: "ok",
      service: "codex-chatgpt-web",
      mode: config.mode,
      version: config.releaseVersion,
      pid: process.pid,
      accepting_turns: !draining,
    }));
    return;
  }
  if (request.method === "POST" && request.url === "/admin/drain-if-idle") {
    draining = true;
    response.end(JSON.stringify({ status: "ok", acquired: true, accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 }));
    return;
  }
  if (request.method === "POST" && request.url === "/admin/drain") draining = true;
  else if (request.method === "POST" && request.url === "/admin/resume") draining = false;
  else if (request.method === "POST" && request.url === "/admin/shutdown" && draining) {
    response.end(JSON.stringify({ status: "ok", accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 }));
    server.close(() => process.exit(0));
    return;
  }
  else {
    response.statusCode = 404;
    response.end("{}");
    return;
  }
  response.end(JSON.stringify({ accepting_turns: !draining, active_http_turns: 0, active_browser_turns: 0 }));
});
server.listen(config.port, config.host);
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`);

  const records = [];
  const logger = {
    info(event, detail) { records.push({ level: "info", event, detail }); },
    warn(event, detail) { records.push({ level: "warning", event, detail }); },
    error(event, detail) { records.push({ level: "error", event, detail }); },
  };
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger,
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
    runtimeInvocationFactory: () => ({
      executable: process.execPath,
      args: [serverPath, configPath],
      cwd: root,
    }),
  });

  try {
    const started = await supervisor.startIfConfigured();
    assert.equal(started.status, "ready");
    const state = JSON.parse(fs.readFileSync(path.join(root, "runtime", "launcher-supervisor.json"), "utf8"));
    assert.equal(state.status, "ready");
    assert.equal(Number.isInteger(state.daemonPid), true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).ok, true);

    const stopped = await supervisor.stopForSetup();
    assert.equal(stopped.status, "stopped");
    assert.equal(fs.existsSync(path.join(root, "runtime", "launcher-supervisor.json")), false);
    assert.equal(records.some((record) => record.event === "runtime.daemon_started"), true);
  } finally {
    await supervisor.stopForSetup().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher supervisor safely replaces an idle daemon left by a crashed launcher owner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-stale-owner-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const statePath = path.join(root, "runtime", "launcher-supervisor.json");
  const configPath = path.join(root, "config.json");
  const serverPath = path.join(root, "fake-runtime.cjs");
  const port = await freePort();
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(configPath, `${JSON.stringify(launcherConfig(descriptorPath, {
    port,
    controlToken: "stale-owner-test-control-token-0123456789",
  }))}\n`);
  fs.writeFileSync(serverPath, `
const fs = require("node:fs");
const http = require("node:http");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
let draining = false;
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.setHeader("connection", "close");
  if (request.url === "/healthz") {
    response.end(JSON.stringify({
      status: "ok",
      service: "codex-chatgpt-web",
      mode: config.mode,
      version: config.releaseVersion,
      pid: process.pid,
      accepting_turns: !draining,
    }));
    return;
  }
  if (request.headers.authorization !== "Bearer " + config.controlToken) {
    response.statusCode = 401;
    response.end("{}");
    return;
  }
  if (request.method === "POST" && request.url === "/admin/drain-if-idle") {
    draining = true;
    response.end(JSON.stringify({ status: "ok", acquired: true, accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 }));
    return;
  }
  if (request.method === "POST" && request.url === "/admin/drain") draining = true;
  else if (request.method === "POST" && request.url === "/admin/resume") draining = false;
  else if (request.method === "POST" && request.url === "/admin/shutdown" && draining) {
    response.end(JSON.stringify({ status: "ok", accepting_turns: false, active_http_turns: 0, active_browser_turns: 0 }));
    server.close(() => process.exit(0));
    return;
  } else {
    response.statusCode = 404;
    response.end("{}");
    return;
  }
  response.end(JSON.stringify({ status: "ok", accepting_turns: !draining, active_http_turns: 0, active_browser_turns: 0 }));
});
server.listen(config.port, config.host);
`);
  const stale = spawn(process.execPath, [serverPath, configPath], {
    cwd: root,
    stdio: "ignore",
  });
  const logger = { info() {}, warn() {}, error() {} };
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger,
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
    runtimeInvocationFactory: () => ({
      executable: process.execPath,
      args: [serverPath, configPath],
      cwd: root,
    }),
  });

  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).ok, true);
    fs.writeFileSync(statePath, `${JSON.stringify({
      version: 1,
      ownerPid: 999_999_999,
      daemonPid: stale.pid,
      tunnelPid: null,
      status: "ready",
      updatedAt: new Date().toISOString(),
    })}\n`);

    const started = await supervisor.startIfConfigured();
    assert.equal(started.status, "ready");
    assert.notEqual(started.daemonPid, stale.pid);
    assert.equal(stale.exitCode !== null || stale.killed, true);
  } finally {
    await supervisor.stopForSetup().catch(() => {});
    if (stale.exitCode === null) stale.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
