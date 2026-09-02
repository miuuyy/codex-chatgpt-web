import { existsSync, readFileSync, statSync } from "node:fs";
import type { AppConfig } from "./config";
import { getConfigDir, getConfigPath, loadConfig } from "./config";
import { join } from "node:path";
import { inspectCodexIntegration } from "./codex-integration";
import { findTopLevelAssignment, parseDocument } from "./codex-integration-document";
import { getCodexConfigPath } from "./codex-integration-shared";
import { browserLoginStateExists, loginVerificationMarkerPath } from "./browser-login";
import { getServiceStatus } from "./service";
import { tunnelStatus } from "./tunnel";
import { getTunnelServiceStatus } from "./tunnel-service";
import { inspectLauncherBrowserHost, readLauncherBrowserHostDescriptor } from "./launcher-browser-host";
import { processRunning } from "./process";

const BUILTIN_CODEX_MODEL_PROVIDER = "openai";
const EXTERNAL_PROVIDER_COEXISTENCE_ISSUE = "https://github.com/miuuyy/codex-chatgpt-web/issues/205";

export type CheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: AppConfig["mode"];
  checks: DoctorCheck[];
}

export type CodexCatalogRouting =
  | { status: "default" }
  | { status: "custom-provider"; provider: string; explicitCatalog: boolean }
  | { status: "explicit-catalog" }
  | { status: "unreadable"; detail: string };

interface ProxyInspection {
  check: DoctorCheck;
  body?: Record<string, unknown>;
}

function secureFile(path: string): boolean {
  if (process.platform === "win32") return true;
  return (statSync(path).mode & 0o077) === 0;
}

function launcherOwnershipError(config: AppConfig, health: Record<string, unknown>): string | undefined {
  if (config.browserHost !== "launcher") return undefined;
  const path = join(getConfigDir(), "runtime", "launcher-supervisor.json");
  if (!existsSync(path)) return `Launcher runtime ownership marker is missing: ${path}`;
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    return `Launcher runtime ownership marker is invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (state.version !== 1
    || !Number.isInteger(state.ownerPid)
    || (state.ownerPid as number) < 1
    || !Number.isInteger(state.daemonPid)
    || (state.daemonPid as number) < 1
    || state.status !== "ready") {
    return "Launcher runtime ownership marker is incomplete or not ready";
  }
  if (!processRunning(state.ownerPid)) {
    return `Launcher owner process is not running (pid ${String(state.ownerPid)})`;
  }
  if (health.pid !== state.daemonPid) {
    return `Responses proxy pid ${String(health.pid)} does not match launcher-owned pid ${String(state.daemonPid)}`;
  }
  return undefined;
}

async function inspectProxy(config: AppConfig): Promise<ProxyInspection> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`http://${config.host}:${config.port}/healthz`, { signal: controller.signal });
    if (!response.ok) return { check: { id: "proxy", status: "error", message: `Responses proxy returned HTTP ${response.status}` } };
    const body = await response.json() as Record<string, unknown>;
    if (body.service !== "codex-chatgpt-web" || body.status !== "ok") {
      return { check: { id: "proxy", status: "error", message: "The configured port belongs to another service" } };
    }
    if (body.mode !== config.mode) {
      return { check: { id: "proxy", status: "error", message: `Daemon is running in ${String(body.mode)} mode; config requires ${config.mode}` } };
    }
    if (body.version !== config.releaseVersion) {
      return { check: { id: "proxy", status: "error", message: `Daemon version is ${String(body.version)}; config requires ${config.releaseVersion}` } };
    }
    if (body.accepting_turns !== true) {
      return {
        check: {
          id: "proxy",
          status: "error",
          message: "Responses proxy is still drained and is not accepting Codex turns",
        },
      };
    }
    const ownershipError = launcherOwnershipError(config, body);
    if (ownershipError) {
      return { check: { id: "proxy", status: "error", message: "Responses proxy ownership could not be verified", detail: ownershipError } };
    }
    return {
      check: { id: "proxy", status: "ok", message: `Responses proxy is healthy on 127.0.0.1:${config.port}` },
      body,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { check: { id: "proxy", status: "error", message: "Responses proxy is not reachable", detail } };
  } finally {
    clearTimeout(timeout);
  }
}

