import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig } from "./config";
import { getConfigPath, loadConfig, saveConfig } from "./config";
import {
  codexInterruptHookCommand,
  codexInterruptHookHash,
  codexJsonInterruptHookStateKey,
  installCodexInterruptHook,
  installCodexInterruptHookCommand,
  installCodexInterruptHookTrust,
  verifyCodexInterruptHook,
} from "./codex-interrupt-hook";
import {
  installCodexInterruptHookJson,
  restoreCodexInterruptHookJson,
  verifyCodexInterruptHookJson,
} from "./codex-interrupt-hook-json";
import {
  CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
  getCodexConfigPath,
  getCodexHooksPath,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
  restoreFileSnapshot,
  routeUrl,
  sha256,
  snapshotFile,
  writeFileSnapshot,
  writeIntegrationState,
} from "./codex-integration-shared";
import type {
  AnyCodexIntegrationJournal,
  CodexIntegrationJournal,
  InstallCodexIntegrationOptions,
  LegacyCodexIntegrationJournalV4,
  LegacyCodexIntegrationJournalV5,
  LegacyCodexIntegrationJournalV6,
  LegacyCodexIntegrationJournalV7,
  LegacyCodexIntegrationJournalV8,
  LegacyCodexIntegrationJournalV9,
  LegacyCodexIntegrationJournalV10,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";
import { assertJournalTargetsConfig, readJournal } from "./codex-integration-journal";
import {
  findTopLevelAssignment,
  installCompatibilityV1Features,
  splitLines,
  textFormat,
} from "./codex-integration-document";
import {
  assertPreservedPreviousAssignments,
  assertPreservedPreviousRealtimeAssignment,
  installRoute,
  managedJournalIsActive,
  replacementBaseline,
  restoreLegacyV2,
  restoreManagedRoute,
  verifyInstalledRoute,
  verifyManagedJournalState,
  verifyRestoredRoute,
} from "./codex-integration-route";

function installConfiguredRoute(
  baseline: string,
  installedUrl: string,
  config: Pick<AppConfig, "subagentProtocol"> & (
    Pick<AppConfig, "runtimeCommand"> | { interruptHookCommand: string }
  ),
  replaceExistingRoute: boolean,
  replaceExistingRealtimeRoute: boolean,
  hooksJson?: { path: string; text: string },
): {
  text: string;
  previous: CodexIntegrationJournal["previous"];
  previousRealtimeWebrtcCallBaseUrl: CodexIntegrationJournal["previousRealtimeWebrtcCallBaseUrl"];
  previousMultiAgent?: CodexIntegrationJournal["previousMultiAgent"];
  previousMultiAgentV2?: CodexIntegrationJournal["previousMultiAgentV2"];
  previousAgentMaxDepth?: CodexIntegrationJournal["previousAgentMaxDepth"];
  installedAgentMaxDepth?: number;
  interruptHook: CodexIntegrationJournal["interruptHook"];
  hooksText?: string;
} {
  const route = installRoute(
    baseline,
    installedUrl,
    replaceExistingRoute,
    replaceExistingRealtimeRoute,
  );
  const configured = config.subagentProtocol === "compatibility-v1"
    ? (() => {
        const features = installCompatibilityV1Features(route.text);
        return {
          text: features.text,
          previous: route.previous,
          previousRealtimeWebrtcCallBaseUrl: route.previousRealtimeWebrtcCallBaseUrl,
          previousMultiAgent: features.previousMultiAgent,
          previousMultiAgentV2: features.previousMultiAgentV2,
          previousAgentMaxDepth: features.previousAgentMaxDepth,
          installedAgentMaxDepth: features.installedAgentMaxDepth,
        };
      })()
    : route;
  const command = "interruptHookCommand" in config
    ? config.interruptHookCommand
    : codexInterruptHookCommand(config);
  if (hooksJson) {
    const hook = installCodexInterruptHookJson(hooksJson.text, command);
    const stateKey = codexJsonInterruptHookStateKey(hooksJson.path, hook.installed.groupIndex, hook.installed.hookIndex);
    const trust = installCodexInterruptHookTrust(configured.text, stateKey, codexInterruptHookHash(command));
    return {
      ...configured,
      text: trust.text,
      hooksText: hook.text,
      interruptHook: {
        storage: "json",
        command,
        hooksPath: hooksJson.path,
        groupIndex: hook.installed.groupIndex,
        hookIndex: hook.installed.hookIndex,
        entryHash: hook.installed.entryHash,
        stateKey,
        trustedHash: trust.installed.trustedHash,
        trustFragment: trust.installed.fragment,
      },
    };
  }
  const hook = "interruptHookCommand" in config
    ? installCodexInterruptHookCommand(configured.text, getCodexConfigPath(), command)
    : installCodexInterruptHook(configured.text, getCodexConfigPath(), config);
  return { ...configured, text: hook.text, interruptHook: { ...hook.installed, storage: "toml" } };
}

function currentHooksJson(): { path: string; text: string } | undefined {
  const path = getCodexHooksPath();
  if (!existsSync(path)) {
    return undefined;
  }
  return { path, text: readFileSync(path, "utf8") };
}

function verifyManagedJsonHook(journal: CodexIntegrationJournal): void {
  if (journal.interruptHook.storage !== "json") {
    return;
  }
  if (!existsSync(journal.interruptHook.hooksPath)) {
    throw new Error(`Codex hooks JSON is missing: ${journal.interruptHook.hooksPath}`);
  }
  verifyCodexInterruptHookJson(readFileSync(journal.interruptHook.hooksPath, "utf8"), {
    ...journal.interruptHook,
    mode: "json",
  });
}

function restoreManagedJsonHook(journal: CodexIntegrationJournal): { path: string; text: string } | undefined {
  if (journal.interruptHook.storage !== "json") {
    return undefined;
  }
  verifyManagedJsonHook(journal);
  return {
    path: journal.interruptHook.hooksPath,
    text: restoreCodexInterruptHookJson(readFileSync(journal.interruptHook.hooksPath, "utf8"), {
      ...journal.interruptHook,
      mode: "json",
    }),
  };
}

function tomlInterruptHookIsFullyAbsent(text: string, stateKey: string): boolean {
  try {
    assertValidCodexToml(text);
    const parsed = Bun.TOML.parse(text) as { hooks?: unknown };
    if (parsed.hooks === undefined) {
      return true;
    }
    if (!parsed.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)) {
      return false;
    }
    const hooks = parsed.hooks as Record<string, unknown>;
    if (hooks.Interrupt !== undefined) {
      return false;
    }
    if (hooks.state === undefined) {
      return true;
    }
    return typeof hooks.state === "object" && hooks.state !== null && !Array.isArray(hooks.state)
      && !Object.hasOwn(hooks.state, stateKey);
  } catch {
    return false;
  }
}

