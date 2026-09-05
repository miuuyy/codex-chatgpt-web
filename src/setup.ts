import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import type { AppConfig, BrowserInteractionMode, RuntimeMode, SubagentProtocol } from "./config";
import {
  currentRuntimeCommand,
  defaultBrokerEndpoint,
  defaultConfig,
  getConfigPath,
  loadConfigForSetup,
  resolveInteractionConnectorIdentities,
  resolveDevSetupConnectorName,
  saveConfig,
  tunnelConfigForInteractionMode,
} from "./config";
import {
  browserLoginStateExists,
  inspectBrowserLoginCapabilities,
  loginToChatGpt,
  storedBrowserLoginCapabilities,
} from "./browser-login";
import {
  installCodexIntegration,
  preflightCodexIntegration,
  readCodexSubagentProtocol,
} from "./codex-integration";
import { inspectLauncherBrowserHost } from "./launcher-browser-host";
import {
  DEV_CONFIG_PURPOSE,
  DEV_LAUNCHER_PROFILE,
  DEV_TUNNEL_BASE_NAME,
} from "./dev-chat/constants";
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
  browserInteractionMode?: BrowserInteractionMode;
  subagentProtocol?: SubagentProtocol;
  port?: number;
  chromeExecutablePath?: string;
  browserHostDescriptorPath?: string;
  refreshAccountCapabilities?: boolean;
  appName?: string;
  forceLogin?: boolean;
  autoApproveToolCalls?: boolean;
  experimentalBiggerContext?: boolean;
  zeroRiskProEnabled?: boolean;
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

interface PreparedSetup {
  existing: AppConfig | undefined;
  config: AppConfig;
  launcherOwned: boolean;
}

export interface DevProfileSetupResult {
  mode: RuntimeMode;
  configPath: string;
  tunnelReady: boolean | null;
  connectorSetupRequired: boolean;
}

export interface ExistingFullSetupCredentials {
  tunnelId: boolean;
  runtimeKey: boolean;
}

export function launcherCapabilityProbeRequired(
  existing: AppConfig | undefined,
  refreshAccountCapabilities = false,
  interactionMode: BrowserInteractionMode = existing?.browserInteractionMode ?? "automatic",
): boolean {
  if (interactionMode === "manual") return false;
  return refreshAccountCapabilities
    || existing?.browserInteractionMode === "manual"
    || existing?.browserHost !== "launcher"
    || typeof existing.solAvailable !== "boolean"
    || typeof existing.proAvailable !== "boolean";
}

export function existingFullSetupCredentials(
  existing: AppConfig | undefined,
  interactionMode: BrowserInteractionMode = existing?.browserInteractionMode ?? "automatic",
): ExistingFullSetupCredentials {
  const tunnel = existing?.mode === "full"
    ? tunnelConfigForInteractionMode(existing, interactionMode)
    : undefined;
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
    subagentProtocol: before.subagentProtocol,
    releaseVersion: before.releaseVersion,
    host: before.host,
    port: before.port,
    contextWindow: before.contextWindow,
    appName: before.appName,
    automaticAppName: before.automaticAppName,
    manualAppName: before.manualAppName,
    browserHost: before.browserHost,
    browserInteractionMode: before.browserInteractionMode,
    browserHostDescriptorPath: before.browserHostDescriptorPath,
    chromeExecutablePath: before.chromeExecutablePath,
    storageStatePath: before.storageStatePath,
    brokerSocketPath: before.brokerSocketPath,
    headed: before.headed,
    solAvailable: before.solAvailable,
    extraHighAvailable: before.extraHighAvailable ?? before.proAvailable,
    proAvailable: before.proAvailable,
    experimentalBiggerContext: before.experimentalBiggerContext,
    zeroRiskProEnabled: before.zeroRiskProEnabled,
    autoApproveToolCalls: before.autoApproveToolCalls,
    controlToken: before.controlToken,
    runtimeCommand: before.runtimeCommand,
    tunnel: before.tunnel,
    automaticTunnel: before.automaticTunnel,
    manualTunnel: before.manualTunnel,
  }) !== JSON.stringify({
    mode: after.mode,
    subagentProtocol: after.subagentProtocol,
    releaseVersion: after.releaseVersion,
    host: after.host,
    port: after.port,
    contextWindow: after.contextWindow,
    appName: after.appName,
    automaticAppName: after.automaticAppName,
    manualAppName: after.manualAppName,
    browserHost: after.browserHost,
    browserInteractionMode: after.browserInteractionMode,
    browserHostDescriptorPath: after.browserHostDescriptorPath,
    chromeExecutablePath: after.chromeExecutablePath,
    storageStatePath: after.storageStatePath,
    brokerSocketPath: after.brokerSocketPath,
    headed: after.headed,
    solAvailable: after.solAvailable,
    extraHighAvailable: after.extraHighAvailable ?? after.proAvailable,
    proAvailable: after.proAvailable,
    experimentalBiggerContext: after.experimentalBiggerContext,
    zeroRiskProEnabled: after.zeroRiskProEnabled,
    autoApproveToolCalls: after.autoApproveToolCalls,
    controlToken: after.controlToken,
    runtimeCommand: after.runtimeCommand,
    tunnel: after.tunnel,
    automaticTunnel: after.automaticTunnel,
    manualTunnel: after.manualTunnel,
  });
}

