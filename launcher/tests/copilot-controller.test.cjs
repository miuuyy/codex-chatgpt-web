const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  COPILOT_DEFAULT_MODEL,
  COPILOT_DEFAULT_PORT,
  CopilotController,
  PROFILE_MARKER,
} = require("../electron/copilot-controller.cjs");

const logger = { info() {}, warn() {}, error() {} };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-controller-"));
  const home = path.join(root, "copilot");
  const codexHome = path.join(root, "codex");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  return { root, home, codexHome };
}

function createController(home, codexHome) {
  return new CopilotController({
    app: { isPackaged: false },
    logger,
    sourceRoot: path.resolve(__dirname, "..", ".."),
    runtimeRootProvider: () => null,
    codexHome,
    home,
  });
}

test("Copilot status reports default paths and a stopped bridge before setup", async () => {
  const { root, home, codexHome } = fixture();
  try {
    const controller = createController(home, codexHome);
    controller.health = async () => null;
    const status = await controller.status();
    assert.equal(status.home, home);
    assert.equal(status.configPath, path.join(home, "config.json"));
    assert.equal(status.catalogPath, path.join(home, "models.json"));
    assert.equal(status.profilePath, path.join(codexHome, "copilot.config.toml"));
    assert.equal(status.configExists, false);
    assert.equal(status.configError, null);
    assert.equal(status.profileInstalled, false);
    assert.equal(status.profileManaged, false);
    assert.equal(status.port, COPILOT_DEFAULT_PORT);
    assert.equal(status.endpoint, `http://127.0.0.1:${COPILOT_DEFAULT_PORT}/v1`);
    assert.deepEqual(status.models, []);
    assert.equal(status.bridge.status, "stopped");
    assert.equal(status.bridge.owned, false);
    assert.equal(status.signedIn, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Copilot status reads the configured port and model list", async () => {
  const { root, home, codexHome } = fixture();
  try {
    fs.writeFileSync(path.join(home, "config.json"), `${JSON.stringify({
      version: 1,
      port: 18_123,
      models: [
        { id: "copilot-web/auto", displayName: "Copilot Auto" },
        { id: "copilot-web/quick", displayName: "Copilot Quick" },
      ],
    })}\n`);
    const controller = createController(home, codexHome);
    controller.health = async () => null;
    const status = await controller.status();
    assert.equal(status.configExists, true);
    assert.equal(status.port, 18_123);
    assert.equal(status.endpoint, "http://127.0.0.1:18123/v1");
    assert.deepEqual(status.models, [
      { id: "copilot-web/auto", displayName: "Copilot Auto" },
      { id: "copilot-web/quick", displayName: "Copilot Quick" },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Copilot profile install writes a managed Codex profile and removes it", async () => {
  const { root, home, codexHome } = fixture();
  try {
    const controller = createController(home, codexHome);
    controller.health = async () => null;
    fs.writeFileSync(path.join(home, "config.json"), `${JSON.stringify({
      version: 1,
      port: 18_321,
      models: [{ id: "copilot-web/auto", displayName: "Copilot Auto" }],
    })}\n`);
    controller.run = async (args) => {
      assert.deepEqual(args.slice(0, 2), ["config", "--catalog"]);
      fs.writeFileSync(args[2], `${JSON.stringify({ object: "list", models: [] })}\n`);
      return { stdout: "", stderr: "" };
    };

    const installed = await controller.installProfile();
    assert.equal(installed.profileInstalled, true);
    assert.equal(installed.profileManaged, true);
    const profilePath = path.join(codexHome, "copilot.config.toml");
    const profile = fs.readFileSync(profilePath, "utf8");
    assert.match(profile, new RegExp(PROFILE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(profile.includes(`model = ${JSON.stringify(COPILOT_DEFAULT_MODEL)}`));
    assert.ok(profile.includes('model_provider = "copilot-web"'));
    assert.ok(profile.includes(`model_catalog_json = ${JSON.stringify(path.join(home, "models.json"))}`));
    assert.ok(profile.includes('base_url = "http://127.0.0.1:18321/v1"'));
    assert.ok(profile.includes('wire_api = "responses"'));
    assert.ok(profile.includes("requires_openai_auth = false"));

    const removed = await controller.removeProfile();
    assert.equal(removed.profileInstalled, false);
    assert.equal(fs.existsSync(profilePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Copilot profile install and removal refuse to overwrite unmanaged files", async () => {
  const { root, home, codexHome } = fixture();
  try {
    const controller = createController(home, codexHome);
    controller.health = async () => null;
    fs.writeFileSync(path.join(home, "config.json"), `${JSON.stringify({ version: 1, port: 17_842 })}\n`);
    controller.run = async () => ({ stdout: "", stderr: "" });
    const profilePath = path.join(codexHome, "copilot.config.toml");
    fs.writeFileSync(profilePath, 'model = "custom"\n');

    await assert.rejects(() => controller.installProfile(), /different copilot\.config\.toml/);
    assert.equal(fs.readFileSync(profilePath, "utf8"), 'model = "custom"\n');
    await assert.rejects(() => controller.removeProfile(), /not created by the launcher/);
    assert.equal(fs.existsSync(profilePath), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Copilot status distinguishes owned and external bridges", async () => {
  const { root, home, codexHome } = fixture();
  try {
    const controller = createController(home, codexHome);
    controller.server = { child: { exitCode: null, pid: 4242 } };
    controller.health = async () => ({ service: "codex-copilot-web", pid: 4242 });
    const owned = await controller.status();
    assert.equal(owned.bridge.status, "running");
    assert.equal(owned.bridge.owned, true);
    assert.equal(owned.bridge.pid, 4242);
    assert.equal(owned.bridge.message, null);

    controller.server = null;
    controller.health = async () => ({ service: "codex-copilot-web", pid: 5252 });
    const external = await controller.status();
    assert.equal(external.bridge.status, "running");
    assert.equal(external.bridge.owned, false);
    assert.equal(external.bridge.pid, 5252);
    assert.match(external.bridge.message, /outside the launcher/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Copilot sign-in is refused while an external bridge owns the profile", async () => {
  const { root, home, codexHome } = fixture();
  try {
    const controller = createController(home, codexHome);
    controller.health = async () => ({ service: "codex-copilot-web", pid: 6262 });
    await assert.rejects(() => controller.login(), /Stop the local bridge/);
    await assert.rejects(() => controller.checkSignIn(), /Stop the local bridge/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
