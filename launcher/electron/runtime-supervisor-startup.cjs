const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { redactText } = require("./logging.cjs");
const { DETACH_OWNED_CHILD, processRunning, terminateOwnedProcessTree } = require("./process-tree.cjs");
const { runtimeInvocation } = require("./runtime-command.cjs");
const helpers = require("./runtime-supervisor-helpers.cjs");
const { RESTART_WINDOW_MS, MAX_RESTARTS_PER_WINDOW, MAX_RUNTIME_LOG_LINE_CHARS, MAX_CONTROL_OUTPUT_BYTES, DRAIN_IDLE_TIMEOUT_MS, DRAIN_POLL_INTERVAL_MS, TUNNEL_START_TIMEOUT_MS, TUNNEL_HEALTH_POLL_INTERVAL_MS, TUNNEL_MONITOR_INTERVAL_MS, TUNNEL_MONITOR_FAILURE_THRESHOLD, sleep, collectLines, loopbackHealthBaseURL, readJson, errorMessage, appendFailure, absolutePath, pathIdentity, windowsPipeEndpoint, tunnelRuntimeAbsent, tunnelRuntimeStopped, runtimeOwnershipMayBeLive, foreignLauncherOwnerMayRecover, conciseTunnelLog, tunnelControlDiagnostic, tunnelCommandQuoted, managedTunnelMcpCommand, managedTunnelConnectArgs, validateConfig } = helpers;

