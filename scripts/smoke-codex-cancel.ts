import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { bridgeToResponsesSSE } from "../src/bridge";
import { defaultConfig } from "../src/config";
import { augmentNativeModelCatalog } from "../src/model-catalog";
import type { AdapterEvent } from "../src/types";

const codex = resolve(process.argv[2] ?? "/Applications/ChatGPT.app/Contents/Resources/codex");
if (!existsSync(codex)) throw new Error(`Codex executable is missing: ${codex}`);

const bundled = spawnSync(codex, ["debug", "models", "--bundled"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 15_000,
});
if (bundled.status !== 0) {
  throw new Error(`Could not read bundled Codex models: ${bundled.error?.message || bundled.stderr}`);
}

const config = defaultConfig("browser-only");
config.proAvailable = true;
const catalog = augmentNativeModelCatalog(JSON.parse(bundled.stdout), config);
const root = join(tmpdir(), `codex-chatgpt-web-cancel-${process.pid}-${Date.now()}`);
const codexHome = join(root, "codex");
let responseRequests = 0;
let beginCancellationDeadline: (() => void) | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
let cancellationStartedAt: number | undefined;
let exitedAt: number | undefined;
let expired: "startup" | "cancellation" | undefined;
let finalizing = false;
let stopChild: (() => Promise<void>) | undefined;
async function* cancelledStream(): AsyncGenerator<AdapterEvent> {
  yield {
    type: "error",
    message: "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
    status: 499,
    errorType: "client_closed_request",
    code: "client_cancelled",
    retryable: false,
  };
}

try {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(root, "models.json"), `${JSON.stringify(catalog)}\n`);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/models") return Response.json(catalog);
      if (url.pathname !== "/v1/responses" || request.method !== "POST") {
        return new Response("Not found", { status: 404 });
      }
      await request.json();
      responseRequests += 1;
      if (responseRequests === 1) {
        const stream = bridgeToResponsesSSE(
          cancelledStream(), "chatgpt-web/high", undefined, undefined, undefined, undefined, undefined,
          { onTerminal(status) { if (status === "failed") beginCancellationDeadline?.(); } },
        );
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      return Response.json({
        error: {
          type: "client_closed_request",
          code: "client_cancelled",
          message: "The ChatGPT browser tab was closed, so the Codex turn was cancelled.",
        },
      }, { status: 400 });
    },
  });

  writeFileSync(join(codexHome, "config.toml"), [
    'model = "chatgpt-web/high"',
    'model_provider = "cancel-smoke"',
    `model_catalog_json = ${JSON.stringify(join(root, "models.json"))}`,
    "",
    "[model_providers.cancel-smoke]",
    'name = "Local cancellation smoke"',
    `base_url = "http://127.0.0.1:${server.port}/v1"`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    "supports_websockets = false",
    "",
  ].join("\n"));

  const child = Bun.spawn([
    codex,
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    "chatgpt-web/high",
    "Wait for the provider cancellation contract.",
  ], {
    cwd: root,
    env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "local-cancel-smoke" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  stopChild = async () => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          child.exited,
          new Promise<never>((_, reject) => {
            cleanupTimeout = setTimeout(() => reject(new Error("Codex did not exit within the cleanup deadline")), 2_000);
          }),
        ]);
      } finally {
        clearTimeout(cleanupTimeout);
      }
    }
  };
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  // Bound cold startup separately; cancellation starts when response.failed is emitted.
  timeout = setTimeout(() => {
    expired = "startup";
    child.kill();
    rejectDeadline(new Error("Codex did not emit a cancellation error within the startup deadline"));
  }, 30_000);
  beginCancellationDeadline = () => {
    if (cancellationStartedAt !== undefined || expired) return;
    cancellationStartedAt = performance.now();
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      expired = "cancellation";
      child.kill();
      rejectDeadline(new Error("Codex did not terminate within the cancellation deadline"));
    }, 15_000);
  };
  const exited = child.exited.then(code => {
    exitedAt = performance.now();
    clearTimeout(timeout);
    if (!finalizing) {
      timeout = setTimeout(() => rejectDeadline(new Error("Codex output did not close within the output deadline")), 5_000);
    }
    return code;
  });
  const [exitCode, stdout, stderr] = await Promise.race([
    Promise.all([exited, new Response(child.stdout).text(), new Response(child.stderr).text()]),
    deadline,
  ]);

  if (cancellationStartedAt === undefined) throw new Error("Codex exited before sending a Responses request");
  if (expired === "cancellation" || exitedAt! - cancellationStartedAt >= 15_000) {
    throw new Error("Codex did not terminate within the cancellation deadline");
  }
  if (exitCode === 0) throw new Error(`Codex reported cancellation as success:\n${stdout}`);
  if (responseRequests !== 2) {
    throw new Error(`Codex made ${responseRequests} Responses requests; expected one streamed failure and one terminal replay`);
  }
  if (!`${stdout}\n${stderr}`.includes("client_cancelled")) {
    throw new Error(`Codex did not surface the terminal cancellation body:\n${stdout}\n${stderr}`);
  }
  process.stdout.write("NATIVE_CODEX_BROWSER_TAB_CANCEL_SMOKE_OK\n");
} finally {
  finalizing = true;
  beginCancellationDeadline = undefined;
  clearTimeout(timeout);
  try {
    await stopChild?.();
  } finally {
    try { await server?.stop(true); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
}
