import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version?: string;
  packageManager?: string;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
};
const packageVersion = packageJson.version;
if (!packageVersion) throw new Error("package.json has no version");
const packageManagerMatch = /^bun@(\d+\.\d+\.\d+)$/.exec(packageJson.packageManager ?? "");
if (!packageManagerMatch) throw new Error("package.json must pin an exact Bun packageManager version");
const bunVersion = packageManagerMatch[1];
if (Bun.version !== bunVersion) throw new Error(`Expected Bun ${bunVersion}, received ${Bun.version}`);
if (packageJson.devDependencies?.["@types/bun"] !== bunVersion) {
  throw new Error(`@types/bun is not synchronized to ${bunVersion}`);
}
if (packageJson.engines?.bun !== bunVersion) throw new Error(`engines.bun is not synchronized to ${bunVersion}`);
const expected = [
  ["src/version.ts", `export const VERSION = ${JSON.stringify(packageVersion)};`],
  ["scripts/install.sh", `VERSION=\"\${CODEX_CHATGPT_WEB_VERSION:-${packageVersion}}\"`],
  ["README.md", `requires Bun ${bunVersion}.`],
  ["README.zh-CN.md", `Bun ${bunVersion}`],
  ["scripts/install.sh", `Bun-${bunVersion}.md`],
  ["scripts/generate-third-party-notices.ts", `Bun ${bunVersion}`],
  ["scripts/prepare-windows-baseline-bun.ps1", `bun-v$Version`],
  [".github/workflows/ci.yml", `bun-version: ${bunVersion}`],
  [".github/workflows/ci.yml", `-Version ${bunVersion}`],
  [".github/workflows/release.yml", `Bun-${bunVersion}.md`],
  [".github/workflows/release.yml", `-Version ${bunVersion}`],
] as const;
for (const [path, needle] of expected) {
  if (!readFileSync(resolve(root, path), "utf8").includes(needle)) throw new Error(`${path} is not synchronized to ${packageVersion}`);
}
const releaseWorkflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
if (releaseWorkflow.split(`bun-version: ${bunVersion}`).length - 1 !== 2) {
  throw new Error(`release.yml must pin Bun ${bunVersion} in both jobs`);
}
const launcherVersion = (JSON.parse(readFileSync(resolve(root, "launcher/package.json"), "utf8")) as { version?: string }).version;
if (launcherVersion !== packageVersion) throw new Error(`launcher/package.json is not synchronized to ${packageVersion}`);
process.stdout.write(`VERSION_SYNC_OK ${packageVersion} bun@${bunVersion}\n`);
