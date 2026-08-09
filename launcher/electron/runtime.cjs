const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { resolveSystemDefaultBrowserExecutable } = require("./system-default-browser.cjs");
const {
  connectorNameForSetup,
  CURRENT_CONNECTOR_NAME,
  isLegacyConnectorName,
  requireCurrentRuntimeConnectorName,
  validateConnectorName,
} = require("./connector-identity.cjs");
const { embeddedRuntimeInvocation, runtimeInvocation } = require("./runtime-command.cjs");
const { redactText } = require("./logging.cjs");
const { DETACH_OWNED_CHILD, terminateOwnedProcessTree } = require("./process-tree.cjs");

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_LOG_LINE_CHARS = 64 * 1024;
const CORE_SETUP_TIMEOUT_MS = 5 * 60_000;
const MCP_SETUP_TIMEOUT_MS = 10 * 60_000;
const UNINSTALL_TIMEOUT_MS = 2 * 60_000;
const MAX_CHECKPOINT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LOGIN_STATE_FILE_BYTES = 16 * 1024 * 1024;
function collect(stream, chunks, onLine, onError) {
  let buffered = "";
  let bytes = 0;
  stream.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_CAPTURE_BYTES) chunks.push(chunk);
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

function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function executablePathIsAbsolute(candidate, platform = process.platform) {
  return platform === "win32" ? path.win32.isAbsolute(candidate) : path.posix.isAbsolute(candidate);
}

