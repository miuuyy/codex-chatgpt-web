import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserContextOptions } from "playwright-core";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import {
  browserName,
  browserType,
  ensureBrowserExecutable,
  systemFirefoxExecutable,
  type BrowserEngine,
} from "./browser-engine";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_TEMPORARY_CHAT_URL,
  detectChatGptProCapability,
} from "./chatgpt-session";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  proAvailable: boolean;
}

interface LoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  proAvailable?: boolean;
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

function writeVerificationMarker(storageStatePath: string, proAvailable: boolean): void {
  const marker: LoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    proAvailable,
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<{ proAvailable: boolean; url: string }> {
  const verifierBrowser = await browserType(config.browserEngine).launch({
    executablePath: ensureBrowserExecutable(config),
    headless: process.platform === "win32",
    ...(config.browserEngine === "chromium" ? {
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
      args: ["--no-first-run", "--no-default-browser-check"],
    } : {}),
  });
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const verifierPage = await verifierContext.newPage();
      await verifierPage.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await verifierPage.getByRole("textbox", { name: "Chat with ChatGPT" }).waitFor({ state: "visible", timeout: 60_000 });
      await assertAuthenticatedChatGptPage(verifierPage);
      await assertTemporaryChatPage(verifierPage);
      return { proAvailable: await detectChatGptProCapability(verifierPage), url: verifierPage.url() };
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<{ proAvailable: boolean }> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await inspectStoredState(config, config.storageStatePath);
  writeVerificationMarker(config.storageStatePath, inspected.proAvailable);
  return { proAvailable: inspected.proAvailable };
}

export function storedBrowserLoginCapabilities(config: AppConfig): { proAvailable?: boolean } {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    return typeof marker.proAvailable === "boolean" ? { proAvailable: marker.proAvailable } : {};
  } catch {
    return {};
  }
}

