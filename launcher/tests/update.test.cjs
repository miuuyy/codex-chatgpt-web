const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  buildJob,
  compareVersions,
  createUpdateController,
  createUpdateDownloader,
  expectedChecksum,
  macApplicationPath,
  releaseAssetName,
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

test("a failed startup check is retried on a bounded schedule; a successful one is not repeated", async () => {
  const release = {
    tag_name: "v1.2.0",
    assets: ["codex-web-gpt-1.2.0-linux-x64.AppImage", "checksums.txt"].map(name => ({
      name,
      browser_download_url: `https://github.com/miuuyy/codex-chatgpt-web/releases/download/v1.2.0/${name}`,
    })),
  };
  const controllerFor = (retryDelaysMs, fetchRelease, logged = []) => createUpdateController({
    currentVersion: "1.1.4",
    platform: "linux",
    arch: "x64",
    packaged: true,
    executablePath: "/tmp/launcher",
    runtimeExecutable: "/tmp/bun",
    logsDirectory: "/tmp/logs",
    retryDelaysMs,
    logger: { info() {}, warn: (event, detail) => logged.push({ event, detail }) },
    dependencies: { fetchRelease },
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 60));

  let calls = 0;
  const logged = [];
  // Offline at sign-in, then a release whose assets are still uploading, then the complete release.
  const recovering = controllerFor([5, 5, 5], async () => {
    calls += 1;
    if (calls === 1) throw new Error("net::ERR_INTERNET_DISCONNECTED");
    if (calls === 2) return { ...release, assets: [] };
    return release;
  }, logged);
  assert.equal((await recovering.checkOnce()).status, "error");
  await settle();
  assert.deepEqual(recovering.getState(), { status: "available", version: "1.2.0" });
  assert.equal(calls, 3);
  assert.deepEqual(logged.map(entry => entry.detail.retryInMs), [5, 5]);
  await settle();
  assert.equal(calls, 3);

  let failures = 0;
  const exhausted = controllerFor([5], async () => {
    failures += 1;
    throw new Error("offline");
  });
  await exhausted.checkOnce();
  await settle();
  assert.deepEqual(exhausted.getState(), { status: "error", message: "offline" });
  assert.equal(failures, 2);
  assert.equal((await exhausted.checkOnce()).status, "error");
  assert.equal(failures, 2);
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


// Electron emits redirects before the response and requires synchronous approval.
function updateTransport({ redirects = [], body = "release metadata", status = 200, headers = {}, stall, error } = {}) {
  const requests = [];
  const createRequest = options => {
    const request = new EventEmitter();
    requests.push(request);
    request.options = options;
    request.followed = [];
    request.aborted = false;
    request.abort = () => {
      if (request.aborted) return;
      request.aborted = true;
      request.response?.emit("aborted");
      request.emit("abort");
    };
    request.end = () => queueMicrotask(() => {
      for (const destination of redirects) {
        let followed = false;
        request.followRedirect = () => { followed = true; request.followed.push(destination); };
        request.emit("redirect", 302, "GET", destination, {});
        if (request.aborted) return;
        if (!followed) { request.emit("error", new Error("Redirect was cancelled")); return; }
      }
      if (stall === "headers") return;
      const response = request.response = new PassThrough();
      response.statusCode = status;
      response.headers = headers;
      request.emit("response", response);
      response.write(Buffer.from(body));
      if (error) request.emit("error", error);
      else if (stall !== "body") response.end();
    });
    return request;
  };
  return { createRequest, requests };
}

test("update downloads follow Chromium redirects synchronously without cookies", async () => {
  const transport = updateTransport({ redirects: ["https://release-assets.githubusercontent.com/asset"] });
  const downloader = createUpdateDownloader(transport.createRequest);
  assert.equal(await downloader.downloadText("https://github.com/release"), "release metadata");
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(transport.requests[0].followed, ["https://release-assets.githubusercontent.com/asset"]);
  for (const { options, aborted } of transport.requests) {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store");
    assert.equal(aborted, true);
  }
});

test("update downloads reject redirect downgrades, redirect loops and oversized metadata", async () => {
  for (const url of ["http://example.com/asset", "https://user:secret@example.com/asset"]) {
    const transport = updateTransport({ redirects: [url] });
    const downloader = createUpdateDownloader(transport.createRequest);
    await assert.rejects(downloader.downloadText("https://github.com/release"), /Refusing non-HTTPS/);
    assert.deepEqual(transport.requests[0].followed, []);
    assert.equal(transport.requests[0].aborted, true);
    await assert.rejects(downloader.downloadText(url), /Refusing non-HTTPS/);
    assert.equal(transport.requests.length, 1);
  }
  const loop = updateTransport({ redirects: Array(6).fill("https://github.com/again") });
  await assert.rejects(createUpdateDownloader(loop.createRequest).downloadText("https://github.com/release"), /Too many redirects/);
  assert.equal(loop.requests[0].followed.length, 5);
  const oversized = createUpdateDownloader(updateTransport({ body: "12345" }).createRequest);
  await assert.rejects(oversized.downloadText("https://github.com/release", 4), /size limit/);
});

test("update downloads cancel stalled headers and stalled response bodies", async () => {
  // Keep the event loop alive while testing the deliberately unref'ed production timer.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    for (const stall of ["headers", "body"]) {
      const transport = updateTransport({ stall });
      await assert.rejects(createUpdateDownloader(transport.createRequest, 15).downloadText("https://github.com/release"), /timed out/);
      assert.equal(transport.requests[0].aborted, true);
    }
  } finally {
    clearInterval(keepAlive);
  }
});

