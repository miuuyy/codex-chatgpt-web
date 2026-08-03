import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defaultBrokerEndpoint } from "../src/config";

async function runCli(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([
    process.execPath,
    resolve(import.meta.dir, "../src/cli.ts"),
    ...args,
  ], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("setup validates the port before performing runtime work", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-"));
  try {
    const result = await runCli([
      "setup",
      "--browser-only",
      "--port",
      "0",
      "--acknowledge-unofficial",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
    });
    const { stderr } = result;
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("--port must be an integer from 1 to 65535");
    expect(stderr).not.toContain("Unknown arguments");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal uninstall refuses to race a launcher-owned runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-uninstall-"));
  const appHome = join(root, "app");
  const configPath = join(appHome, "config.json");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    version: 3,
    releaseVersion: "0.2.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "launcher",
    browserHostDescriptorPath: join(appHome, "runtime", "launcher-browser.json"),
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    proAvailable: false,
    autoApproveToolCalls: false,
    controlToken: "launcher-uninstall-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
  })}\n`);
  try {
    const result = await runCli([
      "uninstall",
      "--yes",
    ], {
      ...process.env,
      CODEX_HOME: join(root, "codex"),
      CODEX_CHATGPT_WEB_HOME: appHome,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("must be removed from Codex Web GPT Settings");
    expect(existsSync(configPath)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conversation routes register privately and expose only their explicit model mapping", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-cli-conversation-"));
  const appHome = join(root, "app");
  const configPath = join(appHome, "config.json");
  mkdirSync(appHome, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({
    version: 3,
    releaseVersion: "1.1.0",
    mode: "browser-only",
    host: "127.0.0.1",
    port: 17841,
    contextWindow: 256_000,
    appName: "Codex Native",
    browserHost: "managed-chrome",
    chromeExecutablePath: process.execPath,
    storageStatePath: join(appHome, "browser", "storage-state.json"),
    brokerSocketPath: defaultBrokerEndpoint(appHome),
    headed: true,
    proAvailable: true,
    autoApproveToolCalls: false,
    controlToken: "conversation-route-control-token-0123456789abcdef",
    runtimeCommand: [process.execPath],
  })}\n`);
  const env = { ...process.env, CODEX_CHATGPT_WEB_HOME: appHome };
  const privateUrl = "https://chatgpt.com/unpromised/path/schema?opaque=1";
  try {
    const registered = await runCli([
      "conversation", "register",
      "--key", "dcp-pro-advisory",
      "--url", privateUrl,
      "--project", "DCP",
      "--conversation", "DCP Pro Advisory",
    ], env);
    expect(registered.exitCode).toBe(0);
    expect(registered.stdout).toContain('"model": "chatgpt-web/project/dcp-pro-advisory"');
    expect(registered.stdout).not.toContain(privateUrl);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({
      conversationRoutes: [{
        routeKey: "dcp-pro-advisory",
        conversationUrl: privateUrl,
        requiredModel: "pro",
        payloadMode: "signed_capsule_or_delta",
      }],
    });

    const listed = await runCli(["conversation", "list"], env);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("dcp-pro-advisory");
    expect(listed.stdout).not.toContain(privateUrl);

    const removed = await runCli(["conversation", "remove", "--key", "dcp-pro-advisory"], env);
    expect(removed.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).not.toHaveProperty("conversationRoutes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
