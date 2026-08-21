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
  async stopStaleOwnedRuntime(config) {
    const state = this.readState();
    if (!state) return false;
    const health = await this.proxyHealthPayload(config);
    const daemonRunning = health?.service === "codex-chatgpt-web"
      && health?.mode === config.mode
      && health?.version === config.releaseVersion;
    if (daemonRunning && health.pid !== state.daemonPid) {
      throw new Error("The process on the Responses port does not match the stale launcher marker");
    }
    if (!daemonRunning && processRunning(state.daemonPid)) {
      throw new Error(
        `The stale daemon PID ${state.daemonPid} is still alive but did not provide matching health evidence`,
      );
    }
    let managedTunnelRunning = false;
    if (config.mode === "full") {
      const tunnelHealth = await this.waitForKnownTunnelStatus(config);
      managedTunnelRunning = !tunnelRuntimeStopped(tunnelHealth);
      if (managedTunnelRunning
        && tunnelHealth.processRunning !== true
        && tunnelHealth.pid === null
        && typeof tunnelHealth.state !== "string") {
        throw new Error(`The stale tunnel runtime state is ambiguous: ${tunnelHealth.detail}`);
      }
      if (!managedTunnelRunning && processRunning(state.tunnelPid)) {
        throw new Error(
          `The stale tunnel PID ${state.tunnelPid} is still alive but the native runtime manager`
          + " does not recognize it; refusing to terminate an unverified process",
        );
      }
    } else if (processRunning(state.tunnelPid)) {
      throw new Error(
        `The stale tunnel PID ${state.tunnelPid} is still alive but browser-only configuration`
        + " has no tunnel identity with which to verify it",
      );
    }
    if (foreignLauncherOwnerMayRecover(state)) {
      throw new Error(`Another launcher process still owns the runtime (pid ${state.ownerPid})`);
    }
    if (!daemonRunning && !managedTunnelRunning) {
      this.clearState();
      return true;
    }

    this.logger.warn("runtime.stale_owner_recovery_started", {
      ownerPid: state.ownerPid,
      daemonPid: daemonRunning ? state.daemonPid : null,
      tunnelPid: managedTunnelRunning ? state.tunnelPid : null,
    });
    if (daemonRunning) {
      let drained = false;
      try {
        drained = await this.acquireDrain(config);
        const shutdown = await this.control(config, "shutdown");
        if (shutdown.status !== "ok") throw new Error("stale daemon did not acknowledge graceful shutdown");
        await this.waitForProcessExit("stale daemon", state.daemonPid);
        await this.waitForPortRelease(config);
      } catch (error) {
        if (drained) {
          try {
            await this.control(config, "resume");
          } catch (resumeError) {
            throw new Error(appendFailure(errorMessage(error), "stale daemon resume compensation failed", resumeError));
          }
        }
        throw error;
      }
    }
    if (managedTunnelRunning) {
      const stopped = await this.runTunnelStopCommand(config);
      if (stopped.code !== 0) {
        throw new Error(`stale tunnel refused graceful shutdown: ${tunnelControlDiagnostic(stopped)}`);
      }
      await this.waitForTunnelStopped(config, 10_000);
    }
    this.clearState();
    this.logger.info("runtime.stale_owner_recovered");
    return true;
  },

  async acquireDrain(config, timeoutMs = DRAIN_IDLE_TIMEOUT_MS) {
    let resumeRequired = false;
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        resumeRequired = true;
        const health = await this.control(config, "drain-if-idle");
        resumeRequired = false;
        const activeHttp = health.active_http_turns;
        const activeBrowser = health.active_browser_turns;
        if (!Number.isInteger(activeHttp) || !Number.isInteger(activeBrowser)) {
          throw new Error("daemon did not acknowledge the atomic idle-drain contract");
        }
        if (health.status === "ok"
          && health.acquired === true
          && health.accepting_turns === false
          && activeHttp === 0
          && activeBrowser === 0) {
          return true;
        }
        if (health.status === "draining"
          && health.acquired === false
          && health.accepting_turns === false
          && activeHttp === 0
          && activeBrowser === 0) {
          return true;
        }
        if (health.status !== "busy"
          || health.acquired !== false
          || health.accepting_turns !== true) {
          resumeRequired = health.acquired === true;
          throw new Error("daemon did not acknowledge the atomic idle-drain contract");
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `daemon has ${activeHttp} active HTTP turn(s) and ${activeBrowser} active browser turn(s)`,
          );
        }
        await sleep(Math.min(DRAIN_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
      }
    } catch (error) {
      let resumeError;
      if (resumeRequired) {
        try {
          await this.control(config, "resume");
        } catch (caught) {
          resumeError = caught;
        }
      }
      const message = resumeError
        ? appendFailure(errorMessage(error), "compensating resume failed", resumeError)
        : errorMessage(error);
      throw new Error(`Refusing to stop launcher-owned runtime because atomic idleness could not be proven: ${message}`);
    }
  },

  async stopChild(name, timeoutMs = 10_000) {
    const child = this[name];
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this[name] = null;
      return;
    }
    this.expectedExits.add(child);
    try {
      terminateOwnedProcessTree(child);
    } catch (error) {
      this.expectedExits.delete(child);
      if (!processRunning(child.pid)) {
        this[name] = null;
        return;
      }
      throw new Error(`Could not request ${name} process-tree shutdown: ${errorMessage(error)}`);
    }
    try {
      await this.waitForChildExit(name, child, timeoutMs);
    } catch (gracefulError) {
      try {
        terminateOwnedProcessTree(child, "SIGKILL");
        await this.waitForChildExit(name, child, 2_000);
      } catch (forceError) {
        throw new Error(appendFailure(
          errorMessage(gracefulError),
          `forced ${name} process-tree shutdown failed`,
          forceError,
        ));
      }
      this.logger.warn(`runtime.${name}_forced_stop`, { message: errorMessage(gracefulError) });
    }
    terminateOwnedProcessTree(child, "SIGKILL");
    this[name] = null;
  },

  async stopForSetup() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStopForSetup();
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  },

  async performStopForSetup() {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch (error) {
        this.logger.warn("runtime.start_failed_before_stop", { message: errorMessage(error) });
      }
    }
    const config = this.readConfig();
    this.stopping = true;
    this.stopTunnelMonitor();
    for (const name of ["daemon", "tunnel"]) {
      if (this.restartTimers[name]) {
        clearTimeout(this.restartTimers[name]);
        this.restartTimers[name] = null;
      }
    }
    if (this.recoveryTasks.size > 0) {
      await Promise.allSettled([...this.recoveryTasks]);
    }
    let drained = false;
    let tunnelStopped = false;
    try {
      const ownershipState = this.readState();
      const healthyRuntime = config ? await this.proxyHealth(config) : false;
      const runtimeMayBeLive = healthyRuntime || runtimeOwnershipMayBeLive(ownershipState);
      if (config?.mode === "full"
        && !this.tunnel
        && (runtimeMayBeLive || !ownershipState)) {
        await this.adoptConfiguredTunnelForStop(config);
      }
      if (!this.daemon && !this.tunnel) {
        if (!config) {
          if (ownershipState && (
            processRunning(ownershipState.daemonPid)
            || processRunning(ownershipState.tunnelPid)
          )) {
            throw new Error("runtime configuration is missing while launcher ownership processes are still alive");
          }
        } else if (runtimeMayBeLive) {
          const recovered = await this.stopStaleOwnedRuntime(config);
          if (!recovered) {
            throw new Error("an existing runtime could not be safely recovered");
          }
        }
        this.clearState();
        return { status: "stopped" };
      }
      if (this.daemon && config) {
        const daemonPid = this.daemon.pid;
        if (!Number.isInteger(daemonPid)
          || !await this.proxyHealth(config, 2_000, daemonPid)) {
          throw new Error("launcher-owned daemon did not provide matching health evidence");
        }
        drained = await this.acquireDrain(config);
      }
      if (this.tunnel) {
        if (!config) throw new Error("launcher-owned tunnel cannot be stopped without a valid configuration");
        await this.stopTunnelGracefully(config);
        tunnelStopped = true;
      }
      if (this.daemon) {
        if (!config || !drained) {
          throw new Error("launcher-owned daemon cannot be stopped without a verified idle drain");
        }
        await this.shutdownDaemon(config);
      }
      this.clearState();
      return { status: "stopped" };
    } catch (error) {
      const compensationErrors = [];
      if (tunnelStopped && config?.mode === "full" && !this.tunnel) {
        try {
          await this.startTunnel(config);
        } catch (caught) {
          compensationErrors.push(["tunnel restart compensation failed", caught]);
        }
      }
      if (drained && config) {
        try {
          await this.restoreDrainedDaemon(config);
        } catch (caught) {
          compensationErrors.push(["daemon resume compensation failed", caught]);
        }
      }
      const message = compensationErrors.reduce(
        (current, [label, failure]) => appendFailure(current, label, failure),
        errorMessage(error),
      );
      let restoredReady = false;
      if (compensationErrors.length === 0 && config) {
        try {
          restoredReady = await this.ownedRuntimeReady(config);
        } catch {
          restoredReady = false;
        }
      }
      this.tryWriteState(restoredReady ? "ready" : "failed", message);
      throw new Error(message);
    } finally {
      this.stopping = false;
    }
  },

  async restart() {
    await this.stopForSetup();
    return this.startIfConfigured();
  },

  async shutdown() {
    return this.stopForSetup();
  },
};
