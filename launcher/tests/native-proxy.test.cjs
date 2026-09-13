const test = require("node:test");
const assert = require("node:assert/strict");
const {
  proxyEnvironmentFromPac,
  resolveNativeProxyEnvironment,
  resolveTunnelProxyEnvironment,
  tunnelProxyEnvironmentFromPac,
} = require("../electron/native-proxy.cjs");

test("resolves the native endpoint's PAC proxy without changing other traffic or global environment", async () => {
  const environment = { EXISTING_SETTING: "keep" };
  let target;
  const result = await resolveNativeProxyEnvironment({ resolveProxy: async url => { target = url; return "PROXY 127.0.0.1:7897; DIRECT"; } }, environment);
  assert.equal(target, "https://chatgpt.com/backend-api/codex");
  assert.deepEqual(result, { CODEX_CHATGPT_WEB_NATIVE_PROXY: "http://127.0.0.1:7897" });
  assert.deepEqual(environment, { EXISTING_SETTING: "keep" });
});

test("keeps an explicit HTTPS proxy instead of replacing it with the system PAC decision", async () => {
  let calls = 0;
  const result = await resolveNativeProxyEnvironment({ resolveProxy: async () => { calls++; return "DIRECT"; } }, { HTTPS_PROXY: "http://explicit.example:8080" });
  assert.deepEqual(result, {});
  assert.equal(calls, 0);
});

test("honors DIRECT and accepts IPv6 and default proxy ports", () => {
  assert.deepEqual(proxyEnvironmentFromPac("DIRECT; PROXY other.example:8080"), {});
  assert.deepEqual(proxyEnvironmentFromPac("PROXY [::1]:7897"), { CODEX_CHATGPT_WEB_NATIVE_PROXY: "http://[::1]:7897" });
  assert.deepEqual(proxyEnvironmentFromPac("PROXY proxy.example:80"), { CODEX_CHATGPT_WEB_NATIVE_PROXY: "http://proxy.example" });
  assert.deepEqual(proxyEnvironmentFromPac("HTTPS proxy.example:443"), { CODEX_CHATGPT_WEB_NATIVE_PROXY: "https://proxy.example" });
});

test("does not fall back to DIRECT for an unsupported or malformed PAC proxy", () => {
  for (const result of ["SOCKS5 localhost:10808; DIRECT", "", "PROXY host:0", "PROXY user:secret@host:8080", "PROXY host:8080#fragment"]) {
    assert.throws(() => proxyEnvironmentFromPac(result), /system proxy/);
  }
});

test("bounds a stalled PAC resolution", async () => {
  await assert.rejects(resolveNativeProxyEnvironment({ resolveProxy: () => new Promise(() => {}) }, {}, 10), /timed out/);
});

test("translates the tunnel control-plane PAC decision into inherited HTTPS proxy variables", async () => {
  const environment = { NO_PROXY: "localhost,127.0.0.1" };
  let target;
  const result = await resolveTunnelProxyEnvironment({
    resolveProxy: async url => { target = url; return "PROXY 127.0.0.1:7897; DIRECT"; },
  }, environment);
  assert.equal(target, "https://api.openai.com/v1/tunnels");
  assert.deepEqual(result, {
    HTTPS_PROXY: "http://127.0.0.1:7897",
    https_proxy: "http://127.0.0.1:7897",
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  });
  assert.deepEqual(environment, { NO_PROXY: "localhost,127.0.0.1" });
});

test("keeps an explicit tunnel proxy and preserves DIRECT", async () => {
  let calls = 0;
  assert.deepEqual(await resolveTunnelProxyEnvironment({ resolveProxy: async () => { calls++; return "DIRECT"; } }, {
    HTTPS_PROXY: "http://explicit.example:8080",
  }), {});
  assert.equal(calls, 0);
  assert.deepEqual(tunnelProxyEnvironmentFromPac("DIRECT"), {});
});

test("uses a loopback no-proxy default for a PAC-derived tunnel proxy", () => {
  assert.deepEqual(tunnelProxyEnvironmentFromPac("PROXY 127.0.0.1:7897", {}), {
    HTTPS_PROXY: "http://127.0.0.1:7897",
    https_proxy: "http://127.0.0.1:7897",
    NO_PROXY: "localhost,127.0.0.1,::1",
    no_proxy: "localhost,127.0.0.1,::1",
  });
});

test("bounds a stalled tunnel PAC resolution", async () => {
  await assert.rejects(resolveTunnelProxyEnvironment({ resolveProxy: () => new Promise(() => {}) }, {}, 10), /timed out/);
});