function assertValidCodexToml(text: string): void {
  Bun.TOML.parse(text);
}

function journalProtocol(journal: Exclude<AnyCodexIntegrationJournal, { version: 2 }>): AppConfig["subagentProtocol"] {
  return journal.version === 8 || journal.version === 9 || journal.version === 10 || journal.version === 11
    ? journal.installed.subagent_protocol
    : "native";
}

export {
  getCodexConfigPath,
  getCodexHooksPath,
  getCodexHome,
  getCodexJournalPath,
  getCodexJournalRecoveryPath,
  getCodexModelsCachePath,
} from "./codex-integration-shared";
export { readCodexModelContextOverride } from "./codex-integration-document";
export type {
  CodexIntegrationJournal,
  CodexModelContextOverride,
  InstallCodexIntegrationOptions,
  SetCodexIntegrationActiveResult,
  UninstallCodexIntegrationResult,
} from "./codex-integration-shared";

export function readCodexSubagentProtocol(
  fallback: AppConfig["subagentProtocol"] = "compatibility-v1",
): AppConfig["subagentProtocol"] {
  const journal = readJournal();
  return journal?.version === 8 || journal?.version === 9 || journal?.version === 10 || journal?.version === 11
    ? journal.installed.subagent_protocol
    : fallback;
}

