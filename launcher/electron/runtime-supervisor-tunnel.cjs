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

module.exports = {
  assertTunnelClientReady(config) {
    const tunnel = config.tunnel;
    if (!tunnel || !fs.existsSync(tunnel.binaryPath)) {
      throw new Error(`Tunnel client is missing: ${tunnel?.binaryPath || "not configured"}`);
    }
    if (!fs.existsSync(tunnel.runtimeKeyFile)) {
      throw new Error(`Tunnel runtime key is missing: ${tunnel.runtimeKeyFile}`);
    }
  },

  async proxyHealthPayload(config, timeoutMs = 2_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  },

  async proxyHealth(config, timeoutMs = 2_000, expectedPid, requireAccepting = false) {
    const body = await this.proxyHealthPayload(config, timeoutMs);
    return body?.service === "codex-chatgpt-web"
      && body?.status === "ok"
      && body?.mode === config.mode
      && body?.version === config.releaseVersion
      && (expectedPid === undefined || body?.pid === expectedPid)
      && (!requireAccepting || body?.accepting_turns === true);
  },

  async waitForProxy(config, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const daemon = this.daemon;
      if (!daemon) {
        throw new Error(this.lastChildFailure.daemon || "Responses proxy exited before becoming healthy");
      }
      if (!Number.isInteger(daemon.pid)) {
        await sleep(50);
        continue;
      }
      if (await this.proxyHealth(config, 2_000, daemon.pid, true)) return;
      await sleep(200);
    }
    throw new Error(`Responses proxy did not become healthy on 127.0.0.1:${config.port} within ${timeoutMs}ms`);
  },

  async readTunnelHealth(config) {
    const tunnel = config.tunnel;
    // `runtimes status` performs an optional control-plane lookup when the saved runtime key is
    // available. The cleanup dry run is the official local-only inventory and never removes
    // entries without `--apply`, so proxy or control-plane failures cannot block supervision.
    const result = await this.runTunnelCommand(
      config,
      ["runtimes", "cleanup", "--json"],
      5_000,
      "Local tunnel inventory probe",
    );
    if (result.code !== 0) {
      return {
        ready: false,
        pid: null,
        state: undefined,
        processRunning: undefined,
        healthy: undefined,
        absent: false,
        statusKnown: false,
        detail: tunnelControlDiagnostic(result),
      };
    }
    try {
      const parsed = JSON.parse(result.output);
      if (!Array.isArray(parsed.entries)) throw new Error("local inventory has no entries array");
      const entry = parsed.entries.find(candidate => candidate?.alias === tunnel.alias);
      if (!entry) {
        return {
          ready: false,
          pid: null,
          state: "stopped",
          processRunning: false,
          healthy: false,
          absent: true,
          statusKnown: true,
          detail: `alias=${tunnel.alias}; local_inventory=absent`,
        };
      }
      const runtimeState = entry.runtime_state;
      if (!["stopped", "starting", "healthy", "ready"].includes(runtimeState)) {
        throw new Error(`local inventory reported unsupported runtime_state=${String(runtimeState)}`);
      }
      const liveRuntime = entry.live_runtime && typeof entry.live_runtime === "object"
        ? entry.live_runtime
        : {};
      const healthBaseUrl = loopbackHealthBaseURL(liveRuntime.base_url);
      if (healthBaseUrl) this.tunnelHealthBaseUrl = healthBaseUrl;
      const pid = Number.isInteger(liveRuntime.system?.pid) && liveRuntime.system.pid > 0
        ? liveRuntime.system.pid
        : Number.isInteger(liveRuntime.status?.pid) && liveRuntime.status.pid > 0
          ? liveRuntime.status.pid
          : null;
      const processRunning = runtimeState !== "stopped";
      const healthy = runtimeState === "healthy" || runtimeState === "ready";
      const ready = runtimeState === "ready";
      const detail = [
        ["state", runtimeState],
        ["process_running", processRunning],
        ["healthy", healthy],
        ["ready", ready],
        ["classification", entry.classification],
        ["live_admin", liveRuntime.found === true],
        ["pid", pid ?? "missing"],
      ]
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join("; ");
      return {
        ready,
        pid,
        state: runtimeState,
        processRunning,
        healthy,
        absent: false,
        statusKnown: true,
        detail: redactText(detail).slice(0, 2_000),
      };
    } catch (error) {
      return {
        ready: false,
        pid: null,
        state: undefined,
        processRunning: undefined,
        healthy: undefined,
        absent: false,
        statusKnown: false,
        detail: `local inventory returned invalid JSON: ${errorMessage(error)};`
          + ` ${redactText(result.output || "[empty]").slice(0, 500)}`,
      };
    }
  },

  async probeTunnelEndpoint(pathname, timeoutMs = 2_000) {
    if (!this.tunnelHealthBaseUrl) {
      return { observed: false, ok: false, detail: "local tunnel health URL is not known" };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.tunnelHealthBaseUrl}${pathname}`, {
        method: "GET",
        signal: controller.signal,
      });
      return {
        observed: true,
        ok: response.ok,
        status: response.status,
        detail: `${pathname} returned HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        observed: false,
        ok: false,
        detail: `${pathname} could not be observed: ${errorMessage(error)}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  },

  async readLocalTunnelHealth() {
    const [healthz, readyz] = await Promise.all([
      this.probeTunnelEndpoint("/healthz"),
      this.probeTunnelEndpoint("/readyz"),
    ]);
    const pid = Number.isInteger(this.tunnel?.pid) ? this.tunnel.pid : null;
    if (pid && !processRunning(pid)) {
      return {
        ready: false,
        pid,
        state: "stopped",
        processRunning: false,
        healthy: false,
        absent: false,
        statusKnown: true,
        detail: `managed tunnel process ${pid} is no longer running`,
      };
    }
    const explicitlyUnhealthy = (healthz.observed && !healthz.ok)
      || (readyz.observed && !readyz.ok);
    const completelyObserved = healthz.observed && readyz.observed;
    if (!explicitlyUnhealthy && !completelyObserved) {
      return {
        ready: false,
        pid,
        state: undefined,
        processRunning: pid ? true : undefined,
        healthy: undefined,
        absent: false,
        statusKnown: false,
        detail: `${healthz.detail}; ${readyz.detail}`,
      };
    }
    return {
      ready: healthz.ok && readyz.ok,
      pid,
      state: healthz.ok && readyz.ok ? "ready" : "degraded",
      processRunning: pid ? true : undefined,
      healthy: healthz.ok,
      absent: false,
      statusKnown: true,
      detail: `${healthz.detail}; ${readyz.detail}`,
    };
  },

  async observeTunnelForMonitor(config) {
    const local = await this.readLocalTunnelHealth();
    if (local.statusKnown) return local;
    try {
      return await this.readTunnelHealth(config);
    } catch (error) {
      return {
        ...local,
        detail: `${local.detail}; native status unavailable: ${errorMessage(error)}`,
      };
    }
  },

  async tunnelHealth(config) {
    return (await this.observeTunnelForMonitor(config)).ready;
  },

  async waitForKnownTunnelStatus(config, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let health;
    do {
      health = await this.readTunnelHealth(config);
      if (health.statusKnown) return health;
      await sleep(TUNNEL_HEALTH_POLL_INTERVAL_MS);
    } while (Date.now() < deadline);
    throw new Error(
      `Tunnel runtime status could not be inspected within ${timeoutMs}ms:`
      + ` ${health?.detail || "no status returned"}`,
    );
  },

  async waitForTunnel(
    config,
    timeoutMs = TUNNEL_START_TIMEOUT_MS,
    operationName = "runtime-start",
  ) {
    const deadline = Date.now() + timeoutMs;
    let lastDetail = "tunnel status has not been observed";
    let lastPublishedDetail;
    while (Date.now() < deadline) {
      const health = await this.readTunnelHealth(config);
      if (health.pid) {
        this.tunnel = {
          pid: health.pid,
          exitCode: null,
          signalCode: null,
          managed: true,
        };
      }
      if (health.ready) {
        if (!this.tunnel) {
          this.tunnel = {
            pid: null,
            exitCode: null,
            signalCode: null,
            managed: true,
          };
        }
        return health;
      }
      if (tunnelRuntimeStopped(health)) {
        throw new Error(`Tunnel managed runtime stopped during startup: ${health.detail}`);
      }
      lastDetail = health.detail;
      if (lastDetail !== lastPublishedDetail) {
        lastPublishedDetail = lastDetail;
        this.logger.info("runtime.tunnel_waiting", { detail: lastDetail });
        this.publishOperation?.({
          name: operationName,
          status: "running",
          message: `Waiting for tunnel readiness: ${lastDetail}`,
        });
      }
      await sleep(TUNNEL_HEALTH_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Tunnel runtime did not become healthy and ready within ${timeoutMs}ms: ${lastDetail}`,
    );
  },

  async startTunnel(config, operationName = "runtime-start") {
    if (config.mode !== "full") return;
    this.assertTunnelClientReady(config);
    try {
      const existing = await this.waitForKnownTunnelStatus(config);
      if (existing.ready) {
        this.tunnel = {
          pid: existing.pid,
          exitCode: null,
          signalCode: null,
          managed: true,
        };
        this.startTunnelMonitor(config);
        this.logger.info("runtime.tunnel_adopted", { pid: existing.pid });
        return;
      }
      this.tunnel = null;
      const stopped = await this.runTunnelStopCommand(config);
      if (stopped.code !== 0
        && !tunnelRuntimeAbsent(stopped.output)) {
        throw new Error(
          `tunnel runtime refused pre-start cleanup: ${tunnelControlDiagnostic(stopped)}`,
        );
      }
      if (stopped.code === 0) await this.waitForTunnelStopped(config);
      const connected = await this.runTunnelConnectCommand(config);
      if (connected.code !== 0) {
        throw new Error(
          `tunnel runtime refused managed startup: ${tunnelControlDiagnostic(connected)}`,
        );
      }
      await this.waitForTunnel(config, TUNNEL_START_TIMEOUT_MS, operationName);
      if (!this.tunnel) throw new Error("Tunnel runtime became ready without a managed process identity");
      this.startTunnelMonitor(config);
    } catch (error) {
      let cleanupError;
      try {
        this.stopTunnelMonitor();
        const managed = this.tunnel;
        const stopped = await this.runTunnelStopCommand(config);
        if (stopped.code !== 0
          && (!tunnelRuntimeAbsent(stopped.output)
            || (managed?.pid && processRunning(managed.pid)))) {
          throw new Error(tunnelControlDiagnostic(stopped));
        }
        if (stopped.code === 0) await this.waitForTunnelStopped(config);
        this.tunnel = null;
      } catch (caught) {
        cleanupError = caught;
      }
      if (cleanupError) {
        throw new Error(appendFailure(errorMessage(error), "tunnel startup cleanup failed", cleanupError));
      }
      throw error;
    }
  },

  async runTunnelConnectCommand(config) {
    const invocation = this.runtimeCommand(["mcp", "--broker-socket", config.brokerSocketPath]);
    return await this.runTunnelCommand(
      config,
      managedTunnelConnectArgs(config, invocation),
      TUNNEL_START_TIMEOUT_MS,
      "Tunnel managed startup",
    );
  },

  startTunnelMonitor(config) {
    this.stopTunnelMonitor();
    this.tunnelMonitorFailures = 0;
    this.tunnelMonitorObservationUnavailable = false;
    const generation = this.tunnelMonitorGeneration;
    const recordFailure = (message) => {
      if (this.stopping || generation !== this.tunnelMonitorGeneration) return;
      this.tunnelMonitorFailures += 1;
      this.logger.warn("runtime.tunnel_monitor_unhealthy", {
        consecutiveFailures: this.tunnelMonitorFailures,
        message,
      });
      if (this.tunnelMonitorFailures < TUNNEL_MONITOR_FAILURE_THRESHOLD) return;
      this.lastChildFailure.tunnel = message;
      this.stopTunnelMonitor();
      if (!this.tryWriteState("degraded", message)) return;
      this.tunnel = null;
      this.publishOperation?.({ name: "runtime-recovery", status: "running", message });
      this.scheduleRecovery("tunnel");
    };
    this.tunnelMonitorTimer = setInterval(() => {
      if (this.stopping
        || generation !== this.tunnelMonitorGeneration
        || this.tunnelMonitorInFlight
        || this.restartTimers.tunnel) return;
      this.tunnelMonitorInFlight = true;
      void this.observeTunnelForMonitor(config).then((health) => {
        if (this.stopping || generation !== this.tunnelMonitorGeneration) return;
        if (!health.statusKnown) {
          if (!this.tunnelMonitorObservationUnavailable) {
            this.tunnelMonitorObservationUnavailable = true;
            this.logger.warn("runtime.tunnel_monitor_observation_unavailable", {
              message: health.detail,
            });
          }
          return;
        }
        if (this.tunnelMonitorObservationUnavailable) {
          this.tunnelMonitorObservationUnavailable = false;
          this.logger.info("runtime.tunnel_monitor_observation_restored", {
            message: health.detail,
          });
        }
        if (health.ready) {
          this.tunnelMonitorFailures = 0;
          if (this.tunnel?.pid !== health.pid) {
            this.tunnel = {
              pid: health.pid,
              exitCode: null,
              signalCode: null,
              managed: true,
            };
            this.tryWriteState("ready");
          }
          return;
        }
        recordFailure(`Tunnel runtime lost readiness: ${health.detail}`);
      }).catch((error) => {
        recordFailure(`Tunnel health probe failed: ${errorMessage(error)}`);
      }).finally(() => {
        this.tunnelMonitorInFlight = false;
      });
    }, TUNNEL_MONITOR_INTERVAL_MS);
    this.tunnelMonitorTimer.unref?.();
  },

  stopTunnelMonitor() {
    if (this.tunnelMonitorTimer) clearInterval(this.tunnelMonitorTimer);
    this.tunnelMonitorTimer = null;
    this.tunnelMonitorFailures = 0;
    this.tunnelMonitorObservationUnavailable = false;
    this.tunnelMonitorGeneration += 1;
  },

};
