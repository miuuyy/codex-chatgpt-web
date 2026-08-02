/**
 * OpenCodex compatibility layer.
 *
 * When opencodex (https://github.com/lidge-jun/opencodex) is running locally, codex-chatgpt-web
 * routes native Codex passthrough requests through it instead of directly to the ChatGPT backend.
 * This gives users access to opencodex's full multi-provider routing (Anthropic, Google, xAI,
 * DeepSeek, Kimi, Ollama, etc.) for non-chatgpt-web models, while chatgpt-web models continue
 * to run through the embedded browser.
 *
 * Detection is passive and fail-open: if opencodex is unreachable, the bridge falls back to the
 * direct ChatGPT backend transparently.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OPENCODEX_DEFAULT_PORT = 10100;
export const OPENCODEX_HEALTH_PATH = "/healthz";
export const OPENCODEX_SERVICE_IDENTITY = "opencodex";

/** Marker opencodex writes above its managed openai_base_url line in config.toml. */
export const OPENCODEX_CONFIG_MARKER = "# Auto-injected by opencodex";

export interface OpenCodexUpstream {
  /** Base URL of the opencodex proxy, e.g. "http://127.0.0.1:10100". */
  baseUrl: string;
  /** Version reported by the opencodex healthz endpoint. */
  version?: string;
  /** PID of the running opencodex proxy. */
  pid?: number;
}

export interface OpenCodexHealthResponse {
  status?: string;
  service?: string;
  version?: string;
  uptime?: number;
  pid?: number;
  port?: number;
}

let cachedUpstream: OpenCodexUpstream | null | undefined;
let lastProbeAt = 0;
const PROBE_COOLDOWN_MS = 30_000;

/**
 * Probe the opencodex proxy health endpoint. Returns the upstream descriptor if a live opencodex
 * instance responds, or null if unreachable or not opencodex.
 */
export async function probeOpenCodex(
  port: number = OPENCODEX_DEFAULT_PORT,
  hostname: string = "127.0.0.1",
  timeoutMs: number = 2_000,
): Promise<OpenCodexUpstream | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${hostname}:${port}${OPENCODEX_HEALTH_PATH}`, {
      signal: controller.signal,
      headers: { "accept": "application/json" },
    });
    if (!response.ok) return null;
    const body = await response.json() as OpenCodexHealthResponse;
    if (body.service !== OPENCODEX_SERVICE_IDENTITY) return null;
    if (body.status !== "ok") return null;
    return {
      baseUrl: `http://${hostname}:${port}`,
      version: typeof body.version === "string" ? body.version : undefined,
      pid: typeof body.pid === "number" ? body.pid : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cached probe with a cooldown to avoid hammering the health endpoint on every request.
 * Returns the cached upstream if still fresh, re-probes if stale, or null if unavailable.
 */
export async function resolveOpenCodexUpstream(
  configuredUrl?: string,
): Promise<OpenCodexUpstream | null> {
  // If explicitly configured, use it directly without probing every time.
  if (configuredUrl) {
    const parsed = new URL(configuredUrl);
    const port = parsed.port ? Number(parsed.port) : OPENCODEX_DEFAULT_PORT;
    const hostname = parsed.hostname || "127.0.0.1";
    const normalizedBase = `http://${hostname}:${port}`;
    if (cachedUpstream && cachedUpstream.baseUrl === normalizedBase) return cachedUpstream;
    const probed = await probeOpenCodex(port, hostname);
    cachedUpstream = probed;
    lastProbeAt = Date.now();
    return probed;
  }

  // Auto-detect with cooldown.
  const now = Date.now();
  if (cachedUpstream !== undefined && now - lastProbeAt < PROBE_COOLDOWN_MS) {
    return cachedUpstream;
  }
  const probed = await probeOpenCodex();
  cachedUpstream = probed;
  lastProbeAt = now;
  return probed;
}

/** Reset the cached probe state (for testing). */
export function resetOpenCodexCache(): void {
  cachedUpstream = undefined;
  lastProbeAt = 0;
}

/**
 * Detect whether opencodex currently owns the Codex config.toml routing.
 * Returns the opencodex base URL if its marker is present, or null.
 */
export function detectOpenCodexConfigOwnership(codexConfigPath?: string): string | null {
  const configPath = codexConfigPath ?? join(homedir(), ".codex", "config.toml");
  if (!existsSync(configPath)) return null;
  const content = readFileSync(configPath, "utf8");
  if (!content.includes(OPENCODEX_CONFIG_MARKER)) return null;
  // Extract the openai_base_url that opencodex set.
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(OPENCODEX_CONFIG_MARKER)) {
      // The URL line should be immediately after the marker.
      const nextLine = lines[i + 1] ?? "";
      const match = /^\s*openai_base_url\s*=\s*["']([^"']+)["']/.exec(nextLine);
      if (match?.[1]) return match[1];
    }
  }
  return null;
}

/**
 * Build the opencodex Responses API URL for a given endpoint.
 */
export function openCodexEndpointUrl(upstream: OpenCodexUpstream, endpoint: string): string {
  return `${upstream.baseUrl}/v1/${endpoint}`;
}

/**
 * Fetch the model catalog from a running opencodex instance.
 * Returns the raw models array or null on failure.
 */
export async function fetchOpenCodexModels(
  upstream: OpenCodexUpstream,
  authorization?: string,
  timeoutMs: number = 5_000,
): Promise<Record<string, unknown>[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "accept": "application/json" };
    if (authorization) headers["authorization"] = authorization;
    const response = await fetch(`${upstream.baseUrl}/v1/models`, {
      signal: controller.signal,
      headers,
    });
    if (!response.ok) return null;
    const body = await response.json() as { models?: unknown[] };
    if (!Array.isArray(body.models)) return null;
    return body.models as Record<string, unknown>[];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
