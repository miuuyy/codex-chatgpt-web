const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

const LINUX_DESKTOP_NAME = "dev.codexwebgpt.launcher.desktop";

function linuxDesktopPath() {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(configHome, "autostart", LINUX_DESKTOP_NAME);
}

function desktopExecArgument(value) {
  return `"${String(value)
    .replaceAll("%", "%%")
    .replace(/["`$\\]/g, "\\$&")}"`;
}

function linuxExecutable(app) {
  const stableLauncher = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE?.trim();
  if (stableLauncher && path.isAbsolute(stableLauncher)) return stableLauncher;
  const appImage = process.env.CODEX_WEB_GPT_APPIMAGE?.trim() || process.env.APPIMAGE?.trim();
  if (appImage && path.isAbsolute(appImage)) return appImage;
  return app.getPath("exe");
}

function linuxDesktopEntry(app, executable = linuxExecutable(app)) {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Codex Web GPT
Comment=Start the Codex Web GPT launcher in the background
Exec=${desktopExecArgument(executable)} --hidden
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

function linuxAutostartMatches(app) {
  const target = linuxDesktopPath();
  try {
    return fs.readFileSync(target, "utf8") === linuxDesktopEntry(app);
  } catch {
    return false;
  }
}

function requireAutostartState(result, desired) {
  if (result.supported && result.enabled !== Boolean(desired)) {
    throw new Error(`The operating system did not ${desired ? "enable" : "disable"} launcher autostart`);
  }
  return result;
}

function setAutostart(app, enabled) {
  if (!app.isPackaged) return { supported: false, enabled: Boolean(enabled) };
  if (process.platform === "linux") {
    const target = linuxDesktopPath();
    if (enabled) {
      writePrivateFileAtomic(target, linuxDesktopEntry(app));
    } else {
      fs.rmSync(target, { force: true });
    }
    return requireAutostartState({
      supported: true,
      enabled: enabled ? linuxAutostartMatches(app) : false,
    }, enabled);
  }
  if (process.platform === "darwin") {
    // `args` is Windows-only and `openAsHidden` stopped working on macOS 13, which is the
    // launcher's minimum version, so a macOS login item carries no hidden-start hint at all.
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return requireAutostartState({
      supported: true,
      enabled: app.getLoginItemSettings().openAtLogin === true,
    }, enabled);
  }
  if (process.platform === "win32") {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      args: ["--hidden"],
    });
    return requireAutostartState({
      supported: true,
      enabled: app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin === true,
    }, enabled);
  }
  return { supported: false, enabled: false };
}

// macOS cannot deliver `--hidden` from a login item, so hidden startup has to read this instead of
// argv. Windows and Linux keep using the launch argument.
function wasOpenedAtLogin(app) {
  if (!app.isPackaged || process.platform !== "darwin") return false;
  return app.getLoginItemSettings().wasOpenedAtLogin === true;
}

function getAutostart(app) {
  if (!app.isPackaged) return { supported: false, enabled: false };
  if (process.platform === "linux") {
    return { supported: true, enabled: linuxAutostartMatches(app) };
  }
  if (process.platform === "darwin") {
    return { supported: true, enabled: app.getLoginItemSettings().openAtLogin === true };
  }
  if (process.platform === "win32") {
    return {
      supported: true,
      enabled: app.getLoginItemSettings({ args: ["--hidden"] }).openAtLogin === true,
    };
  }
  return { supported: false, enabled: false };
}

module.exports = {
  LINUX_DESKTOP_NAME,
  getAutostart,
  linuxAutostartMatches,
  linuxDesktopEntry,
  linuxDesktopPath,
  requireAutostartState,
  setAutostart,
  wasOpenedAtLogin,
};
