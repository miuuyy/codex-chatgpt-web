const fs = require("node:fs");
const path = require("node:path");

function runtimeBundlePaths(runtimeRoot, platform = process.platform) {
  return {
    runtimeRoot,
    executable: path.join(runtimeRoot, "runtime", platform === "win32" ? "bun.exe" : "bun"),
    entrypoint: path.join(runtimeRoot, "app", "cli.js"),
  };
}

function packagedRuntimePaths(resourcesPath, platform = process.platform) {
  return runtimeBundlePaths(path.join(resourcesPath, "runtime"), platform);
}

function sourceRuntimeInvocation(sourceRoot, args) {
  return {
    executable: process.env.CODEX_CHATGPT_WEB_BUN?.trim()
      || process.env.CODEX_WEB_GPT_BUN?.trim()
      || "bun",
    args: ["run", path.join(sourceRoot, "src", "cli.ts"), ...args],
    cwd: sourceRoot,
  };
}

function nodeBrowserLoginInvocation({ app, sourceRoot, installedRuntimeRoot, args }) {
  if (!Array.isArray(args)) throw new Error("Runtime arguments must be an array");
  if (!app.isPackaged) {
    return {
      executable: "node",
      args: ["--import", "tsx", path.join(sourceRoot, "src", "cli.ts"), ...args],
      cwd: sourceRoot,
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  if (!installedRuntimeRoot || !path.isAbsolute(installedRuntimeRoot)) {
    throw new Error("Packaged launcher runtime has not been installed into durable local storage");
  }
  const entrypoint = path.join(installedRuntimeRoot, "app", "cli-node.cjs");
  if (!fs.existsSync(entrypoint)) throw new Error(`Bundled Node login entrypoint is missing: ${entrypoint}`);
  return {
    executable: process.execPath,
    args: [entrypoint, ...args],
    cwd: installedRuntimeRoot,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function runtimeInvocation({ app, sourceRoot, installedRuntimeRoot, args }) {
  if (!Array.isArray(args)) throw new Error("Runtime arguments must be an array");
  if (!app.isPackaged) return sourceRuntimeInvocation(sourceRoot, args);

  if (!installedRuntimeRoot || !path.isAbsolute(installedRuntimeRoot)) {
    throw new Error("Packaged launcher runtime has not been installed into durable local storage");
  }
  const { runtimeRoot, executable, entrypoint } = runtimeBundlePaths(installedRuntimeRoot);
  if (!fs.existsSync(executable)) throw new Error(`Bundled Bun runtime is missing: ${executable}`);
  if (!fs.existsSync(entrypoint)) throw new Error(`Bundled runtime entrypoint is missing: ${entrypoint}`);
  return {
    executable,
    args: [entrypoint, ...args],
    cwd: runtimeRoot,
  };
}

function embeddedRuntimeInvocation({ app, sourceRoot, args }) {
  if (!Array.isArray(args)) throw new Error("Runtime arguments must be an array");
  if (!app.isPackaged) return sourceRuntimeInvocation(sourceRoot, args);
  const { runtimeRoot, executable, entrypoint } = packagedRuntimePaths(process.resourcesPath);
  if (!fs.existsSync(executable)) throw new Error(`Embedded Bun runtime is missing: ${executable}`);
  if (!fs.existsSync(entrypoint)) throw new Error(`Embedded runtime entrypoint is missing: ${entrypoint}`);
  return {
    executable,
    args: [entrypoint, ...args],
    cwd: runtimeRoot,
  };
}

module.exports = {
  embeddedRuntimeInvocation,
  nodeBrowserLoginInvocation,
  packagedRuntimePaths,
  runtimeBundlePaths,
  runtimeInvocation,
};
