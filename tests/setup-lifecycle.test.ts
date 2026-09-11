import { expect, test } from "bun:test";
import { formatSetupReport, launcherCapabilityProbeRequired, setupProxyIsReady } from "../src/setup";

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
  };

  expect(launcherCapabilityProbeRequired(undefined)).toBe(true);
  expect(launcherCapabilityProbeRequired(verifiedLauncher as never)).toBe(false);
  expect(launcherCapabilityProbeRequired({
    browserHost: "launcher",
    proAvailable: false,
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

test("setup report prints the persisted integration mode instead of the omitted CLI flag", () => {
  const result = {
    mode: "browser-only" as const,
    configPath: "/tmp/config.json",
    loginCreated: false,
    serviceLoaded: false,
    tunnelReady: null,
    codexRestartRequired: false,
    connectorSetupRequired: false,
    integrationMode: "external-provider" as const,
  };
  const report = formatSetupReport(result);
  expect(report).toContain("Integration mode: external-provider");
  expect(report).toContain("Codex routing was not changed");
  expect(report).not.toContain("Integration mode: direct");
  expect(report).not.toContain("Restart the Codex app");
});
