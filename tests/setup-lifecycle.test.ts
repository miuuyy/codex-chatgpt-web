import { expect, test } from "bun:test";
import { launcherCapabilityProbeRequired, setupProxyIsReady, trustedLauncherMigrationCanReuseCapabilities } from "../src/setup";

const config = {
  mode: "browser-only" as const,
  releaseVersion: "0.2.0",
};

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
    proAvailable: false,
  } as never;

  expect(launcherCapabilityProbeRequired(undefined)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    browserHost: "launcher",
    proAvailable: false,
  } as never)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher, true)).toBe(true);
});


test("trusted launcher migration reuses stored capabilities without requiring a live ChatGPT session", () => {
  const verifiedLauncher = {
    browserHost: "launcher",
    solAvailable: true,
    proAvailable: false,
  } as never;

  expect(trustedLauncherMigrationCanReuseCapabilities(verifiedLauncher, false, true)).toBe(true);
  expect(trustedLauncherMigrationCanReuseCapabilities(verifiedLauncher, true, true)).toBe(false);
  expect(trustedLauncherMigrationCanReuseCapabilities(verifiedLauncher, false, false)).toBe(false);
  expect(trustedLauncherMigrationCanReuseCapabilities(undefined, false, true)).toBe(false);
});
