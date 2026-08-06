import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const defaultEntryPoint = join(root, "src", "adapters", "chatgpt-web", "browser-helper-main.ts");
const defaultOutput = join(root, ".launcher-runtime", "browser-helper.cjs");

export async function buildBrowserHelperBundle(entrypoint: string, output: string): Promise<void> {
  mkdirSync(dirname(output), { recursive: true });
  rmSync(output, { force: true });
  const build = await Bun.build({
    entrypoints: [entrypoint],
    target: "node",
    format: "cjs",
    minify: true,
    packages: "external",
    external: ["playwright-core"],
    outdir: dirname(output),
    naming: basename(output),
  });
  if (!build.success) {
    throw new Error(`Browser helper build failed: ${build.logs.map(log => log.message).join("; ")}`);
  }
  if (process.platform !== "win32") chmodSync(output, 0o755);
}

export async function watchBrowserHelperBundle(
  entrypoint: string,
  output: string,
  abortSignal?: AbortSignal,
): Promise<number> {
  mkdirSync(dirname(output), { recursive: true });
  const watcher = spawn(process.execPath, [
    "build",
    entrypoint,
    "--target=node",
    "--format=cjs",
    "--minify",
    "--packages=external",
    "--external=playwright-core",
    `--outfile=${output}`,
    "--watch",
    "--no-clear-screen",
  ], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  return await new Promise<number>((resolveExit, rejectExit) => {
    const stop = () => watcher.kill("SIGTERM");
    const cleanup = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      abortSignal?.removeEventListener("abort", stop);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    abortSignal?.addEventListener("abort", stop, { once: true });
    if (abortSignal?.aborted) stop();
    watcher.once("error", error => {
      cleanup();
      rejectExit(error);
    });
    watcher.once("exit", (code, signal) => {
      cleanup();
      resolveExit(signal ? 1 : code ?? 1);
    });
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const output = resolve(args.find(argument => argument !== "--watch") ?? defaultOutput);
  if (args.includes("--watch")) {
    process.exitCode = await watchBrowserHelperBundle(defaultEntryPoint, output);
  } else {
    await buildBrowserHelperBundle(defaultEntryPoint, output);
    process.stdout.write(`${output}\n`);
  }
}
