import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  chromium,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright-core";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_TEMPORARY_CHAT_URL,
  detectChatGptAccountCapabilities,
} from "./chatgpt-session";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  solAvailable: boolean;
  proAvailable: boolean;
}

export interface AuthenticatedSystemBrowserLoginMarker {
  version: 2;
  authenticated: true;
  source: "authenticated-system-browser";
  capturedAt: string;
  solAvailable?: boolean;
  proAvailable?: boolean;
}

export interface SystemBrowserLoginCaptureMarker {
  version: 3;
  captureComplete: true;
  source: "isolated-normal-browser-profile";
  capturedAt: string;
}

export type BrowserLoginStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface SystemBrowserLoginCapture {
  storageState: BrowserLoginStorageState;
  verificationMarker: SystemBrowserLoginCaptureMarker;
}

export interface SystemBrowserLoginCaptureResult {
  storageStatePath: string;
}

export interface BrowserLoginOptions {
  timeoutMs?: number;
  continuation?: Promise<void>;
}

interface LegacyLoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  solAvailable?: boolean;
  proAvailable?: boolean;
}

type LoginVerificationMarker = LegacyLoginVerificationMarker
  | AuthenticatedSystemBrowserLoginMarker
  | SystemBrowserLoginCaptureMarker;

const LOGIN_BROWSER_START_TIMEOUT_MS = 30_000;
const LOGIN_BROWSER_STOP_TIMEOUT_MS = 5_000;
const LOGIN_COMPLETION_TIMEOUT_MS = 10 * 60_000;
const LOGIN_POLL_INTERVAL_MS = 100;
const LOGIN_STORAGE_ROOT_DOMAINS = ["chatgpt.com", "openai.com"] as const;

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function browserProcessExited(browser: ChildProcess): boolean {
  return browser.exitCode !== null || browser.signalCode !== null;
}

async function waitForBrowserProcessExit(browser: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (browserProcessExited(browser)) return true;
  return await new Promise(resolveExit => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.off("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    browser.once("exit", onExit);
    if (browserProcessExited(browser)) finish(true);
  });
}

async function stopOwnedLoginBrowser(browser: ChildProcess): Promise<void> {
  if (browserProcessExited(browser) || !Number.isInteger(browser.pid)) return;
  const gracefulExit = waitForBrowserProcessExit(browser, LOGIN_BROWSER_STOP_TIMEOUT_MS);
  if (!browser.kill() && !browserProcessExited(browser)) {
    throw new Error("The dedicated normal Chrome/Chromium process refused termination");
  }
  if (await gracefulExit) return;

  const forcedExit = waitForBrowserProcessExit(browser, LOGIN_BROWSER_STOP_TIMEOUT_MS);
  if (!browser.kill("SIGKILL") && !browserProcessExited(browser)) {
    throw new Error("The dedicated normal Chrome/Chromium process refused forced termination");
  }
  if (!await forcedExit) {
    throw new Error("The dedicated normal Chrome/Chromium process did not exit after forced termination");
  }
}

function isAllowedLoginStorageHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(normalized)
    || normalized.startsWith(".")
    || normalized.endsWith(".")
    || normalized.includes("..")) return false;
  try {
    const parsed = new URL(`https://${normalized}/`);
    if (parsed.hostname !== normalized
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash) return false;
  } catch {
    return false;
  }
  return LOGIN_STORAGE_ROOT_DOMAINS.some(root => normalized === root || normalized.endsWith(`.${root}`));
}

function isAllowedLoginStorageOrigin(origin: string): boolean {
  return origin === new URL(CHATGPT_TEMPORARY_CHAT_URL).origin;
}

export function sanitizeBrowserLoginStorageState(
  storageState: BrowserLoginStorageState,
): BrowserLoginStorageState {
  return {
    cookies: storageState.cookies
      // A partitioned cookie cannot be represented by Playwright's portable storage-state type.
      // Dropping it avoids silently flattening third-party partition scope into a normal cookie.
      .filter(cookie => !Object.prototype.hasOwnProperty.call(cookie, "partitionKey")
        && isAllowedLoginStorageHost(cookie.domain.replace(/^\.+/, "")))
      .map(cookie => ({ ...cookie })),
    origins: storageState.origins
      .filter(origin => isAllowedLoginStorageOrigin(origin.origin))
      .map(origin => ({
        ...origin,
        localStorage: origin.localStorage.map(item => ({ ...item })),
      })),
  };
}

