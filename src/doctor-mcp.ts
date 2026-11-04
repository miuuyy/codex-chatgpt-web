import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  atomicWriteFile, getConfigDir, type AppConfig,
} from "./config";
import {
  closeSync, existsSync, mkdtempSync, openSync, readFileSync, readSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DoctorCheck } from "./doctor";

const PROOF_TIMEOUT_MS = 120_000;
const PROOF_MAX_AGE_MS = 5 * 60_000;
const PROOF_LOG_LIMIT = 4 * 1024 * 1024;
const BROKER_LOG_LIMIT = 1024 * 1024;
const HEX_SHA256 = /^[a-f0-9]{64}$/i;

type ProbeEvent = { type?: string; item?: Record<string, unknown> };
type ProofRecord = {
  version: 1;
  appName: string;
  tunnelId: string;
  daemonPid: number;
  observedAt: number;
  proofSha256: string;
};

function normalized(value: string): string {
  return value.replaceAll("/", "\\").replace(/\\{2,}/g, "\\").toLowerCase();
}

/** A model statement is never sufficient. The native tool, response and MCP broker must all agree. */
export function assessMcpProof(
  events: ProbeEvent[], expectedHash: string, probePath: string, brokerVerified: boolean,
): boolean {
  if (!brokerVerified || !HEX_SHA256.test(expectedHash) || !probePath || !Array.isArray(events)) return false;
  const expected = expectedHash.toLowerCase();
  let foundTool = false;
  let foundAnswer = false;
  for (const event of events) {
    if (event?.type !== "item.completed" || !event.item) continue;
    const item = event.item;
    const kind = String(item.type ?? "").toLowerCase().replaceAll("_", "");
    if (kind === "commandexecution") {
      const command = String(item.command ?? "");
      const output = String(item.aggregated_output ?? "");
      const probeIsReadOnly = /Get-FileHash|sha256sum|shasum\s+-a\s+256/i.test(command);
      const requestedPath = normalized(command).includes(normalized(probePath))
      const outputMatches = output.toLowerCase().split(/[^a-f0-9]+/i).includes(expected);
      if (item.exit_code === 0 && probeIsReadOnly && requestedPath && outputMatches) foundTool = true;
    }
    if (kind === "agentmessage" && typeof item.text === "string") {

      if (item.text.toLowerCase().includes(expected)) foundAnswer = true;
    }
  }
  return foundTool && foundAnswer;
}

type BrokerRound = { trace: string; call: string };
type RetiredRound = { traceId?: string; pendingTools?: number; activeMcpRequests?: number; completionCommitted?: boolean };

/** Only new, committed browser-MCP broker traffic counts; old healthy tunnel inventories do not. */
export function assessBrokerMcpProof(records: string[], startedAtMs: number): boolean {
  const queued: BrokerRound[] = [];
  const delivered: BrokerRound[] = [];
  const retired: RetiredRound[] = [];
  for (const record of records) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(record) as Record<string, unknown>; } catch { continue; }
    const at = Date.parse(String(event.at ?? ""));
    if (!Number.isFinite(at) || at < startedAtMs || event.event !== "runtime.daemon_stdout") continue;
    const detail = event.detail as Record<string, unknown> | undefined;
    const line = typeof detail?.line === "string" ? detail.line : "";
    const queue = /\bbroker trace=([A-Za-z0-9_-]+) queued call=(call_[A-Za-z0-9_-]+) tool=exec_command\b/.exec(line);
    if (queue) queued.push({ trace: queue[1]!, call: queue[2]! });
    const delivery = /\bbroker trace=([A-Za-z0-9_-]+) delivered call=(call_[A-Za-z0-9_-]+)\b/.exec(line);
    if (delivery) delivered.push({ trace: delivery[1]!, call: delivery[2]! });
    const retirement = /\bbroker_retired\s+(\{.+\})/.exec(line);
    if (retirement) {
      try { retired.push(JSON.parse(retirement[1]!) as RetiredRound); } catch { /* invalid evidence */ }
    }
  }
  if (queued.length !== 1 || delivered.length !== 1 || retired.length !== 1) return false;
  return queued[0]!.trace === delivered[0]!.trace
    && queued[0]!.call === delivered[0]!.call
    && retired[0]!.traceId === queued[0]!.trace
    && retired[0]!.pendingTools === 0
    && retired[0]!.activeMcpRequests === 0
    && retired[0]!.completionCommitted === true;
}

function proofFile(): string {
  return join(getConfigDir(), "runtime", "doctor-mcp-e2e.json");
}

