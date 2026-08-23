import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../src/adapters/base";
import { ChatGptBrowserWorker, type BrowserTurn } from "../src/adapters/chatgpt-web/browser-worker";
import { createChatGptWebAdapter } from "../src/adapters/chatgpt-web";
import { chatGptTurnSessions } from "../src/adapters/chatgpt-web/turn-execution";
import {
  callTurnBroker,
  RemoteTurnBroker,
  TurnBroker,
  type BrokerToolResult,
} from "../src/adapters/chatgpt-web/turn-broker";
import { defaultBrokerEndpoint, defaultConfig, providerConfig } from "../src/config";
import { defaultDevChatModel, DevChatDriver } from "../src/dev-chat/driver";
import { createDevContextFiller, DevChatStore } from "../src/dev-chat/session";
import { startDevChatTransport } from "../src/dev-chat/transport";
import type { CodexProviderConfig } from "../src/types";

const roots: string[] = [];

function scratch(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  chatGptTurnSessions.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("remote outer harness owns a turn through the live broker protocol", async () => {
  const root = scratch("cgw-dev-owner");
  const socketPath = defaultBrokerEndpoint(root);
  const broker = TurnBroker.forSocket(socketPath);
  const remote = new RemoteTurnBroker(socketPath);
  await broker.listen();
  try {
    await remote.assertCompatible();
    await expect(remote.register({ cwd: "relative", roots: [], tools: [] } as never, 60_000, "invalid-owner"))
      .rejects.toThrow("environment is invalid");
    const environment = {
      cwd: root,
      roots: [root],
      writableRoots: [root],
      sandboxPolicy: { type: "dangerFullAccess" as const },
      tools: [{ name: "exec_command", description: "Simulated command", parameters: { type: "object" } }],
    };
    const token = await remote.register(environment, 60_000, "dev-owner-test");
    const claimed = await callTurnBroker<{ bindingId: string }>(socketPath, { method: "claim", token });
    const invocation = callTurnBroker<BrokerToolResult>(socketPath, {
      method: "invoke",
      bindingId: claimed.bindingId,
      wireName: "exec_command",
      arguments: { cmd: "pwd" },
    }, 10_000);
    const batch = await remote.nextToolBatch(token);
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({ wireName: "exec_command", arguments: { cmd: "pwd" } });
    await remote.completeTool(token, batch[0]!.callId, {
      content: [{ type: "text", text: "simulated" }],
      structuredContent: { simulated: true },
    });
    expect(await invocation).toMatchObject({ structuredContent: { simulated: true } });
    await remote.revoke(token);
    await expect(callTurnBroker(socketPath, { method: "claim", token })).rejects.toThrow("already finished");
  } finally {
    await broker.close();
  }
});

test("named DEV state and deterministic context filler persist independently", () => {
  const root = scratch("cgw-dev-store");
  const store = new DevChatStore(join(root, "chats"));
  const opened = store.loadOrCreate("compaction-lab", "chatgpt-web/high", root);
  expect(opened.created).toBe(true);
  const filler = createDevContextFiller(3_000);
  expect(filler.tokens).toBeGreaterThanOrEqual(3_000);
  expect(filler.tokens).toBeLessThan(3_050);
  opened.state.input.push({ type: "message", role: "user", content: filler.text });
  opened.state.syntheticFills += 1;
  store.save(opened.state);
  expect(store.load("compaction-lab")).toMatchObject({ syntheticFills: 1, input: [expect.any(Object)] });
  expect(store.list()).toMatchObject([{ name: "compaction-lab", inputItems: 1 }]);
  store.reset(opened.state);
  expect(store.load("compaction-lab")).toMatchObject({ input: [], turns: 0, syntheticFills: 0 });
});

test("new DEV chats default to the cheapest account-supported browser model", () => {
  expect(defaultDevChatModel({ ...defaultConfig("full"), solAvailable: true })).toBe("chatgpt-web/light");
  expect(defaultDevChatModel({ ...defaultConfig("full"), solAvailable: false })).toBe("chatgpt-web/luna");
});

test("browser-only DEV driver runs real turns without advertising simulated tools", async () => {
  const root = scratch("cgw-dev-browser-only");
  const config = {
    ...defaultConfig("browser-only"),
    purpose: "dev-harness" as const,
    solAvailable: true,
    proAvailable: true,
  };
  const factory = (): ProviderAdapter => ({
    name: "dev-browser-only-test",
    async runTurn(parsed, _incoming, emit) {
      expect(parsed.context.tools ?? []).toEqual([]);
      emit({ type: "text_delta", text: "Browser-only DEV turn completed.", phase: "final_answer" });
      emit({
        type: "done", stopReason: "stop", endTurn: true,
        usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, estimated: true },
      });
    },
  });
  const driver = new DevChatDriver(config, new DevChatStore(join(root, "chats")), factory, root);
  try {
    const state = driver.open("browser-only", "chatgpt-web/extra-high").state;
    await expect(driver.send(state, "Exercise Extra High without MCP credentials."))
      .resolves.toMatchObject({ text: "Browser-only DEV turn completed.", toolCalls: 0 });
  } finally {
    await driver.close();
  }
});