async function isAuthenticatedTemporaryChatPage(page: Page): Promise<boolean> {
  try {
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    return await hasAuthenticatedChatGptSession(page);
  } catch {
    return false;
  }
}

async function hasAuthenticatedChatGptSession(page: Page): Promise<boolean> {
  try {
    const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
    if (new URL(page.url()).origin !== expected.origin) return false;
    return await page.evaluate(async ({ expectedOrigin }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch("/api/auth/session", {
          credentials: "include",
          cache: "no-store",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const responseUrl = new URL(response.url);
        if (!response.ok
          || responseUrl.origin !== expectedOrigin
          || responseUrl.pathname !== "/api/auth/session"
          || !response.headers.get("content-type")?.includes("application/json")) return false;
        const payload = await response.json();
        const user = payload?.user && typeof payload.user === "object" && !Array.isArray(payload.user)
          ? payload.user
          : null;
        const sessionHasUser = user !== null && Object.keys(user).length > 0;
        const sessionHasNoError = payload?.error === undefined || payload.error === null || payload.error === "";
        const sessionExpiryIsValid = payload?.expires === undefined || payload.expires === null
          ? true
          : typeof payload.expires === "string"
            && Number.isFinite(Date.parse(payload.expires))
            && Date.parse(payload.expires) > Date.now();
        return sessionHasUser && sessionHasNoError && sessionExpiryIsValid;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    }, { expectedOrigin: expected.origin });
  } catch {
    return false;
  }
}

async function isAuthenticatedChatGptPage(page: Page): Promise<boolean> {
  try {
    await assertAuthenticatedChatGptPage(page);
    return await hasAuthenticatedChatGptSession(page);
  } catch {
    return false;
  }
}

async function waitForAuthenticatedTemporaryChat(
  context: BrowserContext,
  timeoutMs: number,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (context.isClosed()) {
      throw new Error("System Chrome/Chromium closed before ChatGPT authentication was verified");
    }
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      if (await isAuthenticatedTemporaryChatPage(page)) return page;
      if (await isAuthenticatedChatGptPage(page)) {
        try {
          await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
            waitUntil: "domcontentloaded",
            timeout: Math.min(60_000, Math.max(1, deadline - Date.now())),
          });
          if (await isAuthenticatedTemporaryChatPage(page)) return page;
        } catch {
          // Keep polling until the bounded login deadline; transient SPA navigation can recover.
        }
      }
    }
    await delay(Math.min(LOGIN_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Timed out waiting for an authenticated ChatGPT Temporary Chat in system Chrome/Chromium");
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

function writeLoginVerificationMarker(storageStatePath: string, marker: LoginVerificationMarker): void {
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

function readLoginVerificationMarker(storageStatePath: string): LoginVerificationMarker | undefined {
  try {
    return JSON.parse(readFileSync(loginVerificationMarkerPath(storageStatePath), "utf8")) as LoginVerificationMarker;
  } catch {
    return undefined;
  }
}

function writeRefreshedVerificationMarker(
  storageStatePath: string,
  capabilities: ChatGptWebAccountCapabilities,
): void {
  const existing = readLoginVerificationMarker(storageStatePath);
  if (
    existing?.version === 2
    && existing.authenticated === true
    && existing.source === "authenticated-system-browser"
    && typeof existing.capturedAt === "string"
  ) {
    writeLoginVerificationMarker(storageStatePath, { ...existing, ...capabilities });
    return;
  }
  writeLoginVerificationMarker(storageStatePath, {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    ...capabilities,
  });
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<ChatGptWebAccountCapabilities & { url: string }> {
  const verifierBrowser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const verifierPage = await verifierContext.newPage();
      await verifierPage.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await verifierPage.getByRole("textbox", { name: "Chat with ChatGPT" }).waitFor({ state: "visible", timeout: 60_000 });
      await assertAuthenticatedChatGptPage(verifierPage);
      await assertTemporaryChatPage(verifierPage);
      return { ...await detectChatGptAccountCapabilities(verifierPage), url: verifierPage.url() };
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await inspectStoredState(config, config.storageStatePath);
  writeRefreshedVerificationMarker(config.storageStatePath, inspected);
  return { solAvailable: inspected.solAvailable, proAvailable: inspected.proAvailable };
}

export function storedBrowserLoginCapabilities(
  config: AppConfig,
): Partial<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) return {};
  const marker = readLoginVerificationMarker(config.storageStatePath);
  if (!marker) return {};
  return {
    ...("solAvailable" in marker && typeof marker.solAvailable === "boolean"
      ? { solAvailable: marker.solAvailable }
      : {}),
    ...("proAvailable" in marker && typeof marker.proAvailable === "boolean"
      ? { proAvailable: marker.proAvailable }
      : {}),
  };
}

export async function captureSystemBrowserLogin(
  config: Pick<AppConfig, "chromeExecutablePath" | "storageStatePath">,
  options: BrowserLoginOptions = {},
): Promise<SystemBrowserLoginCapture> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Chrome/Chromium was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  const completionTimeoutMs = options.timeoutMs ?? LOGIN_COMPLETION_TIMEOUT_MS;
  if (!Number.isFinite(completionTimeoutMs) || completionTimeoutMs < 1) {
    throw new Error("System-browser login timeout must be a positive finite number");
  }
  const completionDeadline = Date.now() + completionTimeoutMs;
  const remainingCompletionTime = (): number => {
    const remaining = completionDeadline - Date.now();
    if (remaining < 1) throw new Error("Timed out waiting for system-browser ChatGPT login");
    return remaining;
  };
  const profileParent = dirname(config.storageStatePath);
  mkdirSync(profileParent, { recursive: true, mode: 0o700 });
  try { chmodSync(profileParent, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
  const profileDir = mkdtempSync(join(profileParent, "login-profile-"));
  try { chmodSync(profileDir, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
  process.stdout.write(
    "A dedicated normal Chrome/Chromium window is open. Sign in to ChatGPT, confirm that the Temporary Chat composer is visible, then return to the launcher and choose Continue. Secure capture starts only after that browser exits.\n",
  );
  let context: BrowserContext | undefined;
  let capture: SystemBrowserLoginCapture | undefined;
  let primaryError: unknown;
  try {
    // Authentication happens in a genuinely normal isolated Chrome process. Attaching Playwright
    // during the credential challenge exposes a managed-browser fingerprint that some identity
    // providers reject even though the platform authenticator itself is available.
    const loginBrowser = spawn(config.chromeExecutablePath, [
      `--user-data-dir=${profileDir}`,
      "--new-window",
      "--disable-background-mode",
      "--no-first-run",
      "--no-default-browser-check",
      CHATGPT_TEMPORARY_CHAT_URL,
    ], { env: process.env, stdio: "ignore" });
    let loginTimeout: ReturnType<typeof setTimeout> | undefined;
    let continuationRequested = false;
    let loginExit: number;
    try {
      loginExit = await new Promise<number>((resolveExit, rejectExit) => {
        loginTimeout = setTimeout(() => {
          rejectExit(new Error(
            "Timed out waiting for the dedicated normal Chrome/Chromium login window to close",
          ));
        }, remainingCompletionTime());
        if (options.continuation) {
          void options.continuation.then(() => {
            continuationRequested = true;
            if (!loginBrowser.kill() && !browserProcessExited(loginBrowser)) {
              rejectExit(new Error("The dedicated normal Chrome/Chromium process refused the Continue close request"));
            }
          }, rejectExit);
        }
        loginBrowser.once("error", rejectExit);
        loginBrowser.once("exit", (code, signal) => {
          if (continuationRequested) resolveExit(0);
          else if (signal) rejectExit(new Error(`Normal Chrome/Chromium login window exited from signal ${signal}`));
          else resolveExit(code ?? 1);
        });
      });
    } catch (error) {
      try {
        await stopOwnedLoginBrowser(loginBrowser);
      } catch (cleanupError) {
        const primary = error instanceof Error ? error.message : String(error);
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${primary}; dedicated normal browser cleanup also failed: ${cleanup}`);
      }
      throw error;
    } finally {
      if (loginTimeout) clearTimeout(loginTimeout);
    }
    if (loginExit !== 0) throw new Error(`Normal Chrome/Chromium login window exited with status ${loginExit}`);

    // Only after the normal browser has exited does Playwright reopen the same isolated profile.
    // It owns Chrome over inherited OS pipes, exposes no browser-level TCP listener, and fulfills
    // every request locally so the managed capture surface never reaches ChatGPT or its identity
    // providers. Electron performs the authoritative authenticated-session proof after import.
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: config.chromeExecutablePath,
      headless: true,
      chromiumSandbox: true,
      serviceWorkers: "block",
      ignoreDefaultArgs: [
        "--no-sandbox",
        "--enable-automation",
        "--password-store=basic",
        "--use-mock-keychain",
      ],
      args: ["--disable-background-mode", "--no-first-run", "--no-default-browser-check"],
      timeout: Math.min(LOGIN_BROWSER_START_TIMEOUT_MS, remainingCompletionTime()),
    });
    await context.setOffline(true);
    await context.route("**/*", async route => {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><meta charset=\"utf-8\"><title>Private login-state capture</title>",
      });
    });
    const initialPage = context.pages()[0] ?? await context.newPage();
    await initialPage.goto(CHATGPT_TEMPORARY_CHAT_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(60_000, remainingCompletionTime()),
    });
    if (new URL(initialPage.url()).origin !== new URL(CHATGPT_TEMPORARY_CHAT_URL).origin) {
      throw new Error("Offline login-state capture reached an unexpected origin");
    }
    const storageState = sanitizeBrowserLoginStorageState(await context.storageState());
    if (storageState.cookies.length === 0) {
      throw new Error("The dedicated normal browser profile contains no ChatGPT/OpenAI cookies to import");
    }

    const verificationMarker: SystemBrowserLoginCaptureMarker = {
      version: 3,
      captureComplete: true,
      source: "isolated-normal-browser-profile",
      capturedAt: new Date().toISOString(),
    };
    capture = {
      storageState,
      verificationMarker,
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    if (context && !context.isClosed()) await context.close();
  } catch (error) {
    cleanupError = error;
  }
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }

  if (primaryError) {
    if (cleanupError) {
      const primary = primaryError instanceof Error ? primaryError.message : String(primaryError);
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`${primary}; system-browser login cleanup also failed: ${cleanup}`);
    }
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  if (!capture) throw new Error("System-browser login completed without isolated-profile capture evidence");
  return capture;
}

export async function loginToChatGptWithSystemBrowserCapture(
  config: AppConfig,
  options: BrowserLoginOptions = {},
): Promise<SystemBrowserLoginCaptureResult> {
  const capture = await captureSystemBrowserLogin(config, options);
  const storageState = sanitizeBrowserLoginStorageState(capture.storageState);
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  // Remove stale evidence before replacing the state so an interrupted pair update fails closed.
  rmSync(markerPath, { force: true });
  atomicWriteFile(config.storageStatePath, `${JSON.stringify(storageState)}\n`);
  writeLoginVerificationMarker(config.storageStatePath, capture.verificationMarker);
  return { storageStatePath: config.storageStatePath };
}

export async function loginToChatGpt(
  config: AppConfig,
  options: BrowserLoginOptions = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  const profileDir = join(dirname(config.storageStatePath), "login-profile");
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  process.stdout.write(
    "A normal Chrome window is open. Sign in to ChatGPT, confirm that the composer is visible, then quit this dedicated Chrome instance completely.\n",
  );
  const loginBrowser = spawn(config.chromeExecutablePath, [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    CHATGPT_TEMPORARY_CHAT_URL,
  ], { env: process.env, stdio: "ignore" });
  const loginExit = await new Promise<number>((resolveExit, rejectExit) => {
    loginBrowser.once("error", rejectExit);
    loginBrowser.once("exit", (code, signal) => {
      if (signal) rejectExit(new Error(`Normal Chrome login window exited from signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (loginExit !== 0) throw new Error(`Normal Chrome login window exited with status ${loginExit}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--no-sandbox", "--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
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
    const state = sanitizeBrowserLoginStorageState(await context.storageState());

    const inspected = await inspectStoredState(config, state);
    atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
    writeLoginVerificationMarker(config.storageStatePath, {
      version: 1,
      authenticated: true,
      verifiedAt: new Date().toISOString(),
      solAvailable: inspected.solAvailable,
      proAvailable: inspected.proAvailable,
    });
    return {
      storageStatePath: config.storageStatePath,
      accountSurfaceUrl: page.url(),
      solAvailable: inspected.solAvailable,
      proAvailable: inspected.proAvailable,
    };
  } finally {
    await context.close();
    if (browserLoginStateExists(config)) rmSync(profileDir, { recursive: true, force: true });
  }
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  const marker = readLoginVerificationMarker(config.storageStatePath);
  if (!marker || !("authenticated" in marker) || marker.authenticated !== true) return false;
  if (marker.version === 1) return typeof marker.verifiedAt === "string";
  return marker.version === 2
    && marker.source === "authenticated-system-browser"
    && typeof marker.capturedAt === "string";
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  if (!existsSync(config.chromeExecutablePath)) throw new Error(`Chrome/Chromium was not found at ${config.chromeExecutablePath}`);
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    if (await page.evaluate(() => document.readyState) !== "complete") throw new Error("Browser page did not reach complete state");
  } finally {
    await browser.close();
  }
}
