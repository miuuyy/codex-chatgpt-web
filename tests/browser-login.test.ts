import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserLoginStateExists, loginVerificationMarkerPath } from "../src/browser-login";
import { chromeLaunchArguments } from "../src/chrome-cdp";
import { defaultConfig } from "../src/config";

test("Chrome launches with a fixed loopback DevTools port and no WebDriver flags", () => {
  const config = defaultConfig("browser-only");
  const args = chromeLaunchArguments({
    executablePath: config.chromeExecutablePath,
    profilePath: config.chromeProfilePath,
    debugPort: config.chromeDebugPort,
  }, "https://chatgpt.com/?temporary-chat=true");
  expect(args).toContain(`--user-data-dir=${config.chromeProfilePath}`);
  expect(args).toContain("--remote-debugging-address=127.0.0.1");
  expect(args).toContain(`--remote-debugging-port=${config.chromeDebugPort}`);
  expect(args).not.toContain("--remote-debugging-port=0");
  expect(args).not.toContain("--remote-debugging-pipe");
  expect(args).not.toContain("--enable-automation");
  expect(args).not.toContain("--headless");
});

test("a private profile verification record is required and contains no cookies", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-state-"));
  try {
    const config = defaultConfig("browser-only");
    config.chromeProfilePath = join(root, "chrome-profile");
    config.storageStatePath = join(root, "browser", "session.json");
    mkdirSync(config.chromeProfilePath, { recursive: true });
    mkdirSync(join(root, "browser"), { recursive: true });
    writeFileSync(config.storageStatePath, `${JSON.stringify({
      version: 2,
      transport: "chrome-devtools",
      profilePath: config.chromeProfilePath,
      verifiedAt: "2026-07-27T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({
        version: 2,
        authenticated: true,
        transport: "chrome-devtools",
        verifiedAt: "2026-07-27T00:00:00.000Z",
        proAvailable: true,
      })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);
    expect(readFileSync(config.storageStatePath, "utf8")).not.toContain("cookie");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
