const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { redactText } = require("./logging.cjs");
const { DETACH_OWNED_CHILD, processRunning, terminateOwnedProcessTree } = require("./process-tree.cjs");
const { runtimeInvocation } = require("./runtime-command.cjs");
const helpers = require("./runtime-supervisor-helpers.cjs");
const { RESTART_WINDOW_MS, MAX_RESTARTS_PER_WINDOW, MAX_RUNTIME_LOG_LINE_CHARS, MAX_CONTROL_OUTPUT_BYTES, DRAIN_IDLE_TIMEOUT_MS, DRAIN_POLL_INTERVAL_MS, TUNNEL_START_TIMEOUT_MS, TUNNEL_HEALTH_POLL_INTERVAL_MS, TUNNEL_MONITOR_INTERVAL_MS, TUNNEL_MONITOR_FAILURE_THRESHOLD, sleep, collectLines, loopbackHealthBaseURL, readJson, errorMessage, appendFailure, absolutePath, pathIdentity, windowsPipeEndpoint, tunnelRuntimeAbsent, tunnelRuntimeStopped, runtimeOwnershipMayBeLive, conciseTunnelLog, tunnelControlDiagnostic, tunnelCommandQuoted, managedTunnelMcpCommand, managedTunnelConnectArgs, validateConfig } = helpers;

const tunnelMethods = require("./runtime-supervisor-tunnel.cjs");
const startupMethods = require("./runtime-supervisor-startup.cjs");
const controlMethods = require("./runtime-supervisor-control.cjs");
const stopMethods = require("./runtime-supervisor-stop.cjs");

class RuntimeSupervisor {
  constructor({
    app,
    logger,
    sourceRoot,
    installedRuntimeRoot,
    runtimeRootProvider,
    coreHome,
    browserDescriptorPath,
    publishOperation,
    runtimeInvocationFactory = runtimeInvocation,
  }) {
    this.app = app;
    this.logger = logger;
    this.sourceRoot = sourceRoot;
    this.installedRuntimeRoot = installedRuntimeRoot;
    this.runtimeRootProvider = runtimeRootProvider;
    this.coreHome = coreHome;
    this.browserDescriptorPath = browserDescriptorPath;
    this.publishOperation = publishOperation;
    this.runtimeInvocationFactory = runtimeInvocationFactory;
    this.configPath = path.join(coreHome, "config.json");
    this.statePath = path.join(coreHome, "runtime", "launcher-supervisor.json");
    this.daemon = null;
    this.tunnel = null;
    this.stopping = false;
    this.startPromise = null;
    this.stopPromise = null;
    this.restartHistory = { daemon: [], tunnel: [] };
    this.restartTimers = { daemon: null, tunnel: null };
    this.tunnelMonitorTimer = null;
    this.tunnelMonitorInFlight = false;
    this.tunnelMonitorFailures = 0;
    this.tunnelMonitorObservationUnavailable = false;
    this.tunnelMonitorGeneration = 0;
    this.tunnelHealthBaseUrl = null;
    this.recoveryTasks = new Set();
    this.expectedExits = new WeakSet();
    this.restartableChildren = new WeakSet();
    this.lastChildFailure = { daemon: null, tunnel: null };
    this.lastChildOutput = { daemon: null, tunnel: null };
  }

  readConfig() {
    if (!fs.existsSync(this.configPath)) return null;
    return validateConfig(readJson(this.configPath), this.browserDescriptorPath);
  }

