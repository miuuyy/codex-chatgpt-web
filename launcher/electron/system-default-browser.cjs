const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function commandOutput(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0) return "";
  return result.stdout;
}

function parseMacDefaultBrowserIdentifier(output) {
  const handlers = [];
  let depth = 0;
  let block = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const opening = (line.match(/\{/g) || []).length;
    const closing = (line.match(/\}/g) || []).length;
    if (depth > 0) block.push(line);
    if (opening > 0 && depth === 0) block = [line];
    depth += opening - closing;
    if (depth === 0 && block.length > 0) {
      handlers.push(block.join("\n"));
      block = [];
    }
  }

  let httpsIdentifier = null;
  let contentTypeIdentifier = null;
  for (const handler of handlers) {
    const roles = [...handler.matchAll(/LSHandlerRole(?:All|Viewer)\s*=\s*["']?([^;"'\s]+)["']?\s*;/gi)]
      .map(match => match[1].trim())
      .filter(value => value !== "-");
    const identifier = roles.at(-1);
    if (!identifier) continue;
    const scheme = handler.match(/LSHandlerURLScheme\s*=\s*["']?([^;"'\s]+)["']?\s*;/i)?.[1]?.toLowerCase();
    if (scheme === "http") return identifier;
    if (scheme === "https") httpsIdentifier = identifier;
    if (handler.includes('LSHandlerContentType = "com.apple.default-app.web-browser"')) {
      contentTypeIdentifier = identifier;
    }
  }
  return httpsIdentifier || contentTypeIdentifier;
}

function parseWindowsDefaultBrowserIdentifier(output) {
  return String(output || "").match(/ProgId\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim() || null;
}

function parseLinuxDefaultBrowserIdentifier(output) {
  const identifier = String(output || "").trim();
  return identifier || null;
}

function parseWindowsRegistryString(output) {
  return String(output || "").match(/(?:\(Default\)|@)\s+REG_(?:EXPAND_)?SZ\s+(.+)$/im)?.[1]?.trim() || null;
}

function expandWindowsEnvironmentVariables(value, env) {
  return value.replace(/%([^%]+)%/g, (whole, name) => {
    const matchingKey = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
    return matchingKey ? env[matchingKey] : whole;
  });
}

function executableFromWindowsCommand(command, env) {
  const expanded = expandWindowsEnvironmentVariables(command.trim(), env);
  if (!expanded) return null;
  if (expanded.startsWith('"')) {
    const closingQuote = expanded.indexOf('"', 1);
    if (closingQuote < 0) return null;
    return expanded.slice(1, closingQuote);
  }
  return expanded.split(/\s+/, 1)[0] || null;
}

function xdgDataDirectories(env) {
  const home = env.HOME || os.homedir();
  const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":");
  return [...new Set([dataHome, ...dataDirs].filter(Boolean))];
}

function locateLinuxDesktopFile(identifier, env, exists = fs.existsSync) {
  if (!identifier || path.posix.isAbsolute(identifier) || identifier.split(/[\\/]/).includes("..")) return null;
  for (const dataDirectory of xdgDataDirectories(env)) {
    const candidate = path.join(dataDirectory, "applications", identifier);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function tokenizeDesktopExec(value) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaped = false;
  for (const character of String(value || "")) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += character;
    }
  }
  if (escaped) token += "\\";
  if (token) tokens.push(token);
  return tokens;
}

function desktopExecutableToken(desktopEntry) {
  const execLine = String(desktopEntry || "").match(/^Exec\s*=\s*(.*)$/im)?.[1];
  const tokens = tokenizeDesktopExec(execLine);
  let index = 0;
  if (tokens[index] === "env") {
    index += 1;
    while (tokens[index]?.includes("=") && !tokens[index].startsWith("=")) index += 1;
    if (tokens[index] === "--") index += 1;
  }
  return tokens[index] || null;
}