export function readCatalogRequestCount(health: Record<string, unknown>): number | undefined {
  const value = health.successful_model_catalog_requests;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function inspectCodexCatalogRoutingFromText(text: string): CodexCatalogRouting {
  try {
    const lines = parseDocument(text).lines;
    const provider = findTopLevelAssignment(lines, "model_provider");
    const catalog = findTopLevelAssignment(lines, "model_catalog_json");
    if (provider.present && !provider.value?.trim()) {
      return { status: "unreadable", detail: "top-level model_provider is empty" };
    }
    const customProvider = provider.present && provider.value && provider.value !== BUILTIN_CODEX_MODEL_PROVIDER
      ? provider.value
      : undefined;
    if (customProvider) {
      return { status: "custom-provider", provider: customProvider, explicitCatalog: catalog.present };
    }
    if (catalog.present) return { status: "explicit-catalog" };
    return { status: "default" };
  } catch (error) {
    return { status: "unreadable", detail: error instanceof Error ? error.message : String(error) };
  }
}

export function readCodexCatalogRouting(readText: (path: string) => string = (path) => readFileSync(path, "utf8")): CodexCatalogRouting {
  const path = getCodexConfigPath();
  if (!existsSync(path)) return { status: "default" };
  try {
    return inspectCodexCatalogRoutingFromText(readText(path));
  } catch {
    return { status: "unreadable", detail: "Codex config could not be read" };
  }
}

export function modelCatalogDoctorCheck(input: {
  successfulModelCatalogRequests: number | undefined;
  routing: CodexCatalogRouting;
}): DoctorCheck {
  if (input.successfulModelCatalogRequests === undefined) {
    return {
      id: "model-catalog",
      status: "warning",
      message: "Responses proxy did not report model catalog request counts",
      detail: "Doctor cannot prove whether Codex requested /v1/models.",
    };
  }
  if (input.successfulModelCatalogRequests > 0) {
    return {
      id: "model-catalog",
      status: "ok",
      message: "Codex has requested the ChatGPT Web model catalog from this daemon",
    };
  }

  if (input.routing.status === "custom-provider") {
    return {
      id: "model-catalog",
      status: "warning",
      message: `Codex is obtaining its model catalog from the selected provider ${JSON.stringify(input.routing.provider)}`,
      detail: [
        "A top-level model_provider other than the built-in openai provider owns model discovery, so zero requests to this daemon's /v1/models endpoint are expected.",
        "A [model_providers.*] table definition alone does not select a provider.",
        ...(input.routing.explicitCatalog
          ? ["Codex also has a top-level model_catalog_json assignment, which may bypass this daemon's catalog route."]
          : []),
        `First-class external-provider coexistence is tracked in ${EXTERNAL_PROVIDER_COEXISTENCE_ISSUE}.`,
      ].join(" "),
    };
  }
  if (input.routing.status === "explicit-catalog") {
    return {
      id: "model-catalog",
      status: "warning",
      message: "Codex has a top-level model_catalog_json assignment that may bypass this daemon's model catalog",
      detail: [
        "Zero requests to /v1/models can be expected in this configuration.",
        `First-class external-provider coexistence is tracked in ${EXTERNAL_PROVIDER_COEXISTENCE_ISSUE}.`,
      ].join(" "),
    };
  }

  const unreadable = input.routing.status === "unreadable"
    ? ` Codex catalog routing could not be inspected (${input.routing.detail}); doctor did not assume an alternate catalog owner.`
    : "";
  return {
    id: "model-catalog",
    status: "warning",
    message: "Codex has not requested the ChatGPT Web model catalog since this daemon started",
    detail: `The ChatGPT Web models in the Codex picker are not proven. Setup and a healthy proxy are not catalog evidence. Fully restart Codex, including its background process, while this launcher remains open, then run doctor again.${unreadable}`,
  };
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let config: AppConfig;
  try {
    config = loadConfig();
    checks.push({ id: "config", status: "ok", message: `Configuration is valid (${getConfigPath()})` });
  } catch (error) {
    checks.push({ id: "config", status: "error", message: "Configuration is invalid", detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, checks };
  }

  if (config.browserHost === "launcher") {
    try {
      const descriptor = readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath!);
      await inspectLauncherBrowserHost(config.browserHostDescriptorPath!, { timeoutMs: 30_000 });
      checks.push({
        id: "browser-host",
        status: "ok",
        message: `Embedded launcher browser is authenticated and reachable (pid ${descriptor.pid})`,
      });
    } catch (error) {
      checks.push({
        id: "browser-host",
        status: "error",
        message: "Embedded launcher browser is unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    if (!existsSync(config.chromeExecutablePath)) {
      checks.push({ id: "chrome", status: "error", message: `Chrome executable is missing: ${config.chromeExecutablePath}` });
    } else {
      checks.push({ id: "chrome", status: "ok", message: `Chrome executable found: ${config.chromeExecutablePath}` });
    }
    if (!browserLoginStateExists(config)) {
      checks.push({ id: "login", status: "error", message: "ChatGPT login state is missing or unverified; run `codex-chatgpt-web login`" });
    } else if (!secureFile(config.storageStatePath)) {
      checks.push({ id: "login", status: "error", message: `ChatGPT login state is readable by other users: ${config.storageStatePath}` });
    } else if (!secureFile(loginVerificationMarkerPath(config.storageStatePath))) {
      checks.push({ id: "login", status: "error", message: "ChatGPT login verification marker is readable by other users" });
    } else {
      checks.push({ id: "login", status: "ok", message: "ChatGPT login state has authenticated browser evidence" });
    }
  }

  const codex = inspectCodexIntegration();
  if (!codex.installed) {
    checks.push({ id: "codex", status: "error", message: "Codex model route is not installed" });
  } else if (codex.errors.length > 0) {
    checks.push({ id: "codex", status: "error", message: "Codex integration is inconsistent", detail: codex.errors.join("; ") });
  } else {
    checks.push({ id: "codex", status: "ok", message: "Codex native model route is installed" });
  }

  const service = getServiceStatus();
  if (config.browserHost === "launcher") {
    checks.push(service.installed || service.loaded
      ? {
          id: "service",
          status: "warning",
          message: "A legacy OS background service still exists; rerun launcher setup to migrate ownership",
          detail: JSON.stringify(service),
        }
      : { id: "service", status: "ok", message: "Launcher owns the background runtime" });
  } else if (!service.supported) {
    checks.push({ id: "service", status: "warning", message: "Managed service is unavailable on this OS; keep `serve` running manually" });
  } else if (!service.installed || !service.loaded) {
    checks.push({ id: "service", status: "error", message: "macOS background service is not installed and loaded" });
  } else {
    checks.push({ id: "service", status: "ok", message: "macOS background service is loaded" });
  }
  const proxy = await inspectProxy(config);
  checks.push(proxy.check);
  if (proxy.check.status === "ok" && proxy.body && codex.installed && codex.active && codex.errors.length === 0) {
    checks.push(modelCatalogDoctorCheck({
      successfulModelCatalogRequests: readCatalogRequestCount(proxy.body),
      routing: readCodexCatalogRouting(),
    }));
  }

  if (config.mode === "full") {
    const settings = config.tunnel!;
    if (!existsSync(settings.binaryPath)) {
      checks.push({ id: "tunnel-binary", status: "error", message: `tunnel-client is missing: ${settings.binaryPath}` });
    } else {
      checks.push({ id: "tunnel-binary", status: "ok", message: "Pinned openai/tunnel-client binary is installed" });
    }
    if (!existsSync(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file is missing" });
    } else if (!secureFile(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file has unsafe permissions" });
    } else {
      checks.push({ id: "tunnel-key", status: "ok", message: "Tunnel runtime key is stored privately" });
    }
    const tunnelService = getTunnelServiceStatus();
    if (config.browserHost === "launcher") {
      checks.push(tunnelService.installed || tunnelService.loaded
        ? {
            id: "tunnel-service",
            status: "warning",
            message: "A legacy OS tunnel service still exists; rerun launcher MCP setup to migrate ownership",
            detail: JSON.stringify(tunnelService),
          }
        : { id: "tunnel-service", status: "ok", message: "Launcher owns the tunnel runtime" });
    } else {
      checks.push(tunnelService.installed && tunnelService.loaded && tunnelService.running
        ? { id: "tunnel-service", status: "ok", message: "macOS tunnel service is installed, loaded, and running" }
        : { id: "tunnel-service", status: "error", message: "macOS tunnel service is not fully running", detail: JSON.stringify(tunnelService) });
    }
    const runtime = tunnelStatus(config);
    checks.push(runtime.ok
      ? { id: "tunnel-runtime", status: "ok", message: "Tunnel runtime reports healthy and ready" }
      : { id: "tunnel-runtime", status: "error", message: "Tunnel runtime is not ready", detail: runtime.detail });
    checks.push({
      id: "connector",
      status: "warning",
      message: `Local checks cannot prove that ChatGPT connector ${JSON.stringify(config.appName)} is attached to this tunnel`,
      detail: "Verify it once at https://chatgpt.com/#settings/Plugins while the tunnel is ready.",
    });
  } else {
    checks.push({ id: "tools", status: "warning", message: "Browser-only mode intentionally has no local tools or MCP tunnel" });
  }

  return {
    ok: !checks.some(check => check.status === "error"),
    mode: config.mode,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warning: "!", error: "✗" };
  const lines = report.checks.flatMap(check => [
    `${icon[check.status]} ${check.message}`,
    ...(check.detail ? [`  ${check.detail}`] : []),
  ]);
  lines.push(report.ok ? "Doctor result: ready" : "Doctor result: not ready");
  return `${lines.join("\n")}\n`;
}