test("DEV chat attaches its broker to the launcher-owned tunnel without a Responses listener", async () => {
  const root = scratch("cgw-dev-transport");
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("normal Codex route") });
  const devBroker = defaultBrokerEndpoint(join(root, "dev"));
  const config = {
    ...defaultConfig("full"),
    purpose: "dev-harness" as const,
    port: occupied.port!,
    brokerSocketPath: devBroker,
    tunnel: {
      binaryPath: join(root, "tunnel-client"),
      tunnelId: `tunnel_${"a".repeat(32)}`,
      runtimeKeyFile: join(root, "runtime.key"),
      profileDir: join(root, "profiles"),
      profileName: "production-profile",
      alias: "production-alias",
    },
  };
  let transport: Awaited<ReturnType<typeof startDevChatTransport>> | undefined;
  try {
    transport = await startDevChatTransport(config, join(root, "dev"), {
      status: () => ({
        ok: true,
        processRunning: true,
        healthy: true,
        ready: true,
        state: "ready",
        detail: "launcher-owned DEV tunnel ready",
      }),
    });
    expect(transport.config).toBe(config);
    expect(await callTurnBroker(transport.config.brokerSocketPath, { method: "owner_status" }))
      .toMatchObject({ protocolVersion: 1 });
    expect(await (await fetch(`http://127.0.0.1:${occupied.port}`)).text()).toBe("normal Codex route");
  } finally {
    await transport?.close();
    await occupied.stop(true);
  }
  await expect(callTurnBroker(devBroker, { method: "owner_status" }))
    .rejects.toThrow("unavailable");
});

test("DEV chat fails closed until the launcher-owned MCP tunnel is ready", async () => {
  const root = scratch("cgw-dev-production-owner");
  const config = {
    ...defaultConfig("full"),
    purpose: "dev-harness" as const,
    tunnel: {
      binaryPath: join(root, "tunnel-client"),
      tunnelId: `tunnel_${"b".repeat(32)}`,
      runtimeKeyFile: join(root, "runtime.key"),
      profileDir: join(root, "profiles"),
      profileName: "production-profile",
      alias: "production-alias",
    },
  };
  await expect(startDevChatTransport(config, join(root, "dev"), {
    status: () => ({
      ok: false,
      processRunning: false,
      healthy: false,
      ready: false,
      state: "stopped",
      detail: "stopped",
    }),
  })).rejects.toThrow("launcher-owned DEV MCP tunnel is not ready");
});

