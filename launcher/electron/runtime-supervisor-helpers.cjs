const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { readJsonFile } = require("./json-file.cjs");
const { redactText } = require("./logging.cjs");
const {
  DETACH_OWNED_CHILD,
  processRunning,
  terminateOwnedProcessTree,
} = require("./process-tree.cjs");
const { runtimeInvocation } = require("./runtime-command.cjs");

const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 5;
const MAX_RUNTIME_LOG_LINE_CHARS = 64 * 1024;
const MAX_CONTROL_OUTPUT_BYTES = 1024 * 1024;
const DRAIN_IDLE_TIMEOUT_MS = 15_000;
const DRAIN_POLL_INTERVAL_MS = 100;
const TUNNEL_START_TIMEOUT_MS = 120_000;
const TUNNEL_HEALTH_POLL_INTERVAL_MS = 1_000;
const TUNNEL_MONITOR_INTERVAL_MS = 10_000;
const TUNNEL_MONITOR_FAILURE_THRESHOLD = 3;
const TUNNEL_MCP_CONNECTION_MAX_TTL = "24h";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function collectLines(stream, onLine, onError) {
  let buffered = "";
  stream.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trimEnd();
      buffered = buffered.slice(newline + 1);
      if (line) onLine(line);
    }
    if (buffered.length > MAX_RUNTIME_LOG_LINE_CHARS) {
      onLine(`${buffered.slice(0, MAX_RUNTIME_LOG_LINE_CHARS)}…[truncated]`);
      buffered = "";
    }
  });
  stream.on("end", () => {
    const line = buffered.trim();
    if (line) onLine(line);
  });
  stream.on("error", (error) => onError?.(error));
}

