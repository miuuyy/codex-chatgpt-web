import { chmodSync, copyFileSync, cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VERSION } from "../src/version";

const root = resolve(import.meta.dir, "..");
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
  target: process.platform === "win32" ? "node" : "bun",
  minify: true,
  external: ["playwright-core"],
  packages: "external",
  outdir: appDir,
  naming: "cli.js",
});
if (!build.success) {
  throw new Error(`Runtime bundle failed: ${build.logs.map(log => log.message).join("; ")}`);
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
const runtimeName = process.platform === "win32" ? "node.exe" : "bun";
let runtimeSource = realpathSync(process.execPath);
if (process.platform === "win32") {
  const located = Bun.spawnSync(["where.exe", "node.exe"], { stdout: "pipe", stderr: "pipe" });
  const first = located.stdout.toString().split(/\r?\n/).find(Boolean);
  if (located.exitCode !== 0 || !first) throw new Error("Windows runtime build requires node.exe on PATH");
  runtimeSource = realpathSync(first);
}
cpSync(runtimeSource, join(runtimeDir, runtimeName));
if (process.platform !== "win32") chmodSync(join(runtimeDir, runtimeName), 0o755);

const posixLauncher = `#!/bin/sh
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
const windowsLauncher = `@echo off\r
setlocal\r
set "CODEX_CHATGPT_WEB_LAUNCHER=%~f0"\r
"%~dp0..\\runtime\\node.exe" "%~dp0..\\app\\cli.js" %*\r
`;
const launcherName = process.platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web";
writeFileSync(join(binDir, launcherName), process.platform === "win32" ? windowsLauncher : posixLauncher, { mode: 0o755 });
if (process.platform === "win32") {
  copyFileSync(join(root, "scripts", "windows-route.ps1"), join(binDir, "windows-route.ps1"));
} else {
  chmodSync(join(binDir, launcherName), 0o755);
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
if (packageJson.version !== VERSION) throw new Error("package.json and runtime version are out of sync");
const playwrightPackage = join(appDir, "node_modules", "playwright-core", "package.json");
writeFileSync(join(output, "manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  appVersion: VERSION,
  bunVersion: Bun.version,
  platform: process.platform,
  arch: process.arch,
  launcher: `bin/${launcherName}`,
  entrypoint: "app/cli.js",
  playwright: JSON.parse(readFileSync(playwrightPackage, "utf8")).version,
}, null, 2)}\n`);

process.stdout.write(`${output}\n`);
