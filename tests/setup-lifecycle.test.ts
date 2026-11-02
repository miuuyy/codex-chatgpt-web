import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configModule from "../src/config";
import * as integration from "../src/codex-integration";
import * as service from "../src/service";
import * as tunnel from "../src/tunnel";
import * as tunnelService from "../src/tunnel-service";
import * as browserHost from "../src/launcher-browser-host";
import * as browserLogin from "../src/browser-login";
import { launcherCapabilityProbeRequired, portBindFailureMessage, setup, setupDevProfile, setupProxyIsReady } from "../src/setup";

const config = {
  mode: "browser-only" as const,
  releaseVersion: "0.2.0",
};

// #712: after a restart Windows can reserve the bridge port; Node reports that as EACCES.
test("Windows EACCES suggests checks without claiming a port reservation is proven", () => {
  const reserved = Object.assign(new Error("listen EACCES: permission denied 127.0.0.1:17841"), { code: "EACCES" });
  const busy = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:17841"), { code: "EADDRINUSE" });
  const plain = "Cannot bind 127.0.0.1:17841: listen EACCES: permission denied 127.0.0.1:17841";

  const explained = portBindFailureMessage("127.0.0.1", 17841, reserved, "win32");
  expect(explained.startsWith(`${plain}. Windows may have reserved this port`)).toBeTrue();
  expect(explained).toContain("another service may hold it exclusively");
  expect(explained).toContain("TROUBLESHOOTING.md");
  // Elsewhere EACCES is a real permission error, and a busy port has its own owner to find.
  expect(portBindFailureMessage("127.0.0.1", 17841, reserved, "linux")).toBe(plain);
  expect(portBindFailureMessage("127.0.0.1", 17841, busy, "win32"))
    .toBe("Cannot bind 127.0.0.1:17841: listen EADDRINUSE: address already in use 127.0.0.1:17841");
});

test("setup accepts only a matching daemon that is ready for new Codex turns", () => {
  const ready = {
    service: "codex-chatgpt-web",
    status: "ok",
    mode: "browser-only",
    version: "0.2.0",
    accepting_turns: true,
  };

  expect(setupProxyIsReady(ready, config)).toBe(true);
  expect(setupProxyIsReady({ ...ready, accepting_turns: false }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, status: "degraded" }, config)).toBe(false);
  expect(setupProxyIsReady({ ...ready, version: "0.1.16" }, config)).toBe(false);
});

test("launcher setup refreshes account capabilities only when missing or explicitly requested", () => {
  const verifiedLauncher = {
    browserHost: "launcher",
    solAvailable: true,
    extraHighAvailable: false, proAvailable: false, proPlan: false,
  };

  expect(launcherCapabilityProbeRequired(undefined)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({ ...verifiedLauncher, extraHighAvailable: undefined } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired({
    browserHost: "launcher",
    extraHighAvailable: false, proAvailable: false, proPlan: false,
  } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never, true)).toBe(true);
  expect(launcherCapabilityProbeRequired({
    ...verifiedLauncher,
    browserInteractionMode: "manual",
  } as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    ...verifiedLauncher,
    browserInteractionMode: "manual",
  } as never, false, "automatic")).toBe(true);
});

