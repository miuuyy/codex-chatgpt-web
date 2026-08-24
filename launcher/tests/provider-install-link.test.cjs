const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildProviderInstallUrl,
  parseProviderInstallUrl,
} = require("../electron/provider-install-link.cjs");

test("provider install links carry endpoint metadata but never an API key", () => {
  const link = buildProviderInstallUrl({
    endpoint: "https://gateway.example/v1",
    name: "Example Responses bridge",
  });
  assert.equal(link.includes("secret"), false);
  assert.deepEqual(parseProviderInstallUrl(link), {
    endpoint: "https://gateway.example/v1",
    name: "Example Responses bridge",
  });
});

test("provider install links reject secrets, unexpected fields, and non-HTTPS routes", () => {
  for (const link of [
    "codexwebgpt://install/responses?endpoint=http%3A%2F%2Fgateway.example%2Fv1&name=Example",
    "codexwebgpt://install/responses?endpoint=https%3A%2F%2Fgateway.example%2Fv1&name=Example&apiKey=secret",
    "codexwebgpt://install/responses?endpoint=https%3A%2F%2Fuser%3Asecret%40gateway.example%2Fv1&name=Example",
    "codexwebgpt://other/responses?endpoint=https%3A%2F%2Fgateway.example%2Fv1&name=Example",
  ]) {
    assert.equal(parseProviderInstallUrl(link), null);
  }
});