export function tunnelWorkerRuntimeChanged(before: AppConfig | undefined, after: AppConfig): boolean {
  if (!before || before.mode !== "full" || after.mode !== "full") return false;
  return before.releaseVersion !== after.releaseVersion
    || JSON.stringify(before.runtimeCommand) !== JSON.stringify(after.runtimeCommand)
    || before.brokerSocketPath !== after.brokerSocketPath
    || before.browserInteractionMode !== after.browserInteractionMode
    || JSON.stringify(before.tunnel) !== JSON.stringify(after.tunnel);
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
  if (options.browserInteractionMode) config.browserInteractionMode = options.browserInteractionMode;
  Object.assign(config, resolveInteractionConnectorIdentities(
    existing,
    config.browserInteractionMode,
    options.appName,
  ));
  if (options.subagentProtocol) config.subagentProtocol = options.subagentProtocol;
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
  if (options.autoApproveToolCalls !== undefined) config.autoApproveToolCalls = options.autoApproveToolCalls;
  if (options.experimentalBiggerContext !== undefined) {
    config.experimentalBiggerContext = options.experimentalBiggerContext;
  }
  if (options.zeroRiskProEnabled !== undefined) {
    if (config.browserInteractionMode !== "manual") {
      throw new Error("Zero Risk Pro can be configured only with --zero-risk-browser-interaction");
    }
    config.zeroRiskProEnabled = options.zeroRiskProEnabled;
  }
  if (config.browserInteractionMode === "manual") {
    if (options.refreshAccountCapabilities) {
      throw new Error("Zero Risk cannot refresh account capabilities");
    }
    if (options.forceLogin) {
      throw new Error("Zero Risk uses the launcher's existing ChatGPT session; --login is unavailable");
    }
    if (options.experimentalBiggerContext === true) {
      throw new Error("Zero Risk does not support Bigger Context");
    }
    if (config.mode !== "full") {
      throw new Error("Zero Risk requires --full so Codex Zero Risk can signal start, tools, and completion");
    }
    if (config.browserHost !== "launcher") {
      throw new Error("Zero Risk requires the Launcher; pass --browser-host-descriptor from the running Launcher");
    }
    config.experimentalBiggerContext = false;
  }
  if (options.acknowledgedUnofficial) config.acknowledgedUnofficialAt = new Date().toISOString();
  if (!config.acknowledgedUnofficialAt) {
    throw new Error("Setup requires explicit acknowledgement that this is unofficial browser automation. Pass --acknowledge-unofficial.");
  }
  return config;
}

async function inspectLauncherCapabilities(
  config: AppConfig,
  existing: AppConfig | undefined,
  refreshAccountCapabilities: boolean,
  expectedProfile: "production" | "development",
): Promise<{ solAvailable: boolean; extraHighAvailable: boolean; proAvailable: boolean }> {
  const detectCapabilities = launcherCapabilityProbeRequired(
    existing,
    refreshAccountCapabilities,
    config.browserInteractionMode,
  );
  const inspected = await inspectLauncherBrowserHost(config.browserHostDescriptorPath!, {
    detectCapabilities,
    expectedProfile,
  });
  return {
    solAvailable: detectCapabilities ? inspected.solAvailable === true : existing!.solAvailable,
    extraHighAvailable: detectCapabilities
      ? inspected.extraHighAvailable === true
      : (existing!.extraHighAvailable ?? existing!.proAvailable),
    proAvailable: detectCapabilities ? inspected.proAvailable === true : existing!.proAvailable,
  };
}

