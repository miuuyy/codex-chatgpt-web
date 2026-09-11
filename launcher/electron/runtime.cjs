const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const {
  connectorNameForDevSetup,
  connectorNameForSetup,
  CURRENT_CONNECTOR_NAME,
  DEV_CONNECTOR_NAME,
  isLegacyConnectorName,
  requireCurrentRuntimeConnectorName,
  validateConnectorName,
} = require("./connector-identity.cjs");
const { embeddedRuntimeInvocation, runtimeInvocation } = require("./runtime-command.cjs");
const { redactText } = require("./logging.cjs");
const { DETACH_OWNED_CHILD, terminateOwnedProcessTree } = require("./process-tree.cjs");
const { resolveIntegrationMode } = require("./integration-mode.cjs");

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_LOG_LINE_CHARS = 64 * 1024;
const CORE_SETUP_TIMEOUT_MS = 5 * 60_000;
const MCP_SETUP_TIMEOUT_MS = 10 * 60_000;
const UNINSTALL_TIMEOUT_MS = 2 * 60_000;
const MAX_CHECKPOINT_FILE_BYTES = 16 * 1024 * 1024;
const PASSKEY_LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_PASSKEY_STATE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PASSKEY_MARKER_FILE_BYTES = 64 * 1024;
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

function usableExecutable(candidate, platform = process.platform) {
  if (typeof candidate !== "string" || !candidate) return false;
  const absolute = platform === "win32" ? path.win32.isAbsolute(candidate) : path.posix.isAbsolute(candidate);
  if (!absolute) return false;
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function captureRegularFile(filePath, { followSymlink = false } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: filePath, exists: false };
    throw error;
  }
  let symlink;
  if (followSymlink && stat.isSymbolicLink()) {
    symlink = { link: fs.readlinkSync(filePath), target: fs.realpathSync(filePath) };
    stat = fs.lstatSync(symlink.target);
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
    data: fs.readFileSync(symlink?.target ?? filePath),
    mode: stat.mode & 0o777,
    ...(symlink ? { symlink } : {}),
  };
}

function checkpointWritePath(snapshot) {
  if (!snapshot.symlink) return snapshot.path;
  if (!fs.lstatSync(snapshot.path).isSymbolicLink()
    || fs.readlinkSync(snapshot.path) !== snapshot.symlink.link
    || fs.realpathSync(snapshot.path) !== snapshot.symlink.target) {
    throw new Error(`Codex config symlink changed during setup: ${snapshot.path}`);
  }
  return snapshot.symlink.target;
}

function restoreRegularFile(snapshot, platform = process.platform) {
  if (!snapshot.exists) {
    fs.rmSync(snapshot.path, { force: true });
    return;
  }
  const writePath = checkpointWritePath(snapshot);
  writePrivateFileAtomic(writePath, snapshot.data, snapshot.symlink
    ? { mode: snapshot.mode, protectDirectory: false }
    : undefined);
  if (platform !== "win32") fs.chmodSync(writePath, snapshot.mode);
}

