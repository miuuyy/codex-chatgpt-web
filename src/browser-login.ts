import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { chromium, type BrowserContext, type BrowserContextOptions } from "playwright-core";
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
  extraHighAvailable: boolean;
  proAvailable: boolean;
}

export type BrowserLoginStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface SystemBrowserLoginCaptureMarker {
  version: 1;
  captureComplete: true;
  source: "isolated-normal-browser-profile";
  capturedAt: string;
}

export interface SystemBrowserLoginCapture {
  storageState: BrowserLoginStorageState;
  marker: SystemBrowserLoginCaptureMarker;
}

interface SystemBrowserLoginOptions {
  continuation: Promise<void>;
  timeoutMs?: number;
}

interface LoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  solAvailable?: boolean;
  extraHighAvailable?: boolean;
  proAvailable?: boolean;
}

const SYSTEM_LOGIN_TIMEOUT_MS = 10 * 60_000;
const SYSTEM_LOGIN_STOP_TIMEOUT_MS = 5_000;
const LOGIN_STORAGE_ROOT_DOMAINS = ["chatgpt.com", "openai.com"] as const;
const CHATGPT_ORIGIN = new URL(CHATGPT_TEMPORARY_CHAT_URL).origin;

function browserProcessExited(browser: ChildProcess): boolean {
  return browser.exitCode !== null || browser.signalCode !== null;
}

function removeTemporaryChromeTabSessions(profileDir: string): void {
  const defaultProfile = join(profileDir, "Default");
  rmSync(join(defaultProfile, "Sessions"), { recursive: true, force: true });
  for (const name of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    rmSync(join(defaultProfile, name), { force: true });
  }
}

async function waitForBrowserExit(browser: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (browserProcessExited(browser)) return true;
  return await new Promise(resolve => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    browser.once("exit", onExit);
    if (browserProcessExited(browser)) finish(true);
  });
}

async function stopOwnedLoginBrowser(browser: ChildProcess): Promise<void> {
  if (browserProcessExited(browser) || !Number.isInteger(browser.pid)) return;
  const graceful = waitForBrowserExit(browser, SYSTEM_LOGIN_STOP_TIMEOUT_MS);
  if (!browser.kill() && !browserProcessExited(browser)) {
    throw new Error("The dedicated Chrome login process refused to close");
  }
  if (await graceful) return;
  const forced = waitForBrowserExit(browser, SYSTEM_LOGIN_STOP_TIMEOUT_MS);
  if (!browser.kill("SIGKILL") && !browserProcessExited(browser)) {
    throw new Error("The dedicated Chrome login process refused forced termination");
  }
  if (!await forced) throw new Error("The dedicated Chrome login process did not exit");
}

function allowedLoginStorageHost(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(hostname)
    || hostname.startsWith(".")
    || hostname.endsWith(".")
    || hostname.includes("..")) return false;
  try {
    const parsed = new URL(`https://${hostname}/`);
    if (parsed.hostname !== hostname
      || parsed.host !== hostname
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash) return false;
  } catch {
    return false;
  }
  return LOGIN_STORAGE_ROOT_DOMAINS.some(root => hostname === root || hostname.endsWith(`.${root}`));
}

export function sanitizeBrowserLoginStorageState(
  storageState: BrowserLoginStorageState,
): BrowserLoginStorageState {
  return {
    cookies: storageState.cookies
      .filter(cookie => !Object.prototype.hasOwnProperty.call(cookie, "partitionKey")
        && allowedLoginStorageHost(cookie.domain.replace(/^\.+/, "")))
      .map(cookie => ({ ...cookie })),
    origins: storageState.origins
      .filter(origin => origin.origin === CHATGPT_ORIGIN)
      .map(origin => ({
        origin: origin.origin,
        localStorage: origin.localStorage.map(item => ({ ...item })),
      })),
  };
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

function writeVerificationMarker(
  storageStatePath: string,
  capabilities: ChatGptWebAccountCapabilities,
): void {
  const marker: LoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    ...capabilities,
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<ChatGptWebAccountCapabilities & { url: string }> {
  const verifierBrowser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
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
  writeVerificationMarker(config.storageStatePath, inspected);
  return {
    solAvailable: inspected.solAvailable,
    extraHighAvailable: inspected.extraHighAvailable ?? inspected.proAvailable,
    proAvailable: inspected.proAvailable,
  };
}

export function storedBrowserLoginCapabilities(
  config: AppConfig,
): Partial<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    return {
      ...(typeof marker.solAvailable === "boolean" ? { solAvailable: marker.solAvailable } : {}),
      ...(typeof marker.extraHighAvailable === "boolean"
        ? { extraHighAvailable: marker.extraHighAvailable }
        : typeof marker.proAvailable === "boolean"
          ? { extraHighAvailable: marker.proAvailable }
          : {}),
      ...(typeof marker.proAvailable === "boolean" ? { proAvailable: marker.proAvailable } : {}),
    };
  } catch {
    return {};
  }
}

