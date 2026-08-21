import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

interface PackageJson {
  name?: string;
  version?: string;
  license?: string | { type?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const root = resolve(import.meta.dir, "..");
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson;
const argumentsList = process.argv.slice(2);
const includeLauncher = argumentsList.includes("--include-launcher");
const destinationArgument = argumentsList.find(argument => argument !== "--include-launcher");
const visited = new Map<string, { directory: string; manifest: PackageJson }>();
const bundledLicenseOverrides = new Map([
  ["tiktoken@1.0.22", join(root, "LICENSES", "tiktoken-MIT.txt")],
]);

function packageDirectory(name: string, from: string): string | undefined {
  let cursor = from;
  for (;;) {
    const candidate = join(cursor, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return undefined;
}

function visit(name: string, from: string, optional = false): void {
  const directory = packageDirectory(name, from);
  if (!directory) {
    if (optional) return;
    throw new Error(`Installed runtime dependency is missing: ${name} (from ${from})`);
  }
  if (visited.has(directory)) return;
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as PackageJson;
  if (!manifest.name || !manifest.version || !manifest.license) throw new Error(`Incomplete package metadata: ${directory}`);
  visited.set(directory, { directory, manifest });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, directory);
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) visit(dependency, directory, true);
}

for (const dependency of Object.keys(rootPackage.dependencies ?? {})) visit(dependency, root);
if (includeLauncher) {
  const launcherRoot = join(root, "launcher");
  const launcherPackage = JSON.parse(readFileSync(join(launcherRoot, "package.json"), "utf8")) as PackageJson;
  for (const dependency of Object.keys(launcherPackage.dependencies ?? {})) visit(dependency, launcherRoot);
}

function licenseFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter(name => /^(licen[cs]e|copying|notice)(?:\..*)?$/i.test(name))
    .filter(name => statSync(join(directory, name)).isFile())
    .sort();
}

const sections = [...visited.values()]
  .sort((a, b) => `${a.manifest.name}@${a.manifest.version}`.localeCompare(`${b.manifest.name}@${b.manifest.version}`))
  .map(({ directory, manifest }) => {
    const files = licenseFiles(directory);
    const identity = `${manifest.name}@${manifest.version}`;
    const override = bundledLicenseOverrides.get(identity);
    if (files.length === 0 && !override) throw new Error(`No license/notice file found for ${identity}`);
    if (override && !existsSync(override)) throw new Error(`Bundled license override is missing for ${identity}`);
    const license = typeof manifest.license === "string" ? manifest.license : manifest.license?.type ?? "unknown";
    return [
      "=".repeat(80),
      `${identity} (${license})`,
      ...(override
        ? ["-".repeat(80), `bundled license: ${override.slice(root.length + 1)}`, "-".repeat(80), readFileSync(override, "utf8").trim()]
        : files.flatMap(file => ["-".repeat(80), file, "-".repeat(80), readFileSync(join(directory, file), "utf8").trim()])),
    ].join("\n");
  });

const bunLicense = readFileSync(join(root, "LICENSES", "Bun.md"), "utf8").trim();
const embeddedBunVersion = process.env.CODEX_CHATGPT_WEB_EMBEDDED_BUN_REVISION
  ?? process.env.CODEX_CHATGPT_WEB_EMBEDDED_BUN_VERSION
  ?? Bun.version;
const output = [
  "codex-chatgpt-web third-party notices",
  "",
  "This file covers runtime JavaScript packages bundled into the standalone executable.",
  `The executable also embeds Bun ${embeddedBunVersion}; Bun's licensing and relinking notice follows first.`,
  "",
  "=".repeat(80),
  `Bun ${embeddedBunVersion} runtime`,
  "=".repeat(80),
  bunLicense,
  "",
  ...sections,
  "",
].join("\n");

const destination = resolve(destinationArgument ?? join(root, "dist", "THIRD_PARTY_NOTICES.txt"));
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, output);
process.stdout.write(`Wrote ${destination} (${visited.size} runtime packages)\n`);