function removeVerifiedLoginProfile(config: AppConfig, profileDir: string): void {
  if (!browserLoginStateExists(config)) return;
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Warning: verified login profile cleanup was deferred: ${detail}\n`);
  }
}

export function browserLoginArguments(
  engine: BrowserEngine,
  profileDir: string,
  platform = process.platform,
): string[] {
  return engine === "firefox"
    ? ["-no-remote", "-profile", profileDir, "-new-window", CHATGPT_TEMPORARY_CHAT_URL]
    : [
        `--user-data-dir=${profileDir}`,
        "--new-window",
        "--disable-background-mode",
        ...(platform === "win32" ? ["--remote-debugging-port=0", "--remote-allow-origins=*"] : []),
        "--no-first-run",
        "--no-default-browser-check",
        CHATGPT_TEMPORARY_CHAT_URL,
      ];
}

export function loginChromeArguments(profileDir: string, platform = process.platform): string[] {
  return browserLoginArguments("chromium", profileDir, platform);
}

export function normalLoginBrowserExecutable(
  engine: BrowserEngine,
  automationExecutable: string,
  platform = process.platform,
): string {
  const systemFirefox = systemFirefoxExecutable(platform);
  if (engine === "firefox" && systemFirefox && existsSync(systemFirefox)) return systemFirefox;
  return automationExecutable;
}

async function waitForWindowsDevToolsPort(
  profileDir: string,
  loginExit: Promise<number>,
  timeoutMs: number,
): Promise<number> {
  const path = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const port = Number(readFileSync(path, "utf8").split(/\r?\n/, 1)[0]);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
    }
    const exited = await Promise.race([
      loginExit.then(code => ({ exited: true as const, code })),
      new Promise<{ exited: false }>(resolveWait => setTimeout(() => resolveWait({ exited: false }), 100)),
    ]);
    if (exited.exited) throw new Error(`Normal Chrome login window exited before CDP became ready (status ${exited.code})`);
  }
  throw new Error("Normal Chrome login window did not expose its local DevTools endpoint");
}

interface CdpResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

export function isChatGptCookieDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^\./, "");
  return normalized === "chatgpt.com"
    || normalized.endsWith(".chatgpt.com")
    || normalized === "openai.com"
    || normalized.endsWith(".openai.com");
}

async function captureWindowsLoginState(
  port: number,
  timeoutMs: number,
): Promise<{ state: NonNullable<BrowserContextOptions["storageState"]>; url: string }> {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => {
    if (!response.ok) throw new Error(`Chrome DevTools target discovery failed: HTTP ${response.status}`);
    return response.json() as Promise<Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>>;
  });
  const target = targets.find(candidate =>
    candidate.type === "page"
    && candidate.url?.startsWith("https://chatgpt.com")
    && candidate.webSocketDebuggerUrl
  );
  if (!target?.webSocketDebuggerUrl) throw new Error("Dedicated Chrome did not expose the ChatGPT page target");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (reason: Error) => void;
  }>();
  socket.addEventListener("message", async event => {
    let message: CdpResponse;
    try {
      const raw = typeof event.data === "string"
        ? event.data
        : event.data instanceof ArrayBuffer
          ? new TextDecoder().decode(event.data)
          : event.data instanceof Blob
            ? await event.data.text()
            : new TextDecoder().decode(event.data as ArrayBufferView);
      message = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || "Chrome DevTools command failed"));
    else request.resolve(message.result ?? {});
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) request.reject(new Error("Chrome DevTools connection closed"));
    pending.clear();
  });
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", () => resolveOpen(), { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("Chrome DevTools connection failed")), { once: true });
  });
  const command = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolveCommand, rejectCommand) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        rejectCommand(new Error(`Chrome DevTools command timed out: ${method}`));
      }, 10_000);
      pending.set(id, {
        resolve: value => {
          clearTimeout(timeout);
          resolveCommand(value);
        },
        reject: error => {
          clearTimeout(timeout);
          rejectCommand(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  try {
    const deadline = Date.now() + timeoutMs;
    let pageUrl = CHATGPT_TEMPORARY_CHAT_URL;
    while (Date.now() < deadline) {
      const evaluated = await command("Runtime.evaluate", {
        expression: `(() => {
          const visible = element => Boolean(element && element.getClientRects().length);
          const composer = [...document.querySelectorAll('[role="textbox"], [data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"]')]
            .some(element => visible(element) && (element.getAttribute('aria-label') === 'Chat with ChatGPT'
              || element.getAttribute('data-testid') === 'prompt-textarea'
              || element.getAttribute('data-lexical-editor') === 'true'));
          const loggedOut = [...document.querySelectorAll('button,a')]
            .some(element => visible(element) && element.textContent?.trim() === 'Log in');
          const temporary = new URL(location.href).searchParams.get('temporary-chat') === 'true'
            && [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].some(element => visible(element) && element.textContent?.trim() === 'Temporary Chat');
          return { composer, loggedOut, temporary, url: location.href };
        })()`,
        returnByValue: true,
      });
      const remote = evaluated.result as { value?: { composer?: boolean; loggedOut?: boolean; temporary?: boolean; url?: string } } | undefined;
      const value = remote?.value;
      if (value?.url) pageUrl = value.url;
      if (value?.composer && !value.loggedOut && value.temporary) {
        const cookieResult = await command("Network.getAllCookies");
        const rawCookies = Array.isArray(cookieResult.cookies) ? cookieResult.cookies as Array<Record<string, unknown>> : [];
        const cookies = rawCookies
          .filter(cookie => isChatGptCookieDomain(String(cookie.domain ?? "")))
          .map(cookie => ({
            name: String(cookie.name ?? ""),
            value: String(cookie.value ?? ""),
            domain: String(cookie.domain ?? ""),
            path: String(cookie.path ?? "/"),
            expires: typeof cookie.expires === "number" && cookie.expires > 0 ? cookie.expires : -1,
            httpOnly: cookie.httpOnly === true,
            secure: cookie.secure === true,
            sameSite: cookie.sameSite === "Strict" || cookie.sameSite === "Lax" || cookie.sameSite === "None"
              ? cookie.sameSite
              : "Lax",
          }));
        return {
          state: { cookies, origins: [] } as NonNullable<BrowserContextOptions["storageState"]>,
          url: pageUrl,
        };
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    throw new Error("The authenticated ChatGPT page did not produce a verified Temporary Chat composer");
  } finally {
    socket.close();
  }
}

async function captureWindowsFirefoxState(
  profileDir: string,
): Promise<NonNullable<BrowserContextOptions["storageState"]>> {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(profileDir, "cookies.sqlite"), { readOnly: true });
  try {
    const rows = database.prepare(`
      select name, value, host, path, expiry, isSecure, isHttpOnly, sameSite
      from moz_cookies
    `).all() as Array<Record<string, unknown>>;
    const cookies = rows
      .filter(row => isChatGptCookieDomain(String(row.host ?? "")))
      .map(row => {
        const rawExpiry = Number(row.expiry);
        const expires = Number.isFinite(rawExpiry) && rawExpiry > 0
          ? rawExpiry > 100_000_000_000 ? rawExpiry / 1_000 : rawExpiry
          : -1;
        const sameSite = Number(row.sameSite) === 2 ? "Strict" : Number(row.sameSite) === 1 ? "Lax" : "None";
        return {
          name: String(row.name ?? ""),
          value: String(row.value ?? ""),
          domain: String(row.host ?? ""),
          path: String(row.path ?? "/"),
          expires,
          httpOnly: Number(row.isHttpOnly) === 1,
          secure: Number(row.isSecure) === 1,
          sameSite,
        };
      });
    return { cookies, origins: [] } as NonNullable<BrowserContextOptions["storageState"]>;
  } finally {
    database.close();
  }
}

export async function loginToChatGpt(
  config: AppConfig,
  options: { timeoutMs?: number } = {},
): Promise<BrowserLoginResult> {
  const executable = ensureBrowserExecutable(config);
  const loginExecutable = normalLoginBrowserExecutable(config.browserEngine, executable);
  const name = browserName(config.browserEngine);
  const profileDir = join(dirname(config.storageStatePath), "login-profile");
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32" && config.browserEngine === "chromium") {
    rmSync(join(profileDir, "DevToolsActivePort"), { force: true });
  }
  process.stdout.write(
    process.platform === "win32" && config.browserEngine === "chromium"
      ? "A dedicated Chromium window is open. Sign in to ChatGPT and keep it open; setup will verify and close it automatically.\n"
      : `A normal ${name} window is open. Sign in to ChatGPT, confirm that the composer is visible, then quit this dedicated ${name} instance completely.\n`,
  );
  const loginBrowser = spawn(
    loginExecutable,
    browserLoginArguments(config.browserEngine, profileDir),
    { env: process.env, stdio: "ignore" },
  );
  const loginExit = new Promise<number>((resolveExit, rejectExit) => {
    loginBrowser.once("error", rejectExit);
    loginBrowser.once("exit", code => resolveExit(code ?? 1));
  });
  if (process.platform === "win32" && config.browserEngine === "chromium") {
    const port = await waitForWindowsDevToolsPort(profileDir, loginExit, 30_000);
    let captured = false;
    try {
      const capturedState = await captureWindowsLoginState(port, options.timeoutMs ?? 300_000);
      captured = true;
      loginBrowser.kill();
      await loginExit.catch(() => {});
      const inspected = await inspectStoredState(config, capturedState.state);
      atomicWriteFile(config.storageStatePath, `${JSON.stringify(capturedState.state)}\n`);
      writeVerificationMarker(config.storageStatePath, inspected.proAvailable);
      return { storageStatePath: config.storageStatePath, accountSurfaceUrl: capturedState.url, proAvailable: inspected.proAvailable };
    } finally {
      if (!captured) loginBrowser.kill();
      removeVerifiedLoginProfile(config, profileDir);
    }
  }

  const loginStatus = await loginExit;
  if (loginStatus !== 0) throw new Error(`Normal ${name} login window exited with status ${loginStatus}`);
  if (process.platform === "win32" && config.browserEngine === "firefox") {
    try {
      const state = await captureWindowsFirefoxState(profileDir);
      const inspected = await inspectStoredState(config, state);
      atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
      writeVerificationMarker(config.storageStatePath, inspected.proAvailable);
      return {
        storageStatePath: config.storageStatePath,
        accountSurfaceUrl: inspected.url,
        proAvailable: inspected.proAvailable,
      };
    } finally {
      removeVerifiedLoginProfile(config, profileDir);
    }
  }

  const context = await browserType(config.browserEngine).launchPersistentContext(profileDir, {
    executablePath: executable,
    headless: false,
    ...(config.browserEngine === "chromium" ? {
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
      args: ["--no-first-run", "--no-default-browser-check"],
    } : {}),
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" }).or(
      page.locator('[data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"]'),
    ).first();
    try {
      await composer.waitFor({ state: "visible", timeout: options.timeoutMs ?? 60_000 });
    } catch {
      throw new Error("The authenticated ChatGPT page did not produce a visible composer");
    }
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    const state = await context.storageState();

    const inspected = await inspectStoredState(config, state);
    atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
    writeVerificationMarker(config.storageStatePath, inspected.proAvailable);
    return { storageStatePath: config.storageStatePath, accountSurfaceUrl: page.url(), proAvailable: inspected.proAvailable };
  } finally {
    await context.close();
    removeVerifiedLoginProfile(config, profileDir);
  }
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LoginVerificationMarker>;
    return marker.version === 1 && marker.authenticated === true && typeof marker.verifiedAt === "string";
  } catch {
    return false;
  }
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  const browser = await browserType(config.browserEngine).launch({
    executablePath: ensureBrowserExecutable(config),
    headless: true,
    ...(config.browserEngine === "chromium" ? { args: ["--no-first-run", "--no-default-browser-check"] } : {}),
  });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    if (await page.evaluate(() => document.readyState) !== "complete") throw new Error("Browser page did not reach complete state");
  } finally {
    await browser.close();
  }
}
