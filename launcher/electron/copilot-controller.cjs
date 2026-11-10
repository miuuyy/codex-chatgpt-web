const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { runtimeInvocation } = require("./runtime-command.cjs");

const COPILOT_DEFAULT_PORT = 17842;
const COPILOT_DEFAULT_MODEL = "copilot-web/auto";
const PROFILE_MARKER = "# Managed by Codex Web GPT launcher.";
const MAX_CAPTURE = 64 * 1024;
const HEALTH_TIMEOUT_MS = 1_200;
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 8_000;

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function positivePort(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 65_535
    ? value
    : COPILOT_DEFAULT_PORT;
}

function appendCapture(current, chunk) {
  const next = current + String(chunk);
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}

function lastLines(value, count = 3) {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const selected = lines.slice(-count).join(" ");
  return selected.length > 500 ? selected.slice(selected.length - 500) : selected;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class CopilotController {
  constructor({
    app,
    logger,
    sourceRoot,
    runtimeRootProvider,
    codexHome,
    home,
  }) {
    if (!app || !logger || !sourceRoot || typeof runtimeRootProvider !== "function") {
      throw new Error("CopilotController requires app, logger, sourceRoot, and runtimeRootProvider");
    }
    if (typeof codexHome !== "string" || !path.isAbsolute(codexHome)) {
      throw new Error("CopilotController requires an absolute Codex home");
    }
    this.app = app;
    this.logger = logger;
    this.sourceRoot = sourceRoot;
    this.runtimeRootProvider = runtimeRootProvider;
    this.codexHome = codexHome;
    this.configuredHome = typeof home === "string" && home.trim() ? path.resolve(home) : null;
    this.server = null;
    this.serverState = "stopped";
    this.serverMessage = null;
    this.serverStderr = "";
    this.stopRequested = false;
    this.loginChild = null;
    this.loginState = "idle";
    this.loginMessage = null;
    this.signedIn = null;
  }

  homePath() {
    if (this.configuredHome) return this.configuredHome;
    const configured = process.env.CODEX_COPILOT_WEB_HOME?.trim();
    return configured
      ? expandHome(configured)
      : path.join(os.homedir(), ".codex-copilot-web");
  }

  paths() {
    const home = this.homePath();
    return {
      home,
      config: path.join(home, "config.json"),
      catalog: path.join(home, "models.json"),
      profile: path.join(this.codexHome, "copilot.config.toml"),
      diagnostics: path.join(home, "diagnostics"),
    };
  }

  readConfig() {
    const { config } = this.paths();
    if (!fs.existsSync(config)) return { config: null, error: null };
    try {
      const value = JSON.parse(fs.readFileSync(config, "utf8").replace(/^\uFEFF/, ""));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { config: null, error: "Copilot configuration must be a JSON object" };
      }
      return { config: value, error: null };
    } catch (error) {
      return {
        config: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  portOf(config) {
    return positivePort(config?.port);
  }

  modelsOf(config) {
    if (!Array.isArray(config?.models)) return [];
    return config.models
      .filter(model => model && typeof model === "object" && typeof model.id === "string")
      .map(model => ({
        id: model.id,
        displayName: typeof model.displayName === "string" ? model.displayName : model.id,
      }));
  }

  profileManaged() {
    const { profile } = this.paths();
    if (!fs.existsSync(profile)) return false;
    try {
      return fs.readFileSync(profile, "utf8").includes(PROFILE_MARKER);
    } catch {
      return false;
    }
  }

  invocation(args) {
    return runtimeInvocation({
      app: this.app,
      sourceRoot: this.sourceRoot,
      installedRuntimeRoot: this.runtimeRootProvider(),
      args: ["copilot", ...args],
    });
  }

  async health(port = this.portOf(this.readConfig().config)) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const body = await response.json();
      return body && body.service === "codex-copilot-web" ? body : null;
    } catch {
      return null;
    }
  }

  async status() {
    const paths = this.paths();
    const { config, error } = this.readConfig();
    const port = this.portOf(config);
    const health = await this.health(port);
    const profileExists = fs.existsSync(paths.profile);
    const profileManaged = profileExists ? this.profileManaged() : false;
    let bridge = { status: "stopped", owned: false, pid: null, message: null };
    if (health) {
      const owned = Boolean(this.server?.child && this.server.child.exitCode === null);
      bridge = {
        status: "running",
        owned,
        pid: Number.isInteger(health.pid) ? health.pid : null,
        message: owned ? null : "The Copilot bridge was started outside the launcher.",
      };
    } else if (this.server?.child && this.server.child.exitCode === null) {
      bridge = {
        status: this.serverState === "stopping" ? "stopping" : "starting",
        owned: true,
        pid: Number.isInteger(this.server.child.pid) ? this.server.child.pid : null,
        message: this.serverMessage,
      };
    } else if (this.serverState === "failed") {
      bridge = {
        status: "failed",
        owned: false,
        pid: null,
        message: this.serverMessage,
      };
    }
    return {
      home: paths.home,
      configPath: paths.config,
      configExists: fs.existsSync(paths.config),
      configError: error,
      catalogPath: paths.catalog,
      profilePath: paths.profile,
      profileInstalled: profileExists,
      profileManaged,
      port,
      endpoint: `http://127.0.0.1:${port}/v1`,
      models: this.modelsOf(config),
      bridge,
      login: { status: this.loginState, message: this.loginMessage },
      signedIn: this.signedIn,
    };
  }

  run(args, { timeoutMs = 60_000 } = {}) {
    return new Promise((resolve, reject) => {
      const invocation = this.invocation(args);
      const child = spawn(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on("data", (chunk) => { stdout = appendCapture(stdout, chunk); });
      child.stderr?.on("data", (chunk) => { stderr = appendCapture(stderr, chunk); });
      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) => {
        if (timedOut) {
          finish(new Error(`Copilot ${args[0]} timed out after ${Math.round(timeoutMs / 1_000)} seconds`));
          return;
        }
        if (code !== 0) {
          const detail = lastLines(stderr || stdout);
          finish(new Error(
            `Copilot ${args[0]} failed (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})`
              + (detail ? `: ${detail}` : ""),
          ));
          return;
        }
        finish(null, { stdout, stderr });
      });
    });
  }

  attachServer(child) {
    const entry = { child };
    this.server = entry;
    this.serverStderr = "";
    child.stdout?.on("data", (chunk) => {
      this.serverMessage = lastLines(String(chunk)) || this.serverMessage;
    });
    child.stderr?.on("data", (chunk) => {
      this.serverStderr = appendCapture(this.serverStderr, chunk);
    });
    child.once("error", (error) => {
      this.serverState = "failed";
      this.serverMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("copilot.bridge_spawn_failed", { message: this.serverMessage });
    });
    child.once("exit", (code, signal) => {
      if (this.server === entry) this.server = null;
      if (this.stopRequested) {
        this.serverState = "stopped";
        this.serverMessage = null;
      } else {
        this.serverState = "failed";
        const detail = lastLines(this.serverStderr);
        this.serverMessage = [
          `Copilot bridge exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})`,
          detail,
        ].filter(Boolean).join(": ");
        this.logger.warn("copilot.bridge_exited", { code, signal });
      }
    });
  }

  async waitForHealth(port, timeoutMs = START_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.health(port)) return true;
      if (this.serverState === "failed" || this.serverState === "stopped") return false;
      await delay(250);
    }
    return false;
  }

  waitForExit(child, timeoutMs) {
    if (child.exitCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      const onExit = () => {
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener("exit", onExit);
      };
      child.once("exit", onExit);
    });
  }

  async init() {
    await this.run(["init"], { timeoutMs: 60_000 });
    this.logger.info("copilot.config_initialized", {});
    return this.status();
  }

  async login() {
    if (this.loginState === "running") return this.status();
    const { config } = this.readConfig();
    if (await this.health(this.portOf(config))) {
      throw new Error("Stop the local bridge before signing in or checking sign-in.");
    }
    const invocation = this.invocation(["login"]);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.loginChild = child;
    this.loginState = "running";
    this.loginMessage = null;
    let stderr = "";
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", (chunk) => { stderr = appendCapture(stderr, chunk); });
    child.once("error", (error) => {
      if (this.loginChild === child) this.loginChild = null;
      this.loginState = "failed";
      this.loginMessage = error instanceof Error ? error.message : String(error);
      this.logger.error("copilot.login_spawn_failed", { message: this.loginMessage });
    });
    child.once("exit", (code, signal) => {
      if (this.loginChild === child) this.loginChild = null;
      if (code === 0) {
        this.loginState = "succeeded";
        this.loginMessage = null;
        this.signedIn = true;
        this.logger.info("copilot.login_succeeded", {});
        return;
      }
      this.loginState = "failed";
      this.loginMessage = lastLines(stderr)
        || `Copilot sign-in exited (${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`})`;
      this.logger.warn("copilot.login_failed", { code, signal });
    });
    this.logger.info("copilot.login_started", {});
    return this.status();
  }

  async checkSignIn() {
    if (this.loginState === "running") {
      throw new Error("Microsoft sign-in is already in progress.");
    }
    const { config } = this.readConfig();
    if (await this.health(this.portOf(config))) {
      throw new Error("Stop the local bridge before signing in or checking sign-in.");
    }
    const result = await this.run(["doctor"], { timeoutMs: 120_000 });
    const match = /^signed_in:\s*(true|false)\s*$/m.exec(result.stdout);
    if (!match) throw new Error("Copilot doctor did not report the sign-in state.");
    this.signedIn = match[1] === "true";
    return this.status();
  }

  async start() {
    if (this.loginState === "running") {
      throw new Error("Finish Microsoft sign-in before starting the bridge.");
    }
    const { config } = this.readConfig();
    const port = this.portOf(config);
    if (await this.health(port)) return this.status();
    if (this.server?.child && this.server.child.exitCode === null) {
      await this.waitForHealth(port);
      return this.status();
    }
    this.serverState = "starting";
    this.serverMessage = null;
    this.serverStderr = "";
    this.stopRequested = false;
    const invocation = this.invocation(["serve"]);
    const child = spawn(invocation.executable, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.attachServer(child);
    this.logger.info("copilot.bridge_started", { port });
    const ready = await this.waitForHealth(port);
    if (!ready) {
      const detail = lastLines(this.serverStderr) || this.serverMessage;
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await this.waitForExit(child, 2_000);
      }
      this.serverState = "failed";
      this.serverMessage = detail || null;
      throw new Error(
        `Copilot bridge did not become ready on 127.0.0.1:${port}`
          + (detail ? `: ${detail}` : ""),
      );
    }
    return this.status();
  }

  async stop() {
    const child = this.server?.child;
    const { config } = this.readConfig();
    const port = this.portOf(config);
    if (!child || child.exitCode !== null) {
      if (await this.health(port)) {
        throw new Error("The Copilot bridge was started outside the launcher; stop it there.");
      }
      this.serverState = "stopped";
      this.serverMessage = null;
      return this.status();
    }
    this.stopRequested = true;
    this.serverState = "stopping";
    child.kill("SIGTERM");
    const exited = await this.waitForExit(child, STOP_TIMEOUT_MS);
    if (!exited) {
      child.kill("SIGKILL");
      await this.waitForExit(child, 3_000);
    }
    this.serverState = "stopped";
    this.serverMessage = null;
    this.logger.info("copilot.bridge_stopped", {});
    return this.status();
  }

  ensureProfileWritable(profile) {
    if (!fs.existsSync(profile)) return;
    const existing = fs.readFileSync(profile, "utf8");
    if (!existing.includes(PROFILE_MARKER)) {
      throw new Error("A different copilot.config.toml exists. Rename or remove it before installing.");
    }
  }

  profileText(port) {
    const { catalog } = this.paths();
    return [
      PROFILE_MARKER,
      "# Remove it from the Copilot panel in Codex Web GPT.",
      "# The local Copilot bridge does not require an API key.",
      `model = ${JSON.stringify(COPILOT_DEFAULT_MODEL)}`,
      'model_provider = "copilot-web"',
      `model_catalog_json = ${JSON.stringify(catalog)}`,
      "",
      "[model_providers.copilot-web]",
      'name = "Microsoft 365 Copilot Web"',
      `base_url = ${JSON.stringify(`http://127.0.0.1:${port}/v1`)}`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "",
      "[features]",
      "# Copilot's composer has a ~128k-character limit. App and plugin tool schemas alone can",
      "# exceed it, so the Copilot profile keeps the core Codex tool surface.",
      "apps = false",
      "plugins = false",
      "",
    ].join("\n");
  }

  async installProfile() {
    const paths = this.paths();
    await this.run(["config", "--catalog", paths.catalog], { timeoutMs: 60_000 });
    const { config, error } = this.readConfig();
    if (!config) throw new Error(error || "Copilot configuration is unavailable.");
    const port = this.portOf(config);
    this.ensureProfileWritable(paths.profile);
    writePrivateFileAtomic(paths.profile, this.profileText(port), { mode: 0o600 });
    this.logger.info("copilot.profile_installed", {});
    return this.status();
  }

  async removeProfile() {
    const { profile } = this.paths();
    if (!fs.existsSync(profile)) return this.status();
    const existing = fs.readFileSync(profile, "utf8");
    if (!existing.includes(PROFILE_MARKER)) {
      throw new Error("Refusing to remove copilot.config.toml because it was not created by the launcher.");
    }
    fs.unlinkSync(profile);
    this.logger.info("copilot.profile_removed", {});
    return this.status();
  }

  async shutdown() {
    const login = this.loginChild;
    if (login && login.exitCode === null) {
      login.kill("SIGTERM");
      this.loginChild = null;
    }
    const child = this.server?.child;
    if (!child || child.exitCode !== null) return;
    this.stopRequested = true;
    child.kill("SIGTERM");
    const exited = await this.waitForExit(child, 5_000);
    if (!exited) {
      child.kill("SIGKILL");
      await this.waitForExit(child, 2_000);
    }
  }
}

module.exports = {
  COPILOT_DEFAULT_PORT,
  COPILOT_DEFAULT_MODEL,
  CopilotController,
  PROFILE_MARKER,
};
