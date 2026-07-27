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
  target: "bun",
  minify: true,
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
cpSync(realpathSync(process.execPath), join(runtimeDir, "bun"));
chmodSync(join(runtimeDir, "bun"), 0o755);

const launcher = `#!/bin/sh
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
writeFileSync(join(binDir, "codex-chatgpt-web"), launcher, { mode: 0o755 });
chmodSync(join(binDir, "codex-chatgpt-web"), 0o755);

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
if (packageJson.version !== VERSION) throw new Error("package.json and runtime version are out of sync");
writeFileSync(join(output, "manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  appVersion: VERSION,
  bunVersion: Bun.version,
  platform: process.platform,
  arch: process.arch,
  browserTransport: "chrome-devtools",
  launcher: "bin/codex-chatgpt-web",
  entrypoint: "app/cli.js",
}, null, 2)}\n`);

process.stdout.write(`${output}\n`);
