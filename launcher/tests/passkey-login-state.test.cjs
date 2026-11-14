const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePasskeyLoginState } = require("../electron/passkey-login-state.cjs");

function cookie(name, domain, extra = {}) {
  return {
    name,
    value: `${name}-value`,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    ...extra,
  };
}

test("passkey transfer retains only portable ChatGPT/OpenAI state", () => {
  const state = validatePasskeyLoginState({
    cookies: [
      cookie("chatgpt", ".chatgpt.com"),
      cookie("openai", "auth.openai.com"),
      cookie("partitioned", ".chatgpt.com", { partitionKey: "https://accounts.google.com" }),
      cookie("identity-provider", ".accounts.google.com"),
      cookie("lookalike", ".chatgpt.com.attacker.example"),
      cookie("userinfo", "attacker.example@chatgpt.com"),
      cookie("port", "chatgpt.com:443"),
    ],
    origins: [
      { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
      { origin: "https://auth.openai.com", localStorage: [{ name: "auth", value: "ignored" }] },
      { origin: "https://accounts.google.com", localStorage: [{ name: "idp", value: "ignored" }] },
    ],
  });

  assert.deepEqual(state.cookies.map(value => value.name), ["chatgpt", "openai"]);
  assert.equal(state.cookies[0].domain, ".chatgpt.com");
  assert.equal(state.cookies[1].domain, undefined);
  assert.deepEqual(state.localStorage, [{ name: "chat", value: "kept" }]);
});

test("passkey transfer fails closed without an allowed session cookie", () => {
  assert.throws(() => validatePasskeyLoginState({
    cookies: [cookie("google", ".accounts.google.com")],
    origins: [],
  }), /no ChatGPT\/OpenAI cookies/);
});

test("passkey transfer rejects malformed allowed-domain cookie fields", () => {
  assert.throws(() => validatePasskeyLoginState({
    cookies: [cookie("broken", ".chatgpt.com", { path: "relative" })],
    origins: [],
  }), /invalid cookie path/);
  assert.throws(() => validatePasskeyLoginState({
    cookies: [cookie("broken", ".chatgpt.com", { sameSite: "Unknown" })],
    origins: [],
  }), /invalid cookie SameSite/);
});

function localStorageState(origins) {
  return { cookies: [cookie("session", ".chatgpt.com")], origins };
}

test("passkey transfer preserves a browser-valid value above the old two-megachar limit (#991)", () => {
  const value = "x".repeat(3 * 1024 * 1024);
  const state = validatePasskeyLoginState(localStorageState([
    { origin: "https://chatgpt.com", localStorage: [{ name: "large-state", value }] },
  ]));
  assert.deepEqual(state.localStorage, [{ name: "large-state", value }]);
});

test("passkey local-storage quota includes UTF-16 key and value sizes at its exact boundary", () => {
  const name = "\u{1f600}";
  const value = "x".repeat(5 * 1024 * 1024 - name.length);
  const state = localStorageState([
    { origin: "https://chatgpt.com", localStorage: [{ name, value }] },
  ]);
  assert.equal(validatePasskeyLoginState(state).localStorage[0].value, value);
  state.origins[0].localStorage[0].value += "x";
  assert.throws(() => validatePasskeyLoginState(state), /local.storage.*too large/);
});

test("passkey local-storage quota covers all imported entries and repeated origin records", () => {
  const entries = ["first", "second"].map(name => ({ name, value: "x".repeat(3 * 1024 * 1024) }));
  for (const origins of [
    [{ origin: "https://chatgpt.com", localStorage: entries }],
    entries.map(entry => ({ origin: "https://chatgpt.com", localStorage: [entry] })),
  ]) {
    assert.throws(() => validatePasskeyLoginState(localStorageState(origins)), /local.storage.*too large/);
  }
  assert.deepEqual(validatePasskeyLoginState(localStorageState([
    { origin: "https://unrelated.example", localStorage: entries },
    { origin: "https://chatgpt.com", localStorage: [{ name: "kept", value: "small" }] },
  ])).localStorage, [{ name: "kept", value: "small" }]);
});

test("larger passkey storage values do not relax field types or cookie and key bounds", () => {
  for (const value of [null, 123, {}, [], "x".repeat(5 * 1024 * 1024 + 1)]) {
    assert.throws(() => validatePasskeyLoginState(localStorageState([
      { origin: "https://chatgpt.com", localStorage: [{ name: "entry", value }] },
    ])), /local-storage value/);
  }
  assert.throws(() => validatePasskeyLoginState(localStorageState([
    { origin: "https://chatgpt.com", localStorage: [{ name: "x".repeat(2 * 1024 * 1024 + 1), value: "" }] },
  ])), /local-storage name is too large/);
  assert.throws(() => validatePasskeyLoginState({
    cookies: [cookie("session", ".chatgpt.com", { value: "x".repeat(2 * 1024 * 1024 + 1) })],
    origins: [],
  }), /cookie value is too large/);
});