export function setCodexSubagentProtocol(
  config: AppConfig,
  protocol: AppConfig["subagentProtocol"],
): CodexIntegrationJournal {
  const status = inspectCodexIntegration();
  if (!status.installed) throw new Error("Codex integration is not installed; run setup first");
  if (!status.active) {
    throw new Error("Codex integration is disconnected; reconnect it before changing the subagent protocol");
  }
  const nextConfig = { ...config, subagentProtocol: protocol };
  // The runtime catalog and Codex feature surface are two halves of one protocol selection. If
  // either write fails, restore every participant so the next launcher/Codex restart cannot load a
  // split V1/V2 state.
  const snapshots = [
    getConfigPath(),
    getCodexConfigPath(),
    getCodexHooksPath(),
    getCodexModelsCachePath(),
    getCodexJournalPath(),
    getCodexJournalRecoveryPath(),
  ].map(path => snapshotFile(path, {
    followSymlink: path === getCodexConfigPath() || path === getCodexHooksPath(),
  }));
  try {
    const journal = installCodexIntegration(nextConfig);
    saveConfig(nextConfig);
    return journal;
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [...snapshots].reverse()) {
      try {
        restoreFileSnapshot(snapshot);
      } catch (rollbackError) {
        rollbackFailures.push(
          `${snapshot.path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailures.length > 0
      ? `${primary}; subagent protocol rollback also failed: ${rollbackFailures.join("; ")}`
      : primary);
  }
}

export function preflightCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): void {
  const configPath = getCodexConfigPath();
  const configSnapshot = snapshotFile(configPath, { followSymlink: true });
  const configExists = configSnapshot.exists;
  const currentText = configSnapshot.data?.toString("utf8") ?? "";
  const existing = readJournal();
  const installedUrl = routeUrl(config);
  let hooksJson = currentHooksJson();
  if (existing) assertJournalTargetsConfig(existing, configPath);
  if (existing && existing.version !== 2) {
    if (!configExists) {
      if (options.replaceExistingRoute !== true) {
        throw new Error(`Codex config is missing: ${configPath}`);
      }
      installConfiguredRoute("", installedUrl, config, true, true, hooksJson);
      return;
    }
    try {
      verifyManagedJournalState(currentText, existing);
      assertValidCodexToml(currentText);
      if (existing.version === 11 && existing.active) {
        verifyManagedJsonHook(existing);
        if (managedJournalIsActive(existing)) {
          hooksJson = restoreManagedJsonHook(existing) ?? hooksJson;
        }
      }
    } catch (error) {
      if (existing.version === 11 && existing.interruptHook.storage === "json") throw error;
      if (existing.version === 11 && existing.interruptHook.storage === "toml") {
        if (!tomlInterruptHookIsFullyAbsent(currentText, existing.interruptHook.stateKey)) {
          verifyCodexInterruptHook(currentText, existing.interruptHook);
          assertValidCodexToml(currentText);
        }
      }
      if (options.replaceExistingRoute !== true) throw error;
      installConfiguredRoute(
        replacementBaseline(currentText, configExists, existing),
        installedUrl,
        config,
        true,
        true,
        hooksJson,
      );
      return;
    }
    if ((existing.version === 10 || existing.version === 11) && existing.active) return;
    const baseline = managedJournalIsActive(existing)
      ? restoreManagedRoute(currentText, existing)
      : currentText;
    installConfiguredRoute(
      baseline,
      installedUrl,
      config,
      true,
      options.replaceExistingRoute === true,
      hooksJson,
    );
    return;
  }
  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }
  installConfiguredRoute(
    baseline,
    installedUrl,
    config,
    options.replaceExistingRoute === true,
    options.replaceExistingRoute === true,
    hooksJson,
  );
}
export function installCodexIntegration(
  config: AppConfig,
  options: InstallCodexIntegrationOptions = {},
): CodexIntegrationJournal {
  const configPath = getCodexConfigPath();
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const configExists = existsSync(configPath);
  const currentText = configExists ? readFileSync(configPath, "utf8") : "";
  const existing = readJournal();
  const installedUrl = routeUrl(config);
  let hooksJson = currentHooksJson();
  if (existing) assertJournalTargetsConfig(existing, configPath);

  const hasManagedJournal = Boolean(existing && existing.version !== 2);
  if (hasManagedJournal && !configExists && options.replaceExistingRoute !== true) {
    throw new Error(`Codex config is missing: ${configPath}`);
  }

  if (hasManagedJournal && existing && existing.version !== 2) {
    let baseline: string;
    let preservePrevious = true;
    try {
      verifyManagedJournalState(currentText, existing);
      assertValidCodexToml(currentText);
      if (existing.version === 11 && existing.active) {
        verifyManagedJsonHook(existing);
      }
      baseline = managedJournalIsActive(existing)
        ? restoreManagedRoute(currentText, existing)
        : currentText;
      if (existing.version === 11 && managedJournalIsActive(existing)) {
        hooksJson = restoreManagedJsonHook(existing) ?? hooksJson;
      }
    } catch (error) {
      if (existing.version === 11 && existing.interruptHook.storage === "json") {
        throw error;
      }
      if (existing.version === 11 && existing.interruptHook.storage === "toml") {
        if (!tomlInterruptHookIsFullyAbsent(currentText, existing.interruptHook.stateKey)) {
          verifyCodexInterruptHook(currentText, existing.interruptHook);
          assertValidCodexToml(currentText);
        }
      }
      if (options.replaceExistingRoute !== true) throw error;
      baseline = replacementBaseline(currentText, configExists, existing);
      preservePrevious = false;
    }
    const patched = installConfiguredRoute(
      baseline,
      installedUrl,
      config,
      true,
      !preservePrevious || existing.version === 9 || existing.version === 10 || existing.version === 11 || options.replaceExistingRoute === true,
      hooksJson,
    );
    if (preservePrevious) {
      assertPreservedPreviousAssignments(patched.previous, existing.previous);
      if (existing.version === 9 || existing.version === 10 || existing.version === 11) {
        assertPreservedPreviousRealtimeAssignment(
          patched.previousRealtimeWebrtcCallBaseUrl,
          existing.previousRealtimeWebrtcCallBaseUrl,
        );
      }
    }
    const updated: CodexIntegrationJournal = {
      version: 11,
      active: true,
      configPath,
      installed: {
        openai_base_url: installedUrl,
        experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
        subagent_protocol: config.subagentProtocol,
        ...(config.subagentProtocol === "compatibility-v1" ? {
          agent_max_depth: patched.installedAgentMaxDepth,
        } : {}),
      },
      previous: preservePrevious ? existing.previous : patched.previous,
      previousRealtimeWebrtcCallBaseUrl: preservePrevious && (existing.version === 9 || existing.version === 10 || existing.version === 11)
        ? existing.previousRealtimeWebrtcCallBaseUrl
        : patched.previousRealtimeWebrtcCallBaseUrl,
      interruptHook: patched.interruptHook,
      ...(config.subagentProtocol === "compatibility-v1" ? {
        previousMultiAgent: patched.previousMultiAgent,
        previousMultiAgentV2: patched.previousMultiAgentV2,
        previousAgentMaxDepth: patched.previousAgentMaxDepth,
      } : {}),
      ...(existing.format ? { format: existing.format } : {}),
    };
    writeIntegrationState(
      updated,
      { path: configPath, data: patched.text },
      [getCodexModelsCachePath()],
      patched.hooksText && hooksJson ? [{ path: hooksJson.path, data: patched.hooksText, followSymlink: true }] : [],
    );
    return updated;
  }

  let baseline = currentText;
  if (existing?.version === 2) {
    if (existsSync(existing.catalogPath) && sha256(readFileSync(existing.catalogPath)) !== existing.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup; refusing migration: ${existing.catalogPath}`);
    }
    baseline = restoreLegacyV2(currentText, existing);
  }
  const patched = installConfiguredRoute(
    baseline,
    installedUrl,
    config,
    options.replaceExistingRoute === true,
    options.replaceExistingRoute === true,
    hooksJson,
  );
  const journal: CodexIntegrationJournal = {
    version: 11,
    active: true,
    configPath,
    installed: {
      openai_base_url: installedUrl,
      experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
      subagent_protocol: config.subagentProtocol,
      ...(config.subagentProtocol === "compatibility-v1" ? {
        agent_max_depth: patched.installedAgentMaxDepth,
      } : {}),
    },
    previous: patched.previous,
    previousRealtimeWebrtcCallBaseUrl: patched.previousRealtimeWebrtcCallBaseUrl,
    interruptHook: patched.interruptHook,
    ...(config.subagentProtocol === "compatibility-v1" ? {
      previousMultiAgent: patched.previousMultiAgent,
      previousMultiAgentV2: patched.previousMultiAgentV2,
      previousAgentMaxDepth: patched.previousAgentMaxDepth,
    } : {}),
    format: textFormat(baseline),
  };
  writeIntegrationState(
    journal,
    { path: configPath, data: patched.text },
    [getCodexModelsCachePath()],
    patched.hooksText && hooksJson ? [{ path: hooksJson.path, data: patched.hooksText, followSymlink: true }] : [],
  );
  if (existing?.version === 2 && existsSync(existing.catalogPath)) rmSync(existing.catalogPath);
  return journal;
}

