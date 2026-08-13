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
    controlToken: "runtime-supervisor-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
    ...overrides,
  };
}

test("packaged runtime paths are native on Windows and Unix", () => {
  const windows = packagedRuntimePaths("C:\\Program Files\\Codex\\resources", "win32");
  assert.equal(path.basename(windows.executable), "bun.exe");
  assert.equal(path.basename(windows.entrypoint), "cli.js");

  const linux = packagedRuntimePaths("/opt/codex/resources", "linux");
  assert.equal(path.basename(linux.executable), "bun");
  assert.equal(path.basename(linux.entrypoint), "cli.js");
});

test("Linux autostart launches the durable AppImage invisibly", () => {
  const entry = linuxDesktopEntry(
    { getPath: () => "/tmp/transient-electron" },
    "/home/example/Applications/Codex Web GPT.AppImage",
  );
  assert.match(
    entry,
    /^Exec=\/usr\/bin\/env APPIMAGE_EXTRACT_AND_RUN=1 CODEX_WEB_GPT_APPIMAGE="\/home\/example\/Applications\/Codex Web GPT\.AppImage" "\/home\/example\/Applications\/Codex Web GPT\.AppImage" --hidden$/m,
  );
  assert.match(entry, /^Terminal=false$/m);
  assert.match(entry, /^X-GNOME-Autostart-enabled=true$/m);
});

test("Linux autostart escapes desktop-entry field codes in executable paths", () => {
  const entry = linuxDesktopEntry(
    { getPath: () => "/tmp/transient-electron" },
    "/home/example/100% ready/Codex Web GPT.AppImage",
  );
  assert.match(entry, /CODEX_WEB_GPT_APPIMAGE="\/home\/example\/100%% ready\/Codex Web GPT\.AppImage"/);
  assert.match(entry, /"\/home\/example\/100%% ready\/Codex Web GPT\.AppImage" --hidden/);
});

