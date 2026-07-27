import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config";
import { createNgrokTunnelConfig, createTunnelConfig } from "../src/tunnel";
import { tunnelServiceDefinition } from "../src/tunnel-service";
import { existingFullSetupCredentials, tunnelWorkerRuntimeChanged } from "../src/setup";

const roots: string[] = [];

afterEach(() => {
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("tunnel launchd ownership", () => {
  test("runs the pinned client directly and asks launchd to restore it", () => {
    const root = join(tmpdir(), `codex-chatgpt-web-tunnel-service-${process.pid}-${Date.now()}`);
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const binary = join(root, "bin", "tunnel-client");
    const key = join(root, "secrets", "runtime.key");
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(binary, "binary");
    writeFileSync(key, "secret");
    const config = defaultConfig("full");
    config.tunnel = createTunnelConfig({
      binaryPath: binary,
      runtimeKeyFile: key,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });

    const definition = tunnelServiceDefinition(config, "darwin");
    expect(definition).toContain("<string>run</string>");
    expect(definition).toContain(`<string>${config.tunnel.profileDir}</string>`);
    expect(definition).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(definition).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(definition).not.toContain("tmux");
    expect(definition).not.toContain("/bin/sh");
    expect(definition).not.toContain(config.tunnel.tunnelId);
    expect(definition).not.toContain(key);
  });

  test("runs ngrok and the HTTP MCP bridge under systemd", () => {
    const config = defaultConfig("full");
    config.tunnel = createNgrokTunnelConfig({
      binaryPath: "/usr/local/bin/ngrok",
      url: "https://codex.example.ngrok.app",
      port: 17842,
    });
    const definition = tunnelServiceDefinition(config, "linux");
    expect(definition).toContain("ngrok-tunnel");
    expect(definition).toContain("https://codex.example.ngrok.app");
    expect(definition).toContain("Restart=always");
    expect(definition).not.toContain("/bin/sh");
  });

  test("restarts the long-lived MCP worker when the installed release changes", () => {
    const root = join(tmpdir(), `codex-chatgpt-web-tunnel-runtime-${process.pid}-${Date.now()}`);
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const runtime = join(root, "bin", "codex-chatgpt-web");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(runtime, "runtime");
    const before = defaultConfig("browser-only");
    before.mode = "full";
    before.releaseVersion = "0.1.3";
    before.runtimeCommand = [runtime];
    const after = structuredClone(before);
    after.releaseVersion = "0.1.9";

    expect(tunnelWorkerRuntimeChanged(before, after)).toBe(true);
    after.releaseVersion = before.releaseVersion;
    expect(tunnelWorkerRuntimeChanged(before, after)).toBe(false);
  });

  test("reuses complete full-mode tunnel credentials during setup updates", () => {
    const root = join(tmpdir(), `codex-chatgpt-web-existing-tunnel-${process.pid}-${Date.now()}`);
    roots.push(root);
    process.env.CODEX_CHATGPT_WEB_HOME = root;
    const key = join(root, "secrets", "runtime.key");
    mkdirSync(join(root, "secrets"), { recursive: true });
    writeFileSync(key, "secret");
    const config = defaultConfig("full");
    config.tunnel = createTunnelConfig({
      binaryPath: process.execPath,
      runtimeKeyFile: key,
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
    });

    expect(existingFullSetupCredentials(config)).toEqual({ tunnelId: true, runtimeKey: true });
    rmSync(key);
    expect(existingFullSetupCredentials(config)).toEqual({ tunnelId: true, runtimeKey: false });
    expect(existingFullSetupCredentials(defaultConfig("browser-only"))).toEqual({ tunnelId: false, runtimeKey: false });
  });
});