export function deactivateCodexIntegration(): SetCodexIntegrationActiveResult {
  const existing = readJournal();
  if (!existing) return { changed: false, active: false };
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be disconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if ((existing.version === 4 || existing.version === 5 || existing.version === 6 || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10 || existing.version === 11) && !existing.active) {
    verifyRestoredRoute(current, existing);
    return { changed: false, active: false };
  }
  if (existing.version === 11) {
    verifyManagedJsonHook(existing);
  }
  const restored = restoreManagedRoute(current, existing);
  const disconnected:
    | CodexIntegrationJournal
    | LegacyCodexIntegrationJournalV10
    | LegacyCodexIntegrationJournalV9
    | LegacyCodexIntegrationJournalV8
    | LegacyCodexIntegrationJournalV6
    | LegacyCodexIntegrationJournalV7
    | LegacyCodexIntegrationJournalV5
    | LegacyCodexIntegrationJournalV4 = existing.version === 6 || existing.version === 5
      || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10 || existing.version === 11
      ? { ...existing, active: false }
      : { ...existing, version: 4, active: false };
  const restoredHooks = existing.version === 11 ? restoreManagedJsonHook(existing) : undefined;
  writeIntegrationState(
    disconnected,
    { path: existing.configPath, data: restored },
    [getCodexModelsCachePath()],
    restoredHooks ? [{ path: restoredHooks.path, data: restoredHooks.text, followSymlink: true }] : [],
  );
  return { changed: true, active: false };
}

