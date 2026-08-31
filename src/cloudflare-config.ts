import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import type { CloudflareTunnelConfig } from "./config";

const MAX_CONFIG_BYTES = 1024 * 1024;
export const EXACT_CLOUDFLARE_HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

interface CloudflareConfigDocument extends Record<string, unknown> {
  tunnel: string;
  ingress: Array<Record<string, unknown>>;
}

export interface CloudflareConfigInfo {
  path: string;
  exists: boolean;
  hostnames: string[];
  error: string | null;
}

export interface CloudflareRuntimeConfig {
  path: string;
  tunnel: string;
  hostname: string;
  cleanup(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultCloudflareConfigPath(home = homedir()): string {
  return join(home, ".cloudflared", "config.yml");
}

function resolvedConfigPath(configuredPath: string): string {
  const trimmed = configuredPath.trim();
  if (!trimmed) return defaultCloudflareConfigPath();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith(`~${sep}`)) return join(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

async function readDocument(file: string): Promise<CloudflareConfigDocument> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("Cloudflare config is not a file.");
  if (info.size > MAX_CONFIG_BYTES) throw new Error("Cloudflare config is larger than 1 MiB.");
  const value: unknown = parse(await readFile(file, "utf8"));
  if (!isRecord(value)) throw new Error("Cloudflare config must contain a YAML object.");
  if (typeof value.tunnel !== "string" || !value.tunnel.trim()) {
    throw new Error("Cloudflare config has no tunnel id or name.");
  }
  if (!Array.isArray(value.ingress) || !value.ingress.every(isRecord)) {
    throw new Error("Cloudflare config has no valid ingress rules.");
  }
  return { ...value, tunnel: value.tunnel.trim(), ingress: value.ingress };
}

function selectableRules(document: CloudflareConfigDocument): Array<{ hostname: string; rule: Record<string, unknown> }> {
  const selected: Array<{ hostname: string; rule: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  for (const rule of document.ingress) {
    if (rule.path !== undefined || typeof rule.hostname !== "string") continue;
    const hostname = rule.hostname.trim().toLowerCase();
    if (!EXACT_CLOUDFLARE_HOSTNAME.test(hostname) || seen.has(hostname)) continue;
    seen.add(hostname);
    selected.push({ hostname, rule });
  }
  return selected;
}

export async function inspectCloudflareConfig(configuredPath = ""): Promise<CloudflareConfigInfo> {
  const file = resolvedConfigPath(configuredPath);
  try {
    await access(file, fsConstants.R_OK);
  } catch {
    return {
      path: file,
      exists: false,
      hostnames: [],
      error: configuredPath.trim() ? "The selected Cloudflare config cannot be read." : null,
    };
  }
  try {
    const document = await readDocument(file);
    const hostnames = selectableRules(document).map(entry => entry.hostname);
    return {
      path: file,
      exists: true,
      hostnames,
      error: hostnames.length === 0
        ? "Cloudflare config has no exact hostname ingress rule without a path."
        : null,
    };
  } catch (error) {
    return {
      path: file,
      exists: true,
      hostnames: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveRelativeFileFields(document: CloudflareConfigDocument, sourceFile: string): void {
  for (const key of ["credentials-file", "origincert", "token-file"]) {
    const value = document[key];
    if (typeof value === "string" && value.trim() && !isAbsolute(value)) {
      document[key] = resolve(dirname(sourceFile), value);
    }
  }
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function createCloudflareRuntimeConfig(
  settings: CloudflareTunnelConfig,
  origin: string,
): Promise<CloudflareRuntimeConfig> {
  const info = await inspectCloudflareConfig(settings.configPath);
  if (info.error) throw new Error(info.error);
  if (!info.exists) throw new Error("The selected Cloudflare config cannot be read.");

  const document = await readDocument(info.path);
  const rules = selectableRules(document);
  const hostname = settings.hostname.trim().toLowerCase();
  const selected = rules.find(entry => entry.hostname === hostname);
  if (!selected) throw new Error(`Cloudflare hostname ${JSON.stringify(settings.hostname)} is not in the selected config.`);

  const local = URL.parse(origin);
  if (!local || local.protocol !== "http:" || local.hostname !== "127.0.0.1" || !local.port) {
    throw new Error("The local MCP server returned an invalid loopback URL.");
  }
  const originRequest = isRecord(selected.rule.originRequest) ? selected.rule.originRequest : {};
  resolveRelativeFileFields(document, info.path);
  const { url: _unusedUrl, ...runtimeDocument } = document;
  runtimeDocument.ingress = [
    {
      ...selected.rule,
      hostname,
      path: `^${regexEscape(settings.mcpPath)}(?:/.*)?$`,
      service: local.origin,
      originRequest: { ...originRequest, httpHostHeader: local.host },
    },
    {
      ...selected.rule,
      hostname,
      path: `^/\\.well-known/(?:oauth-protected-resource|oauth-authorization-server)${regexEscape(settings.mcpPath)}/?$`,
      service: local.origin,
      originRequest: { ...originRequest, httpHostHeader: local.host },
    },
    { service: "http_status:404" },
  ];

  const directory = await mkdtemp(join(tmpdir(), "codex-chatgpt-web-cloudflared-"));
  const runtimePath = join(directory, "config.yml");
  try {
    await writeFile(runtimePath, stringify(runtimeDocument), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path: runtimePath,
    tunnel: document.tunnel,
    hostname,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
