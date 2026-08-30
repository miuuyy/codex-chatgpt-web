import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserLoginStateExists,
  captureSystemBrowserLogin,
  loginToChatGpt,
  loginVerificationMarkerPath,
  sanitizeBrowserLoginStorageState,
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

function automaticLoginProfiles(parent: string): string[] {
  try {
    return readdirSync(parent).filter(entry => entry.startsWith("login-profile-"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

test("terminal login keeps the ordinary user-closed Chrome flow", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-terminal-login-"));
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
    const loginError = await loginToChatGpt(config, { timeoutMs: 5_000 }).then(
      () => undefined,
      error => error,
    );
    expect(loginError).toBeInstanceOf(Error);

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(launches).toHaveLength(2);
    expect(launches[0]).toContain("--new-window");
    expect(launches[0]).toContain("--user-data-dir=");
    expect(launches[0]).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(launches[0]).not.toContain("--remote-debugging-pipe");
    expect(launches[0]).not.toContain("--remote-debugging-port");
    expect(launches.every(launch => !launch.includes("--no-sandbox"))).toBe(true);

    const source = readFileSync(new URL("../src/browser-login.ts", import.meta.url), "utf8");
    const loginSource = source.slice(
      source.indexOf("export async function loginToChatGpt("),
      source.indexOf("export function browserLoginStateExists"),
    );
    expect(loginSource).toContain("const loginBrowser = spawn(config.chromeExecutablePath");
    expect(loginSource).toContain("then quit this dedicated Chrome instance completely");
    expect(loginSource).toContain("await chromium.launchPersistentContext(profileDir");
    expect(loginSource).not.toContain("captureSystemBrowserLogin(config, options)");
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic capture authenticates normally before using an owned DevTools pipe", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-pipe-login-"));
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
    // The full suite starts many subprocesses in parallel; allow enough scheduling headroom for
    // the fake executable to report its immediate clean exit.
    const captureError = await captureSystemBrowserLogin(config, { timeoutMs: 5_000 }).then(
      () => undefined,
      error => error,
    );
    if (!existsSync(argsLog)) throw captureError;
    expect(captureError).toBeInstanceOf(Error);

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const loginLaunch = launches[0] ?? "";
    const captureLaunch = launches[1] ?? "";
    expect(launches).toHaveLength(2);
    expect(loginLaunch).toContain("--user-data-dir=");
    expect(loginLaunch).toContain("--new-window");
    expect(loginLaunch).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(loginLaunch).not.toContain("--remote-debugging-pipe");
    expect(loginLaunch).not.toContain("--remote-debugging-port");
    expect(loginLaunch).not.toContain("--remote-debugging-address");
    expect(loginLaunch).not.toContain("--no-sandbox");
    expect(loginLaunch).not.toContain("--enable-automation");
    expect(loginLaunch).not.toContain("--password-store=basic");
    expect(loginLaunch).not.toContain("--use-mock-keychain");
    expect(captureLaunch).toContain("--user-data-dir=");
    expect(captureLaunch).toContain("--remote-debugging-pipe");
    expect(captureLaunch).not.toContain("--remote-debugging-port");
    expect(captureLaunch).not.toContain("--remote-debugging-address");
    expect(captureLaunch).not.toContain("--no-sandbox");
    expect(captureLaunch).not.toContain("--enable-automation");
    expect(captureLaunch).not.toContain("--password-store=basic");
    expect(captureLaunch).not.toContain("--use-mock-keychain");
    expect(automaticLoginProfiles(join(root, "browser"))).toEqual([]);

    const source = readFileSync(new URL("../src/browser-login.ts", import.meta.url), "utf8");
    const captureSource = source.slice(
      source.indexOf("export async function captureSystemBrowserLogin"),
      source.indexOf("export async function loginToChatGptWithSystemBrowserCapture"),
    );
    const writerSource = source.slice(
      source.indexOf("export async function loginToChatGptWithSystemBrowserCapture"),
      source.indexOf("export async function loginToChatGpt("),
    );
    expect(captureSource).toContain("const loginBrowser = spawn(config.chromeExecutablePath");
    expect(captureSource).toContain("return to the launcher and choose Continue");
    expect(captureSource).toContain("chromium.launchPersistentContext(profileDir");
    expect(captureSource.indexOf("const loginBrowser = spawn(config.chromeExecutablePath"))
      .toBeLessThan(captureSource.indexOf("chromium.launchPersistentContext(profileDir"));
    expect(captureSource).toContain("await initialPage.goto(CHATGPT_TEMPORARY_CHAT_URL");
    expect(captureSource).toContain('context.route("**/*"');
    expect(captureSource).toContain("captureComplete: true");
    expect(captureSource).toContain('source: "isolated-normal-browser-profile"');
    expect(captureSource).toContain("sanitizeBrowserLoginStorageState(await context.storageState())");
    expect(captureSource).toContain("if (context && !context.isClosed()) await context.close()");
    expect(captureSource).not.toContain("waitForAuthenticatedTemporaryChat(context");
    expect(captureSource).not.toContain("verifyCapturedStateInOwnedBrowser(");
    expect(captureSource).not.toContain("connectOverCDP");
    expect(captureSource).not.toContain("remote-debugging-port");
    expect(writerSource).toContain("sanitizeBrowserLoginStorageState(capture.storageState)");
    expect(writerSource).toContain("atomicWriteFile(config.storageStatePath");
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("launcher continuation closes only the normal login process before pipe capture", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-continued-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  const countFile = join(root, "count");
  const pidLog = join(root, "pid.log");
  writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"",
    "if [ ! -e \"$CODEX_LOGIN_COUNT_FILE\" ]; then",
    "  : > \"$CODEX_LOGIN_COUNT_FILE\"",
    "  printf '%s\\n' \"$$\" > \"$CODEX_LOGIN_PID_LOG\"",
    "  trap 'exit 0' TERM INT HUP",
    "  while :; do sleep 1; done",
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previous = {
    args: process.env.CODEX_LOGIN_ARG_LOG,
    count: process.env.CODEX_LOGIN_COUNT_FILE,
    pid: process.env.CODEX_LOGIN_PID_LOG,
  };
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  process.env.CODEX_LOGIN_COUNT_FILE = countFile;
  process.env.CODEX_LOGIN_PID_LOG = pidLog;
  let continueLogin!: () => void;
  let pid: number | undefined;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    const continuation = new Promise<void>((resolve) => { continueLogin = resolve; });
    const capture = captureSystemBrowserLogin(config, { timeoutMs: 5_000, continuation });
    for (let attempt = 0; attempt < 100 && !existsSync(pidLog); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    pid = Number(readFileSync(pidLog, "utf8").trim());
    expect(processIsRunning(pid)).toBe(true);
    expect(readFileSync(argsLog, "utf8").trim().split("\n")).toHaveLength(1);

    continueLogin();
    const captureError = await capture.then(() => undefined, error => error);
    expect(captureError).toBeInstanceOf(Error);
    expect(processIsRunning(pid)).toBe(false);
    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    expect(launches).toHaveLength(2);
    expect(launches[0]).not.toContain("--remote-debugging-pipe");
    expect(launches[1]).toContain("--remote-debugging-pipe");
    expect(automaticLoginProfiles(join(root, "browser"))).toEqual([]);
  } finally {
    if (previous.args === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previous.args;
    if (previous.count === undefined) delete process.env.CODEX_LOGIN_COUNT_FILE;
    else process.env.CODEX_LOGIN_COUNT_FILE = previous.count;
    if (previous.pid === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previous.pid;
    if (pid && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("storage-state sanitization retains bounded cookies and only the canonical ChatGPT origin", () => {
  const cookie = (name: string, domain: string, value = name) => ({
    name,
    value,
    domain,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
  });
  const input = {
    cookies: [
      cookie("chatgpt-session", ".chatgpt.com"),
      cookie("openai-session", "auth.openai.com"),
      cookie("case-normalized", ".CHATGPT.COM"),
      { ...cookie("partitioned", ".chatgpt.com"), partitionKey: "https://accounts.google.com" },
      cookie("google-idp", ".accounts.google.com"),
      cookie("lookalike", ".chatgpt.com.attacker.example"),
      cookie("suffix-lookalike", "notopenai.com"),
    ],
    origins: [
      { origin: "https://chatgpt.com", localStorage: [{ name: "chat", value: "retained" }] },
      { origin: "https://auth.openai.com", localStorage: [{ name: "auth", value: "retained" }] },
      { origin: "https://accounts.google.com", localStorage: [{ name: "idp", value: "removed" }] },
      { origin: "http://chatgpt.com", localStorage: [{ name: "plaintext", value: "removed" }] },
      { origin: "https://chatgpt.com.attacker.example", localStorage: [{ name: "lookalike", value: "removed" }] },
      { origin: "https://user@chatgpt.com", localStorage: [{ name: "credentialed", value: "removed" }] },
      { origin: "not a URL", localStorage: [{ name: "invalid", value: "removed" }] },
    ],
  };

  const first = sanitizeBrowserLoginStorageState(input);
  const second = sanitizeBrowserLoginStorageState(input);
  expect(first).toEqual(second);
  expect(first).toEqual({
    cookies: input.cookies.slice(0, 3),
    origins: input.origins.slice(0, 1),
  });
  expect(first).not.toBe(input);
  expect(first.cookies[0]).not.toBe(input.cookies[0]);
  expect(first.origins[0]).not.toBe(input.origins[0]);
  expect(first.origins[0].localStorage[0]).not.toBe(input.origins[0].localStorage[0]);
  expect(input.cookies).toHaveLength(7);
  expect(input.origins).toHaveLength(7);
});

test("stored login accepts legacy verification evidence and authenticated system-browser capture evidence only", () => {
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

test("capture startup timeout removes the isolated profile and writes no authentication state", async () => {
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
    const error = await captureSystemBrowserLogin(config, { timeoutMs: 1_000 }).then(
      () => undefined,
      failure => failure,
    );
    pid = Number(readFileSync(pidLog, "utf8").trim());
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Timed out waiting for the dedicated normal Chrome/Chromium login window to close",
    );
    expect(automaticLoginProfiles(join(root, "browser"))).toEqual([]);
    expect(existsSync(config.storageStatePath)).toBe(false);
    expect(existsSync(loginVerificationMarkerPath(config.storageStatePath))).toBe(false);
  } finally {
    if (previousPidLog === undefined) delete process.env.CODEX_LOGIN_PID_LOG;
    else process.env.CODEX_LOGIN_PID_LOG = previousPidLog;
    if (pid && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