export async function captureSystemBrowserLogin(
  config: Pick<AppConfig, "chromeExecutablePath" | "storageStatePath">,
  options: SystemBrowserLoginOptions,
): Promise<SystemBrowserLoginCapture> {
  if (process.platform !== "darwin") {
    throw new Error("Passkey sign-in is currently supported only on macOS");
  }
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
  }
  const timeoutMs = options.timeoutMs ?? SYSTEM_LOGIN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    throw new Error("Passkey sign-in timeout must be a positive finite number");
  }
  const deadline = Date.now() + timeoutMs;
  const remainingTime = () => {
    const remaining = deadline - Date.now();
    if (remaining < 1) throw new Error("Timed out waiting for passkey sign-in");
    return remaining;
  };

  const profileParent = dirname(config.storageStatePath);
  mkdirSync(profileParent, { recursive: true, mode: 0o700 });
  try { chmodSync(profileParent, 0o700); } catch {}
  const profileDir = mkdtempSync(join(profileParent, "login-profile-"));
  try { chmodSync(profileDir, 0o700); } catch {}
  process.stdout.write(
    "Sign in with your passkey in the dedicated Chrome window. When Temporary Chat is ready, return to Codex Web GPT and choose Continue.\n",
  );

  let capture: SystemBrowserLoginCapture | undefined;
  let context: BrowserContext | undefined;
  let primaryError: unknown;
  try {
    const loginBrowser = spawn(config.chromeExecutablePath, [
      `--user-data-dir=${profileDir}`,
      "--new-window",
      "--disable-background-mode",
      "--no-first-run",
      "--no-default-browser-check",
      CHATGPT_TEMPORARY_CHAT_URL,
    ], { env: process.env, stdio: "ignore" });
    let continuationRequested = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for passkey sign-in")), remainingTime());
        void options.continuation.then(() => {
          continuationRequested = true;
          if (!loginBrowser.kill() && !browserProcessExited(loginBrowser)) {
            reject(new Error("The dedicated Chrome login process refused the Continue request"));
          }
        }, reject);
        loginBrowser.once("error", reject);
        loginBrowser.once("exit", (code, signal) => {
          if (continuationRequested) resolve();
          else if (signal) reject(new Error(`Dedicated Chrome login exited from signal ${signal}`));
          else if (code === 0) reject(new Error("Dedicated Chrome closed before Continue was selected"));
          else reject(new Error(`Dedicated Chrome login exited with status ${code ?? 1}`));
        });
      });
    } catch (error) {
      try {
        await stopOwnedLoginBrowser(loginBrowser);
      } catch (cleanupError) {
        const primary = error instanceof Error ? error.message : String(error);
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${primary}; Chrome cleanup also failed: ${cleanup}`);
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    // Authentication happens before Playwright ever owns this profile. Chrome does not load
    // session-only cookies after a normal restart unless session restore is requested. Remove only
    // the disposable profile's tab-session files first, so restoring cookies cannot reopen the
    // authenticated or identity-provider pages during the offline capture.
    removeTemporaryChromeTabSessions(profileDir);
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath: config.chromeExecutablePath,
      headless: true,
      chromiumSandbox: true,
      offline: true,
      serviceWorkers: "block",
      ignoreDefaultArgs: [
        "--no-sandbox",
        "--enable-automation",
        "--password-store=basic",
        "--use-mock-keychain",
      ],
      args: [
        "--disable-background-mode",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        "--restore-last-session",
      ],
      timeout: Math.min(30_000, remainingTime()),
    });
    await context.setOffline(true);
    await context.route("**/*", route => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><meta charset=\"utf-8\"><title>Private login-state capture</title>",
    }));
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(60_000, remainingTime()),
    });
    if (new URL(page.url()).origin !== CHATGPT_ORIGIN) {
      throw new Error("Offline passkey-state capture reached an unexpected origin");
    }
    const storageState = sanitizeBrowserLoginStorageState(await context.storageState());
    if (storageState.cookies.length === 0) {
      throw new Error("The dedicated Chrome profile contains no ChatGPT/OpenAI cookies");
    }
    capture = {
      storageState,
      marker: {
        version: 1,
        captureComplete: true,
        source: "isolated-normal-browser-profile",
        capturedAt: new Date().toISOString(),
      },
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
      throw new Error(
        `${primaryError instanceof Error ? primaryError.message : String(primaryError)}; temporary-profile cleanup also failed:`
        + ` ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  if (!capture) throw new Error("Passkey sign-in completed without capture evidence");
  return capture;
}

export async function captureSystemBrowserLoginToFile(
  config: Pick<AppConfig, "chromeExecutablePath" | "storageStatePath">,
  options: SystemBrowserLoginOptions,
): Promise<void> {
  const capture = await captureSystemBrowserLogin(config, options);
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  rmSync(markerPath, { force: true });
  atomicWriteFile(config.storageStatePath, `${JSON.stringify(capture.storageState)}\n`);
  atomicWriteFile(markerPath, `${JSON.stringify(capture.marker)}\n`);
}

export async function loginToChatGpt(
  config: AppConfig,
  options: { timeoutMs?: number } = {},
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
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
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
    const state = await context.storageState();

    const inspected = await inspectStoredState(config, state);
    atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
    writeVerificationMarker(config.storageStatePath, inspected);
    return {
      storageStatePath: config.storageStatePath,
      accountSurfaceUrl: page.url(),
      solAvailable: inspected.solAvailable,
      extraHighAvailable: inspected.extraHighAvailable ?? inspected.proAvailable,
      proAvailable: inspected.proAvailable,
    };
  } finally {
    await context.close();
    if (browserLoginStateExists(config)) rmSync(profileDir, { recursive: true, force: true });
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
  if (!existsSync(config.chromeExecutablePath)) throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
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