test("update downloads reject HTTP errors and interrupted response streams", async () => {
  for (const [options, message] of [
    [{ status: 404 }, /HTTP 404/],
    [{ error: new Error("connection lost") }, /connection lost/],
  ]) {
    const transport = updateTransport(options);
    await assert.rejects(createUpdateDownloader(transport.createRequest).downloadText("https://github.com/release"), message);
    assert.equal(transport.requests[0].aborted, true);
  }
});

test("update asset streaming preserves bytes and refuses to overwrite a file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-download-"));
  const destination = path.join(root, "asset.zip");
  const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
  const downloader = createUpdateDownloader(updateTransport({ body: bytes }).createRequest);
  try {
    await downloader.downloadFile("https://github.com/release", destination);
    assert.deepEqual(fs.readFileSync(destination), bytes);
    await assert.rejects(downloader.downloadFile("https://github.com/release", destination), /EEXIST/);
    assert.deepEqual(fs.readFileSync(destination), bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub rate-limit errors retain only bounded reset headers", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const url = "https://api.github.com/repos/miuuyy/codex-chatgpt-web/releases/latest";
  for (const [status, headers, retryAt] of [
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1200" }, 1_201_000],
    [429, { "retry-after": ["30"] }, 1_031_000],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "999" }, undefined],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "999999999999" }, undefined],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "PRIVATE_IP" }, undefined],
    [403, {}, undefined],
    [500, { "retry-after": "30" }, undefined],
  ]) {
    const transport = updateTransport({ status, headers, body: "PRIVATE_IP and private proxy response" });
    await assert.rejects(createUpdateDownloader(transport.createRequest).downloadText(url), error => {
      assert.equal(error.retryAt, retryAt);
      assert.equal(error.message.includes("PRIVATE"), false);
      assert.equal(error.message.includes("GitHub"), status === 429 || headers["x-ratelimit-remaining"] === "0");
      return true;
    });
    assert.equal(transport.requests[0].aborted, true);
  }
});

test("update checks wait for GitHub reset and manual rechecks do not duplicate or install", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  let calls = 0, workers = 0, downloads = 0, finish;
  const controller = createUpdateController({
    currentVersion: "6.1.12", platform: "darwin", arch: "arm64", packaged: true,
    executablePath: "/Applications/Test.app/Contents/MacOS/Test", runtimeExecutable: "/tmp/bun", logsDirectory: "/tmp/logs",
    retryDelaysMs: [60_000],
    dependencies: {
      fetchRelease: async () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("GitHub rate limit"), { retryAt: 1_180_000 });
        if (calls === 3) return new Promise(resolve => { finish = resolve; });
        return { tag_name: "v6.1.12" };
      },
      downloadFile: async () => { downloads++; }, spawnWorker: () => { workers++; },
    },
  });
  await controller.checkOnce();
  await controller.checkNow();
  t.mock.timers.tick(60_000);
  assert.equal(calls, 1);
  t.mock.timers.tick(120_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(controller.getState().status, "up-to-date");
  const first = controller.checkNow();
  const second = controller.checkNow();
  assert.equal(first, second);
  assert.equal(calls, 3);
  finish({ tag_name: "v6.1.17", assets: ["codex-web-gpt-6.1.17-mac-arm64.zip", "checksums.txt"].map(name => ({
    name, browser_download_url: `https://github.com/miuuyy/codex-chatgpt-web/releases/download/v6.1.17/${name}`,
  })) });
  await first;
  assert.deepEqual(controller.getState(), { status: "available", version: "6.1.17" });
  assert.equal(downloads, 0);
  assert.equal(workers, 0);
});

test("manual retry recovers an exhausted startup check without an extra scheduled request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const controller = createUpdateController({
    currentVersion: "6.1.17", platform: "darwin", arch: "arm64", packaged: true,
    retryDelaysMs: [1000], dependencies: { fetchRelease: async () => {
      if (++calls === 1) throw new Error("offline");
      return { tag_name: "v6.1.17" };
    } },
  });
  await controller.checkOnce();
  await controller.checkNow();
  t.mock.timers.tick(2000);
  assert.equal(calls, 2);
  assert.equal(controller.getState().status, "up-to-date");
});