function resolvePathExecutable(token, platform, env, exists = fs.existsSync) {
  if (!token) return null;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (pathApi.isAbsolute(token)) return token;
  const delimiter = platform === "win32" ? ";" : ":";
  const pathValue = env.PATH || env.Path || "";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = pathApi.join(directory, token);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function findMacApplicationBundle(identifier, env, run) {
  if (!/^[A-Za-z0-9._-]+$/.test(identifier)) return null;
  const exactMatch = String(run(
    "mdfind",
    [`kMDItemCFBundleIdentifier == '${identifier}'c`],
    env,
  )).split(/\r?\n/).map(value => value.trim()).find(Boolean);
  if (exactMatch) return exactMatch;

  const applications = String(run(
    "mdfind",
    ["kMDItemContentType == 'com.apple.application-bundle'"],
    env,
  )).split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const indexedApplications = applications.length > 0
    ? applications
    : ["/Applications", path.join(env.HOME || os.homedir(), "Applications"), "/System/Applications"]
      .flatMap(root => String(run("find", [root, "-maxdepth", "2", "-type", "d", "-name", "*.app", "-print"], env))
        .split(/\r?\n/).map(value => value.trim()).filter(Boolean));
  for (const application of indexedApplications) {
    const bundleIdentifier = String(run(
      "mdls",
      ["-raw", "-name", "kMDItemCFBundleIdentifier", application],
      env,
    )).trim().replace(/^"|"$/g, "");
    if (bundleIdentifier && bundleIdentifier.toLowerCase() === identifier.toLowerCase()) return application;
  }

  const applicationFromWorkspace = String(run(
    "osascript",
    ["-e", `POSIX path of (path to application id \"${identifier}\")`],
    env,
  )).trim();
  if (applicationFromWorkspace && applicationFromWorkspace.endsWith(".app/")) {
    return applicationFromWorkspace.slice(0, -1);
  }
  return null;
}

function resolveMacDefaultBrowserExecutable({ env, run }) {
  const identifier = parseMacDefaultBrowserIdentifier(run(
    "defaults",
    ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"],
    env,
  ));
  if (!identifier) throw new Error("macOS did not report a default HTTP browser");
  const bundlePath = findMacApplicationBundle(identifier, env, run);
  if (!bundlePath) throw new Error(`macOS could not locate the default browser application: ${identifier}`);
  const executableName = String(run(
    "defaults",
    ["read", path.join(bundlePath, "Contents", "Info"), "CFBundleExecutable"],
    env,
  )).trim();
  if (!executableName || executableName.includes(path.sep)) {
    throw new Error(`macOS could not read the default browser executable: ${bundlePath}`);
  }
  return path.join(bundlePath, "Contents", "MacOS", executableName);
}

function resolveWindowsDefaultBrowserExecutable({ env, run }) {
  const identifier = parseWindowsDefaultBrowserIdentifier(run(
    "reg.exe",
    ["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice", "/v", "ProgId"],
    env,
  ));
  if (!identifier || /[\\/"\0]/.test(identifier) || identifier.includes("..")) {
    throw new Error("Windows did not report a valid default HTTP browser association");
  }
  const command = parseWindowsRegistryString(run(
    "reg.exe",
    ["query", `HKCR\\${identifier}\\shell\\open\\command`, "/ve"],
    env,
  ));
  const executable = executableFromWindowsCommand(command, env);
  if (!executable || !path.win32.isAbsolute(executable)) {
    throw new Error(`Windows could not resolve the default browser command: ${identifier}`);
  }
  return executable;
}

function resolveLinuxDefaultBrowserExecutable({ env, run, exists, read }) {
  const identifier = parseLinuxDefaultBrowserIdentifier(run(
    "xdg-settings",
    ["get", "default-url-scheme-handler", "http"],
    env,
  )) || parseLinuxDefaultBrowserIdentifier(run("xdg-settings", ["get", "default-web-browser"], env));
  if (!identifier) throw new Error("Linux did not report a default HTTP browser");
  const desktopFile = locateLinuxDesktopFile(identifier, env, exists);
  if (!desktopFile) throw new Error(`Linux could not locate the default browser desktop entry: ${identifier}`);
  const token = desktopExecutableToken(read(desktopFile, "utf8"));
  const executable = resolvePathExecutable(token, "linux", env, exists);
  if (!executable) throw new Error(`Linux could not resolve the default browser executable: ${identifier}`);
  return executable;
}

function resolveSystemDefaultBrowserExecutable({
  platform = process.platform,
  env = process.env,
  run = commandOutput,
  exists = fs.existsSync,
  read = fs.readFileSync,
} = {}) {
  if (platform === "darwin") return resolveMacDefaultBrowserExecutable({ env, run });
  if (platform === "win32") return resolveWindowsDefaultBrowserExecutable({ env, run });
  if (platform === "linux") return resolveLinuxDefaultBrowserExecutable({ env, run, exists, read });
  throw new Error(`Default-browser discovery is not supported on ${platform}`);
}

module.exports = {
  desktopExecutableToken,
  executableFromWindowsCommand,
  parseLinuxDefaultBrowserIdentifier,
  parseMacDefaultBrowserIdentifier,
  parseWindowsDefaultBrowserIdentifier,
  parseWindowsRegistryString,
  resolveSystemDefaultBrowserExecutable,
  tokenizeDesktopExec,
};