for (const development of [false, true]) {
  test(`${development ? "DEV" : "production"} updates an installed launcher without a ChatGPT session`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-web-offline-upgrade-"));
    const configPath = join(root, "config.json");
    const existing = {
      ...configModule.defaultConfig("browser-only"),
      releaseVersion: "6.1.4",
      browserHost: "launcher" as const,
      solAvailable: true, extraHighAvailable: true, proAvailable: true,
      ...(development ? { purpose: "dev-harness" as const } : {}),
    };
    writeFileSync(configPath, JSON.stringify(existing));
    const save = spyOn(configModule, "saveConfig").mockImplementation(() => {});
    const inspect = spyOn(browserHost, "inspectLauncherBrowserHost").mockRejectedValue(new Error("ChatGPT is signed out"));
    const mocks = [save, inspect,
      spyOn(configModule, "getConfigPath").mockReturnValue(configPath),
      spyOn(configModule, "loadConfigForSetup").mockImplementation(() => structuredClone(existing)),
      spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
      spyOn(integration, "installCodexIntegration").mockImplementation(() => ({} as never)),
      spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
    ];
    try {
      const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = listener.port!;
      await listener.stop(true);
      const options = { mode: "browser-only" as const, subagentProtocol: "native" as const, port,
        browserHostDescriptorPath: join(root, "launcher-browser.json"), acknowledgedUnofficial: true };
      const configure = development ? setupDevProfile : setup;
      await configure(options);
      expect(inspect).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0]![0]).toMatchObject({
        releaseVersion: configModule.defaultConfig().releaseVersion,
        solAvailable: true, extraHighAvailable: true, proAvailable: true,
      });
      // Refreshing the actual model list still requires evidence from the account.
      await expect(configure({ ...options, refreshAccountCapabilities: true })).rejects.toThrow("ChatGPT is signed out");
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(save).toHaveBeenCalledTimes(1);
      inspect.mockRejectedValue(new Error("Could not identify ChatGPT's model controls"));
      await expect(configure({ ...options, refreshAccountCapabilities: true }))
        .rejects.toThrow("Could not identify ChatGPT's model controls");
      expect(save).toHaveBeenCalledTimes(1);
      expect(existing).toMatchObject({ solAvailable: true, extraHighAvailable: true, proAvailable: true });
    } finally {
      for (const mock of mocks.reverse()) mock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const development of [false, true]) for (const interaction of ["manual", "automatic"] as const) {
  test(`${development ? "DEV" : "production"} ${interaction} setup commits the tunnel inputs before its supervisor starts the runtime`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-web-setup-owner-"));
    const key = join(root, "runtime.key");
    writeFileSync(key, "fixture-runtime-key");
    const calls: string[] = [];
    let saved: configModule.AppConfig | undefined;
    const mocks = [
      spyOn(configModule, "getConfigPath").mockReturnValue(join(root, "config.json")),
      spyOn(configModule, "saveConfig").mockImplementation(value => { saved = value; calls.push("save"); }),
      spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
      spyOn(integration, "installCodexIntegration").mockImplementation(() => { calls.push("integrate"); return {} as never; }),
      spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
      spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(tunnel, "managedRuntimeKeyPath").mockReturnValue(key),
      spyOn(tunnel, "installTunnelClient").mockResolvedValue(join(root, "tunnel-client")),
      spyOn(tunnel, "connectTunnel").mockImplementation(() => { throw new Error("setup started a runtime before committing its inputs"); }),
      spyOn(tunnel, "stopTunnel").mockImplementation(() => { throw new Error("setup stopped the supervisor's runtime"); }),
      spyOn(browserHost, "inspectLauncherBrowserHost").mockResolvedValue({ solAvailable: true, proAvailable: true, extraHighAvailable: true } as never),
    ];
    try {
      const options = {
        mode: "full" as const,
        browserInteractionMode: interaction,
        subagentProtocol: "native" as const,
        browserHostDescriptorPath: join(root, "launcher-browser.json"),
        tunnelId: `tunnel_${"a".repeat(32)}`,
        acknowledgedUnofficial: true,
      };
      const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = listener.port!;
      await listener.stop(true);
      const result = await (development ? setupDevProfile : setup)({ ...options, port,
        ...(interaction === "automatic" ? { experimentalFreshConversationPerTurn: true } : {}),
        connectorNameSuffix: "Work",
      });
      expect(calls).toEqual(development ? ["save"] : ["save", "integrate"]);
      expect(saved?.tunnel?.alias).toBe(`codex-chatgpt-web${development ? "-dev" : ""}${interaction === "manual" ? "-zero-risk" : ""}`);
      expect(result.tunnelReady).not.toBe(true);
      expect(result.connectorSetupRequired).toBe(true);
      expect(saved?.experimentalFreshConversationPerTurn).toBe(interaction === "automatic");
      expect(saved).not.toHaveProperty("useSavedChats");
      expect(saved?.appName).toBe("Codex Work");
      expect(interaction === "manual" ? saved?.automaticAppName : saved?.manualAppName)
        .toBe(interaction === "automatic" ? "Codex Zero Risk" : development ? "Codex Native2 DEV" : "Codex Native2");
      // Unrelated setup and mode changes retain the suffix; clearing it is explicit.
      const initial = structuredClone(saved!);
      mocks.push(spyOn(configModule, "loadConfigForSetup").mockImplementation(() => structuredClone(initial)));
      writeFileSync(join(root, "config.json"), JSON.stringify(initial));
      await (development ? setupDevProfile : setup)({ ...options, port });
      expect(saved?.appName).toBe(initial.appName);
      await (development ? setupDevProfile : setup)({ ...options, port, connectorNameSuffix: interaction === "manual" ? "Zero Risk" : development ? "Native2 DEV" : "Native2" });
      expect(saved?.appName).toBe(interaction === "manual" ? "Codex Zero Risk"
        : development ? "Codex Native2 DEV" : "Codex Native2");

      calls.length = 0;
      mocks.push(spyOn(configModule, "saveConfig").mockImplementation(() => { throw new Error("config commit failed"); }));
      await expect((development ? setupDevProfile : setup)({ ...options, port })).rejects.toThrow("config commit failed");
      expect(calls).toEqual([]);
    } finally {
      for (const mock of mocks.reverse()) mock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const development of [false, true]) {
  test(`${development ? "DEV" : "production"} allows Luna Bigger Context and preserves it across account refresh`, async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-web-luna-setup-"));
    const configPath = join(root, "config.json");
    const existing = {
      ...configModule.defaultConfig("browser-only"),
      browserHost: "launcher" as const,
      solAvailable: false, extraHighAvailable: false, proAvailable: false,
      experimentalBiggerContext: true,
      ...(development ? { purpose: "dev-harness" as const } : {}),
    };
    writeFileSync(configPath, JSON.stringify(existing));
    let scannedSolAvailable = false;
    const save = spyOn(configModule, "saveConfig").mockImplementation(() => {});
    const integrate = spyOn(integration, "installCodexIntegration").mockImplementation(() => ({} as never));
    const mocks = [save, integrate,
      spyOn(configModule, "getConfigPath").mockReturnValue(configPath),
      spyOn(configModule, "loadConfigForSetup").mockImplementation(() => structuredClone(existing)),
      spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
      spyOn(service, "getServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
      spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
      spyOn(browserHost, "inspectLauncherBrowserHost").mockImplementation(async () => ({
        solAvailable: scannedSolAvailable, extraHighAvailable: false, proAvailable: false,
      }) as never),
    ];
    try {
      const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
      const port = listener.port!;
      await listener.stop(true);
      const options = { mode: "browser-only" as const, subagentProtocol: "native" as const, port,
        browserHostDescriptorPath: join(root, "launcher-browser.json"), acknowledgedUnofficial: true };
      const configure = development ? setupDevProfile : setup;
      await configure(options);
      expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ solAvailable: false, experimentalBiggerContext: true });
      await configure({ ...options, experimentalBiggerContext: true });
      expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ solAvailable: false, experimentalBiggerContext: true });
      // Refreshing a previously paid account preserves the explicitly enabled feature on Free.
      existing.solAvailable = true;
      await configure({ ...options, refreshAccountCapabilities: true });
      expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ solAvailable: false, experimentalBiggerContext: true });
      existing.solAvailable = false;
      await configure({ ...options, experimentalBiggerContext: false });
      expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ solAvailable: false, experimentalBiggerContext: false });
      expect(existing.experimentalBiggerContext).toBeTrue();
      scannedSolAvailable = true;
      await configure({ ...options, refreshAccountCapabilities: true, experimentalBiggerContext: true });
      expect(save.mock.calls.at(-1)?.[0]).toMatchObject({ solAvailable: true, experimentalBiggerContext: true });
    } finally {
      for (const mock of mocks.reverse()) mock.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test.skipIf(process.platform !== "darwin")("external service setup retains validation cleanup on success and failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-web-external-setup-"));
  const configPath = join(root, "config.json");
  const key = join(root, "runtime.key");
  writeFileSync(key, "fixture-runtime-key");
  writeFileSync(configPath, "{}");
  const existing = {
    ...configModule.defaultConfig("full"),
    subagentProtocol: "native" as const,
    acknowledgedUnofficialAt: new Date().toISOString(),
  };
  const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({
    service: "codex-chatgpt-web", status: "ok", mode: "full", version: existing.releaseVersion, accepting_turns: true,
  }) });
  existing.port = proxy.port!;
  const calls: string[] = [];
  let ready = true;
  let stopFails = false;
  const mocks = [
    spyOn(configModule, "getConfigPath").mockReturnValue(configPath),
    spyOn(configModule, "loadConfigForSetup").mockReturnValue(existing),
    spyOn(configModule, "saveConfig").mockImplementation(() => {}),
    spyOn(integration, "preflightCodexIntegration").mockImplementation(() => {}),
    spyOn(integration, "installCodexIntegration").mockImplementation(() => ({} as never)),
    spyOn(browserLogin, "browserLoginStateExists").mockReturnValue(true),
    spyOn(browserLogin, "storedBrowserLoginCapabilities").mockReturnValue({ solAvailable: true, extraHighAvailable: false, proAvailable: false, proPlan: false } as never),
    spyOn(service, "getServiceStatus").mockReturnValue({ installed: true, loaded: true } as never),
    spyOn(service, "assertServiceIdle").mockResolvedValue(undefined),
    spyOn(service, "installService").mockReturnValue({ installed: true, loaded: true } as never),
    spyOn(service, "restartService").mockResolvedValue({ installed: true, loaded: true } as never),
    spyOn(service, "removeLegacyRuntimeArtifacts").mockImplementation(() => {}),
    spyOn(tunnelService, "getTunnelServiceStatus").mockReturnValue({ installed: false, loaded: false } as never),
    spyOn(tunnelService, "installTunnelService").mockImplementation(() => { calls.push("service"); return { installed: true, loaded: true } as never; }),
    spyOn(tunnel, "managedRuntimeKeyPath").mockReturnValue(key),
    spyOn(tunnel, "installTunnelClient").mockResolvedValue(join(root, "tunnel-client")),
    spyOn(tunnel, "connectTunnel").mockImplementation(() => { calls.push("connect"); }),
    spyOn(tunnel, "waitForTunnelReady").mockImplementation(async () => { calls.push("ready"); return { ok: ready, detail: "fixture readiness" } as never; }),
    spyOn(tunnel, "stopTunnel").mockImplementation(() => {
      calls.push("stop");
      if (stopFails) throw new Error("fixture stop failure");
    }),
  ];
  try {
    const options = { mode: "full" as const, subagentProtocol: "native" as const, tunnelId: `tunnel_${"b".repeat(32)}`, restartService: true };
    expect((await setup(options)).tunnelReady).toBe(true);
    expect(calls).toEqual(["connect", "ready", "stop", "service", "ready"]);
    ready = false;
    calls.length = 0;
    await expect(setup(options)).rejects.toThrow("did not become healthy and ready");
    expect(calls).toEqual(["connect", "ready", "stop"]);
    stopFails = true;
    calls.length = 0;
    await expect(setup(options)).rejects.toThrow("fixture readiness; temporary tunnel cleanup also failed: fixture stop failure");
    expect(calls).toEqual(["connect", "ready", "stop"]);
  } finally {
    for (const mock of mocks.reverse()) mock.mockRestore();
    await proxy.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
