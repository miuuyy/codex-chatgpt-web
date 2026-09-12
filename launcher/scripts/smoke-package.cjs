const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { validateRuntimeBundle } = require("../electron/runtime-install.cjs");

const launcherRoot = path.resolve(__dirname, "..");
const artifactsDirectory = path.join(launcherRoot, "artifacts");
const launcherManifest = JSON.parse(
  fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"),
);
const expectedVersion = launcherManifest.version;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-package-smoke-"));
const markerPath = path.join(scratch, "ready.json");
const coreHome = path.join(scratch, "core-home");
let macAppBundle;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || scratch,
    env: options.env || process.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout || 45_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${result.stderr?.trim() || result.stdout?.trim() || "no output"}`,
    );
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function killWindowsLauncher() {
  spawnSync("taskkill.exe", ["/F", "/T", "/IM", `${launcherManifest.build.productName}.exe`], {
    encoding: "utf8",
    windowsHide: true,
  });
}

function killSmokeProcess(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/F", "/T", "/PID", String(child.pid)], {
      encoding: "utf8",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
}

// NSIS runAfterFinish launches the app without smoke flags and holds the single-instance lock.
// spawnSync then waits for a second instance that never writes the marker and never exits.
function runUntilSmokeMarker(command, args, options = {}) {
  const timeout = options.timeout || 90_000;
  const child = spawn(command, args, {
    cwd: options.cwd || scratch,
    env: options.env || process.env,
    stdio: "ignore",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const deadline = Date.now() + timeout;
  try {
    while (!fs.existsSync(markerPath)) {
      if (Date.now() > deadline) {
        throw new Error(
          `Packaged launcher did not write its readiness marker within ${timeout}ms`
            + ` (command=${command})`,
        );
      }
      if (child.exitCode !== null) {
        throw new Error(
          `Packaged launcher exited with status ${child.exitCode} before writing its readiness marker`,
        );
      }
      sleep(200);
    }
  } finally {
    killSmokeProcess(child);
    if (process.platform === "win32") killWindowsLauncher();
  }
}

function windowsInstallLocation() {
  const guid = launcherManifest.build.nsis.guid;
  const registryKey = `HKCU\\Software\\${guid}`;
  const result = spawnSync("reg.exe", ["query", registryKey, "/v", "InstallLocation"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Windows installer did not register ${registryKey}: ${result.stderr?.trim() || "no output"}`);
  }
  const match = result.stdout.match(/^\s*InstallLocation\s+REG_SZ\s+(.+?)\s*$/mi);
  if (!match || !path.win32.isAbsolute(match[1])) {
    throw new Error(`Windows installer registered an invalid InstallLocation: ${result.stdout.trim()}`);
  }
  return match[1];
}

function artifact(pattern, label) {
  const matches = fs.readdirSync(artifactsDirectory)
    .filter((name) => pattern.test(name))
    .sort();
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} in ${artifactsDirectory}; found ${matches.join(", ") || "none"}`);
  }
  return path.join(artifactsDirectory, matches[0]);
}

function smokeEnvironment() {
  return {
    ...process.env,
    TMPDIR: scratch,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(scratch, "launcher-data"),
    CODEX_CHATGPT_WEB_HOME: coreHome,
    CODEX_HOME: path.join(scratch, "codex-home"),
    CODEX_WEB_GPT_SMOKE_FILE: markerPath,
    ELECTRON_DISABLE_GPU: "1",
  };
}

try {
  let executable;
  let command;
  let args;
  const env = smokeEnvironment();

  if (process.platform === "darwin") {
    const archive = artifact(/-mac-(?:arm64|x64)\.zip$/, "macOS launcher archive");
    const stage = path.join(scratch, "stage");
    fs.mkdirSync(stage);
    run("ditto", ["-x", "-k", archive, stage]);
    macAppBundle = path.join(stage, "Codex Web GPT.app");
    executable = path.join(macAppBundle, "Contents", "MacOS", "Codex Web GPT");
    command = executable;
    args = ["--launcher-smoke-test"];
  } else if (process.platform === "linux") {
    executable = artifact(/-linux-x64\.AppImage$/, "Linux AppImage");
    fs.chmodSync(executable, 0o755);
    run(path.join(launcherRoot, "scripts", "smoke-linux-appimage-symbols.sh"), [executable], {
      timeout: 120_000,
    });
    command = "xvfb-run";
    args = ["-a", executable, "--launcher-smoke-test"];
    env.APPIMAGE_EXTRACT_AND_RUN = "1";
  } else if (process.platform === "win32") {
    const installer = artifact(/-win-x64\.exe$/, "Windows installer");
    run(installer, ["/S", "/currentuser"], { timeout: 120_000 });
    // The NSIS package starts the app after install. That instance is not the smoke process.
    killWindowsLauncher();
    sleep(500);
    killWindowsLauncher();
    executable = path.join(windowsInstallLocation(), `${launcherManifest.build.productName}.exe`);
    command = executable;
    args = ["--launcher-smoke-test"];
  } else {
    throw new Error(`Unsupported package smoke platform: ${process.platform}`);
  }

  if (!fs.existsSync(executable)) throw new Error(`Packaged launcher executable is missing: ${executable}`);
  runUntilSmokeMarker(command, args, { env, timeout: process.platform === "win32" ? 120_000 : 90_000 });
  if (!fs.existsSync(markerPath)) throw new Error("Packaged launcher did not write its readiness marker");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  if (marker.ok !== true
    || marker.packaged !== true
    || marker.runtimeVerified !== true
    || marker.version !== expectedVersion
    || marker.platform !== process.platform) {
    throw new Error(`Unexpected packaged launcher marker: ${JSON.stringify(marker)}`);
  }
  const installedRuntime = path.join(
    coreHome,
    "versions",
    `${expectedVersion}-${process.platform}-${process.arch}`,
  );
  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(installedRuntime, "manifest.json"), "utf8"),
  );
  validateRuntimeBundle(installedRuntime, {
    version: expectedVersion,
    platform: process.platform,
    arch: process.arch,
  });
  if (installedManifest.schemaVersion !== 2
    || installedManifest.appVersion !== expectedVersion
    || installedManifest.platform !== process.platform
    || installedManifest.arch !== process.arch
    || !Array.isArray(installedManifest.files)
    || installedManifest.files.length === 0
    || !/^[a-f0-9]{64}$/.test(installedManifest.bundleId)) {
    throw new Error(`Packaged launcher installed the wrong durable runtime: ${JSON.stringify(installedManifest)}`);
  }
  process.stdout.write(`PACKAGED_LAUNCHER_SMOKE_OK ${process.platform}/${process.arch}\n`);
} finally {
  try {
    if (macAppBundle) {
      const launchServices =
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
      run(
        launchServices,
        ["-u", macAppBundle],
      );
      run(launchServices, ["-gc"]);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