function loopbackHealthBaseURL(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:"
      || !["127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)
      || !parsed.port) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function readJson(pathname) {
  return readJsonFile(pathname);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function appendFailure(primary, label, failure) {
  return `${primary}; ${label}: ${errorMessage(failure)}`;
}

function absolutePath(value, platform = process.platform) {
  return platform === "win32" ? path.win32.isAbsolute(value) : path.isAbsolute(value);
}

function pathIdentity(value, platform = process.platform) {
  const normalized = platform === "win32" ? path.win32.resolve(value) : path.resolve(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function windowsPipeEndpoint(value) {
  return /^\\\\\.\\pipe\\[A-Za-z0-9._-]+$/.test(value);
}

function tunnelRuntimeAbsent(value) {
  return /not found|not running|unknown alias|\balias\b[^\r\n]{0,160}\bis not known\b/i.test(
    String(value || ""),
  );
}

function tunnelRuntimeStopped(health) {
  return health?.absent === true
    || (health?.state === "stopped" && health?.processRunning === false);
}

function runtimeOwnershipMayBeLive(state) {
  if (!state) return false;
  if (processRunning(state.daemonPid) || processRunning(state.tunnelPid)) return true;
  return ["starting", "ready", "degraded", "stopping"].includes(state.status);
}

function conciseTunnelLog(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const tail = value.trim().split(/\r?\n/).slice(-3).join(" | ");
  const redacted = redactText(tail);
  return redacted.length > 800 ? `…${redacted.slice(-800)}` : redacted;
}

function tunnelControlDiagnostic(result) {
  const stdout = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : "";
  if (stdout) {
    try {
      const parsed = JSON.parse(stdout);
      const logTail = conciseTunnelLog(
        typeof parsed.launch_diagnostics?.log_tail === "string"
          ? parsed.launch_diagnostics.log_tail
          : typeof parsed.local?.log?.tail === "string"
            ? parsed.local.log.tail
            : undefined,
      );
      const error = [parsed.error, parsed.remote_error, parsed.stop_error]
        .find(value => typeof value === "string" && value.trim());
      const state = parsed.runtime_state ?? parsed.state ?? parsed.status;
      const parts = [
        ...(state !== undefined ? [`state=${String(state)}`] : []),
        ...(parsed.process_running !== undefined ? [`process_running=${String(parsed.process_running)}`] : []),
        ...(parsed.healthy !== undefined ? [`healthy=${String(parsed.healthy)}`] : []),
        ...(parsed.ready !== undefined ? [`ready=${String(parsed.ready)}`] : []),
        ...(typeof error === "string" ? [error.trim()] : []),
        ...(logTail ? [`runtime_log=${logTail}`] : []),
      ];
      if (parts.length > 0) return redactText(parts.join("; ")).slice(0, 1_200);
    } catch {
      // Fall through to bounded plain-text diagnostics.
    }
  }
  return redactText([stderr, stdout].filter(Boolean).join("\n") || result?.output || "[no tunnel diagnostic]")
    .slice(0, 1_200);
}

function tunnelCommandQuoted(value) {
  if (typeof value !== "string" || !value || /[\r\n]/.test(value)) {
    throw new Error("Tunnel MCP command values must be non-empty single-line strings");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function managedTunnelMcpCommand(invocation) {
  if (!invocation
    || typeof invocation.executable !== "string"
    || !Array.isArray(invocation.args)) {
    throw new Error("Launcher tunnel MCP command requires an explicit runtime invocation");
  }
  return [invocation.executable, ...invocation.args]
    .map(tunnelCommandQuoted)
    .join(" ");
}

function managedTunnelConnectArgs(config, invocation) {
  const tunnel = config.tunnel;
  if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");
  return [
    "runtimes", "connect",
    "--alias", tunnel.alias,
    "--profile", tunnel.profileName,
    "--profile-dir", tunnel.profileDir,
    "--tunnel-client-bin", tunnel.binaryPath,
    "--tunnel-id", tunnel.tunnelId,
    "--runtime-api-key", `file:${tunnel.runtimeKeyFile}`,
    "--mcp-command", managedTunnelMcpCommand(invocation),
    "--json",
  ];
}

function validateConfig(config, descriptorPath, platform = process.platform) {
  if (!config || config.version !== 3) throw new Error("Runtime configuration is missing or unsupported");
  if (config.solAvailable === undefined) config = { ...config, solAvailable: true };
  if (config.mode !== "browser-only" && config.mode !== "full") {
    throw new Error("Runtime configuration has an invalid mode");
  }
  if (typeof config.releaseVersion !== "string" || !config.releaseVersion.trim()) {
    throw new Error("Runtime configuration has no release version");
  }
  if (config.browserHost !== "launcher") throw new Error("Runtime configuration is not owned by the launcher");
  if (!absolutePath(config.browserHostDescriptorPath || "", platform)
    || pathIdentity(config.browserHostDescriptorPath || "", platform) !== pathIdentity(descriptorPath, platform)) {
    throw new Error("Runtime configuration points to a different launcher browser host");
  }
  if (config.host !== "127.0.0.1"
    || !Number.isInteger(config.port)
    || config.port < 1
    || config.port > 65_535) {
    throw new Error("Runtime configuration has an invalid loopback endpoint");
  }
  if (typeof config.controlToken !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(config.controlToken)) {
    throw new Error("Runtime configuration has an invalid lifecycle control token");
  }
  if (!Number.isSafeInteger(config.contextWindow) || config.contextWindow <= 0) {
    throw new Error("Runtime configuration has an invalid context window");
  }
  if (typeof config.appName !== "string" || !config.appName.trim() || config.appName.length > 80) {
    throw new Error("Runtime configuration has an invalid connector name");
  }
  for (const key of ["chromeExecutablePath", "storageStatePath", "brokerSocketPath"]) {
    if (typeof config[key] !== "string" || !config[key].trim()) {
      throw new Error(`Runtime configuration is missing ${key}`);
    }
  }
  if (platform === "win32") {
    if (!windowsPipeEndpoint(config.brokerSocketPath)) {
      throw new Error("Runtime configuration has an invalid Windows broker pipe");
    }
  } else if (!absolutePath(config.brokerSocketPath, platform) || windowsPipeEndpoint(config.brokerSocketPath)) {
    throw new Error("Runtime configuration has an invalid Unix broker socket");
  }
  for (const key of ["headed", "solAvailable", "proAvailable", "autoApproveToolCalls"]) {
    if (typeof config[key] !== "boolean") {
      throw new Error(`Runtime configuration has an invalid ${key}`);
    }
  }
  if (config.proAvailable && !config.solAvailable) {
    throw new Error("Runtime configuration cannot enable Pro without Sol");
  }
  if (!Array.isArray(config.runtimeCommand)
    || config.runtimeCommand.length === 0
    || config.runtimeCommand.some(part => typeof part !== "string" || !part.trim())) {
    throw new Error("Runtime configuration has an invalid runtime command");
  }
  if (config.mode === "full") {
    if (!config.tunnel || typeof config.tunnel !== "object") {
      throw new Error("Full mode is missing tunnel configuration");
    }
    for (const key of ["binaryPath", "tunnelId", "runtimeKeyFile", "profileDir", "profileName", "alias"]) {
      if (typeof config.tunnel[key] !== "string" || !config.tunnel[key].trim()) {
        throw new Error(`Full mode is missing tunnel.${key}`);
      }
    }
    if (!/^tunnel_[a-f0-9]{32}$/.test(config.tunnel.tunnelId)) {
      throw new Error("Full mode has an invalid tunnel id");
    }
    for (const key of ["profileName", "alias"]) {
      if (!/^[A-Za-z0-9._-]+$/.test(config.tunnel[key])) {
        throw new Error(`Full mode has an invalid tunnel.${key}`);
      }
    }
    for (const key of ["binaryPath", "runtimeKeyFile", "profileDir"]) {
      if (!absolutePath(config.tunnel[key], platform)) {
        throw new Error(`Full mode requires an absolute tunnel.${key}`);
      }
    }
  }
  return config;
}

module.exports = {
  RESTART_WINDOW_MS,
  MAX_RESTARTS_PER_WINDOW,
  MAX_RUNTIME_LOG_LINE_CHARS,
  MAX_CONTROL_OUTPUT_BYTES,
  DRAIN_IDLE_TIMEOUT_MS,
  DRAIN_POLL_INTERVAL_MS,
  TUNNEL_START_TIMEOUT_MS,
  TUNNEL_HEALTH_POLL_INTERVAL_MS,
  TUNNEL_MONITOR_INTERVAL_MS,
  TUNNEL_MONITOR_FAILURE_THRESHOLD,
  TUNNEL_MCP_CONNECTION_MAX_TTL,
  sleep,
  collectLines,
  loopbackHealthBaseURL,
  readJson,
  errorMessage,
  appendFailure,
  absolutePath,
  pathIdentity,
  windowsPipeEndpoint,
  tunnelRuntimeAbsent,
  tunnelRuntimeStopped,
  runtimeOwnershipMayBeLive,
  conciseTunnelLog,
  tunnelControlDiagnostic,
  tunnelCommandQuoted,
  managedTunnelMcpCommand,
  managedTunnelConnectArgs,
  validateConfig,
};
