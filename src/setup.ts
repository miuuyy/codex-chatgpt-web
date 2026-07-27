import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { AppConfig, RuntimeMode } from "./config";
import { currentRuntimeCommand, defaultConfig, getConfigPath, loadConfigForSetup, saveConfig } from "./config";
import {
  browserLoginStateExists,
  inspectBrowserLoginCapabilities,
  loginToChatGpt,
  storedBrowserLoginCapabilities,
} from "./browser-login";
import { installCodexIntegration } from "./codex-integration";
import { assertServiceIdle, getServiceStatus, installService, removeLegacyRuntimeArtifacts, restartService } from "./service";
import { connectTunnel, createTunnelConfig, installRuntimeKey, installRuntimeKeyBytes, installTunnelClient, managedRuntimeKeyPath, stopTunnel, waitForTunnelReady } from "./tunnel";
import { getTunnelServiceStatus, installTunnelService, restartTunnelService, stopTunnelService, tunnelServiceDefinitionMatches, uninstallTunnelService } from "./tunnel-service";
import { VERSION } from "./version";

export interface SetupOptions {
  mode: RuntimeMode;
  port?: number;
  chromeExecutablePath?: string;
  appName?: string;
  forceLogin?: boolean;
  autoApproveToolCalls?: boolean;
  replaceCodexRoute?: boolean;
  restartService?: boolean;
  acknowledgedUnofficial?: boolean;
  tunnelId?: string;
  runtimeKeyFile?: string;
  runtimeKeyValue?: string;
}

export interface SetupResult {
  mode: RuntimeMode;
  configPath: string;
  loginCreated: boolean;
  serviceLoaded: boolean;
  tunnelReady: boolean | null;
  codexRestartRequired: true;
  connectorSetupRequired: boolean;
}

export interface ExistingFullSetupCredentials {
  tunnelId: boolean;
  runtimeKey: boolean;
}

export function existingFullSetupCredentials(existing: AppConfig | undefined): ExistingFullSetupCredentials {
  const tunnel = existing?.mode === "full" ? existing.tunnel : undefined;
  return {
    tunnelId: Boolean(tunnel?.tunnelId),
    runtimeKey: Boolean(tunnel?.runtimeKeyFile && existsSync(tunnel.runtimeKeyFile)),
  };
}

function loadExistingConfig(): AppConfig | undefined {
  if (!existsSync(getConfigPath())) return undefined;
  return loadConfigForSetup();
}

function meaningfulRuntimeChange(before: AppConfig, after: AppConfig): boolean {
  return JSON.stringify({
    mode: before.mode,
    releaseVersion: before.releaseVersion,
    host: before.host,
    port: before.port,
    contextWindow: before.contextWindow,
    appName: before.appName,
    chromeExecutablePath: before.chromeExecutablePath,
    chromeProfilePath: before.chromeProfilePath,
    chromeDebugPort: before.chromeDebugPort,
    storageStatePath: before.storageStatePath,
    brokerSocketPath: before.brokerSocketPath,
    headed: before.headed,
    proAvailable: before.proAvailable,
    autoApproveToolCalls: before.autoApproveToolCalls,
    controlToken: before.controlToken,
    runtimeCommand: before.runtimeCommand,
    tunnel: before.tunnel,
  }) !== JSON.stringify({
    mode: after.mode,
    releaseVersion: after.releaseVersion,
    host: after.host,
    port: after.port,
    contextWindow: after.contextWindow,
    appName: after.appName,
    chromeExecutablePath: after.chromeExecutablePath,
    chromeProfilePath: after.chromeProfilePath,
    chromeDebugPort: after.chromeDebugPort,
    storageStatePath: after.storageStatePath,
    brokerSocketPath: after.brokerSocketPath,
    headed: after.headed,
    proAvailable: after.proAvailable,
    autoApproveToolCalls: after.autoApproveToolCalls,
    controlToken: after.controlToken,
    runtimeCommand: after.runtimeCommand,
    tunnel: after.tunnel,
  });
}