export function validMcpProof(
  record: unknown, config: AppConfig, daemonPid: unknown, now = Date.now(),
): record is ProofRecord {
  if (!record || typeof record !== "object") return false;
  const value = record as Partial<ProofRecord>;
  return value.version === 1 && config.mode === "full"
    && value.appName === config.appName
    && value.tunnelId === config.tunnel?.tunnelId
    && Number.isInteger(daemonPid)
    && daemonPid === value.daemonPid
    && Number.isFinite(value.observedAt)
    && now >= Number(value.observedAt)
    && now - Number(value.observedAt) <= PROOF_MAX_AGE_MS
    && typeof value.proofSha256 === "string"
    && HEX_SHA256.test(value.proofSha256);
}

export function cachedMcpConnectorCheck(config: AppConfig, daemonPid: unknown): DoctorCheck {
  let proof: unknown;
  try {
    if (existsSync(proofFile())) proof = JSON.parse(readFileSync(proofFile(), "utf8"));
  } catch {
    // Corrupt or stale evidence may never become a successful diagnostic.
  }
  if (validMcpProof(proof, config, daemonPid)) {
    return {
      id: "connector", status: "ok",
      message: "Codex Native MCP end-to-end tool execution was verified recently",
      detail: "Observed at " + new Date(proof.observedAt).toISOString() + "; bound to this tunnel and daemon PID",
    };
  }
  return {
    id: "connector", status: "warning",
    message: "No current end-to-end MCP tool execution proof is available for this connector",
    detail: "Use Doctor --verify-mcp while idle to run a bounded read-only connector probe.",
  };
}

/** Same log Electron's launcher writes. An absent log means E2E verification is unavailable, not green. */
function launcherLogPath(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Codex Web GPT", "logs", "launcher.jsonl");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Logs", "Codex Web GPT", "launcher.jsonl");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Codex Web GPT", "logs", "launcher.jsonl");
}

function newBrokerRecords(path: string, offset: number): string[] {
  const size = statSync(path).size;
  const length = size - offset;
  if (length < 0 || length > BROKER_LOG_LIMIT) throw new Error("BROKER_LOG_CHANGED_OR_OVERFLOW");
  if (length === 0) return [];
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    let count = 0;
    while (count < length) {
      const read = readSync(fd, buffer, count, length - count, offset + count);
      if (!read) break;
      count += read;
    }
    return buffer.subarray(0, count).toString("utf8").split(/\r?\n/);
  } finally { closeSync(fd); }
}

/** The Codex process can linger after a completed browser turn because global MCP children remain.
 * Terminate ONLY this newly spawned probe tree, after the broker has committed and gone idle.
 */
async function stopOwnedProbeTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true, stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => reject(new Error("PROBE_CLEANUP_TIMEOUT")), 10_000);
    killer.once("error", (error) => { clearTimeout(timer); reject(error); });
    killer.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("PROBE_CLEANUP_FAILED"));
    });
  });
}