export function activateCodexIntegration(): SetCodexIntegrationActiveResult {
  const existing = readJournal();
  if (!existing) throw new Error("Codex integration is not installed");
  if (existing.version === 2) {
    throw new Error("Legacy Codex integration must be upgraded by Setup before the bridge can be reconnected");
  }
  assertJournalTargetsConfig(existing, getCodexConfigPath());
  if (!existsSync(existing.configPath)) throw new Error(`Codex config is missing: ${existing.configPath}`);
  const current = readFileSync(existing.configPath, "utf8");
  if ((existing.version === 10 || existing.version === 11) && existing.active) {
    verifyInstalledRoute(current, existing);
    if (existing.version === 11) {
      verifyManagedJsonHook(existing);
    }
    return { changed: false, active: true };
  }
  let baseline: string;
  if ((existing.version === 4 || existing.version === 5 || existing.version === 6 || existing.version === 7 || existing.version === 8 || existing.version === 9 || existing.version === 10 || existing.version === 11) && !existing.active) {
    verifyRestoredRoute(current, existing);
    baseline = current;
  } else {
    verifyInstalledRoute(current, existing);
    baseline = restoreManagedRoute(current, existing);
  }
  const protocol = journalProtocol(existing);
  const hookConfig = existing.version === 10 || existing.version === 11
    ? { interruptHookCommand: existing.interruptHook.command }
    : { runtimeCommand: loadConfig().runtimeCommand };
  const hooksJson = currentHooksJson();
  const route = installConfiguredRoute(
    baseline,
    existing.installed.openai_base_url,
    { subagentProtocol: protocol, ...hookConfig },
    true,
    existing.version === 9 || existing.version === 10 || existing.version === 11,
    hooksJson,
  );
  assertPreservedPreviousAssignments(route.previous, existing.previous);
  if (existing.version === 9 || existing.version === 10 || existing.version === 11) {
    assertPreservedPreviousRealtimeAssignment(
      route.previousRealtimeWebrtcCallBaseUrl,
      existing.previousRealtimeWebrtcCallBaseUrl,
    );
  }
  const connected: CodexIntegrationJournal = {
    version: 11,
    active: true,
    configPath: existing.configPath,
    installed: {
      openai_base_url: existing.installed.openai_base_url,
      experimental_realtime_webrtc_call_base_url: CODEX_REALTIME_WEBRTC_CALL_BASE_URL,
      subagent_protocol: protocol,
      ...(protocol === "compatibility-v1" ? {
        agent_max_depth: route.installedAgentMaxDepth,
      } : {}),
    },
    previous: existing.previous,
    previousRealtimeWebrtcCallBaseUrl: existing.version === 9 || existing.version === 10 || existing.version === 11
      ? existing.previousRealtimeWebrtcCallBaseUrl
      : route.previousRealtimeWebrtcCallBaseUrl,
    interruptHook: route.interruptHook,
    ...(protocol === "compatibility-v1" ? {
      previousMultiAgent: route.previousMultiAgent,
      previousMultiAgentV2: route.previousMultiAgentV2,
      previousAgentMaxDepth: route.previousAgentMaxDepth,
    } : {}),
    ...(existing.format ? { format: existing.format } : {}),
  };
  writeIntegrationState(
    connected,
    { path: existing.configPath, data: route.text },
    [getCodexModelsCachePath()],
    route.hooksText && hooksJson ? [{ path: hooksJson.path, data: route.hooksText, followSymlink: true }] : [],
  );
  return { changed: true, active: true };
}