export function tunnelWorkerRuntimeChanged(before: AppConfig | undefined, after: AppConfig): boolean {
  if (!before || before.mode !== "full" || after.mode !== "full") return false;
  return before.releaseVersion !== after.releaseVersion
    || JSON.stringify(before.runtimeCommand) !== JSON.stringify(after.runtimeCommand)
    || before.brokerSocketPath !== after.brokerSocketPath;
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  await new Promise<void>((resolveAvailable, rejectAvailable) => {
    const server = createServer();
    server.unref();
    server.once("error", error => rejectAvailable(new Error(`Cannot bind ${host}:${port}: ${error.message}`)));
    server.listen(port, host, () => server.close(error => error ? rejectAvailable(error) : resolveAvailable()));
  });
}

async function waitForProxy(config: AppConfig, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${config.host}:${config.port}/healthz`);
      if (response.ok) {
        const body = await response.json() as Record<string, unknown>;
        if (body.service === "codex-chatgpt-web" && body.mode === config.mode && body.version === config.releaseVersion) return;
        lastError = `unexpected health payload: ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  throw new Error(`Responses proxy did not become ready: ${lastError}`);
}

function baseConfig(existing: AppConfig | undefined, options: SetupOptions): AppConfig {
  const config = existing ? structuredClone(existing) : defaultConfig(options.mode);
  config.mode = options.mode;
  config.releaseVersion = VERSION;
  config.runtimeCommand = currentRuntimeCommand();
  if (options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) throw new Error("--port must be an integer from 1 to 65535");
    config.port = options.port;
  }
  if (options.chromeExecutablePath) config.chromeExecutablePath = options.chromeExecutablePath;
  if (options.appName) config.appName = options.appName;
  if (options.autoApproveToolCalls !== undefined) config.autoApproveToolCalls = options.autoApproveToolCalls;
  if (options.acknowledgedUnofficial) config.acknowledgedUnofficialAt = new Date().toISOString();
  if (!config.acknowledgedUnofficialAt) {
    throw new Error("Setup requires explicit acknowledgement that this is unofficial browser automation. Pass --acknowledge-unofficial.");
  }
  return config;
}

async function configureTunnel(config: AppConfig, existing: AppConfig | undefined, options: SetupOptions): Promise<void> {
  if (config.mode === "browser-only") {
    delete config.tunnel;
    return;
  }
  const existingTunnel = existing?.mode === "full" ? existing.tunnel : undefined;
  const tunnelId = options.tunnelId ?? existingTunnel?.tunnelId;
  if (!tunnelId) {
    throw new Error("Full mode requires --tunnel-id. Create it at https://platform.openai.com/settings/organization/tunnels");
  }
  let runtimeKeyFile = existingTunnel?.runtimeKeyFile;
  if (!runtimeKeyFile && existsSync(managedRuntimeKeyPath())) runtimeKeyFile = managedRuntimeKeyPath();
  if (options.runtimeKeyFile) runtimeKeyFile = installRuntimeKey(options.runtimeKeyFile);
  if (options.runtimeKeyValue) runtimeKeyFile = installRuntimeKeyBytes(options.runtimeKeyValue);
  if (!runtimeKeyFile || !existsSync(runtimeKeyFile)) {
    throw new Error("Full mode requires a runtime key. Import it interactively or pass --runtime-key-file; create it at https://platform.openai.com/settings/organization/api-keys");
  }
  const installedBinary = await installTunnelClient();
  config.tunnel = createTunnelConfig({
    binaryPath: installedBinary,
    tunnelId,
    runtimeKeyFile,
    profileName: existingTunnel?.profileName,
    alias: existingTunnel?.alias,
  });
}

