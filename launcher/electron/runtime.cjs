const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { readJsonFile } = require("./json-file.cjs");
const { connectorNameForSetup, CURRENT_CONNECTOR_NAME, isLegacyConnectorName, requireCurrentRuntimeConnectorName, validateConnectorName } = require("./connector-identity.cjs");
const { embeddedRuntimeInvocation, runtimeInvocation } = require("./runtime-command.cjs");
const { redactText } = require("./logging.cjs");
const { DETACH_OWNED_CHILD, terminateOwnedProcessTree } = require("./process-tree.cjs");
const helpers = require("./runtime-helpers.cjs");
const { MAX_CAPTURE_BYTES, MAX_RUNTIME_LOG_LINE_CHARS, CORE_SETUP_TIMEOUT_MS, MCP_SETUP_TIMEOUT_MS, UNINSTALL_TIMEOUT_MS, MAX_CHECKPOINT_FILE_BYTES, collect, resolveUserPath, captureRegularFile, restoreRegularFile, regularFileChanged, parseBridgeRouteResult } = helpers;

const executionMethods = require("./runtime-execution.cjs");
const routeMethods = require("./runtime-route.cjs");
const integrationMethods = require("./runtime-integration.cjs");
const setupMethods = require("./runtime-setup.cjs");
const setupTransactionMethods = require("./runtime-setup-transaction.cjs");

class RuntimeHost {
  constructor({
    app,
    logger,
    sourceRoot,
    installedRuntimeRoot,
    runtimeRootProvider,
    browserDescriptorPath,
    codexHome,
    launchAgentsDir,
    platform = process.platform,
    publishOperation,
    supervisor,
  }) {
    this.app = app;
    this.logger = logger;
    this.sourceRoot = sourceRoot;
    this.installedRuntimeRoot = installedRuntimeRoot;
    this.runtimeRootProvider = runtimeRootProvider;
    this.browserDescriptorPath = browserDescriptorPath;
    this.platform = platform;
    this.codexHome = codexHome
      ? resolveUserPath(codexHome)
      : process.env.CODEX_HOME?.trim()
        ? resolveUserPath(process.env.CODEX_HOME.trim())
        : path.join(os.homedir(), ".codex");
    this.launchAgentsDir = launchAgentsDir
      ? resolveUserPath(launchAgentsDir)
      : path.join(os.homedir(), "Library", "LaunchAgents");
    this.publishOperation = publishOperation;
    this.supervisor = supervisor;
    this.active = null;
    this.activeChild = null;
    this.lifecycleOperation = null;
    this.cleanupEphemeralSecrets();
  }

  currentOperation() {
    const stuckChild = this.activeChild
      && this.activeChild.exitCode === null
      && this.activeChild.signalCode === null;
    return this.lifecycleOperation || this.active || (stuckChild ? "previous runtime process shutdown" : null);
  }