export function uninstallCodexIntegration(): UninstallCodexIntegrationResult {
  const journal = readJournal();
  if (!journal) return { changed: false };
  if (journal.version === 11 && journal.active) {
    deactivateCodexIntegration();
    return uninstallCodexIntegration();
  }
  if (!existsSync(journal.configPath)) throw new Error(`Codex config is missing: ${journal.configPath}`);
  const current = readFileSync(journal.configPath, "utf8");
  let restored: string;
  if (journal.version === 2) {
    if (existsSync(journal.catalogPath) && sha256(readFileSync(journal.catalogPath)) !== journal.catalogSha256) {
      throw new Error(`Managed legacy catalog changed after setup: ${journal.catalogPath}`);
    }
    restored = restoreLegacyV2(current, journal);
  } else if ((journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10 || journal.version === 11) && !journal.active) {
    verifyRestoredRoute(current, journal);
    restored = current;
  } else {
    if (journal.version === 11) {
      verifyManagedJsonHook(journal);
    }
    restored = restoreManagedRoute(current, journal);
  }
  const restoredHooks = journal.version === 11 && journal.active ? restoreManagedJsonHook(journal) : undefined;
  const configSnapshot = snapshotFile(journal.configPath, { followSymlink: true });
  const hooksSnapshot = restoredHooks ? snapshotFile(restoredHooks.path, { followSymlink: true }) : undefined;
  const catalogSnapshot = journal.version === 2 ? snapshotFile(journal.catalogPath) : undefined;
  const modelsCacheSnapshot = snapshotFile(getCodexModelsCachePath());
  const journalSnapshot = snapshotFile(getCodexJournalPath());
  const recoverySnapshot = snapshotFile(getCodexJournalRecoveryPath());
  try {
    writeFileSnapshot(configSnapshot, restored);
    if (restoredHooks && hooksSnapshot) writeFileSnapshot(hooksSnapshot, restoredHooks.text);
    if (catalogSnapshot?.exists) rmSync(catalogSnapshot.path);
    rmSync(modelsCacheSnapshot.path, { force: true });
    rmSync(getCodexJournalPath(), { force: true });
    rmSync(getCodexJournalRecoveryPath(), { force: true });
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const snapshot of [recoverySnapshot, journalSnapshot, modelsCacheSnapshot, catalogSnapshot, hooksSnapshot, configSnapshot]) {
      if (!snapshot) continue;
      try {
        restoreFileSnapshot(snapshot);
      } catch (caught) {
        rollbackFailures.push(`${snapshot.path}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    const primary = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackFailures.length > 0
      ? `${primary}; Codex integration rollback also failed: ${rollbackFailures.join("; ")}`
      : primary);
  }
  return { changed: true };
}

export function inspectCodexIntegration(): {
  installed: boolean;
  active: boolean;
  configPath: string;
  routeUrl?: string;
  journal?: AnyCodexIntegrationJournal;
  errors: string[];
} {
  const journal = readJournal();
  const errors: string[] = [];
  if (journal) {
    try {
      assertJournalTargetsConfig(journal, getCodexConfigPath());
      const text = readFileSync(journal.configPath, "utf8");
      if ((journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10 || journal.version === 11) && !journal.active) {
        verifyRestoredRoute(text, journal);
      }
      else if (journal.version === 3 || journal.version === 4 || journal.version === 5 || journal.version === 6 || journal.version === 7 || journal.version === 8 || journal.version === 9 || journal.version === 10 || journal.version === 11) {
        verifyInstalledRoute(text, journal);
        if (journal.version === 11) {
          verifyManagedJsonHook(journal);
        }
      }
      else {
        const lines = splitLines(text);
        for (const key of ["model_provider", "model_catalog_json"] as const) {
          if (findTopLevelAssignment(lines, key).value !== journal.installed[key]) {
            errors.push(`Codex ${key} no longer matches this installation`);
          }
        }
        if (!text.includes(journal.providerBlock)) errors.push("Managed legacy Codex provider block no longer matches this installation");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    installed: Boolean(journal),
    active: journal?.version === 4 || journal?.version === 5 || journal?.version === 6 || journal?.version === 7 || journal?.version === 8 || journal?.version === 9 || journal?.version === 10 || journal?.version === 11
      ? journal.active
      : Boolean(journal),
    configPath: getCodexConfigPath(),
    ...(journal?.version === 3 || journal?.version === 4 || journal?.version === 5 || journal?.version === 6 || journal?.version === 7 || journal?.version === 8 || journal?.version === 9 || journal?.version === 10 || journal?.version === 11
      ? { routeUrl: journal.installed.openai_base_url }
      : {}),
    ...(journal ? { journal } : {}),
    errors,
  };
}