test("DEV driver uses shared browser methods and its own broker while an unrelated Responses port stays occupied", async () => {
  const root = scratch("cgw-dev-driver");
  const codexConfig = join(root, "codex", "config.toml");
  mkdirSync(join(root, "codex"), { recursive: true });
  writeFileSync(codexConfig, "openai_base_url = \"http://127.0.0.1:17841/v1\"\n");
  const sentinel = readFileSync(codexConfig, "utf8");
  const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("live") });
  const config = { ...defaultConfig("full"), port: occupied.port!, brokerSocketPath: defaultBrokerEndpoint(join(root, "broker")) };
  const localBroker = TurnBroker.forSocket(config.brokerSocketPath);
  await localBroker.listen();
  const remote = new RemoteTurnBroker(config.brokerSocketPath);
  const stateRoot = join(root, "state");
  const devProvider = (provider: CodexProviderConfig): CodexProviderConfig => ({
    ...provider,
    chatgptWeb: {
      ...provider.chatgptWeb,
      brokerSocketPath: config.brokerSocketPath,
      threadEnvironmentStatePath: join(stateRoot, "thread-environments.json"),
      lunaCheckpointStatePath: join(stateRoot, "luna-checkpoints.json"),
    },
  });
  const worker = ChatGptBrowserWorker.forProvider(devProvider(providerConfig(config)));
  const originalRun = worker.run.bind(worker);
  let browserStarts = 0;
  (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = async turn => {
    browserStarts += 1;
    const prepared = await turn.prepare();
    try {
      const token = prepared.text.match(/turn_token (turn_[A-Za-z0-9_-]+)/)?.[1];
      if (!token) throw new Error("missing DEV broker token");
      const claimed = await callTurnBroker<{ bindingId: string }>(config.brokerSocketPath, { method: "claim", token });
      turn.onReasoningSummary?.("Exercising the real broker round");
      const result = await callTurnBroker<BrokerToolResult>(config.brokerSocketPath, {
        method: "invoke",
        bindingId: claimed.bindingId,
        wireName: "exec_command",
        arguments: { cmd: "git status --short" },
      }, 30_000);
      const simulated = (result.structuredContent as { simulated: boolean }).simulated;
      const answer = `DEV receipt simulated=${simulated}`;
      turn.onTextDelta(answer);
      return answer;
    } finally {
      prepared.release();
    }
  };
  const factory = (provider: CodexProviderConfig) => createChatGptWebAdapter(devProvider(provider), { broker: remote });
  const driver = new DevChatDriver(config, new DevChatStore(join(root, "chats")), factory, root);
  try {
    const state = driver.open("tool-round").state;
    const result = await driver.send(state, "Use a command tool, then report its receipt.");
    expect(result).toMatchObject({ text: "DEV receipt simulated=true", toolCalls: 1 });
    expect(state.input.find(item => (item as { role?: string }).role === "assistant"))
      .toMatchObject({ internal_chat_message_metadata_passthrough: { turn_id: expect.stringContaining("dev_turn_") } });
    expect(browserStarts).toBe(1);
    expect(await (await fetch(`http://127.0.0.1:${occupied.port}`)).text()).toBe("live");
    expect(readFileSync(codexConfig, "utf8")).toBe(sentinel);
  } finally {
    (worker as unknown as { run: (turn: BrowserTurn) => Promise<string> }).run = originalRun;
    await driver.close();
    chatGptTurnSessions.clear();
    await Bun.sleep(0);
    await localBroker.close();
    await occupied.stop(true);
  }
});

test("synthetic fill crosses the production threshold and triggers the real compact handler", async () => {
  const root = scratch("cgw-dev-compact");
  const config = defaultConfig("full");
  let compactRuns = 0;
  const factory = (): ProviderAdapter => ({
    name: "dev-compaction-test",
    async runTurn(parsed, _incoming, emit) {
      if (parsed._compactionRequest) {
        compactRuns += 1;
        emit({ type: "text_delta", text: "Synthetic history compacted for the next DEV turn.", phase: "final_answer" });
      } else {
        emit({ type: "text_delta", text: "DEV turn completed after compaction.", phase: "final_answer" });
      }
      emit({
        type: "done", stopReason: "stop", endTurn: true,
        usage: { inputTokens: 1_000, outputTokens: 20, totalTokens: 1_020, estimated: true },
      });
    },
  });
  const store = new DevChatStore(join(root, "chats"));
  const driver = new DevChatDriver(config, store, factory, root);
  const state = driver.open("auto-compact", "chatgpt-web/light").state;
  driver.fill(state, 30_000);
  expect(driver.status(state).inputTokens).toBeGreaterThanOrEqual(32_000);
  const events: string[] = [];
  const result = await driver.send(state, "Continue after compacting the synthetic history.", event => events.push(event.type));
  expect(result).toMatchObject({ text: "DEV turn completed after compaction.", compactions: 1 });
  expect(compactRuns).toBe(1);
  expect(events).toContain("compaction_start");
  expect(events).toContain("compaction_done");
  expect(store.load("auto-compact")?.compactions).toBe(1);
  await driver.close();
}, 30_000);
