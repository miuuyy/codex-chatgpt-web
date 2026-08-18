const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  compareVersions,
  createUpdateController,
  expectedChecksum,
  macApplicationPath,
  releaseAssetName,
  validateReleaseAssetUrl,
} = require("../electron/update.cjs");

test("release comparison and platform assets are strict", () => {
  assert.equal(compareVersions("1.1.5", "1.1.4"), 1);
  assert.equal(compareVersions("1.1.4", "1.1.4"), 0);
  assert.equal(compareVersions("1.1.3", "1.1.4"), -1);
  assert.equal(compareVersions("1.2.0", "1.1.99"), 1);
  assert.equal(releaseAssetName("1.2.0", "darwin", "arm64"), "codex-web-gpt-1.2.0-mac-arm64.zip");
  assert.equal(releaseAssetName("1.2.0", "darwin", "x64"), "codex-web-gpt-1.2.0-mac-x64.zip");
  assert.equal(releaseAssetName("1.2.0", "win32", "x64"), "codex-web-gpt-1.2.0-win-x64.exe");
  assert.equal(releaseAssetName("1.2.0", "linux", "x64"), "codex-web-gpt-1.2.0-linux-x64.AppImage");
  assert.equal(releaseAssetName("1.2.0", "linux", "arm64"), null);
});

test("checksums and release URLs bind the exact expected asset", () => {
  const hash = "a".repeat(64);
  assert.equal(expectedChecksum(`${hash}  launcher.zip\n`, "launcher.zip"), hash);
  assert.throws(() => expectedChecksum(`${hash}  other.zip\n`, "launcher.zip"), /no entry/);
  assert.equal(
    validateReleaseAssetUrl(
      "https://github.com/naakto14/codex-chatgpt-web/releases/download/v1.2.0/launcher.zip",
      "1.2.0",
      "launcher.zip",
    ),
    "https://github.com/naakto14/codex-chatgpt-web/releases/download/v1.2.0/launcher.zip",
  );
  assert.throws(
    () => validateReleaseAssetUrl("https://example.com/launcher.zip", "1.2.0", "launcher.zip"),
    /unexpected release asset URL/,
  );
});

test("macOS bundle resolution never guesses outside Contents/MacOS", () => {
  assert.equal(
    macApplicationPath("/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT"),
    "/Applications/Codex Web GPT.app",
  );
  assert.throws(() => macApplicationPath("/tmp/Codex Web GPT"), /Could not resolve/);
});

test("startup check runs once and exposes only a newer complete release", async () => {
  let calls = 0;
  const published = [];
  const controller = createUpdateController({
    currentVersion: "1.1.4",
    platform: "linux",
    arch: "x64",
    packaged: true,
    executablePath: "/tmp/launcher",
    runtimeExecutable: "/tmp/bun",
    logsDirectory: "/tmp/logs",
    publish: (state) => published.push(state),
    dependencies: {
      fetchRelease: async () => {
        calls += 1;
        return {
          tag_name: "v1.2.0",
          assets: [
            {
              name: "codex-web-gpt-1.2.0-linux-x64.AppImage",
              browser_download_url: "https://github.com/naakto14/codex-chatgpt-web/releases/download/v1.2.0/codex-web-gpt-1.2.0-linux-x64.AppImage",
            },
            {
              name: "checksums.txt",
              browser_download_url: "https://github.com/naakto14/codex-chatgpt-web/releases/download/v1.2.0/checksums.txt",
            },
          ],
        };
      },
    },
  });
  assert.deepEqual(await controller.checkOnce(), { status: "available", version: "1.2.0" });
  assert.deepEqual(await controller.checkOnce(), { status: "available", version: "1.2.0" });
  assert.equal(calls, 1);
  assert.deepEqual(published.map((state) => state.status), ["checking", "available"]);
});

