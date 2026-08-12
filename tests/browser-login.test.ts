import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserLoginStateExists,
  loginToChatGpt,
  loginVerificationMarkerPath,
  seedMacChromeLoginProfile,
} from "../src/browser-login";
import { CHATGPT_TEMPORARY_CHAT_URL } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

test("login uses one normal Chrome on a non-automation loopback port and never launches a verifier browser", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousLog = process.env.CODEX_LOGIN_ARG_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    const loginError = await loginToChatGpt(config, { timeoutMs: 1_000 }).then(
      () => undefined,
      error => error,
    );
    if (!existsSync(argsLog)) throw loginError;
    expect(loginError).toBeInstanceOf(Error);
    expect((loginError as Error).message).toContain("closed before its private login session became inspectable");

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const firstLaunch = launches[0] ?? "";
    expect(firstLaunch).toContain("--new-window");
    expect(firstLaunch).toContain("--user-data-dir=");
    expect(firstLaunch).toContain("--profile-directory=Default");
    expect(firstLaunch).toContain("--disable-extensions");
    expect(firstLaunch).toContain("--remote-debugging-address=127.0.0.1");
    const portMatch = firstLaunch.match(/--remote-debugging-port=(\d+)/);
    expect(portMatch).not.toBeNull();
    expect(Number(portMatch?.[1])).toBeGreaterThan(0);
    expect(firstLaunch).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(firstLaunch).not.toContain("--remote-debugging-pipe");
    expect(launches).toHaveLength(1);

    const source = readFileSync(new URL("../src/browser-login.ts", import.meta.url), "utf8");
    const loginSource = source.slice(
      source.indexOf("export async function loginToChatGpt"),
      source.indexOf("export function browserLoginStateExists"),
    );
    expect(source).toContain("chromium.connectOverCDP(transport");
    expect(source).toContain('session.send("Browser.close")');
    expect(source).not.toContain("launchPersistentContext(profileDir");
    expect(source).not.toContain("inspectStoredState");
    expect(source).toContain("browser.newContext({ storageState })");
    expect(loginSource).not.toContain("chromium.launch(");
    expect(loginSource).not.toContain("AutomationControlled");
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS login seeds only allowlisted ChatGPT/OpenAI cookies from Chrome's current profile", () => {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sqlite3")) return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-seed-"));
  const chromeRoot = join(root, "Chrome");
  const sourceProfile = join(chromeRoot, "Profile 1");
  const targetProfile = join(root, "login-profile");
  mkdirSync(sourceProfile, { recursive: true });
  writeFileSync(
    join(chromeRoot, "Local State"),
    `${JSON.stringify({ profile: { last_used: "Profile 1" } })}\n`,
  );
  const sourceCookies = join(sourceProfile, "Cookies");
  const create = spawnSync("/usr/bin/sqlite3", [sourceCookies, [
    "CREATE TABLE cookies(host_key TEXT);",
    "INSERT INTO cookies VALUES ('.chatgpt.com'), ('auth.openai.com'), ('.google.com'), ('example.com');",
  ].join("")]);
  expect(create.status).toBe(0);
  try {
    expect(seedMacChromeLoginProfile(targetProfile, { chromeUserDataDir: chromeRoot })).toBe(true);
    const targetCookies = join(targetProfile, "Default", "Cookies");
    expect(existsSync(targetCookies)).toBe(true);
    const read = spawnSync("/usr/bin/sqlite3", [
      targetCookies,
      "SELECT host_key FROM cookies ORDER BY host_key;",
    ], { encoding: "utf8" });
    expect(read.status).toBe(0);
    expect(read.stdout.trim().split("\n")).toEqual([".chatgpt.com", "auth.openai.com"]);
    expect(existsSync(join(targetProfile, "Default", "Login Data"))).toBe(false);
    expect(existsSync(join(targetProfile, "Default", "History"))).toBe(false);
    expect(existsSync(join(targetProfile, "Default", "Preferences"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stored login accepts legacy verification evidence and the new authenticated-capture marker only", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-state-"));
  try {
    const config = defaultConfig("browser-only");
    config.storageStatePath = join(root, "storage-state.json");
    writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: "2026-07-26T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({
        version: 2,
        authenticated: true,
        source: "authenticated-system-browser",
        capturedAt: "2026-08-10T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 2, authenticated: true, capturedAt: "2026-08-10T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("login endpoint timeout terminates its owned browser process before returning", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-timeout-"));
  const executable = join(root, "fake-chrome");
  const pidLog = join(root, "pid.log");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "trap 'exit 0' TERM INT HUP",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousPidLog = process.env.CODEX_LOGIN_PID_LOG;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  let pid: number | undefined;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    const error = await loginToChatGpt(config, { timeoutMs: 1_000 }).then(
      () => undefined,
      failure => failure,
    );
    pid = Number(readFileSync(pidLog, "utf8").trim());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("did not expose its private login session within 1000ms");
    expect(processIsRunning(pid)).toBe(false);
    expect(existsSync(join(root, "browser", "login-profile"))).toBe(false);
  } finally {
    if (previousPidLog === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPidLog;
    if (pid && processIsRunning(pid)) process.kill(-pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("login socket rejection terminates its owned browser and removes the private profile", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-socket-"));
  const executable = join(root, "fake-chrome");
  const pidLog = join(root, "pid.log");
  writeFileSync(executable, [
    "#!/usr/bin/env bun",
    'import { createServer } from "node:http";',
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.env.CODEX_LOGIN_PID_LOG, `${process.pid}\\n`);',
    'const portArg = process.argv.find(arg => arg.startsWith("--remote-debugging-port="));',
    'const port = Number(portArg?.slice("--remote-debugging-port=".length));',
    'if (!Number.isInteger(port) || port < 1) process.exit(2);',
    'const server = createServer((request, response) => {',
    '  if (request.url !== "/json/version") { response.writeHead(404).end(); return; }',
    '  response.setHeader("content-type", "application/json");',
    '  response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` }));',
    '});',
    'server.on("upgrade", (_request, socket) => socket.destroy());',
    'server.listen(port, "127.0.0.1");',
    'const stop = () => server.close(() => process.exit(0));',
    'process.on("SIGTERM", stop);',
    'process.on("SIGINT", stop);',
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousPidLog = process.env.CODEX_LOGIN_PID_LOG;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  let pid: number | undefined;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    const error = await loginToChatGpt(config, { timeoutMs: 1_000 }).then(
      () => undefined,
      failure => failure,
    );
    pid = Number(readFileSync(pidLog, "utf8").trim());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("rejected its loopback DevTools connection");
    expect(processIsRunning(pid)).toBe(false);
    expect(existsSync(join(root, "browser", "login-profile"))).toBe(false);
  } finally {
    if (previousPidLog === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPidLog;
    if (pid && processIsRunning(pid)) process.kill(-pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