function usableBrowserExecutable(candidate, platform = process.platform) {
  if (typeof candidate !== "string" || !candidate || !executablePathIsAbsolute(candidate, platform)) return false;
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveBrowserLoginExecutable({
  platform = process.platform,
  env = process.env,
  resolveDefaultBrowserExecutable = resolveSystemDefaultBrowserExecutable,
  isUsable = (candidate) => usableBrowserExecutable(candidate, platform),
} = {}) {
  let candidate;
  try {
    candidate = resolveDefaultBrowserExecutable({ platform, env });
  } catch (error) {
    throw new Error(
      `Could not resolve the system default browser: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof candidate !== "string" || !candidate.trim() || !executablePathIsAbsolute(candidate, platform)) {
    throw new Error("The system default browser did not provide an absolute executable path");
  }
  if (!isUsable(candidate)) {
    throw new Error(`The system default browser executable is unavailable: ${candidate}`);
  }
  return candidate;
}

function captureRegularFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: filePath, exists: false };
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error(`Setup checkpoint path is not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_CHECKPOINT_FILE_BYTES) {
    throw new Error(`Setup checkpoint file exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes: ${filePath}`);
  }
  return {
    path: filePath,
    exists: true,
    data: fs.readFileSync(filePath),
    mode: stat.mode & 0o777,
  };
}

function restoreRegularFile(snapshot, platform = process.platform) {
  if (!snapshot.exists) {
    fs.rmSync(snapshot.path, { force: true });
    return;
  }
  writePrivateFileAtomic(snapshot.path, snapshot.data);
  if (platform !== "win32") fs.chmodSync(snapshot.path, snapshot.mode);
}

function regularFileChanged(snapshot, platform = process.platform) {
  let stat;
  try {
    stat = fs.lstatSync(snapshot.path);
  } catch (error) {
    if (error?.code === "ENOENT") return snapshot.exists;
    throw error;
  }
  if (!snapshot.exists || !stat.isFile()) return true;
  if (platform !== "win32" && (stat.mode & 0o777) !== snapshot.mode) return true;
  if (stat.size > MAX_CHECKPOINT_FILE_BYTES) return true;
  return !fs.readFileSync(snapshot.path).equals(snapshot.data);
}

function parseBridgeRouteResult(stdout, { expectedActive, requireInstalled = false } = {}) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error("Codex bridge route command returned invalid JSON");
  }
  if (typeof result?.active !== "boolean") {
    throw new Error("Codex bridge route command did not report its active state");
  }
  if (requireInstalled && typeof result.installed !== "boolean") {
    throw new Error("Codex bridge route status did not report whether the integration is installed");
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error(`Codex bridge route is inconsistent: ${result.errors.join("; ")}`);
  }
  if (typeof expectedActive === "boolean" && result.active !== expectedActive) {
    throw new Error(`Codex bridge route remained ${result.active ? "connected" : "disconnected"}`);
  }
  return result;
}

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
    this.browserLoginCleanupError = null;
    try {
      this.cleanupBrowserLoginTransfers();
    } catch (error) {
      this.browserLoginCleanupError = error;
      this.logger.warn("runtime.browser_login_cleanup_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
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

  cleanupBrowserLoginTransfers() {
    const parent = path.join(this.app.getPath("userData"), "browser-login");
    let entries;
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!/^transfer-[A-Za-z0-9]+$/.test(entry.name)) continue;
      fs.rmSync(path.join(parent, entry.name), { recursive: true, force: true });
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
      descriptor = JSON.parse(fs.readFileSync(this.browserDescriptorPath, "utf8"));
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

  resolveBrowserLoginExecutable() {
    return resolveBrowserLoginExecutable({
      platform: this.platform,
    });
  }

  async captureSystemBrowserLogin() {
    try {
      this.cleanupBrowserLoginTransfers();
      this.browserLoginCleanupError = null;
    } catch (error) {
      this.browserLoginCleanupError = error;
      throw new Error(
        `Refusing to start system-browser login because stale private transfer state could not be removed:`
        + ` ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const executable = this.resolveBrowserLoginExecutable();
    const parent = path.join(this.app.getPath("userData"), "browser-login");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(parent, 0o700); } catch {}
    const transferRoot = fs.mkdtempSync(path.join(parent, "transfer-"));
    try { fs.chmodSync(transferRoot, 0o700); } catch {}
    const storageStatePath = path.join(transferRoot, "storage-state.json");
    const cleanup = async () => fs.rmSync(transferRoot, { recursive: true, force: true });
    try {
      await this.run(
        "browser-login",
        [
          "login",
          "--launcher-control",
          "--chrome",
          executable,
          "--storage-state",
          storageStatePath,
        ],
        {
          env: this.launcherControlEnvironment(),
          message: "Sign in to ChatGPT in the system default browser window, then quit that dedicated browser instance completely",
          successMessage: "System-browser ChatGPT login verified",
        },
      );
      const stateStat = fs.lstatSync(storageStatePath);
      if (!stateStat.isFile() || stateStat.size <= 0 || stateStat.size > MAX_LOGIN_STATE_FILE_BYTES) {
        throw new Error("System-browser login returned an invalid storage-state file");
      }
      const markerPath = `${storageStatePath}.verified.json`;
      const markerStat = fs.lstatSync(markerPath);
      if (!markerStat.isFile() || markerStat.size <= 0 || markerStat.size > 64 * 1024) {
        throw new Error("System-browser login returned an invalid verification marker");
      }
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      if (marker?.version !== 1 || marker?.authenticated !== true || typeof marker?.verifiedAt !== "string") {
        throw new Error("System-browser login did not return authenticated verification evidence");
      }
      const storageState = JSON.parse(fs.readFileSync(storageStatePath, "utf8"));
      return { storageState, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
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

  async run(name, args, options = {}) {
    if (this.active) throw new Error(`Another launcher operation is active: ${this.active}`);
    if (this.activeChild
      && this.activeChild.exitCode === null
      && this.activeChild.signalCode === null) {
      throw new Error("A previous launcher operation process is still running");
    }
    this.activeChild = null;
    if (this.lifecycleOperation && this.lifecycleOperation !== name) {
      throw new Error(`Another launcher operation is active: ${this.lifecycleOperation}`);
    }
    this.active = name;
    this.publishOperation?.({ name, status: "running", message: options.message || name });
    this.logger.info("runtime.operation_started", { name, args: args.map((arg) => /key|token/i.test(arg) ? "[redacted]" : arg) });
    try {
      const invocation = options.embedded
        ? embeddedRuntimeInvocation({ app: this.app, sourceRoot: this.sourceRoot, args })
        : this.command(args);
      const result = await new Promise((resolve, reject) => {
        const child = spawn(invocation.executable, invocation.args, {
          cwd: invocation.cwd,
          detached: DETACH_OWNED_CHILD,
          env: {
            ...process.env,
            CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: this.browserDescriptorPath,
            ...(options.env || {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        this.activeChild = child;
        const stdout = [];
        const stderr = [];
        const pipeErrors = [];
        const recordPipeError = (stream) => (error) => {
          pipeErrors.push(`${name} ${stream} pipe failed: ${error instanceof Error ? error.message : String(error)}`);
        };
        collect(child.stdout, stdout, (line) => {
          this.logger.info("runtime.stdout", { operation: name, line });
          this.publishOperation?.({ name, status: "running", message: redactText(line) });
        }, recordPipeError("stdout"));
        collect(child.stderr, stderr, (line) => {
          this.logger.warn("runtime.stderr", { operation: name, line });
          this.publishOperation?.({ name, status: "running", message: redactText(line) });
        }, recordPipeError("stderr"));
        let settled = false;
        let timedOut = null;
        let terminationTimeout = null;
        let forceTimeout = null;
        const clearTimers = () => {
          if (timeout) clearTimeout(timeout);
          if (terminationTimeout) clearTimeout(terminationTimeout);
          if (forceTimeout) clearTimeout(forceTimeout);
        };
        const timeout = options.timeoutMs
          ? setTimeout(() => {
              if (settled) return;
              timedOut = new Error(`${name} timed out after ${options.timeoutMs}ms`);
              try {
                terminateOwnedProcessTree(child);
              } catch (error) {
                settled = true;
                clearTimers();
                reject(new Error(
                  `${timedOut.message}; child process tree termination failed: ${error instanceof Error ? error.message : String(error)}`,
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
                    `${timedOut.message}; forced child process tree termination failed: ${error instanceof Error ? error.message : String(error)}`,
                  ));
                  return;
                }
                forceTimeout = setTimeout(() => {
                  if (settled) return;
                  settled = true;
                  clearTimers();
                  reject(new Error(`${timedOut.message}; the child process did not exit after forced termination`));
                }, 2_000);
              }, 5_000);
            }, options.timeoutMs)
          : null;
        child.once("error", (error) => {
          const childStillRunning = Number.isInteger(child.pid)
            && child.exitCode === null
            && child.signalCode === null;
          if (this.activeChild === child && !childStillRunning) this.activeChild = null;
          if (settled) return;
          settled = true;
          clearTimers();
          reject(timedOut
            ? new Error(`${timedOut.message}; termination failed: ${error.message}`)
            : error);
        });
        child.once("exit", (code, signal) => {
          if (this.activeChild === child) this.activeChild = null;
          if (settled) return;
          settled = true;
          clearTimers();
          if (timedOut) {
            try {
              terminateOwnedProcessTree(child, "SIGKILL");
              reject(timedOut);
            } catch (error) {
              reject(new Error(
                `${timedOut.message}; final process-group cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
              ));
            }
            return;
          }
          if (pipeErrors.length > 0) {
            reject(new Error(pipeErrors.join("; ")));
            return;
          }
          resolve({
            code: code ?? 1,
            signal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
      });
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
        throw new Error(detail);
      }
      this.logger.info("runtime.operation_completed", { name });
      this.publishOperation?.({ name, status: "completed", message: options.successMessage || "Completed" });
      return result;
    } catch (error) {
      const message = redactText(error instanceof Error ? error.message : String(error));
      this.logger.error("runtime.operation_failed", { name, message });
      this.publishOperation?.({ name, status: "failed", message });
      throw new Error(message);
    } finally {
      this.active = null;
    }
  }

  async doctor() {
    try {
      const result = await this.run("doctor", ["doctor", "--json"], {
        message: "Checking runtime",
        timeoutMs: 75_000,
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      return {
        ok: false,
        checks: [{ id: "runtime", status: "error", message: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  async bridgeStatus(operationName = "bridge-status") {
    const result = await this.run(operationName, ["route", "status"], {
      embedded: true,
      message: "Checking Codex bridge route",
      successMessage: "Codex bridge route checked",
      timeoutMs: 15_000,
    });
    return parseBridgeRouteResult(result.stdout, { requireInstalled: true });
  }

  async restoreBridgeRouteWithinOperation(operationName) {
    const current = await this.bridgeStatus(operationName);
    if (!current.installed || !current.active) return current;
    const disconnected = await this.run(operationName, ["route", "disconnect"], {
      embedded: true,
      message: "Restoring the previous Codex route",
      successMessage: "Previous Codex route restored",
      timeoutMs: 15_000,
    });
    return {
      ...parseBridgeRouteResult(disconnected.stdout, { expectedActive: false }),
      installed: true,
    };
  }

  async restoreBridgeRoute(operationName = "bridge-route-restore") {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = operationName;
    try {
      return await this.restoreBridgeRouteWithinOperation(operationName);
    } finally {
      this.lifecycleOperation = null;
    }
  }

  async setBridgeEnabled(enabled) {
    const desired = enabled === true;
    const name = desired ? "bridge-connect" : "bridge-disconnect";
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = name;
    try {
      const current = await this.bridgeStatus(name);
      if (!current.installed) throw new Error("Install the Codex integration before changing the bridge route");
      if (desired) {
        const runtime = await this.supervisor.startIfConfigured();
        if (runtime.status !== "ready") {
          throw new Error(`Local runtime is ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
        }
        if (current.active) return current;
        try {
          const connected = await this.run(name, ["route", "connect"], {
            embedded: true,
            message: "Connecting Codex to the launcher",
            successMessage: "Codex bridge connected",
            timeoutMs: 15_000,
          });
          return parseBridgeRouteResult(connected.stdout, { expectedActive: true });
        } catch (error) {
          let cleanupError;
          try { await this.supervisor.stopForSetup(); } catch (caught) { cleanupError = caught; }
          if (!cleanupError) throw error;
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; stopping the unused runtime also failed:`
            + ` ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      }

      await this.supervisor.stopForSetup();
      if (!current.active) return current;
      try {
        const disconnected = await this.run(name, ["route", "disconnect"], {
          embedded: true,
          message: "Restoring the previous Codex route",
          successMessage: "Codex bridge disconnected",
          timeoutMs: 15_000,
        });
        return parseBridgeRouteResult(disconnected.stdout, { expectedActive: false });
      } catch (error) {
        let recoveryError;
        try {
          const runtime = await this.supervisor.startIfConfigured();
          if (runtime.status !== "ready") {
            throw new Error(`runtime recovery returned ${runtime.status}${runtime.detail ? `: ${runtime.detail}` : ""}`);
          }
        } catch (caught) {
          recoveryError = caught;
        }
        if (!recoveryError) throw error;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; restoring the previous runtime also failed:`
          + ` ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
    } finally {
      this.lifecycleOperation = null;
    }
  }

  mcpConnectorName() {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured || current.mode !== "full") {
      throw new Error("The native MCP runtime is not configured");
    }
    return requireCurrentRuntimeConnectorName(current.config?.appName);
  }

  browserConnectorName() {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured || current.mode !== "full") return CURRENT_CONNECTOR_NAME;
    return connectorNameForSetup(current.config?.appName);
  }

  cancelBrowserTurns() {
    return this.run("cancel-browser-turns", ["service", "cancel-turns"], {
      message: "Cancelling retained browser turns",
      successMessage: "Retained browser turns cancelled",
      timeoutMs: 15_000,
    });
  }

  async uninstallIntegration() {
    const name = "uninstall-integration";
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const previousRuntime = this.runtimeConfigSnapshot();
    this.lifecycleOperation = name;
    try {
      try {
        if (previousRuntime.owner === "external") this.supervisor.prepareExternalMigration();
        else await this.supervisor.stopForSetup();
      } catch (error) {
        try {
          await this.restoreBridgeRouteWithinOperation(name);
        } catch (routeError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; restoring the previous Codex route also failed:`
            + ` ${routeError instanceof Error ? routeError.message : String(routeError)}`,
          );
        }
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; the previous Codex route was restored,`
          + " but launcher runtime cleanup did not complete",
        );
      }
      try {
        return await this.run(name, ["uninstall", "--yes", "--launcher-control"], {
          embedded: true,
          env: this.launcherControlEnvironment(),
          message: "Restoring the previous Codex route",
          successMessage: "Codex Web GPT integration removed",
          timeoutMs: UNINSTALL_TIMEOUT_MS,
        });
      } catch (error) {
        try {
          await this.restoreBridgeRouteWithinOperation(name);
        } catch (routeError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; restoring the previous Codex route also failed:`
            + ` ${routeError instanceof Error ? routeError.message : String(routeError)}`,
          );
        }
        throw error;
      }
    } finally {
      this.lifecycleOperation = null;
    }
  }

  async setupCore() {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const existing = this.runtimeConfigSnapshot();
    const mode = existing.mode;
    const args = [
      "setup",
      mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      "--refresh-account-capabilities",
      "--replace-codex-route",
      "--acknowledge-unofficial",
      "--restart-service",
    ];
    if (!existing.configured) args.push("--chrome", this.resolveBrowserLoginExecutable());
    if (mode === "full") args.push("--app-name", this.browserConnectorName());
    const result = await this.runSetup("core-setup", args, {
      message: "Installing ChatGPT Web models into Codex",
      successMessage: "Codex integration installed",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    return { ...result, mode };
  }

  async upgradeManagedRuntime() {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const existing = this.runtimeConfigSnapshot();
    const currentVersion = this.app.getVersion();
    const connectorMigrationRequired = existing.mode === "full"
      && isLegacyConnectorName(validateConnectorName(existing.config?.appName));
    if (existing.owner !== "launcher"
      || (existing.config?.releaseVersion === currentVersion && !connectorMigrationRequired)) {
      return { updated: false };
    }
    const route = await this.bridgeStatus("runtime-upgrade-route");
    const args = [
      "setup",
      existing.mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      "--acknowledge-unofficial",
      "--restart-service",
    ];
    if (existing.mode === "full") {
      args.push("--app-name", connectorNameForSetup(existing.config?.appName));
    }
    const result = await this.runSetup("runtime-upgrade", args, {
      message: `Upgrading launcher runtime from ${existing.config.releaseVersion} to ${currentVersion}`,
      successMessage: `Launcher runtime upgraded to ${currentVersion}`,
      timeoutMs: existing.mode === "full" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,
    });
    if (!route.active) await this.setBridgeEnabled(false);
    return {
      updated: true,
      mode: existing.mode,
      bridgeEnabled: route.active,
      fromVersion: existing.config.releaseVersion,
      toVersion: currentVersion,
      connectorMigrated: connectorMigrationRequired,
      stdout: result.stdout,
    };
  }

  setupMcp({ tunnelId = "", runtimeKey = "", replace = false } = {}) {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const reuseSavedCredentials = replace !== true && this.mcpCredentialsConfigured();
    if (!reuseSavedCredentials && !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) {
      throw new Error("Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters");
    }
    if (!reuseSavedCredentials && (typeof runtimeKey !== "string" || runtimeKey.trim().length < 20)) {
      throw new Error("A Tunnels Read + Use runtime key is required");
    }
    const args = [
      "setup",
      "--full",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      "--app-name",
      this.browserConnectorName(),
      "--replace-codex-route",
    ];
    if (reuseSavedCredentials) {
      args.push("--acknowledge-unofficial", "--restart-service");
      return this.runSetup("mcp-setup", args, {
        message: "Reconnecting the native Codex harness with saved tunnel credentials",
        successMessage: "Local MCP tools are ready",
        timeoutMs: MCP_SETUP_TIMEOUT_MS,
      });
    }
    const secretsDir = path.join(this.app.getPath("userData"), "secrets");
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(secretsDir, 0o700); } catch {}
    const keyPath = path.join(secretsDir, `runtime-key-${randomBytes(16).toString("hex")}.tmp`);
    fs.writeFileSync(keyPath, runtimeKey.trim(), { flag: "wx", mode: 0o600 });
    args.push(
      "--tunnel-id",
      tunnelId,
      "--runtime-key-file",
      keyPath,
      "--acknowledge-unofficial",
      "--restart-service",
    );
    return this.runSetup("mcp-setup", args, {
      message: "Connecting the native Codex harness",
      successMessage: "Local MCP tools are ready",
      timeoutMs: MCP_SETUP_TIMEOUT_MS,
    }).finally(() => fs.rmSync(keyPath, { force: true }));
  }

  async runSetup(name, args, options) {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const previousRuntime = this.runtimeConfigSnapshot();
    const checkpoint = this.captureSetupCheckpoint(previousRuntime);
    this.lifecycleOperation = name;
    let setupCommandStarted = false;
    try {
      if (previousRuntime.owner === "external") this.supervisor.prepareExternalMigration();
      else await this.supervisor.stopForSetup();
      setupCommandStarted = true;
      const result = await this.run(name, args, options);
      const runtime = await this.supervisor.startIfConfigured();
      if (runtime.status !== "ready") {
        throw new Error(`Setup completed, but the launcher-owned runtime is ${runtime.status}: ${runtime.detail || "not ready"}`);
      }
      return result;
    } catch (error) {
      const primary = error instanceof Error ? error.message : String(error);
      const failures = [];
      let rolledBack = false;
      let checkpointChanged = false;
      if (!previousRuntime.configured && setupCommandStarted) {
        try {
          rolledBack = await this.rollbackFirstSetup(checkpoint);
        } catch (caught) {
          failures.push(
            `first-time setup rollback failed: ${caught instanceof Error ? caught.message : String(caught)}`,
          );
        }
      }
      if (previousRuntime.configured && checkpoint) {
        try {
          checkpointChanged = this.setupCheckpointChanged(checkpoint);
        } catch (caught) {
          checkpointChanged = true;
          failures.push(
            `checking the setup checkpoint failed: ${caught instanceof Error ? caught.message : String(caught)}`,
          );
        }
        try {
          this.restoreSetupCheckpoint(checkpoint);
        } catch (caught) {
          failures.push(caught instanceof Error ? caught.message : String(caught));
        }
      }
      let recoveryError;
      try {
        await this.restorePreviousRuntime(previousRuntime, name, {
          repairExternal: previousRuntime.owner === "external" && checkpointChanged,
        });
      } catch (caught) {
        recoveryError = caught;
      }
      if (recoveryError) {
        failures.push(
          `restoring the previous launcher runtime failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        );
      }
      const message = [
        primary,
        ...(rolledBack ? ["incomplete first-time setup was rolled back"] : []),
        ...failures,
      ].join("; ");
      this.publishOperation?.({ name, status: "failed", message });
      throw new Error(message);
    } finally {
      this.lifecycleOperation = null;
    }
  }
}

module.exports = {
  CURRENT_CONNECTOR_NAME,
  resolveBrowserLoginExecutable,
  RuntimeHost,
};
