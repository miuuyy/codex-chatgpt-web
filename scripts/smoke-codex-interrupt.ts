import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { extractChatGptTurnIdentity } from "../src/adapters/chatgpt-web/environment";
import {
  ChatGptTextFeed,
  ChatGptTraceFeed,
  chatGptTurnSessions,
} from "../src/adapters/chatgpt-web/turn-execution";
import { defaultConfig, saveConfig } from "../src/config";
import { installCodexIntegration } from "../src/codex-integration";
import { startServer } from "../src/server";

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
const nativeCatalog = JSON.parse(bundled.stdout);

const root = join(tmpdir(), `codex-chatgpt-web-interrupt-${process.pid}-${Date.now()}`);
const codexHome = join(root, "codex");
const appHome = join(root, "app");
mkdirSync(codexHome, { recursive: true });
process.env.CODEX_HOME = codexHome;
process.env.CODEX_CHATGPT_WEB_HOME = appHome;

let adapterStarted = false;
let adapterAborted = false;
let browserAborted = false;
chatGptTurnSessions.clear();
const config = { ...defaultConfig("browser-only"), port: 0, subagentProtocol: "native" as const };
config.runtimeCommand = [resolve(process.execPath), resolve("src/cli.ts")];
const server = startServer(config, {
  fetchUpstream: async request => {
    if (new URL(request.url).pathname.endsWith("/models")) return Response.json(nativeCatalog);
    return new Response("Unexpected native request", { status: 500 });
  },
  adapterFactory: () => ({
    name: "interrupt-smoke",
    runTurn: (parsed, incoming) => new Promise<void>((_resolve, reject) => {
      adapterStarted = true;
      const identity = extractChatGptTurnIdentity(parsed);
      if (!identity.threadId || !identity.turnId) {
        reject(new Error("Routed smoke turn has no native Codex identity"));
        return;
      }
      let rejectBrowser!: (error: Error) => void;
      const browser = new Promise<string>((_resolveBrowser, rejectBrowserPromise) => {
        rejectBrowser = rejectBrowserPromise;
      });
      chatGptTurnSessions.getOrCreate(
        `interrupt-smoke:${identity.threadId}:${identity.turnId}`,
        () => ({
          mode: "read-only",
          browser,
          physicalSettlement: browser.then(() => undefined, () => undefined),
          trace: new ChatGptTraceFeed(),
          text: new ChatGptTextFeed(),
          cancel: reason => {
            browserAborted = true;
            rejectBrowser(reason ?? new Error("native turn interrupted"));
          },
        }),
        "interrupt-smoke",
        `interrupt-smoke-owner:${identity.threadId}`,
        identity.turnId,
        identity.threadId,
      );
      incoming.abortSignal!.addEventListener("abort", () => {
        adapterAborted = true;
        reject(incoming.abortSignal!.reason);
      }, { once: true });
    }),
  }),
});
if (server.port === undefined) throw new Error("Interrupt smoke server did not bind a port");
config.port = server.port;
saveConfig(config);
writeFileSync(join(codexHome, "hooks.json"), JSON.stringify({
  hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] },
}));
const journal = installCodexIntegration(config);
if (journal.interruptHook.storage !== "json") {
  throw new Error("Interrupt smoke expected an existing hooks.json to select JSON hook storage");
}

type RpcResponse = { id: number; result?: any; error?: { code?: number; message?: string; data?: unknown } };

class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly notifications: any[] = [];
  private readonly input: Bun.FileSink;
  private readonly output: ReadableStream<Uint8Array>;
  private readonly errors: ReadableStream<Uint8Array>;
  private buffered = "";
  readonly child: ReturnType<typeof Bun.spawn>;

  constructor() {
    const child = Bun.spawn([codex, "app-server"], {
      cwd: root,
      env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "local-interrupt-smoke" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (typeof child.stdin === "number" || child.stdin === undefined) {
      throw new Error("Codex app-server stdin is not writable");
    }
    if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream)) {
      throw new Error("Codex app-server output pipes are unavailable");
    }
    this.child = child;
    this.input = child.stdin;
    this.output = child.stdout;
    this.errors = child.stderr;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const reader = this.output.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        this.buffered += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const newline = this.buffered.indexOf("\n");
          if (newline < 0) break;
          const line = this.buffered.slice(0, newline).trim();
          this.buffered = this.buffered.slice(newline + 1);
          if (!line) continue;
          const message = JSON.parse(line) as RpcResponse & { method?: string; params?: unknown };
          if (typeof message.id === "number") {
            const waiting = this.pending.get(message.id);
            if (!waiting) continue;
            this.pending.delete(message.id);
            if (message.error) waiting.reject(new Error(`${message.error.code ?? "RPC"}: ${message.error.message ?? "unknown error"}`));
            else waiting.resolve(message.result);
          } else if (message.method) {
            this.notifications.push(message);
          }
        }
      }
    } finally {
      for (const waiting of this.pending.values()) waiting.reject(new Error("Codex app-server exited"));
      this.pending.clear();
    }
  }

  notify(method: string, params: unknown = {}): void {
    this.input.write(`${JSON.stringify({ method, params })}\n`);
    this.input.flush();
  }

  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    const result = new Promise<any>((resolveRequest, rejectRequest) => {
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    });
    this.input.write(`${JSON.stringify({ id, method, params })}\n`);
    this.input.flush();
    return result;
  }

  async waitForNotification(method: string, predicate: (message: any) => boolean, timeoutMs = 5_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.notifications.findIndex(message => message.method === method && predicate(message));
      if (index >= 0) return this.notifications.splice(index, 1)[0];
      await Bun.sleep(10);
    }
    throw new Error(`Timed out waiting for ${method}`);
  }

  async close(): Promise<{ stderr: string }> {
    this.child.kill();
    const stderr = await new Response(this.errors).text();
    await this.child.exited;
    return { stderr };
  }
}

