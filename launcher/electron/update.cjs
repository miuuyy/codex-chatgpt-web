const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { spawn, spawnSync } = require("node:child_process");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const REPOSITORY = "miuuyy/codex-chatgpt-web";
const RELEASE_API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const USER_AGENT = "codex-web-gpt-launcher-updater";
const MAX_REDIRECTS = 5;

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || "").trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error(`Invalid release version comparison: ${left} / ${right}`);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

function releaseVersion(tagName) {
  const version = String(tagName || "").replace(/^v/, "");
  if (!parseVersion(version)) throw new Error(`GitHub returned an invalid release tag: ${tagName}`);
  return version;
}

function releaseAssetName(version, platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && ["arm64", "x64"].includes(arch)) {
    return `codex-web-gpt-${version}-mac-${arch}.zip`;
  }
  if (platform === "win32" && arch === "x64") {
    return `codex-web-gpt-${version}-win-x64.exe`;
  }
  if (platform === "linux" && ["x64", "arm64"].includes(arch)) {
    return `codex-web-gpt-${version}-linux-${arch}.AppImage`;
  }
  return null;
}

function expectedChecksum(contents, assetName) {
  for (const line of String(contents || "").split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+(.+)$/.exec(line.trim());
    if (match && match[2] === assetName) return match[1].toLowerCase();
  }
  throw new Error(`checksums.txt has no entry for ${assetName}`);
}

function validateReleaseAssetUrl(raw, version, assetName) {
  const url = new URL(raw);
  const expectedPath = `/${REPOSITORY}/releases/download/v${version}/${assetName}`;
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.pathname !== expectedPath) {
    throw new Error(`GitHub returned an unexpected release asset URL for ${assetName}`);
  }
  return url.toString();
}

class HttpsProxyAgent extends https.Agent {
  constructor(proxyUrl, options) {
    super(options);
    this.proxy = new URL(proxyUrl);
  }

  createConnection(options, callback) {
    const isHttpsProxy = this.proxy.protocol === "https:";
    const transport = isHttpsProxy ? https : http;
    const connectReq = transport.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port) || (isHttpsProxy ? 443 : 80),
      method: "CONNECT",
      path: `${options.hostname || options.host}:${options.port || 443}`,
      headers: {
        Host: `${options.hostname || options.host}:${options.port || 443}`,
        ...(this.proxy.username || this.proxy.password ? {
          "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`).toString("base64")}`,
        } : {}),
      },
    });
    connectReq.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`Proxy CONNECT failed with HTTP ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: options.servername || options.hostname || options.host,
      });
      callback(null, tlsSocket);
    });
    connectReq.on("error", (err) => callback(err));
    connectReq.end();
  }
}

function shouldBypassProxy(hostname) {
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "").trim();
  if (!noProxy) return false;
  if (noProxy === "*") return true;
  const entries = noProxy.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const host = (hostname || "").toLowerCase();
  for (const entry of entries) {
    if (entry === host) return true;
    if (entry.startsWith(".") && host.endsWith(entry)) return true;
    if (host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

function resolveProxyUrl(hostname) {
  if (shouldBypassProxy(hostname)) return null;
  const keys = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"];
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      try {
        const parsed = new URL(value);
        if (["http:", "https:"].includes(parsed.protocol) && parsed.hostname) return value;
      } catch {}
    }
  }
  return null;
}

function resolveProxyAgent(hostname) {
  const proxyUrl = resolveProxyUrl(hostname);
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
}

function resolveAssetDownloadUrl(url) {
  const mirror = (process.env.CODEX_RELEASE_MIRROR || process.env.GITHUB_MIRROR || "").trim().replace(/\/+$/, "");
  if (!mirror) return url;
  try {
    const mirrorParsed = new URL(mirror);
    if (mirrorParsed.protocol !== "https:") return url;
    return `${mirror}/${url}`;
  } catch {
    return url;
  }
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      reject(new Error(`Too many redirects while downloading ${url}`));
      return;
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
      reject(new Error(`Refusing non-HTTPS update URL: ${parsed.protocol}`));
      return;
    }
    const agent = resolveProxyAgent(parsed.hostname);
    const req = https.get(parsed, {
      ...(agent ? { agent } : {}),
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, parsed).toString();
        request(next, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Update download failed with HTTP ${response.statusCode}`));
        return;
      }
      resolve(response);
    });
    req.setTimeout(60_000, () => req.destroy(new Error("Update request timed out")));
    req.once("error", reject);
  });
}