  readSetupConfig() {
    if (!fs.existsSync(this.configPath)) return null;
    const config = readJson(this.configPath);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("Runtime configuration is not an object");
    }
    const mode = config.mode === "pro-only" ? "browser-only" : config.mode;
    if (mode !== "browser-only" && mode !== "full") {
      throw new Error("Runtime configuration has an invalid setup mode");
    }
    return { ...config, mode };
  }

  readState() {
    if (!fs.existsSync(this.statePath)) return null;
    try {
      const state = readJson(this.statePath);
      const validPid = (value) => value === null || (Number.isInteger(value) && value > 0);
      if (!state
        || state.version !== 1
        || !Number.isInteger(state.ownerPid)
        || state.ownerPid < 1
        || !validPid(state.daemonPid)
        || !validPid(state.tunnelPid)
        || typeof state.status !== "string"
        || typeof state.updatedAt !== "string"
        || Number.isNaN(Date.parse(state.updatedAt))) {
        throw new Error("state shape is invalid");
      }
      return state;
    } catch (error) {
      throw new Error(`Launcher runtime ownership state is invalid at ${this.statePath}: ${errorMessage(error)}`);
    }
  }

  snapshot(status = "idle", detail) {
    return {
      version: 1,
      ownerPid: process.pid,
      daemonPid: this.daemon?.pid ?? null,
      tunnelPid: this.tunnel?.pid ?? null,
      status,
      ...(detail ? { detail } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  writeState(status, detail) {
    const state = this.snapshot(status, detail);
    writePrivateFileAtomic(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  tryWriteState(status, detail) {
    try {
      this.writeState(status, detail);
      return true;
    } catch (error) {
      const message = `Could not persist launcher runtime ownership: ${errorMessage(error)}`;
      this.stopping = true;
      for (const name of ["daemon", "tunnel"]) {
        if (this.restartTimers[name]) {
          clearTimeout(this.restartTimers[name]);
          this.restartTimers[name] = null;
        }
      }
      this.logger.error("runtime.state_write_failed", { status, message });
      this.publishOperation?.({ name: "runtime-supervisor", status: "failed", message });
      return false;
    }
  }

  clearState() {
    fs.rmSync(this.statePath, { force: true });
  }

  prepareExternalMigration() {
    if (this.daemon || this.tunnel) {
      throw new Error("Launcher-owned runtime children exist while an external installation is configured");
    }
    const state = this.readState();
    if (state && (
      processRunning(state.ownerPid)
      || processRunning(state.daemonPid)
      || processRunning(state.tunnelPid)
    )) {
      throw new Error("Launcher ownership processes are still alive while an external installation is configured");
    }
    this.clearState();
  }

  writeExternalState(detail) {
    const existing = this.readState();
    const preservesLiveOwnership = existing && (
      processRunning(existing.ownerPid)
      || processRunning(existing.daemonPid)
      || processRunning(existing.tunnelPid)
    );
    if (!preservesLiveOwnership) this.writeState("external", detail);
  }

  spawnChild(name, invocation) {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      detached: DETACH_OWNED_CHILD,
      env: {
        ...process.env,
        CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: this.browserDescriptorPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this[name] = child;
    this.lastChildFailure[name] = null;
    this.lastChildOutput[name] = null;
    collectLines(child.stdout, (line) => {
      this.lastChildOutput[name] = redactText(line).slice(0, 1_000);
      this.logger.info(`runtime.${name}_stdout`, { line });
    }, (error) => {
      this.logger.warn(`runtime.${name}_stdout_unavailable`, { message: errorMessage(error) });
    });
    collectLines(child.stderr, (line) => {
      this.lastChildOutput[name] = redactText(line).slice(0, 1_000);
      this.logger.warn(`runtime.${name}_stderr`, { line });
    }, (error) => {
      this.logger.warn(`runtime.${name}_stderr_unavailable`, { message: errorMessage(error) });
    });
    let terminalHandled = false;
    const handleTerminal = ({ code = null, signal = null, error = null }) => {
      if (terminalHandled) return;
      terminalHandled = true;
      const expected = this.stopping || this.expectedExits.has(child);
      this.expectedExits.delete(child);
      const restartable = this.restartableChildren.has(child);
      this.restartableChildren.delete(child);
      if (this[name] === child) this[name] = null;
      const detail = error
        ? `${name} failed to start: ${error.message}`
        : `${name} exited (${signal || code})`
          + (this.lastChildOutput[name] ? `: ${this.lastChildOutput[name]}` : "");
      this.lastChildFailure[name] = detail;
      const statePersisted = this.tryWriteState(expected ? "stopping" : "degraded", detail);
      this.logger[expected ? "info" : "error"](
        error ? `runtime.${name}_spawn_failed` : `runtime.${name}_exited`,
        error ? { message: error.message } : { code, signal },
      );
      if (!expected && restartable && statePersisted) this.scheduleRecovery(name);
    };
    child.once("error", (error) => {
      if (!Number.isInteger(child.pid)) {
        handleTerminal({ error });
        return;
      }
      this.logger.error(`runtime.${name}_process_error`, { message: error.message, pid: child.pid });
    });
    child.once("exit", (code, signal) => handleTerminal({ code, signal }));
    this.logger.info(`runtime.${name}_started`, { pid: child.pid });
    this.writeState("starting");
    return child;
  }

  runtimeCommand(args) {
    if (this.runtimeRootProvider) this.installedRuntimeRoot = this.runtimeRootProvider();
    return this.runtimeInvocationFactory({
      app: this.app,
      sourceRoot: this.sourceRoot,
      installedRuntimeRoot: this.installedRuntimeRoot,
      args,
    });
  }

}

Object.assign(RuntimeSupervisor.prototype, tunnelMethods, startupMethods, controlMethods, stopMethods);

module.exports = {
  MAX_RESTARTS_PER_WINDOW,
  RESTART_WINDOW_MS,
  TUNNEL_HEALTH_POLL_INTERVAL_MS,
  TUNNEL_MONITOR_FAILURE_THRESHOLD,
  TUNNEL_MONITOR_INTERVAL_MS,
  TUNNEL_START_TIMEOUT_MS,
  RuntimeSupervisor,
  managedTunnelConnectArgs,
  validateConfig,
};
