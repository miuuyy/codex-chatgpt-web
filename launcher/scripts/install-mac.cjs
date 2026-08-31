const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const installedApp = "/Applications/Codex Web GPT.app";
const installedExecutable = path.join(installedApp, "Contents", "MacOS", "Codex Web GPT");
const electronBuilderCli = require.resolve("electron-builder/out/cli/cli.js", { paths: [launcherRoot] });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || launcherRoot,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    timeout: options.timeout || 180_000,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${result.stderr?.trim() || result.stdout?.trim() || "no output"}`,
    );
  }
  return result;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function launcherPids() {
  const escaped = installedExecutable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const result = spawnSync("/usr/bin/pgrep", ["-f", `^${escaped}$`], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 1) return [];
  if (result.status !== 0) throw new Error(`Could not inspect the installed launcher process: ${result.stderr.trim()}`);
  return result.stdout.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
}

async function stopInstalledLauncher() {
  const pids = launcherPids();
  for (const pid of pids) process.kill(pid, "SIGTERM");
  if (pids.length === 0) return;
  const deadline = Date.now() + 30_000;
  while (pids.some(processAlive)) {
    if (Date.now() >= deadline) {
      throw new Error("Codex Web GPT did not finish its graceful shutdown; the installed app was not replaced");
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function findBuiltApp(staging) {
  const matches = fs.readdirSync(staging, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(staging, entry.name, "Codex Web GPT.app"))
    .filter(candidate => fs.existsSync(path.join(candidate, "Contents", "MacOS", "Codex Web GPT")));
  if (matches.length !== 1) {
    throw new Error(`Expected one built Codex Web GPT.app in ${staging}; found ${matches.length}`);
  }
  return matches[0];
}

function installBuiltApp(source) {
  const next = `${installedApp}.installing-${process.pid}`;
  fs.rmSync(next, { recursive: true, force: true });
  try {
    run("/usr/bin/ditto", [source, next]);
    if (!fs.existsSync(path.join(next, "Contents", "MacOS", "Codex Web GPT"))) {
      throw new Error("The staged Codex Web GPT application is incomplete");
    }
    fs.rmSync(installedApp, { recursive: true, force: true });
    fs.renameSync(next, installedApp);
  } finally {
    fs.rmSync(next, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== "darwin") throw new Error("Direct launcher installation is supported only on macOS");
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-install-"));
  const env = { ...process.env };
  if (!env.CSC_LINK && !env.CSC_NAME) env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  try {
    const args = [
      electronBuilderCli,
      "--mac",
      "--dir",
      "--publish",
      "never",
      `--config.directories.output=${staging}`,
    ];
    if (!env.CSC_LINK && !env.CSC_NAME) args.push("--config.mac.identity=-");
    run("node", args, { env, stdio: "inherit" });
    const builtApp = findBuiltApp(staging);
    await stopInstalledLauncher();
    installBuiltApp(builtApp);
    const child = spawn("/usr/bin/open", [installedApp], { detached: true, stdio: "ignore" });
    child.unref();
    process.stdout.write(`Installed and opened ${installedApp}\n`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (require.main === module) {
  void main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { findBuiltApp, installBuiltApp };
