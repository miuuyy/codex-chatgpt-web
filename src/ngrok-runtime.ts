import { rmSync } from "node:fs";
import { atomicWriteFile } from "./config";
import { startChatGptMcpHttpServer } from "./adapters/chatgpt-web/mcp-http";
import { ngrokStatusPath } from "./tunnel";

export function ngrokStartedUrl(line: string): string | undefined {
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    return event.msg === "started tunnel" && typeof event.url === "string" ? event.url : undefined;
  } catch {
    return undefined;
  }
}

export function ngrokEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...environment };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete next[key];
  return next;
}

export async function runNgrokRuntime(options: {
  binaryPath: string;
  brokerSocketPath: string;
  port: number;
  url: string;
}): Promise<void> {
  rmSync(ngrokStatusPath(), { force: true });
  const server = startChatGptMcpHttpServer({
    brokerSocketPath: options.brokerSocketPath,
    port: options.port,
  });
  const child = Bun.spawn([
    options.binaryPath,
    "http",
    `http://127.0.0.1:${options.port}`,
    "--url",
    options.url,
    "--log",
    "stdout",
    "--log-format",
    "json",
  ], {
    env: ngrokEnvironment(),
    stdout: "pipe",
    stderr: "inherit",
  });

  let stopping = false;
  const stopChild = () => {
    stopping = true;
    child.kill("SIGTERM");
  };
  process.on("SIGINT", stopChild);
  process.on("SIGTERM", stopChild);
  let buffered = "";
  const pumpLogs = async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      process.stdout.write(result.value);
      buffered += decoder.decode(result.value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const endpoint = ngrokStartedUrl(line);
        if (endpoint && new URL(endpoint).origin === new URL(options.url).origin) {
          atomicWriteFile(ngrokStatusPath(), `${JSON.stringify({
            version: 1,
            ready: true,
            url: options.url,
            endpoint,
            startedAt: new Date().toISOString(),
          })}\n`);
        }
      }
    }
  };

  try {
    const [, exitCode] = await Promise.all([pumpLogs(), child.exited]);
    if (exitCode !== 0 && !stopping) throw new Error(`ngrok exited with status ${exitCode}`);
  } finally {
    process.off("SIGINT", stopChild);
    process.off("SIGTERM", stopChild);
    server.stop(true);
    rmSync(ngrokStatusPath(), { force: true });
  }
}
