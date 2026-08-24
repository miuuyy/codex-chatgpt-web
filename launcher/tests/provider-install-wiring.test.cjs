const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("the packaged launcher registers the credential-free provider install protocol", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.build.protocols, [{
    name: "Codex Web GPT provider install",
    schemes: ["codexwebgpt"],
  }]);
});

test("provider install IPC keeps the key local and exposes an explicit restore action", () => {
  const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
  const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  assert.match(preload, /launcher:external-provider-install/);
  assert.match(preload, /launcher:external-provider-uninstall/);
  assert.match(main, /parseProviderInstallUrl/);
  assert.match(main, /dialog\.showMessageBox/);
  assert.match(main, /input\?\.endpoint !== request\.endpoint/);
  assert.match(main, /input\?\.name !== request\.name/);
  assert.match(renderer, /type="password"/);
  assert.match(renderer, /externalInstallTools/);
  assert.match(renderer, /disconnectExternalProvider/);
  assert.doesNotMatch(main, /apiKey.*searchParams|searchParams.*apiKey/);
});
