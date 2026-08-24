const PROVIDER_INSTALL_SCHEME = "codexwebgpt:";

function normalizeEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { return null; }
  if (endpoint.protocol !== "https:"
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash) return null;
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "");
  if (!endpoint.pathname.endsWith("/v1")) return null;
  return endpoint.toString().replace(/\/$/, "");
}

function normalizeName(value) {
  const name = String(value || "").trim();
  if (!name || name.length > 80 || /[\r\n\u0000-\u001f]/.test(name)) return null;
  return name;
}

function parseProviderInstallUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { return null; }
  if (parsed.protocol !== PROVIDER_INSTALL_SCHEME
    || parsed.hostname !== "install"
    || parsed.pathname !== "/responses") return null;
  const allowed = new Set(["endpoint", "name"]);
  if ([...parsed.searchParams.keys()].some(key => !allowed.has(key))) return null;
  const endpoint = normalizeEndpoint(parsed.searchParams.get("endpoint") || "");
  const name = normalizeName(parsed.searchParams.get("name"));
  return endpoint && name ? { endpoint, name } : null;
}

function buildProviderInstallUrl({ endpoint, name }) {
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const normalizedName = normalizeName(name);
  if (!normalizedEndpoint || !normalizedName) throw new Error("Invalid Responses provider install request");
  const url = new URL("codexwebgpt://install/responses");
  url.searchParams.set("endpoint", normalizedEndpoint);
  url.searchParams.set("name", normalizedName);
  return url.toString();
}

module.exports = {
  PROVIDER_INSTALL_SCHEME,
  buildProviderInstallUrl,
  parseProviderInstallUrl,
};