async function downloadText(url, maxBytes = 2 * 1024 * 1024) {
  const response = await request(url);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("Update metadata exceeded its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function downloadFile(url, destination, onProgress) {
  const pipeWithProgress = async (response) => {
    const total = Number(response.headers["content-length"]) || 0;
    let received = 0;
    const writeStream = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
    if (typeof onProgress === "function" && total > 0) {
      const tracker = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          onProgress({ received, total });
          callback(null, chunk);
        },
      });
      await pipeline(response, tracker, writeStream);
    } else {
      await pipeline(response, writeStream);
    }
  };

  const mirrorUrl = resolveAssetDownloadUrl(url);
  if (mirrorUrl !== url) {
    try {
      const response = await request(mirrorUrl);
      await pipeWithProgress(response);
      return;
    } catch {
      try { fs.rmSync(destination, { force: true }); } catch {}
    }
  }
  const response = await request(url);
  await pipeWithProgress(response);
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function macApplicationPath(executablePath) {
  const match = /^(.*\.app)[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/.exec(executablePath);
  if (!match?.[1]) throw new Error(`Could not resolve the macOS application bundle from ${executablePath}`);
  return match[1];
}

function findMacApplication(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const appEntry = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!appEntry) throw new Error("The macOS update archive does not contain an application bundle");
  const application = path.join(root, appEntry.name);
  const executable = path.join(application, "Contents", "MacOS", "Codex Web GPT");
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error("The macOS update archive is incomplete");
  }
  return application;
}

function linuxUpdateInstallation() {
  const guidance = "Quit Codex Web GPT, run install-launcher.sh from the README once, then reopen the installed app. Your settings and browser profile are preserved.";
  const target = process.env.CODEX_WEB_GPT_APPIMAGE?.trim()
    || process.env.APPIMAGE?.trim();
  if (!target || !path.isAbsolute(target)) {
    throw new Error(`The running Linux AppImage path is unavailable. ${guidance}`);
  }
  const wrapper = process.env.CODEX_WEB_GPT_LAUNCHER_EXECUTABLE?.trim();
  if (!wrapper || !path.isAbsolute(wrapper)) {
    throw new Error(`Linux auto-update requires the stable install-launcher.sh wrapper. ${guidance}`);
  }
  return { target, wrapper };
}

function buildJob({ version, platform, executablePath, assetPath, stagingRoot, tempRoot, logPath }) {
  if (platform === "darwin") {
    return {
      version,
      platform,
      parentPid: process.pid,
      tempRoot,
      logPath,
      source: findMacApplication(stagingRoot),
      target: macApplicationPath(executablePath),
    };
  }
  if (platform === "win32") {
    return {
      version,
      platform,
      parentPid: process.pid,
      tempRoot,
      logPath,
      source: assetPath,
      target: executablePath,
    };
  }
  if (platform === "linux") {
    const { target, wrapper } = linuxUpdateInstallation();
    return {
      version,
      platform,
      parentPid: process.pid,
      tempRoot,
      logPath,
      source: assetPath,
      target,
      wrapper,
      runnerSource: path.join(tempRoot, "linux-appimage-runner.sh"),
    };
  }
  throw new Error(`Updates are not supported on ${platform}`);
}

