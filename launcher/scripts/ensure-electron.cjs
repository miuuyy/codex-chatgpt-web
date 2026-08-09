const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const launcherRoot = path.resolve(__dirname, "..");

function platformExecutablePath(platform) {
  switch (platform) {
    case "darwin":
    case "mas":
      return "Electron.app/Contents/MacOS/Electron";
    case "win32":
      return "electron.exe";
    case "freebsd":
    case "linux":
    case "openbsd":
      return "electron";
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

function electronPackage() {
  const manifestPath = require.resolve("electron/package.json", { paths: [launcherRoot] });
  const packageRoot = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return { manifest, packageRoot };
}

function installationStatus({ manifest, packageRoot }) {
  const platform = process.env.npm_config_platform || process.platform;
  const expectedPath = platformExecutablePath(platform);
  const pathFile = path.join(packageRoot, "path.txt");
  const versionFile = path.join(packageRoot, "dist", "version");

  let installedPath;
  let installedVersion;
  try {
    installedPath = fs.readFileSync(pathFile, "utf8").trim();
    installedVersion = fs.readFileSync(versionFile, "utf8").trim().replace(/^v/, "");
  } catch {
    return { ok: false, reason: "Electron's install markers are missing" };
  }

  if (installedVersion !== manifest.version) {
    return {
      ok: false,
      reason: `Electron runtime version is ${installedVersion || "missing"}; expected ${manifest.version}`,
    };
  }
  if (installedPath !== expectedPath) {
    return {
      ok: false,
      reason: `Electron runtime path is ${installedPath || "missing"}; expected ${expectedPath}`,
    };
  }

  const distRoot = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(packageRoot, "dist");
  const executable = path.join(distRoot, installedPath);
  if (!fs.existsSync(executable)) {
    return { ok: false, reason: `Electron executable is missing: ${executable}` };
  }

  return { ok: true, executable };
}

function ensureElectron() {
  const electron = electronPackage();
  const current = installationStatus(electron);
  if (current.ok) return current.executable;

  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    throw new Error(
      `${current.reason}. ELECTRON_OVERRIDE_DIST_PATH is set, so the launcher cannot repair the custom Electron runtime.`,
    );
  }
  if (!fs.existsSync(path.join(electron.packageRoot, "install.js"))) {
    throw new Error(`${current.reason}. Electron's install script is missing from ${electron.packageRoot}.`);
  }

  process.stderr.write(`Electron runtime is incomplete (${current.reason}); downloading it now...\n`);
  const env = { ...process.env, force_no_cache: "true" };
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  const result = spawnSync(process.execPath, [path.join(electron.packageRoot, "install.js")], {
    cwd: electron.packageRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Electron's runtime download failed with exit code ${result.status ?? 1}`);
  }

  const repaired = installationStatus(electron);
  if (!repaired.ok) {
    throw new Error(`Electron's runtime is still incomplete after repair: ${repaired.reason}`);
  }
  process.stderr.write(`Electron runtime ready: ${repaired.executable}\n`);
  return repaired.executable;
}

module.exports = { ensureElectron, installationStatus, platformExecutablePath };

if (require.main === module) ensureElectron();