async function configureTunnel(config: AppConfig, existing: AppConfig | undefined, options: SetupOptions): Promise<void> {
  if (config.mode === "browser-only") {
    delete config.tunnel;
    delete config.automaticTunnel;
    delete config.manualTunnel;
    return;
  }
  const interactionMode = config.browserInteractionMode;
  const legacyTunnel = existing?.mode === "full"
    && !existing.automaticTunnel
    && !existing.manualTunnel
    ? existing.tunnel
    : undefined;
  let automaticTunnel = existing?.automaticTunnel
    ?? legacyTunnel;
  let manualTunnel = existing?.manualTunnel;
  const existingTunnel = interactionMode === "manual" ? manualTunnel : automaticTunnel;
  const tunnelId = options.tunnelId ?? existingTunnel?.tunnelId;
  if (!tunnelId) {
    throw new Error(`${interactionMode === "manual" ? "Zero Risk" : "Automatic"} mode requires its own Tunnel ID`);
  }
  let runtimeKeyFile = existingTunnel?.runtimeKeyFile;
  const managedKeyFile = managedRuntimeKeyPath(interactionMode);
  if ((!runtimeKeyFile || !existsSync(runtimeKeyFile)) && existsSync(managedKeyFile)) {
    runtimeKeyFile = managedKeyFile;
  }
  if (options.runtimeKeyFile) runtimeKeyFile = installRuntimeKey(options.runtimeKeyFile, interactionMode);
  if (options.runtimeKeyValue) runtimeKeyFile = installRuntimeKeyBytes(options.runtimeKeyValue, interactionMode);
  if (runtimeKeyFile && runtimeKeyFile !== managedKeyFile && existsSync(runtimeKeyFile)) {
    runtimeKeyFile = installRuntimeKey(runtimeKeyFile, interactionMode);
  }
  if (!runtimeKeyFile || !existsSync(runtimeKeyFile)) {
    throw new Error(`${interactionMode === "manual" ? "Zero Risk" : "Automatic"} mode requires its own runtime key`);
  }
  const installedBinary = await installTunnelClient();
  const productionProfileName = interactionMode === "manual"
    ? "codex-chatgpt-web-zero-risk"
    : "codex-chatgpt-web";
  const profileName = config.purpose === DEV_CONFIG_PURPOSE
    ? interactionMode === "manual" ? `${DEV_TUNNEL_BASE_NAME}-zero-risk` : DEV_TUNNEL_BASE_NAME
    : productionProfileName;
  const configuredTunnel = createTunnelConfig({
    binaryPath: installedBinary,
    tunnelId,
    runtimeKeyFile,
    profileName,
    alias: profileName,
  });
  const otherTunnel = interactionMode === "manual" ? automaticTunnel : manualTunnel;
  if (otherTunnel?.tunnelId === configuredTunnel.tunnelId) {
    throw new Error("Automatic and Zero Risk require different Tunnel IDs and separate ChatGPT connectors");
  }
  if (interactionMode === "manual") manualTunnel = configuredTunnel;
  else automaticTunnel = configuredTunnel;
  config.tunnel = configuredTunnel;
  if (automaticTunnel) config.automaticTunnel = automaticTunnel;
  else delete config.automaticTunnel;
  if (manualTunnel) config.manualTunnel = manualTunnel;
  else delete config.manualTunnel;
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

function prepareSetup(options: SetupOptions): PreparedSetup {
  const existing = loadExistingConfig();
  if (existing?.purpose === DEV_CONFIG_PURPOSE) {
    throw new Error("A DEV harness configuration cannot be installed into Codex");
  }
  const config = baseConfig(existing, {
    ...options,
    subagentProtocol: options.subagentProtocol
      ?? readCodexSubagentProtocol(existing?.subagentProtocol ?? "compatibility-v1"),
  });
  delete config.purpose;
  const launcherOwned = config.browserHost === "launcher";
  if (!launcherOwned && process.platform !== "darwin") {
    throw new Error(
      "Terminal-only managed Chrome setup currently requires macOS. "
      + "Use the Codex Web GPT launcher on Windows or Linux.",
    );
  }
  return { existing, config, launcherOwned };
}

export function preflightSetup(options: SetupOptions): void {
  const { existing, config } = prepareSetup(options);
  if (config.mode === "full") {
    const saved = existing?.mode === "full"
      ? tunnelConfigForInteractionMode(existing, config.browserInteractionMode)
      : undefined;
    const tunnelId = options.tunnelId ?? saved?.tunnelId;
    if (!tunnelId) {
      throw new Error(
        `${config.browserInteractionMode === "manual" ? "Zero Risk" : "Automatic"} mode needs its own MCP Tunnel ID`,
      );
    }
    const savedKey = saved?.runtimeKeyFile;
    const managedKey = managedRuntimeKeyPath(config.browserInteractionMode);
    const hasRuntimeKey = Boolean(
      options.runtimeKeyValue
      || (options.runtimeKeyFile && existsSync(options.runtimeKeyFile))
      || (savedKey && existsSync(savedKey))
      || existsSync(managedKey),
    );
    if (!hasRuntimeKey) {
      throw new Error(
        `${config.browserInteractionMode === "manual" ? "Zero Risk" : "Automatic"} mode needs its own MCP runtime key`,
      );
    }
    const otherMode = config.browserInteractionMode === "manual" ? "automatic" : "manual";
    const other = existing?.mode === "full"
      ? tunnelConfigForInteractionMode(existing, otherMode)
      : undefined;
    if (other?.tunnelId === tunnelId) {
      throw new Error("Automatic and Zero Risk require different Tunnel IDs and separate ChatGPT connectors");
    }
  }
  preflightCodexIntegration(config, {
    replaceExistingRoute: options.replaceCodexRoute,
  });
}

export async function setup(options: SetupOptions): Promise<SetupResult> {
  const { existing, config, launcherOwned } = prepareSetup(options);
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
  let solAvailable: boolean | undefined = config.solAvailable;
  let extraHighAvailable: boolean | undefined = config.extraHighAvailable ?? config.proAvailable;
  let proAvailable: boolean | undefined = config.proAvailable;
  if (config.browserInteractionMode === "manual") {
    // The generic manual route is independent of account capabilities. The launcher may open the
    // authenticated surface, but setup must not inspect its model selector or infer availability.
  } else if (config.browserHost === "launcher") {
    if (options.forceLogin) throw new Error("Launcher browser login is owned by the launcher UI; --login cannot replace it");
    const capabilities = await inspectLauncherCapabilities(
      config,
      existing,
      options.refreshAccountCapabilities === true,
      "production",
    );
    solAvailable = capabilities.solAvailable;
    extraHighAvailable = capabilities.extraHighAvailable;
    proAvailable = capabilities.proAvailable;
  } else {
    const stored = storedBrowserLoginCapabilities(config);
    solAvailable = stored.solAvailable;
    extraHighAvailable = stored.extraHighAvailable ?? stored.proAvailable;
    proAvailable = stored.proAvailable;
    const loginRequired = options.forceLogin || !browserLoginStateExists(config);
    const capabilityProbeRequired = !loginRequired
      && (options.refreshAccountCapabilities === true
        || existing?.browserInteractionMode === "manual"
        || solAvailable === undefined
        || extraHighAvailable === undefined
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
      extraHighAvailable = login.extraHighAvailable;
      proAvailable = login.proAvailable;
      loginCreated = true;
    } else if (capabilityProbeRequired) {
      const inspected = await inspectBrowserLoginCapabilities(config);
      solAvailable = inspected.solAvailable;
      extraHighAvailable = inspected.extraHighAvailable ?? inspected.proAvailable;
      proAvailable = inspected.proAvailable;
    }
  }
  config.solAvailable = solAvailable === true;
  config.extraHighAvailable = config.solAvailable && extraHighAvailable === true;
  config.proAvailable = config.solAvailable && proAvailable === true;
  if (config.proAvailable) config.extraHighAvailable = true;
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

/**
 * Configure the isolated launcher/browser/tunnel inputs used by the repository DEV harness.
 * This deliberately has no Codex integration, Responses listener, or system service; the DEV
 * launcher supervises only the isolated MCP tunnel after this transaction commits.
 */
export async function setupDevProfile(options: SetupOptions): Promise<DevProfileSetupResult> {
  const existing = loadExistingConfig();
  if (existing && existing.purpose !== DEV_CONFIG_PURPOSE) {
    throw new Error("DEV profile home contains a non-DEV configuration; refusing to repurpose it");
  }
  if (!options.browserHostDescriptorPath) {
    throw new Error("DEV profile setup requires the isolated launcher browser descriptor");
  }
  const config = baseConfig(existing, {
    ...options,
    appName: resolveDevSetupConnectorName(existing?.automaticAppName, options.appName),
  });
  if (config.browserHost !== "launcher") {
    throw new Error("DEV profile setup requires the desktop launcher browser host");
  }
  config.purpose = DEV_CONFIG_PURPOSE;
  if (config.browserInteractionMode === "automatic") {
    const capabilities = await inspectLauncherCapabilities(
      config,
      existing,
      options.refreshAccountCapabilities === true,
      DEV_LAUNCHER_PROFILE,
    );
    config.solAvailable = capabilities.solAvailable;
    config.extraHighAvailable = capabilities.solAvailable && capabilities.extraHighAvailable;
    config.proAvailable = capabilities.solAvailable && capabilities.proAvailable;
    if (config.proAvailable) config.extraHighAvailable = true;
  }

  const explicitTunnelChange = Boolean(options.tunnelId || options.runtimeKeyFile || options.runtimeKeyValue);
  await configureTunnel(config, existing, options);
  let tunnelReady: boolean | null = null;
  if (config.mode === "full") {
    const profilePath = join(config.tunnel!.profileDir, `${config.tunnel!.profileName}.yaml`);
    const needsProfile = !existsSync(profilePath);
    if (needsProfile || tunnelWorkerRuntimeChanged(existing, config) || explicitTunnelChange) {
      await bootstrapTunnelProfile(config);
    }
    tunnelReady = false;
  }
  saveConfig(config);
  return {
    mode: config.mode,
    configPath: getConfigPath(),
    tunnelReady,
    connectorSetupRequired: config.mode === "full",
  };
}