const client = new AppServerClient();
let smokeError: unknown;
try {
  await client.request("initialize", {
    clientInfo: { name: "codex-chatgpt-web-interrupt-smoke", version: "1" },
    capabilities: { experimentalApi: true },
  });
  client.notify("initialized");

  const hookList = await client.request("hooks/list", { cwds: [root] });
  const hooks = Array.isArray(hookList?.data) ? hookList.data.flatMap((entry: any) => entry.hooks ?? []) : [];
  const installedHook = hooks.find((hook: any) => hook.command === journal.interruptHook.command);
  if (!installedHook) throw new Error(`Codex did not discover the installed Interrupt hook: ${JSON.stringify(hookList)}`);
  if (installedHook.currentHash !== journal.interruptHook.trustedHash || installedHook.trustStatus !== "trusted") {
    throw new Error(`Codex did not trust the exact installed Interrupt hook: ${JSON.stringify(installedHook)}`);
  }

  const started = await client.request("thread/start", {
    cwd: root,
    model: "chatgpt-web/high",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ephemeral: true,
  });
  const threadId = started?.thread?.id;
  if (typeof threadId !== "string") throw new Error(`thread/start returned no thread id: ${JSON.stringify(started)}`);
  const turnStarted = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Wait until this turn is interrupted." }],
  });
  const turnId = turnStarted?.turn?.id;
  if (typeof turnId !== "string") throw new Error(`turn/start returned no turn id: ${JSON.stringify(turnStarted)}`);

  const activeDeadline = Date.now() + 10_000;
  let activeHttpTurns = 0;
  let activeBrowserTurns = 0;
  while (Date.now() < activeDeadline && (activeHttpTurns !== 1 || activeBrowserTurns !== 1)) {
    const health = await (await fetch(`http://${config.host}:${config.port}/healthz`)).json() as {
      active_http_turns: number;
      active_browser_turns: number;
    };
    activeHttpTurns = health.active_http_turns;
    activeBrowserTurns = health.active_browser_turns;
    if (activeHttpTurns !== 1 || activeBrowserTurns !== 1) await Bun.sleep(20);
  }
  if (!adapterStarted || activeHttpTurns !== 1 || activeBrowserTurns !== 1) {
    throw new Error(
      `Routed turn did not become active: adapterStarted=${adapterStarted} `
      + `activeHttpTurns=${activeHttpTurns} activeBrowserTurns=${activeBrowserTurns}`,
    );
  }

  await client.request("turn/interrupt", { threadId, turnId });
  await client.waitForNotification(
    "turn/completed",
    message => message.params?.threadId === threadId
      && message.params?.turn?.id === turnId
      && message.params?.turn?.status === "interrupted",
  );

  const releasedDeadline = Date.now() + 5_000;
  do {
    const health = await (await fetch(`http://${config.host}:${config.port}/healthz`)).json() as {
      active_http_turns: number;
      active_browser_turns: number;
    };
    activeHttpTurns = health.active_http_turns;
    activeBrowserTurns = health.active_browser_turns;
    if (activeHttpTurns !== 0 || activeBrowserTurns !== 0) await Bun.sleep(20);
  } while (Date.now() < releasedDeadline && (activeHttpTurns !== 0 || activeBrowserTurns !== 0));
  if (!adapterAborted || !browserAborted || activeHttpTurns !== 0 || activeBrowserTurns !== 0) {
    throw new Error(
      `Interrupt leaked routed work: adapterAborted=${adapterAborted} browserAborted=${browserAborted} `
      + `activeHttpTurns=${activeHttpTurns} activeBrowserTurns=${activeBrowserTurns}`,
    );
  }
  process.stdout.write("NATIVE_CODEX_INTERRUPT_LIFECYCLE_SMOKE_OK\n");
} catch (error) {
  smokeError = error;
} finally {
  const { stderr } = await client.close();
  chatGptTurnSessions.clear();
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  if (smokeError) {
    throw new Error(`${smokeError instanceof Error ? smokeError.message : String(smokeError)}\nCodex stderr:\n${stderr.slice(-8_000)}`);
  }
}
