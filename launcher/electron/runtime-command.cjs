const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Bun 1.3.2 crashes with a Windows x64 segmentation fault (see bun.report/1.3.2/wr1b...). */
const UNSTABLE_BUN_VERSIONS = new Set(["1.3.2"]);

function resolveBunVersion(executable) {
  try {
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    if (result.error || result.status !== 0) return null;
    const version = (result.stdout || "").trim().split(/\r?\n/)[0]?.trim();
    return version || null;
  } catch {
    return null;
  }
}

function isUnstableBunVersion(version) {
  if (!version) return false;
  const majorMinorPatch = version.split("+")[0];
  return UNSTABLE_BUN_VERSIONS.has(majorMinorPatch);
}

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

function resolveBunExecutable() {
  const configured = process.env.CODEX_CHATGPT_WEB_BUN?.trim()
    || process.env.CODEX_WEB_GPT_BUN?.trim();
  if (configured) {
    if (process.platform !== "win32" || /\.exe$/i.test(configured) && fs.existsSync(configured)) {
      return configured;
    }
    // On Windows the configured value may be a .cmd/.bat shim or an
    // extensionless script (e.g. %APPDATA%\npm\bun), which spawn cannot
    // launch (spawn EINVAL). Fall through to real executable discovery.
  }

  if (process.platform !== "win32") return "bun";

  // On Windows a bare "bun" can resolve to the extensionless npm shim
  // (a bash script), which CreateProcess refuses to launch and Node reports
  // as spawn EINVAL. Prefer a real bun.exe from known install locations.
  const candidates = [
    path.join(process.env.APPDATA || "", "npm", "node_modules", "bun", "bin", "bun.exe"),
    path.join(process.env.LOCALAPPDATA || "", "bun", "bin", "bun.exe"),
    path.join(os.homedir(), ".bun", "bin", "bun.exe"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fall back to PATH lookup, preferring a native .exe over a .cmd/.bat shim.
  try {
    const { status, stdout } = require("node:child_process").spawnSync("where", ["bun"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (status === 0) {
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const resolved = lines.find((line) => /\.exe$/i.test(line))
        || lines.find((line) => /\.(cmd|bat)$/i.test(line))
        || lines[0];
      if (resolved) return resolved;
    }
  } catch {
    // ignore lookup failures and fall back to the bare command
  }
  return "bun";
}

function sourceRuntimeInvocation(sourceRoot, args) {
  return {
    executable: resolveBunExecutable(),
    args: ["run", path.join(sourceRoot, "src", "cli.ts"), ...args],
    cwd: sourceRoot,
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
  isUnstableBunVersion,
  packagedRuntimePaths,
  resolveBunVersion,
  runtimeBundlePaths,
  runtimeInvocation,
};