async function observeActualMcpTool(
  config: AppConfig, probePath: string, digest: string, cwd: string,
  startedAtMs: number, logPath: string, logOffset: number,
): Promise<void> {
  const prompt = [
    "Doctor read-only connector verification. The file at " + JSON.stringify(probePath)
      + " contains unpredictable random data NOT provided here.",
    "Use the ACTUAL Codex Native2 MCP connector command tool to calculate SHA256 of the file.",
    "On Windows: Get-FileHash -LiteralPath " + JSON.stringify(probePath) + " -Algorithm SHA256.",
    "On other systems: sha256sum on this exact path.",
    "Do not write to disk or run unrelated commands. Only one read-only tool call.",
    "If the MCP tool is missing reply MCPUNAVAILABLE, never invent a hash.",
    "Only if the tool really returns the hash, reply exactly MCPPROOF=<hash>.",
  ].join(" ");
  const codex = process.platform === "win32" ? "codex.exe" : "codex";
  const child = spawn(codex, [
    "exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only",
    "-C", cwd, prompt,
  ], { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin?.end();
  const events: ProbeEvent[] = [];
  let buffer = "";
  let byteCount = 0;
  let settled = false;
  let checking = false;
  let exitedWithError = false;
  let stderrBytes = 0;

  await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let interval: ReturnType<typeof setInterval>;
      const finish = async (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(interval);
        try {
          await stopOwnedProbeTree(child);
          if (error) reject(error);
          else resolve();
        } catch (cleanupError) {
          reject(error ?? cleanupError);
        }
      };
      const inspect = async () => {
        if (checking || settled) return;
        checking = true;
        try {
          if (exitedWithError) {
            await finish(new Error("CODEX_PROBE_EXIT_NONZERO"));
            return;
          }
          if (events.some(event => event.type === "turn.failed")) {
            await finish(new Error("CODEX_PROBE_TURN_FAILED"));
            return;
          }
          const brokerRows = newBrokerRecords(logPath, logOffset);
          const broker = assessBrokerMcpProof(brokerRows, startedAtMs);
          if (assessMcpProof(events, digest, probePath, broker)) {
            const response = await fetch("http://" + config.host + ":" + config.port + "/healthz", {
              signal: AbortSignal.timeout(3_000),
            });
            if (!response.ok) throw new Error("PROXY_UNAVAILABLE");
            const health = await response.json() as Record<string, unknown>;
            if (health.active_http_turns === 0 && health.active_browser_turns === 0) {
              await finish();
            }
          }
        } catch (error) {
          await finish(error instanceof Error ? error : new Error("PROBE_EVIDENCE_FAILED"));
        } finally {
          checking = false;
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        if (settled) return;
        byteCount += chunk.length;
        if (byteCount > PROOF_LOG_LIMIT) {
          void finish(new Error("CODEX_PROBE_OUTPUT_LIMIT"));
          return;
        }
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed: unknown = JSON.parse(line);
            if (parsed && typeof parsed === "object") events.push(parsed as ProbeEvent);
          } catch { /* not evidence */ }
        }
        void inspect();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > PROOF_LOG_LIMIT) void finish(new Error("CODEX_PROBE_STDERR_LIMIT"));
      });
      child.once("error", () => { void finish(new Error("CODEX_PROBE_SPAWN_FAILED")); });
      child.once("exit", (code) => {
        if (code !== 0) exitedWithError = true;
        void inspect();
      });
      timer = setTimeout(() => { void finish(new Error("CODEX_PROBE_TIMEOUT")); }, PROOF_TIMEOUT_MS);
      interval = setInterval(() => { void inspect(); }, 700);
    });
}

async function removeProbeDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(String(code))) throw error;
      if (attempt === 19) throw new Error("PROBE_CLEANUP_LOCKED");
      await new Promise(resolve => setTimeout(resolve, Math.min(100 + attempt * 50, 300)));
    }
  }
}

export async function activeMcpConnectorCheck(config: AppConfig): Promise<DoctorCheck> {
  if (config.mode !== "full" || !config.tunnel) {
    return { id: "connector", status: "error", message: "MCP probe requires a configured Full harness" };
  }
  let temporary: string | undefined;
  try {
    const healthResponse = await fetch("http://" + config.host + ":" + config.port + "/healthz", {
      signal: AbortSignal.timeout(3_000),
    });
    if (!healthResponse.ok) throw new Error("PROXY_UNAVAILABLE");
    const health = await healthResponse.json() as Record<string, unknown>;
    if (health.service !== "codex-chatgpt-web" || health.status !== "ok" || health.accepting_turns !== true) {
      throw new Error("PROXY_UNHEALTHY");
    }
    if (health.active_http_turns !== 0 || health.active_browser_turns !== 0) throw new Error("ACTIVE_TURNS");
    if (!Number.isInteger(health.pid)) throw new Error("DAEMON_IDENTITY_UNAVAILABLE");
    const logPath = launcherLogPath();
    if (!existsSync(logPath)) throw new Error("BROKER_LOG_UNAVAILABLE");
    const logOffset = statSync(logPath).size;
    const startedAtMs = Date.now();
    temporary = mkdtempSync(join(tmpdir(), "doctor-mcp-e2e-"));
    const probePath = join(temporary, "nonce.txt");
    writeFileSync(probePath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    const digest = createHash("sha256").update(readFileSync(probePath)).digest("hex");
    await observeActualMcpTool(config, probePath, digest, temporary, startedAtMs, logPath, logOffset);
    await removeProbeDirectory(temporary);
    temporary = undefined;
    const receipt: ProofRecord = {
      version: 1, appName: config.appName,
      tunnelId: config.tunnel.tunnelId, daemonPid: health.pid as number,
      observedAt: Date.now(), proofSha256: digest,
    };
    atomicWriteFile(proofFile(), JSON.stringify(receipt) + "\n");
    return cachedMcpConnectorCheck(config, health.pid);
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN";
    return {
      id: "connector", status: "error",
      message: "MCP end-to-end connector verification failed",
      detail: /^[A-Z_]+$/.test(code) ? code : "UNEXPECTED_PROBE_FAILURE",
    };
  } finally {
    if (temporary) {
      try { await removeProbeDirectory(temporary); }
      catch { /* preserve the original verification failure; no receipt was issued */ }
    }
  }
}
