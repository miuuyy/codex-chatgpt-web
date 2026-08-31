import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppConfig, CloudflareTunnelConfig } from "./config";
import { isCloudflareTunnel } from "./config";
import { createCloudflareRuntimeConfig } from "./cloudflare-config";

const STARTUP_TIMEOUT_MS = 45_000;

function lines(stream: NodeJS.ReadableStream, consume: (line: string) => void): void {
  let buffered = "";
  stream.on("data", chunk => {
    buffered += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trimEnd();
      buffered = buffered.slice(newline + 1);
      if (line) consume(line);
    }
  });
  stream.on("end", () => {
    const line = buffered.trim();
    if (line) consume(line);
  });
}

export function cloudflarePublicUrl(settings: CloudflareTunnelConfig): string {
  return `https://${settings.hostname}${settings.mcpPath}`;
}

export async function runCloudflareTunnel(config: AppConfig): Promise<void> {
  if (config.mode !== "full" || !isCloudflareTunnel(config.tunnel)) {
    throw new Error("Cloudflare tunnel runtime requires a full Cloudflare configuration");
  }
  const settings = config.tunnel;
  const runtime = await createCloudflareRuntimeConfig(
    settings,
    `http://${config.host}:${config.port}`,
  );
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(settings.binaryPath, [
      "tunnel",
      "--no-autoupdate",
      "--config",
      runtime.path,
      "run",
      runtime.tunnel,
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
  } catch (error) {
    await runtime.cleanup();
    throw error;
  }

  let ready = false;
  let stopping = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const consume = (line: string) => {
    console.error(`[cloudflared] ${line}`);
    if (!ready && /registered tunnel connection/i.test(line)) {
      ready = true;
      if (startupTimer) clearTimeout(startupTimer);
      console.log(JSON.stringify({ event: "cloudflare_ready", hostname: settings.hostname }));
    }
  };
  lines(child.stdout, consume);
  lines(child.stderr, consume);

  try {
    await new Promise<void>((resolveRun, rejectRun) => {
      startupTimer = setTimeout(() => {
        rejectRun(new Error(`cloudflared did not connect ${settings.hostname} within 45 seconds`));
        stop();
      }, STARTUP_TIMEOUT_MS);
      child.once("error", rejectRun);
      child.once("exit", (code, signal) => {
        if (startupTimer) clearTimeout(startupTimer);
        if (stopping && (code === 0 || signal)) resolveRun();
        else rejectRun(new Error(`cloudflared exited before shutdown (${signal ?? code ?? "unknown"})`));
      });
    });
  } finally {
    if (startupTimer) clearTimeout(startupTimer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await runtime.cleanup();
  }
}