function regularFileChanged(snapshot, platform = process.platform) {
  let filePath;
  try { filePath = checkpointWritePath(snapshot); } catch { return true; }
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return snapshot.exists;
    throw error;
  }
  if (!snapshot.exists || !stat.isFile()) return true;
  if (platform !== "win32" && (stat.mode & 0o777) !== snapshot.mode) return true;
  if (stat.size > MAX_CHECKPOINT_FILE_BYTES) return true;
  return !fs.readFileSync(filePath).equals(snapshot.data);
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
    coreHome,
    codexHome,
    launcherProfile = "production",
    launchAgentsDir,
    platform = process.platform,
    publishOperation,
    supervisor,
    getBrowserInteractionMode = () => "automatic",
    getIntegrationMode = () => "direct",
  }) {
    this.app = app;
    this.logger = logger;
    this.sourceRoot = sourceRoot;
    this.installedRuntimeRoot = installedRuntimeRoot;
    this.runtimeRootProvider = runtimeRootProvider;
    this.browserDescriptorPath = browserDescriptorPath;
    if (launcherProfile !== "production" && launcherProfile !== "development") {
      throw new Error("Runtime host launcher profile is invalid");
    }
    this.launcherProfile = launcherProfile;
    this.coreHome = coreHome ? resolveUserPath(coreHome) : null;
    if (launcherProfile === "development" && !this.coreHome) {
      throw new Error("Runtime host DEV profile requires its isolated home");
    }
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
    this.getBrowserInteractionMode = getBrowserInteractionMode;
    this.getIntegrationMode = getIntegrationMode;
    this.active = null;
    this.activeChild = null;
    this.lifecycleOperation = null;
    this.cleanupEphemeralSecrets();
    this.passkeyContinuationRequested = false;
    try {
      this.cleanupPasskeyTransfers();
    } catch (error) {
      this.logger.warn("runtime.passkey_cleanup_failed", {
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

  browserInteractionMode() {
    const mode = this.getBrowserInteractionMode();
    if (mode !== "automatic" && mode !== "manual") {
      throw new Error("Launcher browser interaction mode is invalid");
    }
    return mode;
  }

  browserInteractionArgs({ refreshCapabilities = false, mode = this.browserInteractionMode() } = {}) {
    if (mode !== "automatic" && mode !== "manual") {
      throw new Error("Launcher browser interaction mode is invalid");
    }
    return [
      mode === "manual" ? "--zero-risk-browser-interaction" : "--automatic-browser-interaction",
      ...(mode === "automatic" && refreshCapabilities ? ["--refresh-account-capabilities"] : []),
    ];
  }

  assertProductionProfile(operation) {
    if (this.launcherProfile !== "production") {
      throw new Error(`${operation} is unavailable in the isolated DEV launcher profile`);
    }
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

  cleanupPasskeyTransfers() {
    const parent = path.join(this.app.getPath("userData"), "passkey-login");
    let entries;
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && /^transfer-[A-Za-z0-9]+$/.test(entry.name)) {
        fs.rmSync(path.join(parent, entry.name), { recursive: true, force: true });
      }
    }
  }

  passkeyChromeExecutable() {
    if (this.platform !== "darwin") throw new Error("Passkey sign-in is currently supported only on macOS");
    const setupConfig = this.supervisor.readSetupConfig
      ? this.supervisor.readSetupConfig()
      : this.supervisor.readConfig();
    const candidate = setupConfig?.chromeExecutablePath
      || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (!usableExecutable(candidate, this.platform)) {
      throw new Error(`Google Chrome is unavailable at ${candidate}`);
    }
    return candidate;
  }

  continuePasskeyLogin() {
    const child = this.activeChild;
    if (this.active !== "passkey-login"
      || this.passkeyContinuationRequested
      || !child
      || child.exitCode !== null
      || child.signalCode !== null
      || !child.stdin?.writable) {
      throw new Error("No passkey sign-in is waiting for Continue");
    }
    this.passkeyContinuationRequested = true;
    this.publishOperation?.({
      name: "passkey-login",
      status: "running",
      message: "Capturing and verifying the passkey session",
    });
    return new Promise((resolve, reject) => {
      child.stdin.write(
        `${JSON.stringify({ version: 1, type: "passkey-login-continue" })}\n`,
        error => {
          if (error) {
            this.passkeyContinuationRequested = false;
            reject(error);
          } else {
            resolve(true);
          }
        },
      );
    });
  }

  async capturePasskeyLogin() {
    this.cleanupPasskeyTransfers();
    const chrome = this.passkeyChromeExecutable();
    const parent = path.join(this.app.getPath("userData"), "passkey-login");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(parent, 0o700); } catch {}
    const transferRoot = fs.mkdtempSync(path.join(parent, "transfer-"));
    try { fs.chmodSync(transferRoot, 0o700); } catch {}
    const storageStatePath = path.join(transferRoot, "storage-state.json");
    const markerPath = `${storageStatePath}.verified.json`;
    const cleanup = async () => fs.rmSync(transferRoot, { recursive: true, force: true });
    this.passkeyContinuationRequested = false;
    try {
      await this.run("passkey-login", [
        "login",
        "--launcher-control",
        "--chrome",
        chrome,
        "--storage-state",
        storageStatePath,
      ], {
        embedded: true,
        controlStdin: true,
        env: this.launcherControlEnvironment(),
        message: "Sign in with your passkey in Chrome, then return here and choose Continue",
        successMessage: "Passkey session captured for private Launcher verification",
        timeoutMs: PASSKEY_LOGIN_TIMEOUT_MS,
      });
      const stateStat = fs.lstatSync(storageStatePath);
      if (!stateStat.isFile() || stateStat.size < 1 || stateStat.size > MAX_PASSKEY_STATE_FILE_BYTES) {
        throw new Error("Passkey sign-in returned an invalid storage-state file");
      }
      const markerStat = fs.lstatSync(markerPath);
      if (!markerStat.isFile() || markerStat.size < 1 || markerStat.size > MAX_PASSKEY_MARKER_FILE_BYTES) {
        throw new Error("Passkey sign-in returned invalid capture evidence");
      }
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      const capturedAt = typeof marker?.capturedAt === "string" ? Date.parse(marker.capturedAt) : Number.NaN;
      if (marker?.version !== 1
        || marker?.captureComplete !== true
        || marker?.source !== "isolated-normal-browser-profile"
        || !Number.isFinite(capturedAt)
        || capturedAt < Date.now() - PASSKEY_LOGIN_TIMEOUT_MS - 60_000
        || capturedAt > Date.now() + 60_000) {
        throw new Error("Passkey sign-in did not return completed capture evidence");
      }
      return { storageState: JSON.parse(fs.readFileSync(storageStatePath, "utf8")), cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    } finally {
      this.passkeyContinuationRequested = false;
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

  devSetupEnvironment(environment = process.env) {
    if (this.launcherProfile !== "development" || !this.coreHome) {
      throw new Error("DEV setup environment requires the isolated DEV launcher");
    }
    const childEnvironment = { ...environment };
    delete childEnvironment.CODEX_CHATGPT_WEB_HOME;
    delete childEnvironment.CODEX_HOME;
    delete childEnvironment.CODEX_WEB_GPT_LAUNCHER_DATA_DIR;
    childEnvironment.CODEX_WEB_GPT_DEV_HOME = this.coreHome;
    return childEnvironment;
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
        integrationMode: resolveIntegrationMode({ integrationMode: this.getIntegrationMode() }),
        serialized: null,
      };
    }
    const launcherOwned = setupConfig.browserHost === "launcher";
    const config = launcherOwned ? this.supervisor.readConfig() : setupConfig;
    return {
      configured: true,
      owner: launcherOwned ? "launcher" : "external",
      mode: config.mode === "full" ? "full" : "browser-only",
      integrationMode: resolveIntegrationMode(config),
      serialized: JSON.stringify(config),
      config: structuredClone(config),
    };
  }

  integrationMode() {
    const snapshot = this.runtimeConfigSnapshot();
    return snapshot.configured
      ? resolveIntegrationMode(snapshot.config)
      : resolveIntegrationMode({ integrationMode: this.getIntegrationMode() });
  }

  isExternalProvider() {
    return this.integrationMode() === "external-provider";
  }

  productionSetupArgs(args, options = {}) {
    if (this.launcherProfile !== "production") return args;
    const next = [...args];
    if (this.isExternalProvider()) {
      if (!next.includes("--integration-mode")) next.push("--integration-mode", "external-provider");
      return next.filter(arg => arg !== "--replace-codex-route");
    }
    if (!next.includes("--integration-mode")) next.push("--integration-mode", "direct");
    if (options.replaceCodexRoute === false) {
      return next.filter(arg => arg !== "--replace-codex-route");
    }
    if (!next.includes("--replace-codex-route")) next.push("--replace-codex-route");
    return next;
  }

  mcpCredentialsConfigured(requestedMode) {
    const config = this.runtimeConfigSnapshot().config;
    const interactionMode = requestedMode ?? config?.browserInteractionMode ?? "automatic";
    if (interactionMode !== "automatic" && interactionMode !== "manual") {
      throw new Error("Browser interaction mode must be automatic or manual");
    }
    const explicitTunnel = interactionMode === "manual"
      ? config?.manualTunnel
      : config?.automaticTunnel;
    const hasExplicitProfiles = Boolean(config?.automaticTunnel || config?.manualTunnel);
    const tunnel = config?.mode === "full"
      ? explicitTunnel || (!hasExplicitProfiles && interactionMode === "automatic" ? config.tunnel : null)
      : null;
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
      path.join(coreHome, "secrets", "tunnel-runtime.key"),
      path.join(coreHome, "secrets", "tunnel-runtime-automatic.key"),
      path.join(coreHome, "secrets", "tunnel-runtime-zero-risk.key"),
      path.join(coreHome, "tunnel", "profiles", "codex-chatgpt-web.yaml"),
      path.join(coreHome, "tunnel", "profiles", "codex-chatgpt-web-zero-risk.yaml"),
      path.join(coreHome, "tunnel", "profiles", "codex-chatgpt-web-dev.yaml"),
      path.join(coreHome, "tunnel", "profiles", "codex-chatgpt-web-dev-zero-risk.yaml"),
    ]);
    if (!this.isExternalProvider()) {
      paths.add(path.join(this.codexHome, "config.toml"));
      paths.add(path.join(this.codexHome, "models_cache.json"));
    }
    if (snapshot.owner === "external" && this.platform === "darwin") {
      paths.add(path.join(this.launchAgentsDir, "io.github.codex-chatgpt-web.daemon.plist"));
      paths.add(path.join(this.launchAgentsDir, "io.github.codex-chatgpt-web.tunnel.plist"));
    }
    const tunnels = [
      snapshot.config?.tunnel,
      snapshot.config?.automaticTunnel,
      snapshot.config?.manualTunnel,
    ];
    for (const tunnel of tunnels) {
      if (!tunnel || typeof tunnel !== "object") continue;
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
    return [...paths].map(filePath => captureRegularFile(filePath, {
      followSymlink: filePath === path.join(this.codexHome, "config.toml"),
    }));
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
        const environment = options.environment
          ? { ...options.environment }
          : { ...process.env };
        Object.assign(environment, {
          CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: this.browserDescriptorPath,
          ...(options.env || {}),
        });
        const child = spawn(invocation.executable, invocation.args, {
          cwd: invocation.cwd,
          detached: DETACH_OWNED_CHILD,
          env: environment,
          stdio: [options.controlStdin ? "pipe" : "ignore", "pipe", "pipe"],
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
      const acceptedExitCodes = options.acceptedExitCodes || [0];
      if (!acceptedExitCodes.includes(result.code)) {
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
    this.assertProductionProfile("Runtime doctor");
    try {
      const result = await this.run("doctor", ["doctor", "--json"], {
        message: "Checking runtime",
        timeoutMs: 75_000,
        acceptedExitCodes: [0, 1],
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      return {
        ok: false,
        checks: [{ id: "runtime", status: "error", message: error instanceof Error ? error.message : String(error) }],
      };
    }
  }

  async devDoctor() {
    if (this.launcherProfile !== "development") {
      throw new Error("DEV harness diagnostics require the isolated DEV launcher profile");
    }
    const checks = [];
    let config;
    try {
      config = this.supervisor.readConfig();
      checks.push({
        id: "dev-profile",
        status: config?.purpose === "dev-harness" ? "ok" : "error",
        message: config?.purpose === "dev-harness"
          ? "Isolated DEV harness configuration is valid"
          : "Isolated DEV harness configuration is missing",
      });
    } catch (error) {
      checks.push({
        id: "dev-profile",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const full = config?.mode === "full" && config?.tunnel;
    checks.push({
      id: "dev-tunnel-credentials",
      status: full && fs.existsSync(config.tunnel.runtimeKeyFile) ? "ok" : "error",
      message: full && fs.existsSync(config.tunnel.runtimeKeyFile)
        ? "DEV tunnel credentials are configured"
        : "DEV Full harness tunnel credentials are not configured",
    });
    if (full) {
      try {
        const runtime = await this.supervisor.readTunnelHealth(config);
        checks.push({
          id: "dev-tunnel-runtime",
          status: runtime.ready ? "ok" : "error",
          message: runtime.ready
            ? "Isolated DEV MCP tunnel runtime is ready"
            : "Isolated DEV MCP tunnel runtime is not ready",
          ...(!runtime.ready ? { detail: runtime.detail } : {}),
        });
      } catch (error) {
        checks.push({
          id: "dev-tunnel-runtime",
          status: "error",
          message: "Isolated DEV MCP tunnel runtime could not be inspected",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    checks.push({
      id: "responses-listener",
      status: "ok",
      message: "DEV runtime supervision is tunnel-only and never starts a Responses listener",
    });
    return {
      ok: checks.every(check => check.status !== "error"),
      mode: config?.mode,
      checks,
    };
  }

  async bridgeStatus(operationName = "bridge-status") {
    this.assertProductionProfile("Codex bridge status");
    const result = await this.run(operationName, ["route", "status"], {
      embedded: true,
      message: "Checking Codex bridge route",
      successMessage: "Codex bridge route checked",
      timeoutMs: 15_000,
    });
    return parseBridgeRouteResult(result.stdout, { requireInstalled: true });
  }

  async restoreBridgeRouteWithinOperation(operationName) {
    if (this.isExternalProvider()) {
      return { installed: false, active: false, errors: [], skipped: true, reason: "external-provider" };
    }
    const current = await this.bridgeStatus(operationName);
    if (!current.installed || !current.active) return current;
    const disconnected = await this.run(operationName, ["route", "disconnect"], {
      embedded: true,
      message: "Restoring the previous Codex route",
      successMessage: "Previous Codex route restored",
      timeoutMs: 15_000,
    });
    const result = parseBridgeRouteResult(disconnected.stdout, { expectedActive: false });
    const verified = await this.bridgeStatus(operationName);
    if (!verified.installed || verified.active) {
      throw new Error("Codex bridge route restore did not persist in the active config");
    }
    return {
      ...result,
      installed: true,
    };
  }

  async restoreBridgeRoute(operationName = "bridge-route-restore") {
    if (this.isExternalProvider()) {
      return { installed: false, active: false, errors: [], skipped: true, reason: "external-provider" };
    }
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = operationName;
    try {
      return await this.restoreBridgeRouteWithinOperation(operationName);
    } finally {
      this.lifecycleOperation = null;
    }
  }

  async connectBridgeRoute() {
    this.assertProductionProfile("Codex bridge routing");
    if (this.isExternalProvider()) {
      return { installed: false, active: false, changed: false, errors: [], skipped: true, reason: "external-provider" };
    }
    const name = "bridge-connect";
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.lifecycleOperation = name;
    try {
      const current = await this.bridgeStatus(name);
      if (!current.installed) throw new Error("Install the Codex integration before connecting the bridge route");
      if (current.active) return current;
      try {
        const connected = await this.run(name, ["route", "connect"], {
          embedded: true,
          message: "Connecting Codex to the launcher",
          successMessage: "Codex bridge connected",
          timeoutMs: 15_000,
        });
        const result = parseBridgeRouteResult(connected.stdout, { expectedActive: true });
        const verified = await this.bridgeStatus(name);
        if (!verified.installed || !verified.active) {
          throw new Error("Codex bridge route connection did not persist in the active config");
        }
        return result;
      } catch (error) {
        let cleanupError;
        try { await this.supervisor.stopForSetup(); } catch (caught) { cleanupError = caught; }
        if (!cleanupError) throw error;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; stopping the unrouted runtime also failed:`
          + ` ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
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
    return this.launcherProfile === "development"
      ? connectorNameForDevSetup(current.config?.appName)
      : requireCurrentRuntimeConnectorName(current.config?.appName);
  }

  browserConnectorName() {
    const current = this.runtimeConfigSnapshot();
    if (this.launcherProfile === "development") {
      return connectorNameForDevSetup(current.config?.appName);
    }
    if (!current.configured || current.mode !== "full") return CURRENT_CONNECTOR_NAME;
    return connectorNameForSetup(current.config?.appName);
  }

  setupConnectorName() {
    return this.launcherProfile === "development" ? DEV_CONNECTOR_NAME : CURRENT_CONNECTOR_NAME;
  }

  cancelActiveTurns() {
    this.assertProductionProfile("Launcher-owned turn cancellation");
    return this.run("cancel-active-turns", ["service", "cancel-turns"], {
      message: "Cancelling active Codex turns",
      successMessage: "Active Codex turns cancelled",
      timeoutMs: 15_000,
    });
  }

  async uninstallIntegration() {
    this.assertProductionProfile("Codex integration removal");
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
        const result = await this.run(name, ["uninstall", "--yes", "--launcher-control"], {
          embedded: true,
          env: this.launcherControlEnvironment(),
          message: this.isExternalProvider()
            ? "Removing the local ChatGPT Web provider without changing Codex routing"
            : "Restoring the previous Codex route",
          successMessage: "Codex Web GPT integration removed",
          timeoutMs: UNINSTALL_TIMEOUT_MS,
        });
        if (!this.isExternalProvider()) {
          const verified = await this.bridgeStatus(name);
          if (verified.installed || verified.active) {
            throw new Error("Codex integration removal did not persist in the active config");
          }
        }
        return result;
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
    this.assertProductionProfile("Codex integration setup");
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const existing = this.runtimeConfigSnapshot();
    const mode = existing.mode;
    const interactionMode = existing.configured
      ? existing.config?.browserInteractionMode ?? this.browserInteractionMode()
      : this.browserInteractionMode();
    if (!existing.configured && interactionMode === "manual") {
      throw new Error("Zero Risk must be installed through MCP setup because tunnel credentials are required");
    }
    const args = [
      "setup",
      mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      ...this.browserInteractionArgs({
        mode: interactionMode,
        refreshCapabilities: interactionMode === "automatic",
      }),
      "--acknowledge-unofficial",
      "--restart-service",
    ];
    const result = await this.runSetup("core-setup", this.productionSetupArgs(args), {
      message: "Installing ChatGPT Web models into Codex",
      successMessage: "Codex integration installed",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    return { ...result, mode };
  }

  async setupDevCore() {
    if (this.launcherProfile !== "development") {
      throw new Error("DEV profile setup requires the isolated DEV launcher");
    }
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const existing = this.runtimeConfigSnapshot();
    const mode = existing.mode;
    const interactionMode = existing.configured
      ? existing.config?.browserInteractionMode ?? this.browserInteractionMode()
      : "automatic";
    const args = [
      "dev",
      "setup",
      mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      ...this.browserInteractionArgs({
        mode: interactionMode,
        refreshCapabilities: interactionMode === "automatic",
      }),
      "--acknowledge-unofficial",
    ];
    const result = await this.runDevSetup("dev-profile-setup", args, {
      message: "Configuring the isolated DEV harness",
      successMessage: "Isolated DEV harness configured",
      timeoutMs: mode === "full" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,
    });
    return { ...result, mode };
  }

  async setBiggerContext(enabled) {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) {
      throw new Error("Initialize the runtime before changing Bigger Context");
    }
    const mode = current.mode;
    const contextFlag = enabled === true ? "--bigger-context" : "--standard-context";
    if (this.launcherProfile === "development") {
      const args = [
        "dev",
        "setup",
        mode === "full" ? "--full" : "--browser-only",
        "--browser-host-descriptor",
        this.browserDescriptorPath,
        ...this.browserInteractionArgs(),
        "--acknowledge-unofficial",
        contextFlag,
      ];
      if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
      const result = await this.runDevSetup("bigger-context", args, {
        message: enabled ? "Enabling Bigger Context" : "Disabling Bigger Context",
        successMessage: enabled ? "Bigger Context enabled" : "Standard context restored",
        timeoutMs: CORE_SETUP_TIMEOUT_MS,
      });
      return { ...result, mode, enabled: enabled === true };
    }
    const args = [
      "setup",
      mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      ...this.browserInteractionArgs(),
      "--acknowledge-unofficial",
      "--restart-service",
      contextFlag,
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const result = await this.runSetup("bigger-context", this.productionSetupArgs(args), {
      message: enabled ? "Enabling Bigger Context" : "Disabling Bigger Context",
      successMessage: enabled ? "Bigger Context enabled; restart Codex" : "Standard context restored; restart Codex",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    return { ...result, mode, enabled: enabled === true };
  }

  async setZeroRiskPro(enabled) {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) {
      throw new Error("Install the Codex integration before changing Zero Risk model profiles");
    }
    if (current.config?.browserInteractionMode !== "manual" || current.mode !== "full") {
      throw new Error("Zero Risk Pro is available only while the Full Zero Risk harness is active");
    }
    const profileFlag = enabled === true ? "--zero-risk-pro" : "--zero-risk-default";
    const args = [
      ...(this.launcherProfile === "development" ? ["dev", "setup"] : ["setup"]),
      "--full",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      ...this.browserInteractionArgs({ mode: "manual" }),
      "--acknowledge-unofficial",
      "--standard-context",
      profileFlag,
      ...(this.launcherProfile === "production" ? ["--restart-service"] : []),
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const options = {
      message: enabled ? "Installing the Zero Risk Pro model" : "Removing the Zero Risk Pro model",
      successMessage: enabled
        ? `Zero Risk Pro installed${this.launcherProfile === "production" ? "; restart Codex" : ""}`
        : `Default Zero Risk model restored${this.launcherProfile === "production" ? "; restart Codex" : ""}`,
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    };
    const result = this.launcherProfile === "development"
      ? await this.runDevSetup("zero-risk-pro", args, options)
      : await this.runSetup("zero-risk-pro", this.productionSetupArgs(args), options);
    return { ...result, mode: current.mode, enabled: enabled === true };
  }

  async upgradeManagedRuntime() {
    this.assertProductionProfile("Managed Codex runtime upgrade");
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const existing = this.runtimeConfigSnapshot();
    const currentVersion = this.app.getVersion();
    const connectorMigrationRequired = existing.mode === "full"
      && isLegacyConnectorName(validateConnectorName(existing.config?.appName));
    const interactionMode = existing.config?.browserInteractionMode ?? "automatic";
    const expectedTunnelProfile = interactionMode === "manual"
      ? "codex-chatgpt-web-zero-risk"
      : "codex-chatgpt-web";
    const expectedKeyFile = interactionMode === "manual"
      ? "tunnel-runtime-zero-risk.key"
      : "tunnel-runtime-automatic.key";
    const explicitTunnel = interactionMode === "manual"
      ? existing.config?.manualTunnel
      : existing.config?.automaticTunnel;
    const activeTunnel = existing.config?.tunnel;
    const tunnelProfileMigrationRequired = existing.mode === "full" && Boolean(activeTunnel) && Boolean(
      !explicitTunnel
      || explicitTunnel.tunnelId !== activeTunnel.tunnelId
      || activeTunnel.profileName !== expectedTunnelProfile
      || activeTunnel.alias !== expectedTunnelProfile
      || path.basename(activeTunnel.runtimeKeyFile) !== expectedKeyFile
    );
    if (existing.owner !== "launcher"
      || (existing.config?.releaseVersion === currentVersion
        && !connectorMigrationRequired
        && !tunnelProfileMigrationRequired)) {
      return { updated: false };
    }
    const args = [
      "setup",
      existing.mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      // A release may repair capability detection. Reusing the previous result can
      // keep eligible models disabled even after the corrected probe is installed.
      ...this.browserInteractionArgs({ mode: interactionMode, refreshCapabilities: true }),
      "--acknowledge-unofficial",
      "--restart-service",
    ];
    const result = await this.runSetup("runtime-upgrade", this.productionSetupArgs(args, { replaceCodexRoute: false }), {
      message: tunnelProfileMigrationRequired
        ? `Separating ${interactionMode === "manual" ? "Zero Risk" : "Automatic"} MCP credentials`
        : `Upgrading launcher runtime from ${existing.config.releaseVersion} to ${currentVersion}`,
      successMessage: tunnelProfileMigrationRequired
        ? `${interactionMode === "manual" ? "Zero Risk" : "Automatic"} MCP profile migrated`
        : `Launcher runtime upgraded to ${currentVersion}`,
      timeoutMs: existing.mode === "full" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,
    });
    return {
      updated: true,
      mode: existing.mode,
      fromVersion: existing.config.releaseVersion,
      toVersion: currentVersion,
      connectorMigrated: connectorMigrationRequired,
      stdout: result.stdout,
    };
  }

  setupMcp({ tunnelId = "", runtimeKey = "", replace = false, interactionMode } = {}, afterRuntimeReady) {
    this.assertProductionProfile("Native Codex MCP setup");
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const targetMode = interactionMode ?? this.browserInteractionMode();
    const reuseSavedCredentials = replace !== true && this.mcpCredentialsConfigured(targetMode);
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
      ...this.browserInteractionArgs({ mode: targetMode }),
    ];
    if (reuseSavedCredentials) {
      args.push("--acknowledge-unofficial", "--restart-service");
      return this.runSetup("mcp-setup", this.productionSetupArgs(args), {
        message: "Reconnecting the native Codex harness with saved tunnel credentials",
        successMessage: "Local MCP tools are ready",
        timeoutMs: MCP_SETUP_TIMEOUT_MS,
        afterRuntimeReady,
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
    return this.runSetup("mcp-setup", this.productionSetupArgs(args), {
      message: "Connecting the native Codex harness",
      successMessage: "Local MCP tools are ready",
      timeoutMs: MCP_SETUP_TIMEOUT_MS,
      afterRuntimeReady,
    }).finally(() => fs.rmSync(keyPath, { force: true }));
  }

  setupDevMcp({ tunnelId = "", runtimeKey = "", replace = false, interactionMode } = {}, afterRuntimeReady) {
    if (this.launcherProfile !== "development") {
      throw new Error("DEV MCP setup requires the isolated DEV launcher");
    }
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const targetMode = interactionMode ?? this.browserInteractionMode();
    const reuseSavedCredentials = replace !== true && this.mcpCredentialsConfigured(targetMode);
    if (!reuseSavedCredentials && !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) {
      throw new Error("Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters");
    }
    if (!reuseSavedCredentials && (typeof runtimeKey !== "string" || runtimeKey.trim().length < 20)) {
      throw new Error("A Tunnels Read + Use runtime key is required");
    }
    const args = [
      "dev",
      "setup",
      "--full",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      ...this.browserInteractionArgs({ mode: targetMode }),
      "--acknowledge-unofficial",
    ];
    if (reuseSavedCredentials) {
      return this.runDevSetup("dev-mcp-setup", args, {
        message: "Validating saved DEV tunnel credentials",
        successMessage: "DEV Full harness is configured",
        timeoutMs: MCP_SETUP_TIMEOUT_MS,
        afterRuntimeReady,
      });
    }
    const secretsDir = path.join(this.app.getPath("userData"), "secrets");
    fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(secretsDir, 0o700); } catch {}
    const keyPath = path.join(secretsDir, `runtime-key-${randomBytes(16).toString("hex")}.tmp`);
    fs.writeFileSync(keyPath, runtimeKey.trim(), { flag: "wx", mode: 0o600 });
    args.push("--tunnel-id", tunnelId, "--runtime-key-file", keyPath);
    return this.runDevSetup("dev-mcp-setup", args, {
      message: "Configuring the isolated DEV Full harness",
      successMessage: "DEV Full harness is configured",
      timeoutMs: MCP_SETUP_TIMEOUT_MS,
      afterRuntimeReady,
    }).finally(() => fs.rmSync(keyPath, { force: true }));
  }

  async setBrowserInteractionMode(mode, afterRuntimeReady) {
    if (mode !== "automatic" && mode !== "manual") {
      throw new Error("Browser interaction mode must be automatic or manual");
    }
    const current = this.runtimeConfigSnapshot();
    if (!current.configured) {
      throw new Error("Install the Codex integration before changing browser interaction mode");
    }
    if (mode === "manual" && current.mode !== "full") {
      throw new Error("Connect the Full MCP harness before enabling Zero Risk");
    }
    const args = [
      ...(this.launcherProfile === "development" ? ["dev", "setup"] : ["setup"]),
      current.mode === "full" ? "--full" : "--browser-only",
      "--browser-host-descriptor",
      this.browserDescriptorPath,
      ...this.browserInteractionArgs({ mode, refreshCapabilities: true }),
      "--acknowledge-unofficial",
      ...(this.launcherProfile === "production" ? ["--restart-service"] : []),
      mode === "automatic" && current.config?.experimentalBiggerContext === true
        ? "--bigger-context"
        : "--standard-context",
    ];
    if (current.config?.autoApproveToolCalls === true) args.push("--auto-approve-tool-calls");
    const options = {
      message: mode === "manual"
        ? "Enabling Zero Risk"
        : "Enabling automatic browser interaction",
      successMessage: mode === "manual"
        ? `Zero Risk enabled${this.launcherProfile === "production" ? "; restart Codex" : ""}`
        : `Automatic browser interaction enabled${this.launcherProfile === "production" ? "; restart Codex" : ""}`,
      timeoutMs: current.mode === "full" ? MCP_SETUP_TIMEOUT_MS : CORE_SETUP_TIMEOUT_MS,
      afterRuntimeReady,
    };
    const result = this.launcherProfile === "development"
      ? await this.runDevSetup("browser-interaction-mode", args, options)
      : await this.runSetup("browser-interaction-mode", this.productionSetupArgs(args), options);
    return { configured: true, mode, stdout: result.stdout };
  }

  async runDevSetup(name, args, options) {
    if (this.launcherProfile !== "development") {
      throw new Error("DEV setup transaction requires the isolated DEV launcher");
    }
    return this.runSetup(name, args, {
      ...options,
      embedded: true,
      environment: this.devSetupEnvironment(),
    });
  }

  async runSetup(name, args, options) {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    const previousRuntime = this.runtimeConfigSnapshot();
    const checkpoint = this.captureSetupCheckpoint(previousRuntime);
    this.lifecycleOperation = name;
    let setupCommandStarted = false;
    let runtimeTransitionStarted = false;
    try {
      if (this.launcherProfile === "production") {
        await this.run(name, [...args, "--preflight-only"], {
          ...options,
          message: "Validating Codex configuration before changing the runtime",
          successMessage: "Codex configuration is ready for setup",
          timeoutMs: Math.min(options.timeoutMs || 15_000, 15_000),
        });
      }
      runtimeTransitionStarted = true;
      if (previousRuntime.owner === "external") this.supervisor.prepareExternalMigration();
      else await this.supervisor.stopForSetup();
      setupCommandStarted = true;
      const result = await this.run(name, args, options);
      const runtime = await this.supervisor.startIfConfigured();
      if (runtime.status !== "ready") {
        throw new Error(`Setup completed, but the launcher-owned runtime is ${runtime.status}: ${runtime.detail || "not ready"}`);
      }
      await options.afterRuntimeReady?.();
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
      if (previousRuntime.configured && checkpoint && runtimeTransitionStarted) {
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
      if (runtimeTransitionStarted) {
        try {
          await this.restorePreviousRuntime(previousRuntime, name, {
            repairExternal: previousRuntime.owner === "external" && checkpointChanged,
          });
        } catch (caught) {
          recoveryError = caught;
        }
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

module.exports = { CURRENT_CONNECTOR_NAME, RuntimeHost };
