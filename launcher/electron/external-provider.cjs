const fs = require("node:fs");
const path = require("node:path");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function findTopLevelStringAssignment(text, key) {
  let insideTable = false;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) insideTable = true;
    if (insideTable) continue;
    const match = trimmed.match(new RegExp(`^${key}\\s*=\\s*("(?:\\\\.|[^"\\\\])*")\\s*(?:#.*)?$`));
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

function requiredWebModelSuffixes(config) {
  const suffixes = ["chatgpt-web/light", "chatgpt-web/medium"];
  if (config?.solAvailable === true) suffixes.push("chatgpt-web/high", "chatgpt-web/extra-high");
  if (config?.proAvailable === true) suffixes.push("chatgpt-web/pro");
  return suffixes;
}

function findProviderPrefix(modelIds, suffixes) {
  const candidates = new Set();
  for (const id of modelIds) {
    const suffix = suffixes.find((item) => id.endsWith(`/${item}`));
    if (suffix) candidates.add(id.slice(0, -(suffix.length + 1)));
  }
  for (const prefix of candidates) {
    if (prefix && suffixes.every((suffix) => modelIds.includes(`${prefix}/${suffix}`))) return prefix;
  }
  return null;
}

function inactive(reason, evidence = {}) {
  return { active: false, reason, ...evidence };
}

function resolveIntegrationMode({ route, provider }) {
  if (route?.active === true) return "direct";
  if (provider?.active === true) return "external-provider";
  if (route?.installed === true) return "direct-disabled";
  return "unconfigured";
}

async function inspectExternalProvider({
  codexHome,
  runtimeConfig,
  fetchImpl = globalThis.fetch,
  timeoutMs = 3_000,
} = {}) {
  if (!codexHome || !path.isAbsolute(codexHome)) return inactive("codex-home-unavailable");
  if (!runtimeConfig || typeof runtimeConfig !== "object") return inactive("runtime-config-unavailable");
  if (typeof fetchImpl !== "function") return inactive("fetch-unavailable");
  const configPath = path.join(codexHome, "config.toml");
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    return inactive(error?.code === "ENOENT" ? "codex-config-missing" : "codex-config-unreadable");
  }
  const configuredBaseUrl = findTopLevelStringAssignment(text, "openai_base_url");
  if (!configuredBaseUrl) return inactive("codex-base-url-missing");
  let baseUrl;
  try {
    baseUrl = new URL(configuredBaseUrl);
  } catch {
    return inactive("codex-base-url-invalid");
  }
  if (baseUrl.protocol !== "http:" || !LOOPBACK_HOSTS.has(baseUrl.hostname)) {
    return inactive("external-provider-not-loopback", { baseUrl: configuredBaseUrl });
  }
  const normalizedPath = baseUrl.pathname.replace(/\/+$/, "") || "/";
  const directPort = String(runtimeConfig.port);
  if (LOOPBACK_HOSTS.has(baseUrl.hostname)
    && baseUrl.port === directPort
    && normalizedPath === "/v1") {
    return inactive("direct-codex-route", { baseUrl: configuredBaseUrl });
  }
  const modelsUrl = new URL(`${baseUrl.pathname.replace(/\/$/, "")}/models`, baseUrl.origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(modelsUrl, { signal: controller.signal });
  } catch {
    return inactive("external-provider-unreachable", { baseUrl: configuredBaseUrl });
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) {
    return inactive("external-provider-model-catalog-failed", {
      baseUrl: configuredBaseUrl,
      status: Number.isInteger(response?.status) ? response.status : null,
    });
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return inactive("external-provider-model-catalog-invalid", { baseUrl: configuredBaseUrl });
  }
  const modelIds = Array.isArray(payload?.data)
    ? payload.data.map((item) => item?.id).filter((id) => typeof id === "string")
    : [];
  const suffixes = requiredWebModelSuffixes(runtimeConfig);
  const provider = findProviderPrefix(modelIds, suffixes);
  if (!provider) {
    return inactive("external-provider-models-missing", {
      baseUrl: configuredBaseUrl,
      requiredModels: suffixes,
    });
  }
  return {
    active: true,
    reason: "verified-external-provider",
    baseUrl: `${baseUrl.origin}${baseUrl.pathname}`,
    provider,
    verifiedModels: suffixes.map((suffix) => `${provider}/${suffix}`),
  };
}

module.exports = {
  findTopLevelStringAssignment,
  inspectExternalProvider,
  requiredWebModelSuffixes,
  resolveIntegrationMode,
};
