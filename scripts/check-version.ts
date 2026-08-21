import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version?: string;
  packageManager?: string;
  engines?: Record<string, string>;
};
const packageVersion = packageJson.version;
if (!packageVersion) throw new Error("package.json has no version");
const packageManagerMatch = /^bun@((\d+\.\d+\.\d+)\+([0-9a-f]+))$/.exec(packageJson.packageManager ?? "");
if (!packageManagerMatch) throw new Error("package.json must pin an exact Bun stable revision");
const bunRevision = packageManagerMatch[1];
const bunVersion = packageManagerMatch[2];
const revision = Bun.spawnSync([process.execPath, "--revision"], { stdout: "pipe", stderr: "pipe" });
const reportedRevision = revision.stdout.toString().trim();
if (revision.exitCode !== 0 || Bun.version !== bunVersion || reportedRevision !== bunRevision) {
  throw new Error(`Expected Bun ${bunRevision}, received ${reportedRevision || Bun.version}`);
}
if (packageJson.engines?.bun !== `>=${bunVersion}`) throw new Error(`engines.bun is not synchronized to ${bunVersion}`);
const expected = [
  ["src/version.ts", `export const VERSION = ${JSON.stringify(packageVersion)};`],
  ["scripts/install.sh", `VERSION=\"\${CODEX_CHATGPT_WEB_VERSION:-${packageVersion}}\"`],
  ["README.md", `requires Bun ${bunRevision}.`],
  ["scripts/install.sh", "Bun.md"],
  ["scripts/generate-third-party-notices.ts", "CODEX_CHATGPT_WEB_EMBEDDED_BUN_VERSION"],
  ["scripts/prepare-windows-baseline-bun.ps1", `bun-v$Version`],
  [".github/workflows/ci.yml", `bun-version: ${bunVersion}`],
  [".github/workflows/release.yml", "Bun.md"],
] as const;
for (const [path, needle] of expected) {
  if (!readFileSync(resolve(root, path), "utf8").includes(needle)) throw new Error(`${path} is not synchronized to ${packageVersion}`);
}
const releaseWorkflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
if (releaseWorkflow.split(`bun-version: ${bunVersion}`).length - 1 !== 2) {
  throw new Error("release.yml must use the pinned Bun stable version in both jobs");
}
const launcherVersion = (JSON.parse(readFileSync(resolve(root, "launcher/package.json"), "utf8")) as { version?: string }).version;
if (launcherVersion !== packageVersion) throw new Error(`launcher/package.json is not synchronized to ${packageVersion}`);
process.stdout.write(`VERSION_SYNC_OK ${packageVersion} bun@${bunRevision}\n`);
