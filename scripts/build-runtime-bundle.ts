import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { VERSION } from "../src/version";

const root = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version?: string;
  packageManager?: string;
};
if (packageJson.version !== VERSION) throw new Error("package.json and runtime version are out of sync");
const packageManagerMatch = /^bun@((\d+\.\d+\.\d+)\+[0-9a-f]+)$/.exec(packageJson.packageManager ?? "");
if (!packageManagerMatch) throw new Error("package.json must pin an exact Bun stable revision");
const expectedBunRevision = packageManagerMatch[1];
const expectedBunVersion = packageManagerMatch[2];
const buildRevision = Bun.spawnSync([process.execPath, "--revision"], { stdout: "pipe", stderr: "pipe" });
const reportedBuildRevision = buildRevision.stdout.toString().trim();
if (buildRevision.exitCode !== 0 || Bun.version !== expectedBunVersion || reportedBuildRevision !== expectedBunRevision) {
  throw new Error(`Runtime bundle requires Bun ${expectedBunRevision}, received ${reportedBuildRevision || Bun.version}`);
}

type EmbeddedBun = { executable: string; version: string; revision: string };

function embeddedBunRuntime(): EmbeddedBun {
  const configured = process.env.CODEX_CHATGPT_WEB_EMBEDDED_BUN;
  if (configured && !isAbsolute(configured)) {
    throw new Error("CODEX_CHATGPT_WEB_EMBEDDED_BUN must be an absolute path");
  }
  const executable = realpathSync(configured || process.execPath);
  const version = Bun.spawnSync([executable, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (version.exitCode !== 0) {
    throw new Error(`Embedded Bun validation failed: ${version.stderr.toString() || version.stdout.toString()}`);
  }
  const revision = Bun.spawnSync([executable, "--revision"], { stdout: "pipe", stderr: "pipe" });
  if (revision.exitCode !== 0) {
    throw new Error(`Embedded Bun revision failed: ${revision.stderr.toString() || revision.stdout.toString()}`);
  }
  const reportedVersion = version.stdout.toString().trim();
  const reportedRevision = revision.stdout.toString().trim();
  if (reportedVersion !== expectedBunVersion || reportedRevision !== expectedBunRevision) {
    throw new Error(
      `Embedded Bun must be ${expectedBunRevision}; received ${reportedRevision || reportedVersion || "no version"}`,
    );
  }
  return { executable, version: reportedVersion, revision: reportedRevision };
}
const embeddedBun = embeddedBunRuntime();
const output = resolve(process.argv[2] ?? join(root, "dist", "runtime"));
const appDir = join(output, "app");
const runtimeDir = join(output, "runtime");
const binDir = join(output, "bin");

rmSync(output, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

const build = await Bun.build({
  entrypoints: [join(root, "src", "cli.ts")],
  target: "bun",
  minify: true,
  external: ["playwright-core"],
  packages: "external",
  outdir: appDir,
  naming: "cli.js",
});
if (!build.success) {
  throw new Error(`Runtime bundle failed: ${build.logs.map(log => log.message).join("; ")}`);
}

const browserHelperBuild = await Bun.build({
  entrypoints: [join(root, "src", "adapters", "chatgpt-web", "browser-helper-main.ts")],
  target: "node",
  format: "cjs",
  minify: true,
  external: ["playwright-core"],
  packages: "external",
  outdir: appDir,
  naming: "browser-helper.cjs",
});
if (!browserHelperBuild.success) {
  throw new Error(`Browser helper bundle failed: ${browserHelperBuild.logs.map(log => log.message).join("; ")}`);
}

copyFileSync(join(root, "package.json"), join(appDir, "package.json"));
copyFileSync(join(root, "bun.lock"), join(appDir, "bun.lock"));
const install = Bun.spawnSync([process.execPath, "install", "--production", "--frozen-lockfile", "--ignore-scripts"], {
  cwd: appDir,
  stdout: "pipe",
  stderr: "pipe",
});
if (install.exitCode !== 0) {
  throw new Error(`Runtime dependencies failed to install: ${install.stderr.toString() || install.stdout.toString()}`);
}
const bunName = process.platform === "win32" ? "bun.exe" : "bun";
cpSync(embeddedBun.executable, join(runtimeDir, bunName));
if (process.platform !== "win32") chmodSync(join(runtimeDir, bunName), 0o755);

const launcherName = process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web";
const launcher = process.platform === "win32" ? `@echo off
setlocal
chcp 65001 >nul
set "ROOT=%~dp0.."
set "CODEX_CHATGPT_WEB_LAUNCHER=%~f0"
"%ROOT%\\runtime\\bun.exe" "%ROOT%\\app\\cli.js" %*
` : `#!/bin/sh
set -eu
invoked="$0"
case "$invoked" in
  /*) ;;
  *) invoked="$(command -v -- "$invoked")" ;;
esac
script="$invoked"
while [ -L "$script" ]; do
  target="$(readlink "$script")"
  case "$target" in
    /*) script="$target" ;;
    *) script="$(dirname "$script")/$target" ;;
  esac
done
bin_dir="$(CDPATH= cd -- "$(dirname "$script")" && pwd -P)"
root="$(CDPATH= cd -- "$bin_dir/.." && pwd -P)"
export CODEX_CHATGPT_WEB_LAUNCHER="$invoked"
exec "$root/runtime/bun" "$root/app/cli.js" "$@"
`;
writeFileSync(join(binDir, launcherName), launcher, process.platform === "win32" ? undefined : { mode: 0o755 });
if (process.platform !== "win32") chmodSync(join(binDir, launcherName), 0o755);

const playwrightPackage = join(appDir, "node_modules", "playwright-core", "package.json");
const bundleId = createHash("sha256");
for (const relativePath of ["app/cli.js", "app/browser-helper.cjs", "app/package.json", "app/bun.lock", `runtime/${bunName}`]) {
  bundleId.update(relativePath);
  bundleId.update("\0");
  bundleId.update(readFileSync(join(output, relativePath)));
  bundleId.update("\0");
}
writeFileSync(join(output, "manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  appVersion: VERSION,
  bundleId: bundleId.digest("hex"),
  bunVersion: embeddedBun.version,
  bunRevision: embeddedBun.revision,
  platform: process.platform,
  arch: process.arch,
  launcher: `bin/${launcherName}`,
  entrypoint: "app/cli.js",
  playwright: JSON.parse(readFileSync(playwrightPackage, "utf8")).version,
}, null, 2)}\n`);

process.stdout.write(`${output}\n`);
