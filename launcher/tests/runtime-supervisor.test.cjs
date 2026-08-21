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
    useEnhancedWebSessionMode: false,
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
