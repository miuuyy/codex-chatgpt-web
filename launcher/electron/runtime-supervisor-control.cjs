const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { redactText } = require("./logging.cjs");
const { DETACH_OWNED_CHILD, processRunning, terminateOwnedProcessTree } = require("./process-tree.cjs");
const { runtimeInvocation } = require("./runtime-command.cjs");
const helpers = require("./runtime-supervisor-helpers.cjs");
const { RESTART_WINDOW_MS, MAX_RESTARTS_PER_WINDOW, MAX_RUNTIME_LOG_LINE_CHARS, MAX_CONTROL_OUTPUT_BYTES, DRAIN_IDLE_TIMEOUT_MS, DRAIN_POLL_INTERVAL_MS, TUNNEL_START_TIMEOUT_MS, TUNNEL_HEALTH_POLL_INTERVAL_MS, TUNNEL_MONITOR_INTERVAL_MS, TUNNEL_MONITOR_FAILURE_THRESHOLD, TUNNEL_MCP_CONNECTION_MAX_TTL, sleep, collectLines, loopbackHealthBaseURL, readJson, errorMessage, appendFailure, absolutePath, pathIdentity, windowsPipeEndpoint, tunnelRuntimeAbsent, tunnelRuntimeStopped, runtimeOwnershipMayBeLive, conciseTunnelLog, tunnelControlDiagnostic, tunnelCommandQuoted, managedTunnelMcpCommand, managedTunnelConnectArgs, validateConfig } = helpers;

