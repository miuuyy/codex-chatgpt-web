import { readFileSync } from "node:fs";
import type { AppConfig } from "./config";
import { getCodexConfigPath } from "./codex-integration";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface ExternalProviderInspection {
  active: boolean;
  reason: string;
  provider?: string;
  verifiedModels?: string[];
  requiredModels?: string[];
  status?: number;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function findTopLevelStringAssignment(text: string, key: string): string | undefined {
  let insideTable = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) insideTable = true;
    if (insideTable) continue;
    const match = trimmed.match(new RegExp(`^${key}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*(?:#.*)?$`));
    if (!match) continue;
    try {
      const value: unknown = JSON.parse(match[1]);
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function requiredWebModelSuffixes(
  config: Pick<AppConfig, "solAvailable" | "proAvailable">,
): string[] {
  const suffixes = ["chatgpt-web/light", "chatgpt-web/medium"];
  if (config.solAvailable) suffixes.push("chatgpt-web/high", "chatgpt-web/extra-high");
  if (config.proAvailable) suffixes.push("chatgpt-web/pro");
  return suffixes;
}

function providerPrefix(modelIds: string[], suffixes: string[]): string | undefined {
  const candidates = new Set<string>();
  for (const id of modelIds) {
    const suffix = suffixes.find(item => id.endsWith(`/${item}`));
    if (suffix) candidates.add(id.slice(0, -(suffix.length + 1)));
  }
  return [...candidates].find(prefix => prefix && suffixes.every(suffix => modelIds.includes(`${prefix}/${suffix}`)));
}

export async function inspectExternalProvider(
  config: Pick<AppConfig, "port" | "solAvailable" | "proAvailable">,
  {
    codexConfigPath = getCodexConfigPath(),
    fetchImpl = fetch,
    timeoutMs = 3_000,
  }: {
    codexConfigPath?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  } = {},
): Promise<ExternalProviderInspection> {
  let text: string;
  try {
    text = readFileSync(codexConfigPath, "utf8");
  } catch (error) {
    return { active: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "codex-config-missing" : "codex-config-unreadable" };
  }
  const configuredBaseUrl = findTopLevelStringAssignment(text, "openai_base_url");
  if (!configuredBaseUrl) return { active: false, reason: "codex-base-url-missing" };
  let baseUrl: URL;
  try {
    baseUrl = new URL(configuredBaseUrl);
  } catch {
    return { active: false, reason: "codex-base-url-invalid" };
  }
  if (baseUrl.protocol !== "http:" || !LOOPBACK_HOSTS.has(baseUrl.hostname)) {
    return { active: false, reason: "external-provider-not-loopback" };
  }
  const normalizedPath = baseUrl.pathname.replace(/\/+$/, "") || "/";
  if (baseUrl.port === String(config.port) && normalizedPath === "/v1") {
    return { active: false, reason: "direct-codex-route" };
  }
  const modelsUrl = new URL(`${baseUrl.pathname.replace(/\/$/, "")}/models`, baseUrl.origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(modelsUrl, { signal: controller.signal });
  } catch {
    return { active: false, reason: "external-provider-unreachable" };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    return { active: false, reason: "external-provider-model-catalog-failed", status: response.status };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { active: false, reason: "external-provider-model-catalog-invalid" };
  }
  const data = (payload as { data?: unknown }).data;
  const modelIds = Array.isArray(data)
    ? data.map(item => (item as { id?: unknown })?.id).filter((id): id is string => typeof id === "string")
    : [];
  const suffixes = requiredWebModelSuffixes(config);
  const provider = providerPrefix(modelIds, suffixes);
  if (!provider) {
    return { active: false, reason: "external-provider-models-missing", requiredModels: suffixes };
  }
  return {
    active: true,
    reason: "verified-external-provider",
    provider,
    verifiedModels: suffixes.map(suffix => `${provider}/${suffix}`),
  };
}