function defaultDependencies() {
  return {
    fetchRelease: async () => JSON.parse(await downloadText(RELEASE_API_URL)),
    downloadText,
    downloadFile,
    sha256,
    extractMac(archive, destination) {
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      const result = spawnSync("/usr/bin/ditto", ["-x", "-k", archive, destination], {
        encoding: "utf8",
        timeout: 120_000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Could not extract the macOS update: ${result.stderr.trim()}`);
    },
    linuxRunnerSource() {
      if (typeof process.resourcesPath === "string" && process.resourcesPath) {
        const unpacked = path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "assets",
          "linux-appimage-runner.sh",
        );
        if (fs.statSync(unpacked, { throwIfNoEntry: false })?.isFile()) return unpacked;
      }
      const source = path.resolve(__dirname, "..", "assets", "linux-appimage-runner.sh");
      if (fs.statSync(source, { throwIfNoEntry: false })?.isFile()) return source;
      throw new Error("Packaged Linux AppImage runner is missing");
    },
    spawnWorker(runtimeExecutable, workerPath, jobPath) {
      return spawn(runtimeExecutable, [workerPath, jobPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    },
  };
}

function createUpdateController({
  currentVersion,
  platform,
  arch,
  packaged,
  executablePath,
  runtimeExecutable,
  logsDirectory,
  publish,
  logger,
  dependencies = {},
}) {
  const deps = { ...defaultDependencies(), ...dependencies };
  const supportedAsset = releaseAssetName(currentVersion, platform, arch);
  let state = packaged && supportedAsset ? { status: "idle" } : { status: "disabled" };
  let checked = false;
  let pending = null;
  let candidate = null;

  const transition = (next) => {
    state = next;
    publish?.(state);
    return state;
  };

  async function checkOnce() {
    if (state.status === "disabled" || checked) return state;
    checked = true;
    transition({ status: "checking" });
    try {
      const release = await deps.fetchRelease();
      // GitHub's /releases/latest already excludes these, including for older launchers.
      if (release?.draft === true || release?.prerelease === true) {
        candidate = null;
        return transition({ status: "up-to-date" });
      }
      const version = releaseVersion(release?.tag_name);
      if (compareVersions(version, currentVersion) <= 0) {
        candidate = null;
        return transition({ status: "up-to-date" });
      }
      const assetName = releaseAssetName(version, platform, arch);
      if (!assetName) return transition({ status: "disabled" });
      const assets = Array.isArray(release?.assets) ? release.assets : [];
      const asset = assets.find((item) => item?.name === assetName);
      const checksums = assets.find((item) => item?.name === "checksums.txt");
      if (!asset?.browser_download_url || !checksums?.browser_download_url) {
        throw new Error(`Release v${version} is missing ${assetName} or checksums.txt`);
      }
      candidate = {
        version,
        assetName,
        assetUrl: validateReleaseAssetUrl(asset.browser_download_url, version, assetName),
        checksumsUrl: validateReleaseAssetUrl(checksums.browser_download_url, version, "checksums.txt"),
      };
      logger?.info("launcher.update_available", { currentVersion, version, platform, arch });
      return transition({ status: "available", version });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn("launcher.update_check_failed", { message });
      return transition({ status: "error", message });
    }
  }

  async function beginInstall() {
    if (pending) throw new Error("An update is already being prepared");
    if (state.status !== "available" || !candidate) throw new Error("No launcher update is available");
    if (platform === "linux") linuxUpdateInstallation();
    const available = candidate;
    pending = (async () => {
      transition({ status: "downloading", version: available.version });
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-update-"));
      try {
        const checksums = await deps.downloadText(available.checksumsUrl);
        const expected = expectedChecksum(checksums, available.assetName);
        const assetPath = path.join(tempRoot, available.assetName);
        let lastPercent = -1;
        await deps.downloadFile(available.assetUrl, assetPath, ({ received, total }) => {
          if (!total || total <= 0) return;
          const percentage = Math.min(100, Math.floor((received / total) * 100));
          if (percentage !== lastPercent) {
            lastPercent = percentage;
            transition({
              status: "downloading",
              version: available.version,
              percentage,
            });
          }
        });
        const actual = deps.sha256(assetPath);
        if (actual !== expected) throw new Error(`SHA-256 verification failed for ${available.assetName}`);

        const stagingRoot = path.join(tempRoot, "stage");
        if (platform === "darwin") deps.extractMac(assetPath, stagingRoot);
        if (platform === "linux") {
          fs.chmodSync(assetPath, 0o755);
          const runnerSource = deps.linuxRunnerSource();
          fs.copyFileSync(runnerSource, path.join(tempRoot, "linux-appimage-runner.sh"));
          fs.chmodSync(path.join(tempRoot, "linux-appimage-runner.sh"), 0o755);
        }

        const workerPath = path.join(tempRoot, "update-worker.cjs");
        fs.copyFileSync(path.join(__dirname, "update-worker.cjs"), workerPath);
        const job = buildJob({
          version: available.version,
          platform,
          executablePath,
          assetPath,
          stagingRoot,
          tempRoot,
          logPath: path.join(logsDirectory, "update-worker.log"),
        });
        const jobPath = path.join(tempRoot, "job.json");
        fs.writeFileSync(jobPath, `${JSON.stringify(job)}\n`, { mode: 0o600 });
        const child = deps.spawnWorker(runtimeExecutable, workerPath, jobPath);
        if (!Number.isInteger(child?.pid) || child.pid <= 0) throw new Error("The update worker did not start");
        child.unref?.();
        logger?.info("launcher.update_worker_started", { pid: child.pid, version: available.version });
        transition({ status: "installing", version: available.version });
        return { child, tempRoot, version: available.version };
      } catch (error) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        transition({ status: "available", version: available.version });
        throw error;
      }
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  }

  function cancelInstall(launch) {
    try { launch?.child?.kill(); } catch {}
    if (launch?.tempRoot) fs.rmSync(launch.tempRoot, { recursive: true, force: true });
    if (candidate) transition({ status: "available", version: candidate.version });
  }

  return {
    getState: () => state,
    checkOnce,
    beginInstall,
    cancelInstall,
  };
}

module.exports = {
  buildJob,
  compareVersions,
  createUpdateController,
  expectedChecksum,
  macApplicationPath,
  parseVersion,
  releaseAssetName,
  releaseVersion,
  resolveAssetDownloadUrl,
  resolveProxyUrl,
  shouldBypassProxy,
  validateReleaseAssetUrl,
};
