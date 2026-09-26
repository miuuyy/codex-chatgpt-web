const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  buildJob,
  compareVersions,
  createUpdateController,
  expectedChecksum,
  macApplicationPath,
  releaseAssetName,
  resolveAssetDownloadUrl,
  resolveProxyUrl,
  shouldBypassProxy,
  validateReleaseAssetUrl,
} = require("../electron/update.cjs");

test("Linux auto-update fails closed without the stable installer wrapper", () => {
  const previousAppImage = process.env.CODEX_WEB_GPT_APPIMAGE;
  const previousWrapper = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
  process.env.CODEX_WEB_GPT_APPIMAGE = "/opt/codex/Codex Web GPT.AppImage";
  delete process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
  try {
    assert.throws(() => buildJob({
      version: "1.2.0",
      platform: "linux",
      executablePath: "/tmp/transient",
      assetPath: "/tmp/update.AppImage",
      stagingRoot: "/tmp/stage",
      tempRoot: "/tmp/update",
      logPath: "/tmp/update.log",
    }), /requires the stable install-launcher\.sh wrapper/);
  } finally {
    if (previousAppImage === undefined) delete process.env.CODEX_WEB_GPT_APPIMAGE;
    else process.env.CODEX_WEB_GPT_APPIMAGE = previousAppImage;
    if (previousWrapper === undefined) delete process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE;
    else process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = previousWrapper;
  }
});