test("verified update is handed to one detached worker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-update-test-"));
  const oldAppImage = path.join(root, "versions", "1.1.4", "Codex Web GPT.AppImage");
  const wrapper = path.join(root, "bin", "codex-web-gpt");
  fs.mkdirSync(path.dirname(oldAppImage), { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(oldAppImage, "old");
  fs.writeFileSync(wrapper, "old wrapper");
  const assetBody = Buffer.from("new appimage");
  const hash = require("node:crypto").createHash("sha256").update(assetBody).digest("hex");
  let spawned = null;
  const previousAppImage = process.env.CODEX_WEB_GPT_APPIMAGE;
  const previousWrapper = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
  process.env.CODEX_WEB_GPT_APPIMAGE = oldAppImage;
  process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = wrapper;
  try {
    const controller = createUpdateController({
      currentVersion: "1.1.4",
      platform: "linux",
      arch: "x64",
      packaged: true,
      executablePath: "/tmp/launcher",
      runtimeExecutable: "/durable/bun",
      logsDirectory: path.join(root, "logs"),
      dependencies: {
        fetchRelease: async () => ({
          tag_name: "v1.2.0",
          assets: [
            {
              name: "codex-web-gpt-1.2.0-linux-x64.AppImage",
              browser_download_url: "https://github.com/naakto14/codex-chatgpt-web/releases/download/v1.2.0/codex-web-gpt-1.2.0-linux-x64.AppImage",
            },
            {
              name: "checksums.txt",
              browser_download_url: "https://github.com/naakto14/codex-chatgpt-web/releases/download/v1.2.0/checksums.txt",
            },
          ],
        }),
        downloadText: async () => `${hash}  codex-web-gpt-1.2.0-linux-x64.AppImage\n`,
        downloadFile: async (_url, destination) => fs.writeFileSync(destination, assetBody),
        sha256: (filePath) => require("node:crypto").createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
        spawnWorker: (runtime, worker, job) => {
          spawned = { runtime, worker, job, data: JSON.parse(fs.readFileSync(job, "utf8")) };
          return { pid: 123, unref() {}, kill() {} };
        },
      },
    });
    await controller.checkOnce();
    const launch = await controller.beginInstall();
    assert.equal(spawned.runtime, "/durable/bun");
    assert.equal(spawned.data.version, "1.2.0");
    assert.equal(spawned.data.target, oldAppImage);
    assert.equal(spawned.data.wrapper, wrapper);
    assert.equal(controller.getState().status, "installing");
    controller.cancelInstall(launch);
    assert.equal(fs.existsSync(launch.tempRoot), false);
    assert.deepEqual(controller.getState(), { status: "available", version: "1.2.0" });
  } finally {
    if (previousAppImage === undefined) delete process.env.CODEX_WEB_GPT_APPIMAGE;
    else process.env.CODEX_WEB_GPT_APPIMAGE = previousAppImage;
    if (previousWrapper === undefined) delete process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
    else process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = previousWrapper;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("detached worker replaces an installed Linux AppImage and removes the old version", {
  skip: process.platform === "win32" ? "Linux AppImage execution is not meaningful on Windows" : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-worker-test-"));
  const jobRoot = path.join(root, "job");
  const versionsRoot = path.join(root, "versions");
  const oldTarget = path.join(versionsRoot, "1.1.4", "Codex Web GPT.AppImage");
  const newTarget = path.join(versionsRoot, "1.2.0", "Codex Web GPT.AppImage");
  const wrapper = path.join(root, "bin", "codex-web-gpt");
  const marker = path.join(root, "launched");
  const source = path.join(jobRoot, "update.AppImage");
  const logPath = path.join(root, "logs", "update-worker.log");
  fs.mkdirSync(path.dirname(oldTarget), { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(jobRoot, { recursive: true });
  fs.writeFileSync(oldTarget, "old");
  fs.writeFileSync(wrapper, "old wrapper");
  fs.writeFileSync(source, `#!/bin/sh\nprintf launched > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const jobPath = path.join(jobRoot, "job.json");
  fs.writeFileSync(jobPath, JSON.stringify({
    version: "1.2.0",
    platform: "linux",
    parentPid: 2_147_483_647,
    tempRoot: jobRoot,
    logPath,
    source,
    target: oldTarget,
    wrapper,
  }));
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, "..", "electron", "update-worker.cjs"), jobPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(newTarget), true);
    assert.equal(fs.existsSync(path.dirname(oldTarget)), false);
    assert.match(fs.readFileSync(wrapper, "utf8"), /versions\/1\.2\.0\/Codex Web GPT\.AppImage/);
    const deadline = Date.now() + 3_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    assert.equal(fs.readFileSync(marker, "utf8"), "launched");
    assert.match(fs.readFileSync(logPath, "utf8"), /installed and relaunched/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