module.exports = {
  async waitForChildExit(name, child, timeoutMs) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timeout);
        child.off("exit", finish);
        child.off("close", finish);
        resolve();
      };
      const timeout = setTimeout(() => {
        child.off("exit", finish);
        child.off("close", finish);
        reject(new Error(`${name} did not stop within ${timeoutMs}ms`));
      }, timeoutMs);
      child.once("exit", finish);
      child.once("close", finish);
    });
  },

  async waitForProcessExit(name, pid, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (processRunning(pid) && Date.now() < deadline) await sleep(50);
    if (processRunning(pid)) throw new Error(`${name} process ${pid} did not stop within ${timeoutMs}ms`);
  },

  async waitForTunnelStopped(config, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let lastDetail = "tunnel stop status has not been observed";
    while (Date.now() < deadline) {
      const health = await this.readTunnelHealth(config);
      if (tunnelRuntimeStopped(health)) {
        return health;
      }
      lastDetail = health.detail;
      await sleep(TUNNEL_HEALTH_POLL_INTERVAL_MS);
    }
    throw new Error(`Tunnel runtime did not confirm a stopped state within ${timeoutMs}ms: ${lastDetail}`);
  },

  async waitForPortRelease(config, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = "port is still occupied";
    while (Date.now() < deadline) {
      try {
        await new Promise((resolve, reject) => {
          const probe = net.createServer();
          probe.unref();
          probe.once("error", reject);
          probe.listen(config.port, config.host, () => {
            probe.close((error) => error ? reject(error) : resolve());
          });
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await sleep(100);
      }
    }
    throw new Error(
      `Responses port ${config.host}:${config.port} was not released within ${timeoutMs}ms: ${lastError}`,
    );
  },

  async shutdownDaemon(config, timeoutMs = 10_000) {
    const child = this.daemon;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.daemon = null;
      return;
    }
    const result = await this.control(config, "shutdown");
    if (result.status !== "ok") throw new Error("daemon did not acknowledge graceful shutdown");
    await this.waitForChildExit("daemon", child, timeoutMs);
    await this.waitForPortRelease(config);
    this.daemon = null;
  },

  async stopTunnelGracefully(config, timeoutMs = 10_000) {
    const managed = this.tunnel;
    if (!managed) {
      this.stopTunnelMonitor();
      this.tunnel = null;
      return;
    }
    const tunnel = config.tunnel;
    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");
    this.stopTunnelMonitor();
    let result;
    try {
      result = await this.runTunnelStopCommand(config);
    } catch (error) {
      this.startTunnelMonitor(config);
      throw error;
    }
    if (result.code !== 0) {
      this.startTunnelMonitor(config);
      throw new Error(`tunnel runtime refused graceful shutdown: ${tunnelControlDiagnostic(result)}`);
    }
    try {
      await this.waitForTunnelStopped(config, timeoutMs);
    } catch (error) {
      // The native manager accepted the stop request but did not prove the terminal state.
      // Keep supervising the alias until the caller either recovers or retries the transaction.
      this.startTunnelMonitor(config);
      throw error;
    }
    this.tunnel = null;
  },

  async adoptConfiguredTunnelForStop(config) {
    if (config.mode !== "full" || this.tunnel) return;
    const health = await this.waitForKnownTunnelStatus(config);
    if (tunnelRuntimeStopped(health)) {
      return;
    }
    if (health.state === undefined
      && health.processRunning !== true
      && health.pid === null) {
      throw new Error(`Tunnel runtime state is ambiguous before shutdown: ${health.detail}`);
    }
    this.tunnel = {
      pid: health.pid,
      exitCode: null,
      signalCode: null,
      managed: true,
    };
    this.logger.info("runtime.tunnel_adopted_for_stop", {
      pid: health.pid,
      state: health.state,
    });
  },

  async runTunnelStopCommand(config) {
    const tunnel = config.tunnel;
    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");
    return await this.runTunnelCommand(
      config,
      ["runtimes", "stop", tunnel.alias, "--json"],
      10_000,
      "Tunnel shutdown",
    );
  },

  async runTunnelCommand(config, args, timeoutMs, label) {
    const tunnel = config.tunnel;
    if (!tunnel) throw new Error("launcher-owned tunnel has no runtime configuration");
    return await new Promise((resolve, reject) => {
      const child = spawn(tunnel.binaryPath, args, {
        cwd: tunnel.profileDir,
        detached: DETACH_OWNED_CHILD,
        env: { ...process.env, MCP_CONNECTION_MAX_TTL: TUNNEL_MCP_CONNECTION_MAX_TTL },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const capture = (chunks, chunk, stream) => {
        const used = stream === "stdout" ? stdoutBytes : stderrBytes;
        const remaining = MAX_CONTROL_OUTPUT_BYTES - used;
        if (remaining <= 0) return;
        const captured = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        chunks.push(captured);
        if (stream === "stdout") stdoutBytes += captured.length;
        else stderrBytes += captured.length;
      };
      let settled = false;
      let timeoutError = null;
      let terminationTimeout = null;
      let forceTimeout = null;
      const clearTimers = () => {
        clearTimeout(timeout);
        if (terminationTimeout) clearTimeout(terminationTimeout);
        if (forceTimeout) clearTimeout(forceTimeout);
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
        try {
          terminateOwnedProcessTree(child);
        } catch (error) {
          settled = true;
          clearTimers();
          reject(new Error(
            `${timeoutError.message}; control process tree termination failed: ${errorMessage(error)}`,
          ));
          return;
        }
        terminationTimeout = setTimeout(() => {
          if (settled) return;
          try {
            terminateOwnedProcessTree(child, "SIGKILL");
          } catch (error) {
            settled = true;
            clearTimers();
            reject(new Error(
              `${timeoutError.message}; forced control process tree termination failed: ${errorMessage(error)}`,
            ));
            return;
          }
          forceTimeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            clearTimers();
            reject(new Error(`${timeoutError.message}; the control process did not exit after forced termination`));
          }, 2_000);
        }, 5_000);
      }, timeoutMs);
      child.stdout.on("data", (chunk) => capture(stdout, chunk, "stdout"));
      child.stderr.on("data", (chunk) => capture(stderr, chunk, "stderr"));
      const onOutputError = (stream) => (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        try {
          terminateOwnedProcessTree(child);
        } catch {}
        reject(new Error(`${label} ${stream} pipe failed: ${errorMessage(error)}`));
      };
      child.stdout.once("error", onOutputError("stdout"));
      child.stderr.once("error", onOutputError("stderr"));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        reject(timeoutError
          ? new Error(`${timeoutError.message}; termination failed: ${error.message}`)
          : error);
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimers();
        if (timeoutError) {
          try {
            terminateOwnedProcessTree(child, "SIGKILL");
            reject(timeoutError);
          } catch (error) {
            reject(new Error(
              `${timeoutError.message}; final control process-group cleanup failed: ${errorMessage(error)}`,
            ));
          }
          return;
        }
        const exitCode = code ?? 1;
        const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
        const stderrText = Buffer.concat(stderr).toString("utf8").trim();
        resolve({
          code: exitCode,
          stdout: stdoutText,
          stderr: stderrText,
          output: exitCode === 0
            ? (stdoutText || stderrText)
            : [stderrText, stdoutText].filter(Boolean).join("\n"),
        });
      });
    });
  },

};
