const NATIVE_CODEX_URL = "https://chatgpt.com/backend-api/codex";
const TUNNEL_CONTROL_URL = "https://api.openai.com/v1/tunnels";
const NATIVE_PROXY_VARIABLE = "CODEX_CHATGPT_WEB_NATIVE_PROXY";

function proxyOriginFromPac(result, label) {
  const first = typeof result === "string" ? result.split(";")[0].trim() : "";
  if (first === "DIRECT") return null;
  const match = /^(PROXY|HTTPS)\s+([^\s/]+)$/i.exec(first);
  if (!match) throw new Error(`The system proxy for ${label} is not an HTTP/HTTPS proxy`);
  let url;
  try { url = new URL(`${match[1].toUpperCase() === "HTTPS" ? "https" : "http"}://${match[2]}`); }
  catch { throw new Error(`The system proxy for ${label} has an invalid address`); }
  const port = /:(\d+)$/.exec(match[2])?.[1];
  if (!url.hostname || !port || url.username || url.password || url.search || url.hash
    || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`The system proxy for ${label} has an invalid address`);
  }
  return url.origin;
}

function proxyEnvironmentFromPac(result) {
  const origin = proxyOriginFromPac(result, "native Codex");
  return origin ? { [NATIVE_PROXY_VARIABLE]: origin } : {};
}

function tunnelProxyEnvironmentFromPac(result, environment = process.env) {
  const origin = proxyOriginFromPac(result, "OpenAI tunnel control plane");
  if (!origin) return {};
  const noProxy = environment.NO_PROXY || environment.no_proxy || "localhost,127.0.0.1,::1";
  return {
    HTTPS_PROXY: origin,
    https_proxy: origin,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

async function resolveNativeProxyEnvironment(session, environment = process.env, timeoutMs = 5000) {
  // Explicit runtime proxy settings retain priority. Do not send Roche or tunnel traffic through
  // a PAC decision that applies only to the first-party native Codex endpoint.
  if ([NATIVE_PROXY_VARIABLE, "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
    .some(key => typeof environment[key] === "string" && environment[key].trim())) return {};
  let timer;
  try {
    const result = await Promise.race([
      session.resolveProxy(NATIVE_CODEX_URL),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Resolving the system proxy for native Codex timed out")), timeoutMs); }),
    ]);
    return proxyEnvironmentFromPac(result);
  } finally { clearTimeout(timer); }
}

async function resolveTunnelProxyEnvironment(session, environment = process.env, timeoutMs = 5000) {
  // tunnel-client is a native process and does not consume Electron's PAC automatically. Preserve
  // an explicit process proxy; otherwise translate the PAC decision for the exact OpenAI endpoint
  // into the standard HTTPS proxy variables inherited by the managed tunnel runtime.
  if (["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"]
    .some(key => typeof environment[key] === "string" && environment[key].trim())) return {};
  let timer;
  try {
    const result = await Promise.race([
      session.resolveProxy(TUNNEL_CONTROL_URL),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Resolving the system proxy for the OpenAI tunnel control plane timed out")), timeoutMs); }),
    ]);
    return tunnelProxyEnvironmentFromPac(result, environment);
  } finally { clearTimeout(timer); }
}

module.exports = {
  resolveNativeProxyEnvironment,
  resolveTunnelProxyEnvironment,
  proxyEnvironmentFromPac,
  tunnelProxyEnvironmentFromPac,
};