export async function setup(options: SetupOptions): Promise<SetupResult> {
  if (process.platform !== "darwin") {
    throw new Error("The 0.1 release installer currently supports macOS only; no untested service fallback is installed.");
  }
  const existing = loadExistingConfig();
  const config = baseConfig(existing, options);
  const refreshTunnelWorker = tunnelWorkerRuntimeChanged(existing, config);
  if (existing && options.restartService) config.controlToken = randomBytes(32).toString("base64url");
  const beforeService = getServiceStatus();
  if (beforeService.loaded && !existing) {
    throw new Error("A codex-chatgpt-web service is loaded but its configuration is missing; refusing to replace an unverifiable process");
  }

  let loginCreated = false;
  let proAvailable = storedBrowserLoginCapabilities(config).proAvailable;
  const loginRequired = options.forceLogin || !browserLoginStateExists(config);
  const capabilityProbeRequired = !loginRequired && proAvailable === undefined;
  if (beforeService.loaded && (loginRequired || capabilityProbeRequired) && !options.restartService) {
    throw new Error(
      "Setup must verify the browser account before changing the running daemon. "
      + "Rerun from a normal terminal with --restart-service after the active task finishes.",
    );
  }
  if (beforeService.loaded && (loginRequired || capabilityProbeRequired) && existing) await assertServiceIdle(existing);
  if (loginRequired) {
    const login = await loginToChatGpt(config);
    proAvailable = login.proAvailable;
    loginCreated = true;
  } else if (capabilityProbeRequired) {
    proAvailable = (await inspectBrowserLoginCapabilities(config)).proAvailable;
  }
  config.proAvailable = proAvailable === true;
  const explicitTunnelChange = Boolean(options.tunnelId || options.runtimeKeyFile || options.runtimeKeyValue);
  const preliminaryChange = Boolean(existing && (meaningfulRuntimeChange(existing, config) || explicitTunnelChange || options.forceLogin));
  if (beforeService.loaded && preliminaryChange && !options.restartService) {
    throw new Error(
      "The daemon is currently serving a Codex task and setup would change its runtime. "
      + "Rerun from a normal terminal with --restart-service after the active task finishes.",
    );
  }
  if (beforeService.loaded && preliminaryChange && existing) await assertServiceIdle(existing);
  await configureTunnel(config, existing, options);

  const changedWhileLoaded = Boolean(existing && beforeService.loaded && meaningfulRuntimeChange(existing, config));
  if (changedWhileLoaded && !options.restartService) {
    throw new Error(
      "The daemon is currently serving a Codex task and setup would change its runtime. "
      + "Rerun from a normal terminal with --restart-service after the active task finishes.",
    );
  }
  if (changedWhileLoaded && !preliminaryChange && existing) await assertServiceIdle(existing);
  if (!beforeService.loaded) await assertPortAvailable(config.host, config.port);
  saveConfig(config);

  installService(config);
  if (changedWhileLoaded && options.restartService && existing) await restartService(existing);
  await waitForProxy(config);
  removeLegacyRuntimeArtifacts(config);

  let tunnelReady: boolean | null = null;
  if (config.mode === "browser-only" && existing?.mode === "full") {
    const previousTunnelService = getTunnelServiceStatus();
    if (previousTunnelService.installed || previousTunnelService.loaded) await uninstallTunnelService();
    stopTunnel(existing);
  }
  if (config.mode === "full") {
    const profilePath = `${config.tunnel!.profileDir}/${config.tunnel!.profileName}.yaml`;
    const tunnelService = getTunnelServiceStatus();
    const needsOwnershipMigration = !tunnelService.installed || !tunnelService.loaded || !tunnelServiceDefinitionMatches(config);
    const needsProfile = !existsSync(profilePath);
    if (needsOwnershipMigration || needsProfile) {
      await assertServiceIdle(config);
      if (tunnelService.loaded) await stopTunnelService();
      connectTunnel(config);
      const bootstrapStatus = await waitForTunnelReady(config);
      if (!bootstrapStatus.ok) throw new Error(`Temporary tunnel bootstrap did not become healthy and ready: ${bootstrapStatus.detail}`);
      stopTunnel(config);
      installTunnelService(config);
    } else if (refreshTunnelWorker) {
      await assertServiceIdle(config);
      await restartTunnelService();
    }
    const status = await waitForTunnelReady(config);
    if (!status.ok) throw new Error(`Tunnel runtime did not become healthy and ready: ${status.detail}`);
    tunnelReady = true;
  }
  installCodexIntegration(config, {
    replaceExistingRoute: options.replaceCodexRoute,
  });

  return {
    mode: config.mode,
    configPath: getConfigPath(),
    loginCreated,
    serviceLoaded: getServiceStatus().loaded,
    tunnelReady,
    codexRestartRequired: true,
    connectorSetupRequired: config.mode === "full",
  };
}
