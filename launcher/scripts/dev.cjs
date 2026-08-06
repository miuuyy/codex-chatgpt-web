const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const {
  DETACH_OWNED_CHILD,
  terminateOwnedProcessTree,
} = require("../electron/process-tree.cjs");

const root = path.resolve(__dirname, "..");
const vitePackage = require.resolve("vite/package.json", { paths: [root] });
const viteBin = path.join(path.dirname(vitePackage), "bin", "vite.js");
const electronBin = require("electron");
const bun = process.env.CODEX_WEB_GPT_BUN || process.execPath;

const helperBuild = spawnSync(bun, ["run", "scripts/build-browser-helper.ts"], {
  cwd: path.resolve(root, ".."),
  env: process.env,
  stdio: "inherit",
});
if (helperBuild.error) throw helperBuild.error;
if (helperBuild.status !== 0) process.exit(helperBuild.status ?? 1);

const helperWatcher = spawn(bun, ["run", "scripts/build-browser-helper.ts", "--watch"], {
  cwd: path.resolve(root, ".."),
  env: process.env,
  stdio: "inherit",
  detached: DETACH_OWNED_CHILD,
  windowsHide: true,
});

const vite = spawn(process.execPath, [viteBin], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

let electron;
let stopped = false;

const stop = () => {
  if (stopped) return;
  stopped = true;
  electron?.kill("SIGTERM");
  vite.kill("SIGTERM");
  try {
    terminateOwnedProcessTree(helperWatcher);
  } catch (error) {
    console.error(`Browser helper watcher shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const waitForVite = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:4178");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Vite did not become ready on 127.0.0.1:4178");
};

void waitForVite().then(() => {
  electron = spawn(electronBin, [root], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: "http://127.0.0.1:4178",
      CODEX_WEB_GPT_BUN: bun,
      CODEX_CHATGPT_WEB_BUN: bun,
    },
  });
  electron.once("exit", (code) => {
    stop();
    process.exitCode = code ?? 0;
  });
  electron.once("error", (error) => {
    console.error(`Electron failed to start: ${error.message}`);
    stop();
    process.exitCode = 1;
  });
}).catch((error) => {
  console.error(error);
  stop();
  process.exitCode = 1;
});

vite.once("exit", (code) => {
  if (!stopped && code !== 0) {
    console.error(`Vite exited with code ${code}`);
    stop();
    process.exitCode = code ?? 1;
  }
});

helperWatcher.once("error", (error) => {
  if (stopped) return;
  console.error(`Browser helper watcher failed to start: ${error.message}`);
  stop();
  process.exitCode = 1;
});

helperWatcher.once("exit", (code) => {
  if (stopped) return;
  console.error(`Browser helper watcher exited with code ${code ?? 1}`);
  stop();
  process.exitCode = code === 0 ? 1 : code ?? 1;
});

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