  cleanupEphemeralSecrets() {
    const secretsDir = path.join(this.app.getPath("userData"), "secrets");
    try {
      for (const entry of fs.readdirSync(secretsDir, { withFileTypes: true })) {
        if (/^runtime-key-(?:\d+|[a-f0-9]{32})\.tmp$/.test(entry.name)) {
          fs.rmSync(path.join(secretsDir, entry.name), { force: true });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.warn("runtime.secret_cleanup_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  command(args) {
    if (this.runtimeRootProvider) this.installedRuntimeRoot = this.runtimeRootProvider();
    return runtimeInvocation({
      app: this.app,
      sourceRoot: this.sourceRoot,
      installedRuntimeRoot: this.installedRuntimeRoot,
      args,
    });
  }

  launcherControlEnvironment() {
    let descriptor;
    try {
      descriptor = readJsonFile(this.browserDescriptorPath);
    } catch (error) {
      throw new Error(
        `Launcher browser ownership descriptor is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const token = descriptor?.control?.token;
    if (descriptor?.pid !== process.pid || typeof token !== "string" || !/^[A-Za-z0-9_-]{40,}$/.test(token)) {
      throw new Error("Launcher browser ownership descriptor does not belong to this launcher process");
    }
    return { CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: token };
  }

  runtimeConfigSnapshot() {
    const setupConfig = this.supervisor.readSetupConfig
      ? this.supervisor.readSetupConfig()
      : this.supervisor.readConfig();
    if (!setupConfig) {
      return {
        configured: false,
        owner: "none",
        mode: "browser-only",
        serialized: null,
      };
    }
    const launcherOwned = setupConfig.browserHost === "launcher";
    const config = launcherOwned ? this.supervisor.readConfig() : setupConfig;
    return {
      configured: true,
      owner: launcherOwned ? "launcher" : "external",
      mode: config.mode === "full" ? "full" : "browser-only",
      serialized: JSON.stringify(config),
      config: structuredClone(config),
    };
  }

  mcpCredentialsConfigured() {
    const config = this.runtimeConfigSnapshot().config;
    const tunnel = config?.mode === "full" ? config.tunnel : null;
    return Boolean(
      tunnel
      && /^tunnel_[a-f0-9]{32}$/.test(tunnel.tunnelId)
      && typeof tunnel.runtimeKeyFile === "string"
      && path.isAbsolute(tunnel.runtimeKeyFile)
      && fs.existsSync(tunnel.runtimeKeyFile),
    );
  }

  captureSetupCheckpoint(snapshot) {
    if (typeof this.supervisor.configPath !== "string" || !path.isAbsolute(this.supervisor.configPath)) {
      throw new Error("Launcher runtime supervisor has no absolute configuration path for setup rollback");
    }
    const coreHome = this.supervisor.coreHome
      || path.dirname(this.supervisor.configPath);
    const paths = new Set([
      this.supervisor.configPath,
      path.join(coreHome, "codex", "integration-journal.json"),
      path.join(coreHome, "codex", "integration-journal.recovery.json"),
      path.join(this.codexHome, "config.toml"),
      path.join(this.codexHome, "models_cache.json"),
      path.join(coreHome, "secrets", "tunnel-runtime.key"),
      path.join(coreHome, "tunnel", "profiles", "codex-chatgpt-web.yaml"),
    ]);
    if (snapshot.owner === "external" && this.platform === "darwin") {
      paths.add(path.join(this.launchAgentsDir, "io.github.codex-chatgpt-web.daemon.plist"));
      paths.add(path.join(this.launchAgentsDir, "io.github.codex-chatgpt-web.tunnel.plist"));
    }
    const tunnel = snapshot.config?.tunnel;
    if (tunnel && typeof tunnel === "object") {
      if (typeof tunnel.runtimeKeyFile === "string" && tunnel.runtimeKeyFile) {
        paths.add(tunnel.runtimeKeyFile);
      }
      if (typeof tunnel.profileDir === "string"
        && tunnel.profileDir
        && typeof tunnel.profileName === "string"
        && tunnel.profileName) {
        paths.add(path.join(tunnel.profileDir, `${tunnel.profileName}.yaml`));
      }
    }
    return [...paths].map(captureRegularFile);
  }

  setupCheckpointChanged(checkpoint) {
    return checkpoint ? checkpoint.some(snapshot => regularFileChanged(snapshot, this.platform)) : false;
  }

  restoreSetupCheckpoint(checkpoint) {
    if (!checkpoint) return;
    const failures = [];
    for (const snapshot of [...checkpoint].reverse()) {
      try {
        restoreRegularFile(snapshot, this.platform);
      } catch (error) {
        failures.push(`${snapshot.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Setup checkpoint restoration failed: ${failures.join("; ")}`);
    }
  }

  async restorePreviousRuntime(snapshot, operationName, { repairExternal = false } = {}) {
    const current = this.runtimeConfigSnapshot();
    if (current.owner !== snapshot.owner || current.serialized !== snapshot.serialized) {
      throw new Error(
        "Runtime configuration changed before the operation failed; refusing to describe the current runtime as the previous installation",
      );
    }
    if (snapshot.owner === "external") {
      if (repairExternal) {
        if (this.platform !== "darwin") {
          throw new Error("Terminal-managed runtime repair is supported only on macOS");
        }
        await this.run(operationName, ["service", "install"], {
          embedded: true,
          message: "Restoring the previous terminal-managed daemon",
          successMessage: "Previous terminal-managed daemon restored",
          timeoutMs: 75_000,
        });
        if (snapshot.mode === "full") {
          await this.run(operationName, ["tunnel", "start"], {
            embedded: true,
            message: "Restoring the previous terminal-managed tunnel",
            successMessage: "Previous terminal-managed tunnel restored",
            timeoutMs: 75_000,
          });
        }
      }
      await this.run(operationName, ["doctor", "--json"], {
        message: "Verifying the previous terminal-managed runtime",
        successMessage: "Previous terminal-managed runtime is still healthy",
        timeoutMs: 75_000,
      });
      return;
    }
    const runtime = await this.supervisor.startIfConfigured();
    const expected = snapshot.configured ? "ready" : "not-configured";
    if (runtime.status !== expected) {
      throw new Error(
        `Previous runtime recovery returned ${runtime.status}; expected ${expected}${runtime.detail ? `: ${runtime.detail}` : ""}`,
      );
    }
  }

  async rollbackFirstSetup(checkpoint) {
    const changed = this.setupCheckpointChanged(checkpoint);
    let stopError;
    try {
      await this.supervisor.stopForSetup();
    } catch (error) {
      stopError = error;
    }
    let restoreError;
    try {
      this.restoreSetupCheckpoint(checkpoint);
    } catch (error) {
      restoreError = error;
    }
    this.supervisor.clearState();
    if (stopError || restoreError) {
      const failures = [
        stopError ? `stopping the incomplete runtime failed: ${stopError instanceof Error ? stopError.message : String(stopError)}` : null,
        restoreError ? (restoreError instanceof Error ? restoreError.message : String(restoreError)) : null,
      ].filter(Boolean);
      throw new Error(failures.join("; "));
    }
    return changed;
  }

}

Object.assign(
  RuntimeHost.prototype,
  executionMethods,
  routeMethods,
  integrationMethods,
  setupMethods,
  setupTransactionMethods,
);

module.exports = { CURRENT_CONNECTOR_NAME, RuntimeHost };