test("unsupported Linux launches reject updates before downloading or changing state", async () => {
  const keys = ["CODEX_WEB_GPT_APPIMAGE", "APPIMAGE", "CODEX_WEB_GPT_LAUNCHER_EXECUTABLE"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const [appImage, wrapper] of [
      [undefined, "/opt/codex/launcher"],
      ["relative.AppImage", "/opt/codex/launcher"],
      ["/opt/codex/app.AppImage", undefined],
      ["/opt/codex/app.AppImage", "relative-launcher"],
    ]) {
      for (const key of keys) delete process.env[key];
      if (appImage !== undefined) process.env.CODEX_WEB_GPT_APPIMAGE = appImage;
      if (wrapper !== undefined) process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE = wrapper;
      const calls = [];
      const states = [];
      const controller = createUpdateController({
        currentVersion: "1.1.4", platform: "linux", arch: "x64", packaged: true,
        publish: state => states.push(state.status),
        dependencies: {
          fetchRelease: async () => ({
            tag_name: "v1.2.0",
            assets: ["codex-web-gpt-1.2.0-linux-x64.AppImage", "checksums.txt"].map(name => ({
              name,
              browser_download_url: `https://github.com/miuuyy/codex-chatgpt-web/releases/download/v1.2.0/${name}`,
            })),
          }),
          downloadText: async () => { calls.push("checksums"); throw new Error("Unexpected download"); },
          downloadFile: async () => { calls.push("asset"); },
          spawnWorker: () => { calls.push("worker"); },
        },
      });
      await controller.checkOnce();
      await assert.rejects(controller.beginInstall(), /install-launcher\.sh/);
      assert.deepEqual(calls, []);
      assert.deepEqual(states, ["checking", "available"]);
      assert.deepEqual(controller.getState(), { status: "available", version: "1.2.0" });
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("release comparison and platform assets are strict", () => {
  assert.equal(compareVersions("1.1.5", "1.1.4"), 1);
  assert.equal(compareVersions("1.1.4", "1.1.4"), 0);
  assert.equal(compareVersions("1.1.3", "1.1.4"), -1);
  assert.equal(compareVersions("1.2.0", "1.1.99"), 1);
  assert.equal(releaseAssetName("1.2.0", "darwin", "arm64"), "codex-web-gpt-1.2.0-mac-arm64.zip");
  assert.equal(releaseAssetName("1.2.0", "darwin", "x64"), "codex-web-gpt-1.2.0-mac-x64.zip");
  assert.equal(releaseAssetName("1.2.0", "win32", "x64"), "codex-web-gpt-1.2.0-win-x64.exe");
  assert.equal(releaseAssetName("1.2.0", "linux", "x64"), "codex-web-gpt-1.2.0-linux-x64.AppImage");
  assert.equal(releaseAssetName("1.2.0", "linux", "arm64"), "codex-web-gpt-1.2.0-linux-arm64.AppImage");
  assert.equal(releaseAssetName("1.2.0", "linux", "arm"), null);
  assert.equal(releaseAssetName("1.2.0", "linux", "ia32"), null);
});

test("checksums and release URLs bind the exact expected asset", () => {
  const hash = "a".repeat(64);
  assert.equal(expectedChecksum(`${hash}  launcher.zip\n`, "launcher.zip"), hash);
  assert.throws(() => expectedChecksum(`${hash}  other.zip\n`, "launcher.zip"), /no entry/);
  assert.equal(
    validateReleaseAssetUrl(
      "https://github.com/miuuyy/codex-chatgpt-web/releases/download/v1.2.0/launcher.zip",
      "1.2.0",
      "launcher.zip",
    ),
    "https://github.com/miuuyy/codex-chatgpt-web/releases/download/v1.2.0/launcher.zip",
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
              browser_download_url: "https://github.com/miuuyy/codex-chatgpt-web/releases/download/v1.2.0/codex-web-gpt-1.2.0-linux-x64.AppImage",
            },
            {
              name: "checksums.txt",
              browser_download_url: "https://github.com/miuuyy/codex-chatgpt-web/releases/download/v1.2.0/checksums.txt",
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

test("preview and draft releases stay hidden until promoted, regardless of the version suffix", async () => {
  for (const tag of ["1.2.0", "1.2.0-rc.1"]) {
    for (const flags of [{ prerelease: true }, { draft: true }, { prerelease: false, draft: false }]) {
      const controller = createUpdateController({
        currentVersion: "1.1.4", platform: "linux", arch: "x64", packaged: true,
        dependencies: {
          fetchRelease: async () => ({
            tag_name: `v${tag}`, ...flags,
            assets: [`codex-web-gpt-${tag}-linux-x64.AppImage`, "checksums.txt"].map(name => ({
              name,
              browser_download_url: `https://github.com/miuuyy/codex-chatgpt-web/releases/download/v${tag}/${name}`,
            })),
          }),
        },
      });
      const hidden = flags.prerelease || flags.draft;
      assert.deepEqual(await controller.checkOnce(), hidden
        ? { status: "up-to-date" }
        : { status: "available", version: tag });
      if (hidden) await assert.rejects(controller.beginInstall(), /No launcher update/);
    }
  }
});

for (const arch of ["x64", "arm64"]) {
  test(`verified Linux ${arch} update is handed to one detached worker`, async () => {
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
        arch,
        packaged: true,
        executablePath: "/tmp/launcher",
        runtimeExecutable: "/durable/bun",
        logsDirectory: path.join(root, "logs"),
        dependencies: {
          fetchRelease: async () => ({
            tag_name: "v1.2.0",
            assets: [
              {
                name: `codex-web-gpt-1.2.0-linux-${arch}.AppImage`,
                browser_download_url: `https://github.com/miuuyy/codex-chatgpt-web/releases/download/v1.2.0/codex-web-gpt-1.2.0-linux-${arch}.AppImage`,
              },
              {
                name: "checksums.txt",
                browser_download_url: "https://github.com/miuuyy/codex-chatgpt-web/releases/download/v1.2.0/checksums.txt",
              },
            ],
          }),
          downloadText: async () => `${hash}  codex-web-gpt-1.2.0-linux-${arch}.AppImage\n`,
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
      assert.equal(path.basename(spawned.data.runnerSource), "linux-appimage-runner.sh");
      assert.equal(fs.existsSync(spawned.data.runnerSource), true);
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
}

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
  const runnerSource = path.join(jobRoot, "run-appimage");
  const logPath = path.join(root, "logs", "update-worker.log");
  fs.mkdirSync(path.dirname(oldTarget), { recursive: true });
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.mkdirSync(jobRoot, { recursive: true });
  fs.writeFileSync(oldTarget, "old");
  fs.writeFileSync(wrapper, "old wrapper");
  fs.writeFileSync(source, `#!/bin/sh\nprintf launched > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  fs.writeFileSync(runnerSource, "#!/bin/sh\ntarget=\"$1\"\nshift\nexec \"$target\" \"$@\"\n", { mode: 0o755 });
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
    runnerSource,
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
    assert.doesNotMatch(fs.readFileSync(wrapper, "utf8"), /APPIMAGE_EXTRACT_AND_RUN/);
    assert.equal(fs.existsSync(path.join(versionsRoot, "run-appimage")), true);
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

test("proxy environment variables are resolved and respected", () => {
  const proxyKeys = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
  const previous = Object.fromEntries(proxyKeys.map(k => [k, process.env[k]]));
  try {
    for (const k of proxyKeys) delete process.env[k];
    assert.equal(resolveProxyUrl("github.com"), null);

    process.env.HTTPS_PROXY = "http://127.0.0.1:7890";
    assert.equal(resolveProxyUrl("github.com"), "http://127.0.0.1:7890");

    process.env.NO_PROXY = "github.com";
    assert.equal(resolveProxyUrl("github.com"), null);
    assert.equal(resolveProxyUrl("example.com"), "http://127.0.0.1:7890");

    process.env.NO_PROXY = ".github.com";
    assert.equal(shouldBypassProxy("api.github.com"), true);
    assert.equal(shouldBypassProxy("github.com"), false);
    assert.equal(shouldBypassProxy("objects.githubusercontent.com"), false);

    process.env.NO_PROXY = "*";
    assert.equal(shouldBypassProxy("objects.githubusercontent.com"), true);
  } finally {
    for (const k of proxyKeys) {
      if (previous[k] === undefined) delete process.env[k];
      else process.env[k] = previous[k];
    }
  }
});

test("mirror environment variable resolves release asset URLs and ignores non-HTTPS", () => {
  const previousMirror = process.env.CODEX_RELEASE_MIRROR;
  const previousGhMirror = process.env.GITHUB_MIRROR;
  try {
    delete process.env.CODEX_RELEASE_MIRROR;
    delete process.env.GITHUB_MIRROR;
    const original = "https://github.com/miuuyy/codex-chatgpt-web/releases/download/v1.2.0/launcher.zip";
    assert.equal(resolveAssetDownloadUrl(original), original);

    process.env.CODEX_RELEASE_MIRROR = "https://ghfast.top";
    assert.equal(resolveAssetDownloadUrl(original), `https://ghfast.top/${original}`);

    // Trailing slash normalized
    process.env.CODEX_RELEASE_MIRROR = "https://ghfast.top/";
    assert.equal(resolveAssetDownloadUrl(original), `https://ghfast.top/${original}`);

    // GITHUB_MIRROR fallback
    delete process.env.CODEX_RELEASE_MIRROR;
    process.env.GITHUB_MIRROR = "https://mirror.example.com";
    assert.equal(resolveAssetDownloadUrl(original), `https://mirror.example.com/${original}`);

    // Insecure mirror rejected
    process.env.CODEX_RELEASE_MIRROR = "http://insecure.example.com";
    assert.equal(resolveAssetDownloadUrl(original), original);
  } finally {
    if (previousMirror === undefined) delete process.env.CODEX_RELEASE_MIRROR;
    else process.env.CODEX_RELEASE_MIRROR = previousMirror;
    if (previousGhMirror === undefined) delete process.env.GITHUB_MIRROR;
    else process.env.GITHUB_MIRROR = previousGhMirror;
  }
});

test("download progress reports percentage during update installation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-progress-test-"));
  const assetBody = Buffer.from("simulated release asset bytes");
  const hash = require("node:crypto").createHash("sha256").update(assetBody).digest("hex");
  const emittedStates = [];
  try {
    const controller = createUpdateController({
      currentVersion: "1.0.0",
      platform: "darwin",
      arch: "arm64",
      packaged: true,
      executablePath: "/Applications/Codex Web GPT.app/Contents/MacOS/Codex Web GPT",
      runtimeExecutable: "/durable/bun",
      logsDirectory: path.join(root, "logs"),
      publish: (state) => emittedStates.push(state),
      dependencies: {
        fetchRelease: async () => ({
          tag_name: "v1.1.0",
          assets: [
            {
              name: "codex-web-gpt-1.1.0-mac-arm64.zip",
              browser_download_url: "https://github.com/miuuyy/codex-chatgpt-web/releases/download/v1.1.0/codex-web-gpt-1.1.0-mac-arm64.zip",
            },
            {
              name: "checksums.txt",
              browser_download_url: "https://github.com/miuuyy/codex-chatgpt-web/releases/download/v1.1.0/checksums.txt",
            },
          ],
        }),
        downloadText: async () => `${hash}  codex-web-gpt-1.1.0-mac-arm64.zip\n`,
        downloadFile: async (_url, destination, onProgress) => {
          onProgress?.({ received: 50, total: 100 });
          onProgress?.({ received: 100, total: 100 });
          fs.writeFileSync(destination, assetBody);
        },
        sha256: () => hash,
        extractMac: (_archive, target) => {
          const exe = path.join(target, "Codex Web GPT.app", "Contents", "MacOS", "Codex Web GPT");
          fs.mkdirSync(path.dirname(exe), { recursive: true });
          fs.writeFileSync(exe, "mock");
        },
        spawnWorker: () => ({ pid: 999, unref() {}, kill() {} }),
      },
    });

    await controller.checkOnce();
    await controller.beginInstall();

    const downloadingStates = emittedStates.filter((s) => s.status === "downloading");
    assert.equal(downloadingStates.length >= 3, true);
    assert.deepEqual(downloadingStates[0], { status: "downloading", version: "1.1.0" });
    assert.deepEqual(downloadingStates[1], { status: "downloading", version: "1.1.0", percentage: 50 });
    assert.deepEqual(downloadingStates[2], { status: "downloading", version: "1.1.0", percentage: 100 });
    assert.equal(emittedStates.some((s) => s.status === "installing"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

