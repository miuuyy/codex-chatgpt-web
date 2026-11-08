import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserLoginStateExists,
  captureSystemBrowserLogin,
  loginToChatGpt,
  loginVerificationMarkerPath,
  quitMacApplication,
  sanitizeBrowserLoginStorageState,
} from "../src/browser-login";
import { CHATGPT_NEW_CHAT_URL } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

test("login starts with normal Chrome and captures state in a headed Keychain-aware context", async () => {
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
    await loginToChatGpt(config, { timeoutMs: 100 }).catch(() => {});

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const firstLaunch = launches[0] ?? "";
    expect(firstLaunch).toContain("--new-window");
    expect(firstLaunch).toContain("--user-data-dir=");
    expect(firstLaunch).toContain(CHATGPT_NEW_CHAT_URL);
    expect(firstLaunch).not.toContain("--remote-debugging-pipe");
    expect(launches[1]).not.toContain("--headless");
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey login authenticates in normal Chrome before isolated offline pipe capture", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-passkey-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  const pidLog = join(root, "pid.log");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"",
    "case \"$*\" in",
    "  *--remote-debugging-pipe*) exit 0 ;;",
    "esac",
    "printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "trap 'exit 0' TERM INT HUP",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousArgs = process.env.CODEX_LOGIN_ARG_LOG;
  const previousPid = process.env.CODEX_LOGIN_PID_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "transfer", "storage-state.json");
    let continueLogin!: () => void;
    const continuation = new Promise<void>(resolve => { continueLogin = resolve; });
    let browserReady = false;
    const quitRequests: number[] = [];
    const capture = captureSystemBrowserLogin(config, { continuation, timeoutMs: 5_000,
      onBrowserReady: () => { browserReady = true; },
      quitBrowser: async pid => { quitRequests.push(pid); process.kill(pid, "SIGHUP"); } });
    for (let attempt = 0; attempt < 100 && !existsSync(pidLog); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(existsSync(pidLog)).toBe(true);
    expect(browserReady).toBe(true);
    continueLogin();
    const error = await capture.then(() => undefined, caught => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(quitRequests).toEqual([Number(readFileSync(pidLog, "utf8").trim())]);

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(launches).toHaveLength(2);
    expect(launches[0]).toContain("--new-window");
    expect(launches[0]).toContain("--user-data-dir=");
    expect(launches[0]).not.toContain("--remote-debugging-pipe");
    expect(launches[0]).not.toContain("--enable-automation");
    expect(launches[1]).toContain("--remote-debugging-pipe");
    expect(launches[1]).toContain("--headless");
    expect(launches[1]).toContain("--restore-last-session");
    expect(launches[1]).toContain("--disable-background-networking");
    expect(readdirSync(join(root, "transfer")).filter(name => name.startsWith("login-profile-"))).toEqual([]);
  } finally {
    if (previousArgs === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousArgs;
    if (previousPid === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPid;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey login refuses to capture a profile whose Chrome did not quit cleanly", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-passkey-unclean-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  const pidLog = join(root, "pid.log");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"",
    "printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o700 });
  const previousArgs = process.env.CODEX_LOGIN_ARG_LOG;
  const previousPid = process.env.CODEX_LOGIN_PID_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "transfer", "storage-state.json");
    let continueLogin!: () => void;
    const continuation = new Promise<void>(resolve => { continueLogin = resolve; });
    const capture = captureSystemBrowserLogin(config, { continuation, timeoutMs: 5_000,
      quitBrowser: async pid => { process.kill(pid, "SIGKILL"); } });
    for (let attempt = 0; attempt < 100 && !existsSync(pidLog); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    continueLogin();
    const error = await capture.then(() => undefined, caught => caught as Error);
    expect(error?.message).toContain("did not quit cleanly");
    expect(readFileSync(argsLog, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readdirSync(join(root, "transfer")).filter(name => name.startsWith("login-profile-"))).toEqual([]);
  } finally {
    if (previousArgs === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousArgs;
    if (previousPid === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPid;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey login trusts a clean Chrome exit even when the quit request fails", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-passkey-race-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  const pidLog = join(root, "pid.log");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"",
    "case \"$*\" in",
    "  *--remote-debugging-pipe*) exit 0 ;;",
    "esac",
    "printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "trap 'exit 0' HUP",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o700 });
  const previousArgs = process.env.CODEX_LOGIN_ARG_LOG;
  const previousPid = process.env.CODEX_LOGIN_PID_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "transfer", "storage-state.json");
    let continueLogin!: () => void;
    const continuation = new Promise<void>(resolve => { continueLogin = resolve; });
    const capture = captureSystemBrowserLogin(config, { continuation, timeoutMs: 5_000,
      quitBrowser: async pid => {
        process.kill(pid, "SIGHUP");
        throw new Error("application already stopped");
      } });
    for (let attempt = 0; attempt < 100 && !existsSync(pidLog); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    continueLogin();
    const error = await capture.then(() => undefined, caught => caught as Error);
    expect(error?.message).not.toContain("application already stopped");
    expect(readFileSync(argsLog, "utf8").trim().split("\n")).toHaveLength(2);
  } finally {
    if (previousArgs === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousArgs;
    if (previousPid === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPid;
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS quit request waits for app registration before reporting a missing application", async () => {
  if (process.platform !== "darwin") return;
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    const started = Date.now();
    const error = await quitMacApplication(child.pid!, "/bin/sleep", new AbortController().signal, 600)
      .then(() => undefined, caught => caught as Error);
    expect(error?.message).toContain("(missing)");
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
  } finally {
    child.kill("SIGKILL");
  }
});

test("macOS quit request refuses a process this login did not spawn", async () => {
  if (process.platform !== "darwin") return;
  const { execFileSync } = await import("node:child_process");
  const pid = Number(execFileSync("/bin/sh", ["-c", "/bin/sleep 30 >/dev/null 2>&1 & echo $!"]).toString().trim());
  try {
    const started = Date.now();
    const error = await quitMacApplication(pid, "/bin/sleep", new AbortController().signal, 10_000)
      .then(() => undefined, caught => caught as Error);
    expect(error?.message).toContain("(foreign)");
    expect(Date.now() - started).toBeLessThan(5_000);
  } finally {
    process.kill(pid, "SIGKILL");
  }
});

test("passkey login ignores a Continue that arrives after the sign-in deadline", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-passkey-late-"));
  const executable = join(root, "fake-chrome");
  writeFileSync(executable, [
    "#!/bin/sh",
    "trap 'sleep 1; exit 0' TERM",
    "while :; do sleep 0.1; done",
    "",
  ].join("\n"), { mode: 0o700 });
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "transfer", "storage-state.json");
    const quitRequests: number[] = [];
    const continuation = new Promise<void>(resolve => setTimeout(resolve, 700));
    const capture = captureSystemBrowserLogin(config, { continuation, timeoutMs: 400,
      quitBrowser: async pid => { quitRequests.push(pid); } });
    const error = await capture.then(() => undefined, caught => caught as Error);
    expect(error?.message).toContain("Timed out waiting for passkey sign-in");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(quitRequests).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS quit request stops retrying once ownership of the process ends", async () => {
  if (process.platform !== "darwin") return;
  const child = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    const ownership = new AbortController();
    const started = Date.now();
    setTimeout(() => ownership.abort(new Error("Chrome exited")), 300);
    const error = await quitMacApplication(child.pid!, "/bin/sleep", ownership.signal, 10_000)
      .then(() => undefined, caught => caught as Error);
    expect(error?.message).toBe("Chrome exited");
    expect(Date.now() - started).toBeLessThan(3_000);
  } finally {
    child.kill("SIGKILL");
  }
});

test("passkey login ends a pending quit request when the sign-in deadline expires", async () => {
  if (process.platform !== "darwin") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-passkey-deadline-"));
  const executable = join(root, "fake-chrome");
  const pidLog = join(root, "pid.log");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "trap 'exit 0' TERM",
    "while :; do sleep 1; done",
    "",
  ].join("\n"), { mode: 0o700 });
  const previousPid = process.env.CODEX_LOGIN_PID_LOG;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "transfer", "storage-state.json");
    let quitSignal: AbortSignal | undefined;
    let quitSettled = false;
    const capture = captureSystemBrowserLogin(config, { continuation: Promise.resolve(), timeoutMs: 1_000,
      quitBrowser: (_pid, signal) => {
        quitSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => { quitSettled = true; reject(signal.reason); }, { once: true });
        });
      } });
    const error = await capture.then(() => undefined, caught => caught as Error);
    expect(error?.message).toContain("Timed out waiting for passkey sign-in");
    expect(quitSignal?.aborted).toBe(true);
    expect(quitSettled).toBe(true);
  } finally {
    if (previousPid === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPid;
    rmSync(root, { recursive: true, force: true });
  }
});

test("passkey storage capture excludes identity-provider and partitioned state", () => {
  const cookie = (name: string, domain: string, extra = {}) => ({
    name,
    value: name,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
    ...extra,
  });
  const state = sanitizeBrowserLoginStorageState({
    cookies: [
      cookie("chatgpt", ".chatgpt.com"),
      cookie("openai", "auth.openai.com"),
      cookie("partitioned", ".chatgpt.com", { partitionKey: "https://accounts.google.com" }),
      cookie("google", ".accounts.google.com"),
      cookie("lookalike", ".chatgpt.com.attacker.example"),
    ],
    origins: [
      { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
      { origin: "https://accounts.google.com", localStorage: [{ name: "idp", value: "removed" }] },
    ],
  });
  expect(state.cookies.map(value => value.name)).toEqual(["chatgpt", "openai"]);
  expect(state.origins).toEqual([
    { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "kept" }] },
  ]);
});

test("a storage-state file is not trusted without a verification marker", () => {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
