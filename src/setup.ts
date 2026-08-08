import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import type { AppConfig, RuntimeMode } from "./config";
import {
  currentRuntimeCommand,
  defaultBrokerEndpoint,
  defaultConfig,
  getConfigPath,
  loadConfigForSetup,
  resolveSetupConnectorName,
  saveConfig,
} from "./config";
import {
  browserLoginStateExists,
  inspectBrowserLoginCapabilities,
  loginToChatGpt,
  storedBrowserLoginCapabilities,
} from "./browser-login";
import { installCodexIntegration, preflightCodexIntegration } from "./codex-integration";
import { inspectLauncherBrowserHost } from "./launcher-browser-host";
import {
  assertServiceIdle,
  getServiceStatus,
  installService,
  removeLegacyRuntimeArtifacts,
  restartService,
  uninstallService,
} from "./service";
import { connectTunnel, createTunnelConfig, installRuntimeKey, installRuntimeKeyBytes, installTunnelClient, managedRuntimeKeyPath, stopTunnel, waitForTunnelReady } from "./tunnel";
import { getTunnelServiceStatus, installTunnelService, restartTunnelService, stopTunnelService, tunnelServiceDefinitionMatches, uninstallTunnelService } from "./tunnel-service";
import { VERSION } from "./version";

export interface SetupOptions {
  mode: RuntimeMode;
  port?: number;
  chromeExecutablePath?: string;
  browserHostDescriptorPath?: string;
  refreshAccountCapabilities?: boolean;
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

export function launcherCapabilityProbeRequired(
  existing: AppConfig | undefined,
  refreshAccountCapabilities = false,
): boolean {
  return refreshAccountCapabilities
    || existing?.browserHost !== "launcher"
    || typeof existing.solAvailable !== "boolean"
    || typeof existing.proAvailable !== "boolean";
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
    browserHost: before.browserHost,
    browserHostDescriptorPath: before.browserHostDescriptorPath,
    chromeExecutablePath: before.chromeExecutablePath,
    storageStatePath: before.storageStatePath,
    brokerSocketPath: before.brokerSocketPath,
    headed: before.headed,
    solAvailable: before.solAvailable,
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
    browserHost: after.browserHost,
    browserHostDescriptorPath: after.browserHostDescriptorPath,
    chromeExecutablePath: after.chromeExecutablePath,
    storageStatePath: after.storageStatePath,
    brokerSocketPath: after.brokerSocketPath,
    headed: after.headed,
    solAvailable: after.solAvailable,
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

export function setupProxyIsReady(
  health: Record<string, unknown>,
  config: Pick<AppConfig, "mode" | "releaseVersion">,
): boolean {
  return health.service === "codex-chatgpt-web"
    && health.status === "ok"
    && health.mode === config.mode
    && health.version === config.releaseVersion
    && health.accepting_turns === true;
}

async function waitForProxy(config: AppConfig, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const requestTimeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`http://${config.host}:${config.port}/healthz`, {
        signal: controller.signal,
      });
      if (response.ok) {
        const body = await response.json() as Record<string, unknown>;
        if (setupProxyIsReady(body, config)) return;
        lastError = `unexpected health payload: ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(requestTimeout);
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
  if (options.browserHostDescriptorPath) {
    config.browserHost = "launcher";
    config.browserHostDescriptorPath = options.browserHostDescriptorPath;
    config.brokerSocketPath = defaultBrokerEndpoint();
  } else if (options.chromeExecutablePath) {
    config.browserHost = "managed-chrome";
    delete config.browserHostDescriptorPath;
  }
  config.appName = resolveSetupConnectorName(existing?.appName, options.appName);
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

async function bootstrapTunnelProfile(config: AppConfig): Promise<void> {
  let bootstrapError: unknown;
  try {
    // `runtimes connect` writes the native profile and returns once its managed runtime is healthy.
    // Readiness follows after a successful control-plane poll, so setup proves it separately before
    // stopping the validation runtime. The launcher supervisor reconnects the committed profile.
    connectTunnel(config);
    const status = await waitForTunnelReady(config);
    if (!status.ok) throw new Error(`Tunnel runtime did not become healthy and ready: ${status.detail}`);
  } catch (error) {
    bootstrapError = error;
  }
  try {
    stopTunnel(config);
  } catch (stopError) {
    if (bootstrapError) {
      const primary = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError);
      const cleanup = stopError instanceof Error ? stopError.message : String(stopError);
      throw new Error(`${primary}; temporary tunnel cleanup also failed: ${cleanup}`);
    }
    throw stopError;
  }
  if (bootstrapError) throw bootstrapError;
}

export async function setup(options: SetupOptions): Promise<SetupResult> {
  const existing = loadExistingConfig();
  const config = baseConfig(existing, options);
  const launcherOwned = config.browserHost === "launcher";
  if (!launcherOwned && process.platform !== "darwin") {
    throw new Error(
      "Terminal-only managed Chrome setup currently requires macOS. "
      + "Use the Codex Web GPT launcher on Windows or Linux.",
    );
  }
  preflightCodexIntegration(config, {
    replaceExistingRoute: options.replaceCodexRoute,
  });
  const refreshTunnelWorker = tunnelWorkerRuntimeChanged(existing, config);
  if (existing && options.restartService) config.controlToken = randomBytes(32).toString("base64url");
  const beforeService = getServiceStatus();
  if (launcherOwned && (beforeService.installed || beforeService.loaded)) {
    if (!existing) {
      throw new Error("A legacy background service exists without a verifiable configuration; refusing automatic migration");
    }
    if (!options.restartService) {
      throw new Error(
        "Launcher ownership migration must stop the legacy background service. "
        + "Retry from the launcher after the active Codex task finishes.",
      );
    }
  }
  if (beforeService.loaded && !existing) {
    throw new Error("A codex-chatgpt-web service is loaded but its configuration is missing; refusing to replace an unverifiable process");
  }

  let loginCreated = false;
  let solAvailable: boolean | undefined;
  let proAvailable: boolean | undefined;
  if (config.browserHost === "launcher") {
    if (options.forceLogin) throw new Error("Launcher browser login is owned by the launcher UI; --login cannot replace it");
    const detectCapabilities = launcherCapabilityProbeRequired(
      existing,
      options.refreshAccountCapabilities === true,
    );
    const inspected = await inspectLauncherBrowserHost(config.browserHostDescriptorPath!, {
      detectCapabilities,
    });
    solAvailable = detectCapabilities ? inspected.solAvailable : existing!.solAvailable;
    proAvailable = detectCapabilities ? inspected.proAvailable : existing!.proAvailable;
  } else {
    const stored = storedBrowserLoginCapabilities(config);
    solAvailable = stored.solAvailable;
    proAvailable = stored.proAvailable;
    const loginRequired = options.forceLogin || !browserLoginStateExists(config);
    const capabilityProbeRequired = !loginRequired
      && (options.refreshAccountCapabilities === true
        || solAvailable === undefined
        || proAvailable === undefined);
    if (beforeService.loaded && (loginRequired || capabilityProbeRequired) && !options.restartService) {
      throw new Error(
        "Setup must verify the browser account before changing the running daemon. "
        + "Rerun from a normal terminal with --restart-service after the active task finishes.",
      );
    }
    if (beforeService.loaded && (loginRequired || capabilityProbeRequired) && existing) await assertServiceIdle(existing);
    if (loginRequired) {
      const login = await loginToChatGpt(config);
      solAvailable = login.solAvailable;
      proAvailable = login.proAvailable;
      loginCreated = true;
    } else if (capabilityProbeRequired) {
      const inspected = await inspectBrowserLoginCapabilities(config);
      solAvailable = inspected.solAvailable;
      proAvailable = inspected.proAvailable;
    }
  }
  config.solAvailable = solAvailable === true;
  config.proAvailable = config.solAvailable && proAvailable === true;
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

  if (!launcherOwned) {
    saveConfig(config);
    installService(config);
    if (changedWhileLoaded && options.restartService && existing) await restartService(existing);
    await waitForProxy(config);
  }

  let tunnelReady: boolean | null = null;
  if (config.mode === "browser-only" && existing?.mode === "full") {
    const previousTunnelService = getTunnelServiceStatus();
    if (previousTunnelService.installed || previousTunnelService.loaded) await uninstallTunnelService();
    stopTunnel(existing);
  }
  if (config.mode === "full") {
    const profilePath = join(config.tunnel!.profileDir, `${config.tunnel!.profileName}.yaml`);
    const tunnelService = getTunnelServiceStatus();
    const needsProfile = !existsSync(profilePath);
    if (launcherOwned) {
      if (tunnelService.installed || tunnelService.loaded) await uninstallTunnelService();
      if (needsProfile || refreshTunnelWorker || explicitTunnelChange) {
        await bootstrapTunnelProfile(config);
      }
    } else {
      const needsOwnershipMigration = !tunnelService.installed || !tunnelService.loaded || !tunnelServiceDefinitionMatches(config);
      if (needsOwnershipMigration || needsProfile) {
        await assertServiceIdle(config);
        if (tunnelService.loaded) await stopTunnelService();
        await bootstrapTunnelProfile(config);
        installTunnelService(config);
      } else if (refreshTunnelWorker) {
        await assertServiceIdle(config);
        await restartTunnelService();
      }
      const status = await waitForTunnelReady(config);
      if (!status.ok) throw new Error(`Tunnel runtime did not become healthy and ready: ${status.detail}`);
      tunnelReady = true;
    }
  }
  if (launcherOwned && (beforeService.installed || beforeService.loaded)) {
    await uninstallService(existing!);
  }
  if (launcherOwned) saveConfig(config);
  // Keep the previous terminal runtime intact through the ownership handoff. A later launcher
  // setup removes it once the launcher-owned configuration is already the established baseline.
  const migratingTerminalRuntime = Boolean(
    launcherOwned && existing && existing.browserHost !== "launcher",
  );
  if (!migratingTerminalRuntime) removeLegacyRuntimeArtifacts(config);
  installCodexIntegration(config, {
    replaceExistingRoute: options.replaceCodexRoute,
  });

  return {
    mode: config.mode,
    configPath: getConfigPath(),
    loginCreated,
    serviceLoaded: launcherOwned ? false : getServiceStatus().loaded,
    tunnelReady,
    codexRestartRequired: true,
    connectorSetupRequired: config.mode === "full",
  };
}
