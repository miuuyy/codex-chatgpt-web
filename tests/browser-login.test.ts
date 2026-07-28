import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserLoginArguments,
  browserLoginStateExists,
  isChatGptCookieDomain,
  loginChromeArguments,
  loginToChatGpt,
  loginVerificationMarkerPath,
  normalLoginBrowserExecutable,
} from "../src/browser-login";
import { CHATGPT_TEMPORARY_CHAT_URL } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

test("login uses a dedicated normal Chrome profile and opens Temporary Chat", () => {
  const args = loginChromeArguments("C:\\dedicated-login-profile", "linux");
  expect(args).toContain("--new-window");
  expect(args).toContain("--user-data-dir=C:\\dedicated-login-profile");
  expect(args).toContain(CHATGPT_TEMPORARY_CHAT_URL);
  expect(args).not.toContain("--remote-debugging-pipe");
  expect(args).not.toContain("--headless");
});

test("Windows login exposes only the dedicated profile through a local CDP port", () => {
  const args = loginChromeArguments("C:\\dedicated-login-profile", "win32");
  expect(args).toContain("--user-data-dir=C:\\dedicated-login-profile");
  expect(args).toContain("--remote-debugging-port=0");
  expect(args).toContain("--remote-allow-origins=*");
  expect(args).not.toContain("--remote-debugging-pipe");
});

test("Firefox login uses a dedicated profile without Chromium flags", () => {
  expect(browserLoginArguments("firefox", "C:\\dedicated-login-profile", "win32")).toEqual([
    "-no-remote",
    "-profile",
    "C:\\dedicated-login-profile",
    "-new-window",
    CHATGPT_TEMPORARY_CHAT_URL,
  ]);
});

test("Windows Firefox login prefers the installed system browser", () => {
  expect(normalLoginBrowserExecutable("firefox", "C:\\playwright\\firefox", "win32"))
    .toBe("C:\\Program Files\\Mozilla Firefox\\firefox.exe");
});

test("captured browser state is restricted to ChatGPT and OpenAI cookie domains", () => {
  expect(isChatGptCookieDomain(".chatgpt.com")).toBe(true);
  expect(isChatGptCookieDomain("auth.openai.com")).toBe(true);
  expect(isChatGptCookieDomain(".google.com")).toBe(false);
  expect(isChatGptCookieDomain("notopenai.com")).toBe(false);
});

test.skipIf(process.platform === "win32")("login starts the prepared Chrome command on POSIX", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousLog = process.env.CODEX_LOGIN_ARG_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  try {
    const config = defaultConfig("browser-only");
    config.browserExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    await loginToChatGpt(config, { timeoutMs: 100 }).catch(() => {});

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const firstLaunch = launches[0] ?? "";
    expect(firstLaunch).toContain("--new-window");
    expect(firstLaunch).toContain("--user-data-dir=");
    expect(firstLaunch).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(firstLaunch).not.toContain("--remote-debugging-pipe");
    expect(launches[1]).not.toContain("--headless");
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
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
