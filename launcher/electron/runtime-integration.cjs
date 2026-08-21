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
  mcpConnectorName() {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured || current.mode !== "full") {
      throw new Error("The native MCP runtime is not configured");
    }
    return requireCurrentRuntimeConnectorName(current.config?.appName);
  },

  browserConnectorName() {
    const current = this.runtimeConfigSnapshot();
    if (!current.configured || current.mode !== "full") return CURRENT_CONNECTOR_NAME;
    return connectorNameForSetup(current.config?.appName);
  },

  cancelBrowserTurns() {
    return this.run("cancel-browser-turns", ["service", "cancel-turns"], {
      message: "Cancelling retained browser turns",
      successMessage: "Retained browser turns cancelled",
      timeoutMs: 15_000,
    });
  },

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
        const result = await this.run(name, ["uninstall", "--yes", "--launcher-control"], {
          embedded: true,
          env: this.launcherControlEnvironment(),
          message: "Restoring the previous Codex route",
          successMessage: "Codex Web GPT integration removed",
          timeoutMs: UNINSTALL_TIMEOUT_MS,
        });
        const verified = await this.bridgeStatus(name);
        if (verified.installed || verified.active) {
          throw new Error("Codex integration removal did not persist in the active config");
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
  },

};