module.exports = {
  async startDaemon(config) {
    if (this.daemon) {
      const child = this.daemon;
      const identity = Number.isInteger(child.pid)
        && await this.proxyHealth(config, 2_000, child.pid);
      if (identity && !await this.proxyHealth(config, 2_000, child.pid, true)) {
        const resumed = await this.control(config, "resume");
        if (resumed.status !== "ok" || resumed.accepting_turns !== true) {
          throw new Error("Responses proxy did not acknowledge readiness after resume");
        }
      }
      await this.waitForProxy(config);
      if (this.daemon !== child) throw new Error("Responses proxy exited while readiness was being confirmed");
      this.restartableChildren.add(child);
      return;
    }
    let child;
    try {
      child = this.spawnChild("daemon", this.runtimeCommand(["serve"]));
      await this.waitForProxy(config);
      if (this.daemon !== child) throw new Error("Responses proxy exited immediately after becoming healthy");
      this.restartableChildren.add(child);
    } catch (error) {
      let cleanupError;
      try {
        await this.stopChild("daemon");
      } catch (caught) {
        cleanupError = caught;
      }
      if (cleanupError) {
        throw new Error(appendFailure(errorMessage(error), "daemon startup cleanup failed", cleanupError));
      }
      throw error;
    }
  },

  async startIfConfigured() {
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startConfigured();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  },

  async startConfigured() {
    let config;
    try {
      config = this.readConfig();
    } catch (error) {
      const detail = errorMessage(error);
      this.logger.warn("runtime.setup_required", { detail });
      return { status: "needs-setup", detail };
    }
    if (!config) {
      const ownershipState = this.readState();
      if (ownershipState && (
        processRunning(ownershipState.daemonPid)
        || processRunning(ownershipState.tunnelPid)
        || foreignLauncherOwnerMayRecover(ownershipState)
      )) {
        const detail = "Runtime configuration is missing while launcher ownership processes are still alive";
        this.logger.warn("runtime.external_owner_detected", { detail });
        return { status: "external", detail };
      }
      this.clearState();
      return { status: "not-configured" };
    }
    if (config.releaseVersion !== this.app.getVersion()) {
      const ownershipState = this.readState();
      if (await this.proxyHealth(config) || runtimeOwnershipMayBeLive(ownershipState)) {
        try {
          const recovered = await this.stopStaleOwnedRuntime(config);
          if (!recovered) {
            const detail = "A runtime for another launcher version could not be safely recovered";
            this.writeExternalState(detail);
            this.logger.warn("runtime.external_owner_detected", { port: config.port, detail });
            return { status: "external", detail };
          }
        } catch (error) {
          const detail = errorMessage(error);
          this.writeExternalState(detail);
          this.logger.warn("runtime.external_owner_detected", { port: config.port, detail });
          return { status: "external", detail };
        }
      }
      const detail = `Config requires ${config.releaseVersion}; launcher is ${this.app.getVersion()}`;
      this.writeState("needs-setup", detail);
      this.logger.warn("runtime.setup_required", { detail });
      return { status: "needs-setup", detail };
    }
    if (!this.daemon && !this.tunnel) {
      const healthyRuntime = await this.proxyHealth(config);
      const ownershipState = this.readState();
      if (healthyRuntime || runtimeOwnershipMayBeLive(ownershipState)) {
        try {
          const recovered = await this.stopStaleOwnedRuntime(config);
          if (!recovered) {
            const detail = healthyRuntime
              ? "An external runtime already owns the configured port"
              : "Existing launcher runtime ownership could not be safely recovered";
            this.writeExternalState(detail);
            this.logger.warn("runtime.external_owner_detected", { port: config.port, detail });
            return { status: "external", detail };
          }
        } catch (error) {
          const detail = errorMessage(error);
          this.writeExternalState(detail);
          this.logger.warn("runtime.external_owner_detected", { port: config.port, detail });
          return { status: "external", detail };
        }
      }
    }

    this.stopping = false;
    this.publishOperation?.({ name: "runtime-start", status: "running", message: "Starting local runtime" });
    try {
      await this.startTunnel(config, "runtime-start");
      await this.startDaemon(config);
      this.restartHistory.daemon = [];
      this.restartHistory.tunnel = [];
      this.writeState("ready");
      this.publishOperation?.({ name: "runtime-start", status: "completed", message: "Local runtime is ready" });
      return { status: "ready", daemonPid: this.daemon?.pid, tunnelPid: this.tunnel?.pid };
    } catch (error) {
      this.stopping = true;
      let cleanupError;
      try {
        await this.cleanupFailedStart(config);
      } catch (caught) {
        cleanupError = caught;
      } finally {
        this.stopping = false;
      }
      const primary = errorMessage(error);
      const message = cleanupError
        ? appendFailure(primary, "runtime startup cleanup failed", cleanupError)
        : primary;
      this.tryWriteState("failed", message);
      this.publishOperation?.({ name: "runtime-start", status: "failed", message });
      throw new Error(message);
    }
  },

  recordRestart(name) {
    const cutoff = Date.now() - RESTART_WINDOW_MS;
    const recent = this.restartHistory[name].filter((at) => at >= cutoff);
    recent.push(Date.now());
    this.restartHistory[name] = recent;
    return recent.length;
  },

  scheduleRecovery(name) {
    if (this.stopping) return;
    if (this.restartTimers[name]) return;
    const attempts = this.recordRestart(name);
    if (attempts > MAX_RESTARTS_PER_WINDOW) {
      const cause = this.lastChildFailure[name];
      const message = `${name} stopped more than ${MAX_RESTARTS_PER_WINDOW} times in 60 seconds; automatic restart is disabled`
        + (cause ? `; last failure: ${cause}` : "");
      this.tryWriteState("failed", message);
      this.publishOperation?.({ name: "runtime-recovery", status: "failed", message });
      return;
    }
    const delay = Math.min(attempts * 1_000, 5_000);
    this.restartTimers[name] = setTimeout(() => {
      this.restartTimers[name] = null;
      const recovery = this.recover(name).catch((error) => {
        const message = errorMessage(error);
        this.logger.error(`runtime.${name}_recovery_failed`, { message });
        if (this.tryWriteState("failed", message)) this.scheduleRecovery(name);
      });
      this.recoveryTasks.add(recovery);
      void recovery.finally(() => this.recoveryTasks.delete(recovery));
    }, delay);
  },

  async recover(name) {
    if (this.stopping) return;
    const config = this.readConfig();
    if (!config) return;
    if (config.releaseVersion !== this.app.getVersion()) {
      const message = `Config requires ${config.releaseVersion}; launcher is ${this.app.getVersion()}`;
      this.tryWriteState("needs-setup", message);
      this.logger.warn("runtime.setup_required", { detail: message });
      this.publishOperation?.({ name: "runtime-recovery", status: "failed", message });
      return;
    }
    this.publishOperation?.({ name: "runtime-recovery", status: "running", message: `Restarting ${name}` });
    if (name === "tunnel") await this.startTunnel(config, "runtime-recovery");
    else await this.startDaemon(config);
    if (!this.daemon) throw new Error("Responses proxy is unavailable after runtime recovery");
    if (config.mode === "full" && !this.tunnel) {
      throw new Error("Tunnel runtime is unavailable after runtime recovery");
    }
    await this.waitForProxy(config);
    if (config.mode === "full") {
      await this.waitForTunnel(config, TUNNEL_START_TIMEOUT_MS, "runtime-recovery");
    }
    if (!this.tryWriteState("ready")) {
      let cleanupError;
      try {
        await this.cleanupFailedStart(config);
      } catch (caught) {
        cleanupError = caught;
      }
      const message = cleanupError
        ? appendFailure(
            "Recovered runtime could not persist launcher ownership",
            "runtime recovery cleanup failed",
            cleanupError,
          )
        : "Recovered runtime could not persist launcher ownership";
      throw new Error(message);
    }
    this.publishOperation?.({ name: "runtime-recovery", status: "completed", message: `${name} recovered` });
  },

  async cleanupFailedStart(config) {
    if (this.daemon) {
      const child = this.daemon;
      const healthy = Number.isInteger(child.pid) && await this.proxyHealth(config, 2_000, child.pid);
      if (healthy) {
        let drained = false;
        try {
          drained = await this.acquireDrain(config);
          await this.shutdownDaemon(config);
        } catch (error) {
          if (drained) {
            try {
              await this.control(config, "resume");
            } catch (resumeError) {
              throw new Error(appendFailure(errorMessage(error), "daemon resume compensation failed", resumeError));
            }
          }
          throw error;
        }
      } else {
        await this.stopChild("daemon");
      }
    }
    if (this.tunnel) {
      await this.stopTunnelGracefully(config);
    }
  },

  async restoreDrainedDaemon(config) {
    const child = this.daemon;
    const childAlive = child
      && child.exitCode === null
      && child.signalCode === null
      && processRunning(child.pid);
    if (childAlive) {
      if (!Number.isInteger(child.pid) || !await this.proxyHealth(config, 2_000, child.pid)) {
        throw new Error("drained daemon is still alive but no longer provides matching health evidence");
      }
      const resumed = await this.control(config, "resume");
      if (resumed.status !== "ok" || resumed.accepting_turns !== true) {
        throw new Error("drained daemon did not acknowledge resume");
      }
      await this.waitForProxy(config);
      return { status: "resumed", pid: child.pid };
    }
    this.daemon = null;
    await this.waitForPortRelease(config);
    await this.startDaemon(config);
    return { status: "restarted", pid: this.daemon?.pid };
  },

  async ownedRuntimeReady(config) {
    const daemon = this.daemon;
    if (!daemon
      || !Number.isInteger(daemon.pid)
      || daemon.exitCode !== null
      || daemon.signalCode !== null
      || !await this.proxyHealth(config, 2_000, daemon.pid, true)) {
      return false;
    }
    if (config.mode !== "full") return true;
    return Boolean(this.tunnel && await this.tunnelHealth(config));
  },

  async control(config, action) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`http://${config.host}:${config.port}/admin/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.controlToken}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  },

};
