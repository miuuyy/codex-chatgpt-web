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

module.exports = {
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
    if (mode === "full") args.push("--app-name", this.browserConnectorName());
    const result = await this.runSetup("core-setup", args, {
      message: "Installing ChatGPT Web models into Codex",
      successMessage: "Codex integration installed",
      timeoutMs: CORE_SETUP_TIMEOUT_MS,
    });
    return { ...result, mode };
  },

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
  },

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
  },

};