test("Linux autostart follows the stable installer wrapper across app updates", () => {
  const previous = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
  process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = "/home/example/.local/bin/codex-web-gpt";
  try {
    const entry = linuxDesktopEntry({ getPath: () => "/tmp/versioned-appimage-mount" });
    assert.match(entry, /CODEX_WEB_GPT_APPIMAGE="\/home\/example\/\.local\/bin\/codex-web-gpt"/);
    assert.match(entry, /"\/home\/example\/\.local\/bin\/codex-web-gpt" --hidden/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
    else process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = previous;
  }
});

test("launcher autostart fails explicitly when the operating system rejects the requested state", () => {
  assert.deepEqual(
    requireAutostartState({ supported: true, enabled: true }, true),
    { supported: true, enabled: true },
  );
  assert.throws(
    () => requireAutostartState({ supported: true, enabled: false }, true),
    /did not enable launcher autostart/,
  );
});

test("launcher runtime ownership rejects a different browser descriptor", () => {
  assert.throws(
    () => validateConfig(launcherConfig("/one/launcher.json"), "/two/launcher.json"),
    /different launcher browser host/,
  );
});

test("launcher runtime validation rejects a relative full-mode executable before spawn", () => {
  const descriptorPath = path.join(os.tmpdir(), "launcher.json");
  assert.throws(() => validateConfig(launcherConfig(descriptorPath, {
    mode: "full",
    tunnel: {
      binaryPath: "tunnel-client",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: path.join(os.tmpdir(), "runtime.key"),
      profileDir: path.join(os.tmpdir(), "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  }), descriptorPath), /absolute tunnel\.binaryPath/);
});

test("launcher runtime validation accepts native Windows paths and a named pipe", () => {
  const descriptorPath = "C:\\Users\\Example\\AppData\\Local\\Codex Web GPT\\launcher-browser.json";
  const config = {
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: descriptorPath.toLowerCase(),
    chromeExecutablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    storageStatePath: "C:\\Users\\Example\\AppData\\Local\\Codex Web GPT\\storage-state.json",
    brokerSocketPath: "\\\\.\\pipe\\codex-chatgpt-web-runtime-supervisor-test",
    headed: true,
    solAvailable: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "runtime-supervisor-control-token-0123456789abcdef",
    runtimeCommand: ["C:\\Users\\Example\\.codex-chatgpt-web\\runtime\\bun.exe"],
  };
  assert.equal(validateConfig(config, descriptorPath, "win32"), config);
});

test("launcher delegates long-lived tunnel supervision to native runtimes connect", () => {
  const config = launcherConfig("C:\\Users\\Example\\.codex-chatgpt-web\\runtime\\launcher-browser.json", {
    mode: "full",
    runtimeCommand: [
      "C:\\Users\\Example\\.codex-chatgpt-web\\versions\\0.2.0-win32-x64\\runtime\\bun.exe",
      "C:\\Users\\Example\\.codex-chatgpt-web\\versions\\0.2.0-win32-x64\\app\\cli.js",
    ],
    brokerSocketPath: "\\\\.\\pipe\\codex-chatgpt-web-example",
    tunnel: {
      binaryPath: "C:\\Users\\Example\\.codex-chatgpt-web\\bin\\tunnel-client.exe",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: "C:\\Users\\Example\\.codex-chatgpt-web\\secrets\\tunnel-runtime.key",
      profileDir: "C:\\Users\\Example\\.codex-chatgpt-web\\tunnel\\profiles",
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  });
  const invocation = {
    executable: "C:\\Program Files\\Codex Web GPT\\resources\\runtime\\bun.exe",
    args: [
      "C:\\Program Files\\Codex Web GPT\\resources\\runtime\\app\\cli.js",
      "mcp",
      "--broker-socket",
      config.brokerSocketPath,
    ],
    cwd: "C:\\Program Files\\Codex Web GPT\\resources\\runtime",
  };
  const args = managedTunnelConnectArgs(config, invocation);
  assert.deepEqual(args.slice(0, 4), [
    "runtimes", "connect", "--alias", "codex-chatgpt-web",
  ]);
  assert.equal(args.includes("run"), false);
  assert.equal(args.at(-1), "--json");
  assert.equal(args[args.indexOf("--mcp-command") + 1].includes("bun.exe"), true);
  assert.equal(args[args.indexOf("--mcp-command") + 1].includes("\\\\\\\\.\\\\pipe\\\\codex-chatgpt-web-example"), true);
  assert.equal(args[args.indexOf("--mcp-command") + 1].includes("versions"), false);
  assert.throws(
    () => managedTunnelConnectArgs(config),
    /requires an explicit runtime invocation/,
  );
});

test("launcher repairs its runtime before building the tunnel MCP command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-runtime-"));
  const config = launcherConfig(path.join(root, "launcher-browser.json"), {
    mode: "full",
    runtimeCommand: [path.join(root, "versions", "stale", "runtime", "bun")],
    tunnel: {
      binaryPath: path.join(root, "bin", "tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: path.join(root, "secrets", "tunnel-runtime.key"),
      profileDir: path.join(root, "tunnel", "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  });
  const repairedRuntime = path.join(root, "launcher-runtime");
  let runtimeRepairs = 0;
  let connectArgs;
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: true },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    installedRuntimeRoot: path.join(root, "versions", "stale"),
    runtimeRootProvider: () => {
      runtimeRepairs += 1;
      return repairedRuntime;
    },
    coreHome: root,
    browserDescriptorPath: config.browserHostDescriptorPath,
    runtimeInvocationFactory: ({ installedRuntimeRoot, args }) => ({
      executable: path.join(installedRuntimeRoot, "runtime", "bun"),
      args: [path.join(installedRuntimeRoot, "app", "cli.js"), ...args],
      cwd: installedRuntimeRoot,
    }),
  });
  supervisor.runTunnelCommand = async (_config, args) => {
    connectArgs = args;
    return { code: 0, stdout: "", stderr: "", output: "" };
  };

  try {
    await supervisor.runTunnelConnectCommand(config);
    const command = connectArgs[connectArgs.indexOf("--mcp-command") + 1];
    const serializedRuntime = repairedRuntime.replaceAll("\\", "\\\\");
    assert.equal(runtimeRepairs, 1);
    assert.equal(command.includes(serializedRuntime), true);
    assert.equal(command.includes(`${path.sep}versions${path.sep}`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel control failures preserve stderr even when stdout is also present", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-control-output-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  try {
    const result = await supervisor.runTunnelCommand({
      tunnel: {
        binaryPath: process.execPath,
        profileDir: root,
      },
    }, [
      "-e",
      "process.stdout.write('machine-readable output'); process.stderr.write('root failure'); process.exit(9)",
    ], 5_000, "Synthetic tunnel command");
    assert.equal(result.code, 9);
    assert.equal(result.stdout, "machine-readable output");
    assert.equal(result.stderr, "root failure");
    assert.equal(result.output, "root failure\nmachine-readable output");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel health diagnostics preserve the machine-readable readiness state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-health-detail-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  let commandArgs;
  supervisor.runTunnelCommand = async (_config, args) => {
    commandArgs = args;
    return {
      code: 0,
      output: JSON.stringify({
        entries: [{
          alias: "codex-web-gpt",
          runtime_state: "stopped",
          classification: "stale_alias",
          live_runtime: { found: false },
        }],
      }),
    };
  };
  try {
    assert.deepEqual(await supervisor.readTunnelHealth({
      tunnel: { alias: "codex-web-gpt" },
    }), {
      ready: false,
      pid: null,
      state: "stopped",
      processRunning: false,
      healthy: false,
      absent: false,
      statusKnown: true,
      detail: "state=stopped; process_running=false; healthy=false; ready=false; classification=stale_alias; live_admin=false; pid=missing",
    });
    assert.deepEqual(commandArgs, ["runtimes", "cleanup", "--json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel failures surface a bounded summary instead of dumping the JSON payload into the UI", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-summary-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const output = JSON.stringify({
    runtime_state: "stopped",
    process_running: false,
    healthy: false,
    ready: false,
    remote_error: "runtime principal cannot use the requested tunnel",
    launch_diagnostics: { log_tail: `old line\n${"x".repeat(4_000)}\nroot failure` },
  });
  supervisor.runTunnelCommand = async () => ({
    code: 2,
    stdout: output,
    stderr: "",
    output,
  });
  try {
    const health = await supervisor.readTunnelHealth({
      tunnel: { alias: "codex-web-gpt" },
    });
    assert.match(health.detail, /state=stopped/);
    assert.match(health.detail, /runtime principal cannot use/);
    assert.doesNotMatch(health.detail, /"launch_diagnostics"/);
    assert.equal(health.detail.length <= 1_200, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel readiness preserves a native managed process identity when one is reported", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-health-pid-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.runTunnelCommand = async () => ({
    code: 0,
    output: JSON.stringify({
      entries: [{
        alias: "codex-web-gpt",
        runtime_state: "ready",
        classification: "active_runtime",
        live_runtime: {
          found: true,
          base_url: "http://127.0.0.1:12345",
          system: { pid: 123_456_779 },
        },
      }],
    }),
  });
  try {
    assert.deepEqual(await supervisor.readTunnelHealth({
      tunnel: { alias: "codex-web-gpt" },
    }), {
      ready: true,
      pid: 123_456_779,
      state: "ready",
      processRunning: true,
      healthy: true,
      absent: false,
      statusKnown: true,
      detail: "state=ready; process_running=true; healthy=true; ready=true; classification=active_runtime; live_admin=true; pid=123456779",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("steady tunnel monitoring uses the runtime local health endpoints without a control-plane status lookup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-local-tunnel-health-"));
  const health = await localHealthServer();
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.tunnel = { pid: process.pid, managed: true };
  supervisor.tunnelHealthBaseUrl = health.baseUrl;
  supervisor.readTunnelHealth = async () => {
    throw new Error("control-plane lookup must not run for a healthy local runtime");
  };
  try {
    const observation = await supervisor.observeTunnelForMonitor({ tunnel: {} });
    assert.equal(observation.ready, true);
    assert.equal(observation.statusKnown, true);
    assert.match(observation.detail, /healthz returned HTTP 200/);
    assert.match(observation.detail, /readyz returned HTTP 200/);
  } finally {
    await health.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unavailable local probe plus a stalled native status is unknown, not proof that the tunnel died", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-unknown-tunnel-health-"));
  const port = await freePort();
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.tunnelHealthBaseUrl = `http://127.0.0.1:${port}`;
  supervisor.readTunnelHealth = async () => {
    throw new Error("Tunnel health probe timed out after 5000ms");
  };
  try {
    const observation = await supervisor.observeTunnelForMonitor({ tunnel: {} });
    assert.equal(observation.ready, false);
    assert.equal(observation.statusKnown, false);
    assert.match(observation.detail, /native status unavailable/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit local readiness failure remains actionable tunnel evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-degraded-tunnel-health-"));
  const health = await localHealthServer(pathname => pathname === "/readyz" ? 503 : 200);
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.tunnelHealthBaseUrl = health.baseUrl;
  try {
    const observation = await supervisor.readLocalTunnelHealth();
    assert.equal(observation.ready, false);
    assert.equal(observation.statusKnown, true);
    assert.equal(observation.state, "degraded");
    assert.match(observation.detail, /readyz returned HTTP 503/);
  } finally {
    await health.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tunnel readiness accepts the official tmux status without inventing a PID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-health-tmux-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.runTunnelCommand = async () => ({
    code: 0,
    output: JSON.stringify({
      entries: [{
        alias: "codex-chatgpt-web",
        runtime_state: "ready",
        classification: "active_runtime",
        live_runtime: { found: true, base_url: "http://127.0.0.1:12345" },
      }],
    }),
  });
  try {
    const health = await supervisor.readTunnelHealth({
      tunnel: { alias: "codex-chatgpt-web" },
    });
    assert.equal(health.ready, true);
    assert.equal(health.pid, null);
    await supervisor.waitForTunnel({ tunnel: { alias: "codex-chatgpt-web" } }, 1);
    assert.equal(supervisor.tunnel?.managed, true);
    assert.equal(supervisor.tunnel?.pid, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a clean machine reports the official unknown-alias status as an absent runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-absent-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.runTunnelCommand = async () => ({
    code: 0,
    output: JSON.stringify({ entries: [] }),
  });
  try {
    const health = await supervisor.readTunnelHealth({
      tunnel: { alias: "codex-chatgpt-web" },
    });
    assert.equal(health.ready, false);
    assert.equal(health.absent, true);
    assert.equal(health.statusKnown, true);
    assert.equal(health.pid, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed startup fails immediately when native status reports a stopped runtime", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-stopped-start-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.readTunnelHealth = async () => ({
    ready: false,
    pid: null,
    state: "stopped",
    processRunning: false,
    healthy: false,
    absent: false,
    detail: "state=stopped; process_running=false",
  });
  try {
    await assert.rejects(
      supervisor.waitForTunnel({ tunnel: {} }, 120_000),
      /stopped during startup/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher adopts a healthy native managed tunnel without spawning a foreground wrapper", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-managed-tunnel-adopt-"));
  const binaryPath = path.join(root, "tunnel-client");
  const runtimeKeyFile = path.join(root, "runtime.key");
  const profileDir = path.join(root, "profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(binaryPath, "binary");
  fs.writeFileSync(runtimeKeyFile, "runtime-key");
  fs.writeFileSync(path.join(profileDir, "codex-chatgpt-web.yaml"), "profile");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  let connects = 0;
  let monitors = 0;
  supervisor.readTunnelHealth = async () => ({
    ready: true,
    pid: 123_456_778,
    statusKnown: true,
    detail: "ready",
  });
  supervisor.runTunnelConnectCommand = async () => {
    connects += 1;
    return { code: 0, output: "{}" };
  };
  supervisor.startTunnelMonitor = () => { monitors += 1; };
  try {
    await supervisor.startTunnel({
      mode: "full",
      tunnel: {
        binaryPath,
        runtimeKeyFile,
        profileDir,
        profileName: "codex-chatgpt-web",
      },
    });
    assert.equal(connects, 0);
    assert.equal(monitors, 1);
    assert.equal(supervisor.tunnel?.pid, 123_456_778);
    assert.equal(supervisor.tunnel?.managed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher stops an unhealthy managed runtime before reconnecting the alias", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-managed-tunnel-reconnect-"));
  const binaryPath = path.join(root, "tunnel-client");
  const runtimeKeyFile = path.join(root, "runtime.key");
  const profileDir = path.join(root, "profiles");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(binaryPath, "binary");
  fs.writeFileSync(runtimeKeyFile, "runtime-key");
  fs.writeFileSync(path.join(profileDir, "codex-chatgpt-web.yaml"), "profile");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const events = [];
  let reads = 0;
  supervisor.readTunnelHealth = async () => {
    reads += 1;
    return reads === 1
      ? { ready: false, pid: 123_456_777, statusKnown: true, detail: "state=degraded" }
      : { ready: true, pid: 123_456_776, statusKnown: true, detail: "state=ready" };
  };
  supervisor.runTunnelStopCommand = async () => {
    events.push("stop");
    return { code: 0, output: "{}" };
  };
  supervisor.waitForTunnelStopped = async () => {
    events.push("stopped");
  };
  supervisor.runTunnelConnectCommand = async () => {
    events.push("connect");
    return { code: 0, output: "{}" };
  };
  supervisor.startTunnelMonitor = () => { events.push("monitor"); };
  try {
    await supervisor.startTunnel({
      mode: "full",
      tunnel: {
        binaryPath,
        runtimeKeyFile,
        profileDir,
        profileName: "codex-chatgpt-web",
      },
    });
    assert.deepEqual(events, [
      "stop",
      "stopped",
      "connect",
      "monitor",
    ]);
    assert.equal(supervisor.tunnel?.pid, 123_456_776);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed tunnel startup accepts an absent alias only after its recorded process has exited", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-dead-cleanup-"));
  const binaryPath = path.join(root, "tunnel-client");
  const runtimeKeyFile = path.join(root, "runtime.key");
  fs.writeFileSync(binaryPath, "binary");
  fs.writeFileSync(runtimeKeyFile, "runtime-key");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  supervisor.waitForKnownTunnelStatus = async () => ({
    ready: false,
    pid: null,
    state: undefined,
    processRunning: undefined,
    healthy: undefined,
    absent: true,
    statusKnown: true,
    detail: "alias is not known",
  });
  supervisor.runTunnelStopCommand = async () => ({
    code: 1,
    stdout: "",
    stderr: "alias codex-chatgpt-web is not known",
    output: "alias codex-chatgpt-web is not known",
  });
  supervisor.runTunnelConnectCommand = async () => {
    supervisor.tunnel = {
      pid: 999_999_999,
      exitCode: null,
      signalCode: null,
      managed: true,
    };
    throw new Error("synthetic connect failure");
  };
  try {
    await assert.rejects(
      supervisor.startTunnel({
        mode: "full",
        runtimeCommand: [process.execPath],
        brokerSocketPath: path.join(root, "broker.sock"),
        tunnel: {
          binaryPath,
          runtimeKeyFile,
          profileDir: root,
          profileName: "codex-chatgpt-web",
          alias: "codex-chatgpt-web",
          tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
        },
      }),
      (error) => {
        assert.match(error.message, /synthetic connect failure/);
        assert.doesNotMatch(error.message, /startup cleanup failed/);
        return true;
      },
    );
    assert.equal(supervisor.tunnel, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("graceful tunnel stop uses the native status contract instead of killing a recorded PID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-wrapper-stop-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const child = { pid: 123_456_781, exitCode: null, signalCode: null, managed: true };
  const confirmations = [];
  supervisor.tunnel = child;
  supervisor.runTunnelStopCommand = async () => ({ code: 0, output: "{}" });
  supervisor.waitForTunnelStopped = async (_config, timeoutMs) => {
    confirmations.push(timeoutMs);
  };
  try {
    await supervisor.stopTunnelGracefully({ tunnel: {} }, 10);
    assert.deepEqual(confirmations, [10]);
    assert.equal(supervisor.tunnel, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed native tunnel shutdown keeps the managed runtime monitored", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-stop-refused-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const child = { pid: 123_456_780, exitCode: null, signalCode: null };
  let monitorRestarts = 0;
  supervisor.tunnel = child;
  supervisor.runTunnelStopCommand = async () => ({ code: 9, output: "runtime refused stop" });
  supervisor.startTunnelMonitor = () => { monitorRestarts += 1; };
  try {
    await assert.rejects(
      supervisor.stopTunnelGracefully({ tunnel: {} }, 10),
      /runtime refused stop/,
    );
    assert.equal(supervisor.tunnel, child);
    assert.equal(monitorRestarts, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an accepted tunnel stop without terminal proof keeps the alias supervised", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-stop-unconfirmed-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const managed = { pid: null, exitCode: null, signalCode: null, managed: true };
  let monitorRestarts = 0;
  supervisor.tunnel = managed;
  supervisor.runTunnelStopCommand = async () => ({ code: 0, output: "{}" });
  supervisor.waitForTunnelStopped = async () => {
    throw new Error("native status remained ambiguous");
  };
  supervisor.startTunnelMonitor = () => { monitorRestarts += 1; };
  try {
    await assert.rejects(
      supervisor.stopTunnelGracefully({ tunnel: {} }, 10),
      /native status remained ambiguous/,
    );
    assert.equal(supervisor.tunnel, managed);
    assert.equal(monitorRestarts, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stopping a tunnel monitor invalidates results from its previous generation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-monitor-generation-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  try {
    const before = supervisor.tunnelMonitorGeneration;
    supervisor.stopTunnelMonitor();
    assert.equal(supervisor.tunnelMonitorGeneration, before + 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher shutdown reacquires a managed tunnel that was between monitor and recovery states", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-tunnel-stop-reconcile-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  const config = { mode: "full", tunnel: { alias: "codex-chatgpt-web" } };
  let stops = 0;
  let confirmations = 0;
  supervisor.readConfig = () => config;
  supervisor.readTunnelHealth = async () => ({
    ready: true,
    pid: 123_456_779,
    state: "ready",
    processRunning: true,
    healthy: true,
    absent: false,
    statusKnown: true,
    detail: "state=ready",
  });
  supervisor.runTunnelStopCommand = async () => {
    stops += 1;
    return { code: 0, output: "{}" };
  };
  supervisor.waitForTunnelStopped = async () => {
    confirmations += 1;
  };
  try {
    assert.deepEqual(await supervisor.stopForSetup(), { status: "stopped" });
    assert.equal(stops, 1);
    assert.equal(confirmations, 1);
    assert.equal(supervisor.tunnel, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("crash-loop diagnostics include the last redacted child failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-crash-loop-diagnostic-"));
  const operations = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
    publishOperation: operation => operations.push(operation),
  });
  supervisor.restartHistory.tunnel = Array.from(
    { length: MAX_RESTARTS_PER_WINDOW },
    () => Date.now(),
  );
  supervisor.lastChildFailure.tunnel = "tunnel exited (1): invalid profile for [tunnel-id]";
  try {
    supervisor.scheduleRecovery("tunnel");
    const failure = operations.at(-1);
    assert.equal(failure.status, "failed");
    assert.match(failure.message, /automatic restart is disabled/);
    assert.match(failure.message, /last failure: tunnel exited \(1\): invalid profile for \[tunnel-id\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher supervisor refuses shutdown while a Codex turn is active and compensates the drain", async () => {
  const actions = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.control = async (_config, action) => {
    actions.push(action);
    return action === "drain"
      ? { accepting_turns: false, active_http_turns: 1, active_browser_turns: 0 }
      : { accepting_turns: true, active_http_turns: 1, active_browser_turns: 0 };
  };
  await assert.rejects(
    supervisor.acquireDrain({}, 0),
    /atomic idleness could not be proven.*1 active HTTP turn/,
  );
  assert.deepEqual(actions, ["drain", "resume"]);
});

test("launcher supervisor waits for an in-flight HTTP turn to finish after draining", async () => {
  const actions = [];
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  let drainChecks = 0;
  supervisor.control = async (_config, action) => {
    actions.push(action);
    drainChecks += 1;
    return {
      accepting_turns: false,
      active_http_turns: drainChecks === 1 ? 1 : 0,
      active_browser_turns: 0,
    };
  };

  await supervisor.acquireDrain({}, 1_000);
  assert.deepEqual(actions, ["drain", "drain"]);
});

test("launcher resumes an owned drained daemon before reporting it ready", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  const child = { pid: 123_456_789, exitCode: null, signalCode: null };
  let accepting = false;
  const actions = [];
  supervisor.daemon = child;
  supervisor.proxyHealth = async (_config, _timeoutMs, expectedPid, requireAccepting) => (
    expectedPid === child.pid && (!requireAccepting || accepting)
  );
  supervisor.control = async (_config, action) => {
    actions.push(action);
    accepting = true;
    return { status: "ok", accepting_turns: true };
  };
  supervisor.waitForProxy = async () => {
    assert.equal(accepting, true);
  };

  await supervisor.startDaemon({});
  assert.deepEqual(actions, ["resume"]);
  assert.equal(supervisor.daemon, child);
});

test("launcher restarts the daemon when a failed stop already terminated the drained child", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  let portReleased = 0;
  let starts = 0;
  supervisor.daemon = null;
  supervisor.waitForPortRelease = async () => { portReleased += 1; };
  supervisor.startDaemon = async () => {
    starts += 1;
    supervisor.daemon = { pid: 123_456_782, exitCode: null, signalCode: null };
  };

  const result = await supervisor.restoreDrainedDaemon({});
  assert.deepEqual(result, { status: "restarted", pid: 123_456_782 });
  assert.equal(portReleased, 1);
  assert.equal(starts, 1);
});

test("launcher marks compensation ready only after both owned runtime processes pass health checks", async () => {
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: os.tmpdir(),
    coreHome: os.tmpdir(),
    browserDescriptorPath: path.join(os.tmpdir(), "launcher.json"),
  });
  supervisor.daemon = { pid: 123_456_783, exitCode: null, signalCode: null };
  supervisor.proxyHealth = async () => true;
  assert.equal(await supervisor.ownedRuntimeReady({ mode: "browser-only" }), true);

  supervisor.tunnel = { pid: 123_456_784, exitCode: null, signalCode: null };
  supervisor.tunnelHealth = async () => false;
  assert.equal(await supervisor.ownedRuntimeReady({ mode: "full" }), false);
  supervisor.tunnelHealth = async () => true;
  assert.equal(await supervisor.ownedRuntimeReady({ mode: "full" }), true);
});

test("failed initial health checks stop their child without scheduling crash recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-startup-cleanup-"));
  const childPath = path.join(root, "child.cjs");
  fs.writeFileSync(childPath, "setInterval(() => {}, 1000);\n");
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
    runtimeInvocationFactory: () => ({
      executable: process.execPath,
      args: [childPath],
      cwd: root,
    }),
  });
  let recoveries = 0;
  supervisor.waitForProxy = async () => {
    throw new Error("synthetic health failure");
  };
  supervisor.scheduleRecovery = () => {
    recoveries += 1;
  };
  try {
    await assert.rejects(supervisor.startDaemon({}), /synthetic health failure/);
    assert.equal(supervisor.daemon, null);
    assert.equal(recoveries, 0);
  } finally {
    await supervisor.stopChild("daemon").catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher preserves stale ownership evidence when an old active runtime cannot be drained", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-active-stale-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  const statePath = path.join(root, "runtime", "launcher-supervisor.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(launcherConfig(descriptorPath, {
    releaseVersion: "0.1.16",
    controlToken: "active-stale-control-token-0123456789abcdef",
  }))}\n`);
  const staleState = {
    version: 1,
    ownerPid: 999_999_999,
    daemonPid: process.pid,
    tunnelPid: null,
    status: "ready",
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(statePath, `${JSON.stringify(staleState)}\n`);
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
  });
  supervisor.proxyHealth = async () => true;
  supervisor.stopStaleOwnedRuntime = async () => {
    throw new Error("daemon has 0 active HTTP turn(s) and 1 active browser turn(s)");
  };

  try {
    const result = await supervisor.startConfigured();
    assert.equal(result.status, "external");
    assert.match(result.detail, /1 active browser turn/);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), staleState);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher recovers a stale tunnel even when no stale Responses proxy is reachable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-stale-tunnel-only-"));
  const descriptorPath = path.join(root, "runtime", "launcher-browser.json");
  fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
  fs.writeFileSync(descriptorPath, "{}\n");
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(launcherConfig(descriptorPath, {
    mode: "full",
    controlToken: "stale-tunnel-control-token-0123456789abcdef",
    tunnel: {
      binaryPath: path.join(root, "tunnel-client"),
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      runtimeKeyFile: path.join(root, "runtime.key"),
      profileDir: path.join(root, "profiles"),
      profileName: "codex-chatgpt-web",
      alias: "codex-chatgpt-web",
    },
  }))}\n`);
  fs.writeFileSync(path.join(root, "runtime", "launcher-supervisor.json"), `${JSON.stringify({
    version: 1,
    ownerPid: 999_999_999,
    daemonPid: null,
    tunnelPid: process.pid,
    status: "degraded",
    updatedAt: new Date().toISOString(),
  })}\n`);
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: descriptorPath,
  });
  let recovered = 0;
  supervisor.proxyHealth = async () => false;
  supervisor.stopStaleOwnedRuntime = async () => {
    recovered += 1;
    return true;
  };
  supervisor.startTunnel = async () => {
    supervisor.tunnel = { pid: 123_456_780 };
  };
  supervisor.startDaemon = async () => {
    supervisor.daemon = { pid: 123_456_781 };
  };
  try {
    const result = await supervisor.startConfigured();
    assert.equal(result.status, "ready");
    assert.equal(recovered, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stale ownership recovery stops a managed tmux runtime even though it has no PID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-stale-tmux-tunnel-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, `${JSON.stringify({
    version: 1,
    ownerPid: 999_999_999,
    daemonPid: null,
    tunnelPid: null,
    status: "ready",
    updatedAt: new Date().toISOString(),
  })}\n`);
  supervisor.proxyHealthPayload = async () => null;
  supervisor.waitForKnownTunnelStatus = async () => ({
    ready: true,
    pid: null,
    state: "ready",
    processRunning: true,
    healthy: true,
    absent: false,
    statusKnown: true,
    detail: "state=ready; process_running=true; healthy=true; ready=true; pid=missing",
  });
  let stops = 0;
  supervisor.runTunnelStopCommand = async () => {
    stops += 1;
    return { code: 0, output: "{}" };
  };
  supervisor.waitForTunnelStopped = async () => ({
    ready: false,
    pid: null,
    state: "stopped",
    processRunning: false,
    absent: false,
    statusKnown: true,
    detail: "state=stopped; process_running=false",
  });
  try {
    assert.equal(await supervisor.stopStaleOwnedRuntime({
      mode: "full",
      tunnel: { alias: "codex-chatgpt-web" },
    }), true);
    assert.equal(stops, 1);
    assert.equal(fs.existsSync(supervisor.statePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher fails closed on a corrupt runtime ownership marker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-corrupt-runtime-state-"));
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, "{\"version\":1}\n");
  try {
    assert.throws(() => supervisor.readState(), /ownership state is invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launcher clears an empty stale ownership marker when Windows reuses its PID", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-reused-owner-pid-"));
  const pidOccupant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const supervisor = new RuntimeSupervisor({
    app: { getVersion: () => "0.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    coreHome: root,
    browserDescriptorPath: path.join(root, "launcher.json"),
  });
  fs.mkdirSync(path.dirname(supervisor.statePath), { recursive: true });
  fs.writeFileSync(supervisor.statePath, `${JSON.stringify({
    version: 1,
    ownerPid: pidOccupant.pid,
    daemonPid: null,
    tunnelPid: null,
    status: "failed",
    updatedAt: new Date().toISOString(),
  })}\n`);
  try {
    assert.deepEqual(await supervisor.startConfigured(), { status: "not-configured" });
    assert.equal(fs.existsSync(supervisor.statePath), false);
  } finally {
    pidOccupant.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
