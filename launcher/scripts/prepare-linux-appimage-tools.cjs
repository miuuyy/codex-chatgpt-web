const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Arch } = require("builder-util");
const { getAppImageTools } = require("app-builder-lib/out/toolsets/linux.js");

const REQUIRED_LIBNOTIFY_SYMBOL = "notify_notification_get_activation_app_launch_context";

function requireLibnotifySymbol(libraryPath) {
  const result = spawnSync("nm", ["-D", "--defined-only", libraryPath], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not inspect ${libraryPath}: ${result.stderr.trim() || `nm exited ${result.status}`}`);
  }
  if (!result.stdout.split(/\r?\n/).some((line) => (
    line.trim().split(/\s+/).at(-1) === REQUIRED_LIBNOTIFY_SYMBOL
  ))) {
    throw new Error(`${libraryPath} does not export ${REQUIRED_LIBNOTIFY_SYMBOL}`);
  }
}

function assertInside(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`AppImage toolset library target escapes its owned root: ${target}`);
  }
}

function replaceToolsetLibnotify(toolsetRoot, source) {
  const libraryLink = path.join(toolsetRoot, "lib", "x64", "libnotify.so.4");
  const metadata = fs.lstatSync(libraryLink, { throwIfNoEntry: false });
  if (!metadata) throw new Error(`AppImage toolset contains no ${libraryLink}`);
  const replacement = metadata.isSymbolicLink()
    ? path.resolve(path.dirname(libraryLink), fs.readlinkSync(libraryLink))
    : libraryLink;
  assertInside(toolsetRoot, replacement);
  if (!fs.statSync(replacement, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`AppImage toolset libnotify target is not a file: ${replacement}`);
  }
  fs.copyFileSync(source, replacement);
  fs.chmodSync(replacement, 0o755);
  requireLibnotifySymbol(libraryLink);
  return libraryLink;
}

function resolvePreparedAppImageTools(env = process.env, defaultRoot = path.join(__dirname, "..", "build", "appimage-tools")) {
  const toolsetRoot = path.resolve(env.APPIMAGE_TOOLS_PATH?.trim() || defaultRoot);
  const library = path.join(toolsetRoot, "lib", "x64", "libnotify.so.4");
  if (!fs.statSync(library, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      `No prepared AppImage libnotify found at ${library}. Run scripts/prepare-linux-libnotify.sh, then `
      + "launcher/scripts/prepare-linux-appimage-tools.cjs with CODEX_WEB_GPT_LINUX_LIBNOTIFY set to the built library.",
    );
  }
  requireLibnotifySymbol(library);
  return toolsetRoot;
}

async function main() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Codex Web GPT AppImage tool preparation requires Linux x64");
  }
  const source = process.env.CODEX_WEB_GPT_LINUX_LIBNOTIFY?.trim();
  if (!source || !path.isAbsolute(source) || !fs.statSync(source, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(
      "AppImage tool preparation requires CODEX_WEB_GPT_LINUX_LIBNOTIFY from scripts/prepare-linux-libnotify.sh",
    );
  }
  requireLibnotifySymbol(source);

  const tools = await getAppImageTools("0.0.0", Arch.x64);
  const downloadedRoot = path.dirname(path.dirname(tools.runtimeLibraries));
  const outputRoot = path.resolve(
    process.env.CODEX_WEB_GPT_APPIMAGE_TOOLS_OUTPUT
      || path.join(__dirname, "..", "build", "appimage-tools"),
  );
  if (downloadedRoot === outputRoot) throw new Error("AppImage toolset output must not replace the shared download cache");
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.cpSync(downloadedRoot, outputRoot, {
    recursive: true,
    force: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  replaceToolsetLibnotify(outputRoot, source);

  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `APPIMAGE_TOOLS_PATH=${outputRoot}\n`);
  }
  process.stdout.write(`${outputRoot}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  REQUIRED_LIBNOTIFY_SYMBOL,
  replaceToolsetLibnotify,
  requireLibnotifySymbol,
  resolvePreparedAppImageTools,
};
