import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConnectOverCDPTransport,
  type Page,
} from "playwright-core";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import {
  CHATGPT_TEMPORARY_CHAT_URL,
  detectChatGptAccountCapabilities,
  isAuthenticatedTemporaryChatPage,
} from "./chatgpt-session";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  solAvailable: boolean;
  proAvailable: boolean;
}

interface LegacyLoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  solAvailable?: boolean;
  proAvailable?: boolean;
}

interface LoginCaptureMarker {
  version: 2;
  authenticated: true;
  source: "authenticated-system-browser";
  capturedAt: string;
  solAvailable?: boolean;
  proAvailable?: boolean;
}

type LoginVerificationMarker = LegacyLoginVerificationMarker | LoginCaptureMarker;

interface LoginBrowserExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

const LOGIN_BROWSER_START_TIMEOUT_MS = 30_000;
const LOGIN_COMPLETION_TIMEOUT_MS = 10 * 60_000;
const LOGIN_POLL_INTERVAL_MS = 100;
const MAX_DEVTOOLS_VERSION_BYTES = 64 * 1024;

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function seedMacChromeLoginProfile(
  profileDir: string,
  options: {
    platform?: NodeJS.Platform;
    chromeUserDataDir?: string;
    sqliteExecutable?: string;
  } = {},
): boolean {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const chromeUserDataDir = options.chromeUserDataDir
    ?? join(homedir(), "Library", "Application Support", "Google", "Chrome");
  const sqliteExecutable = options.sqliteExecutable ?? "/usr/bin/sqlite3";
  if (!existsSync(sqliteExecutable)) return false;

  let lastUsed: unknown;
  try {
    const localState = JSON.parse(readFileSync(join(chromeUserDataDir, "Local State"), "utf8")) as {
      profile?: { last_used?: unknown };
    };
    lastUsed = localState.profile?.last_used;
  } catch {
    return false;
  }
  if (typeof lastUsed !== "string" || !/^(?:Default|Profile [1-9]\d*)$/.test(lastUsed)) return false;

  const sourceCookies = join(chromeUserDataDir, lastUsed, "Cookies");
  if (!existsSync(sourceCookies)) return false;
  const targetProfile = join(profileDir, "Default");
  const targetCookies = join(targetProfile, "Cookies");
  mkdirSync(targetProfile, { recursive: true, mode: 0o700 });
  rmSync(targetCookies, { force: true });

  const backup = spawnSync(sqliteExecutable, [
    sourceCookies,
    `.backup ${sqliteString(targetCookies)}`,
  ], { encoding: "utf8", timeout: 10_000 });
  if (backup.error || backup.status !== 0 || !existsSync(targetCookies)) {
    rmSync(targetCookies, { force: true });
    return false;
  }
  const filter = spawnSync(sqliteExecutable, [
    targetCookies,
    [
      "DELETE FROM cookies WHERE NOT (",
      "host_key = 'chatgpt.com' OR host_key LIKE '%.chatgpt.com' OR ",
      "host_key = 'openai.com' OR host_key LIKE '%.openai.com'",
      "); VACUUM;",
    ].join(""),
  ], { encoding: "utf8", timeout: 10_000 });
  if (filter.error || filter.status !== 0) {
    rmSync(targetCookies, { force: true });
    return false;
  }
  try { chmodSync(targetCookies, 0o600); } catch {}
  return true;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

function loginBrowserExitError(exit: LoginBrowserExit, phase: string): Error {
  if (exit.error) return new Error(`System Chrome/Chromium ${phase}: ${exit.error.message}`);
  if (exit.signal) return new Error(`System Chrome/Chromium ${phase} after signal ${exit.signal}`);
  return new Error(`System Chrome/Chromium ${phase} with status ${exit.code ?? "unknown"}`);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== "127.0.0.1" || address.port < 1) {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    throw new Error("Could not reserve a private loopback port for system Chrome/Chromium login");
  }
  const port = address.port;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
  });
  return port;
}

async function readDevToolsEndpoint(port: number, timeoutMs: number): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const raw = await response.text();
    if (!raw || raw.length > MAX_DEVTOOLS_VERSION_BYTES) return undefined;
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const endpoint = (payload as Record<string, unknown>).webSocketDebuggerUrl;
    if (typeof endpoint !== "string") return undefined;
    const parsed = new URL(endpoint);
    if (
      parsed.protocol !== "ws:"
      || parsed.hostname !== "127.0.0.1"
      || parsed.port !== String(port)
      || parsed.search
      || parsed.hash
      || !/^\/devtools\/browser\/[A-Za-z0-9_-]{16,}$/.test(parsed.pathname)
    ) return undefined;
    return endpoint;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function openNativeCdpTransport(endpoint: string, timeoutMs: number): Promise<ConnectOverCDPTransport> {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => {
      socket.close();
      rejectOpen(new Error("System Chrome/Chromium DevTools connection timed out"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolveOpen();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectOpen(new Error("System Chrome/Chromium rejected its loopback DevTools connection"));
    }, { once: true });
  });

  const transport: ConnectOverCDPTransport = {
    send(message) {
      socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    },
  };
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      transport.onclose?.("System Chrome/Chromium returned a non-text DevTools message");
      socket.close();
      return;
    }
    try {
      transport.onmessage?.(JSON.parse(event.data) as object);
    } catch {
      transport.onclose?.("System Chrome/Chromium returned malformed DevTools JSON");
      socket.close();
    }
  });
  socket.addEventListener("close", event => transport.onclose?.(event.reason));
  return transport;
}

async function waitForDevToolsEndpoint(
  port: number,
  browserExit: Promise<LoginBrowserExit>,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const endpoint = await readDevToolsEndpoint(port, Math.min(500, remaining));
    if (endpoint) return endpoint;
    const exited = await Promise.race([
      browserExit,
      delay(Math.min(LOGIN_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))).then(() => undefined),
    ]);
    if (exited) throw loginBrowserExitError(exited, "closed before its private login session became inspectable");
  }
  throw new Error(`System Chrome/Chromium did not expose its private login session within ${timeoutMs}ms`);
}

async function waitForAuthenticatedTemporaryChat(
  context: BrowserContext,
  browserExit: Promise<LoginBrowserExit>,
  timeoutMs: number,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      if (await isAuthenticatedTemporaryChatPage(page)) return page;
    }
    const exited = await Promise.race([
      browserExit,
      delay(Math.min(LOGIN_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))).then(() => undefined),
    ]);
    if (exited) throw loginBrowserExitError(exited, "closed before ChatGPT authentication was verified");
  }
  throw new Error("Timed out waiting for an authenticated ChatGPT Temporary Chat in system Chrome/Chromium");
}

async function requireCleanLoginBrowserExit(
  browserExit: Promise<LoginBrowserExit>,
  timeoutMs = 30_000,
): Promise<void> {
  const exit = await Promise.race([
    browserExit,
    delay(timeoutMs).then(() => undefined),
  ]);
  if (!exit) throw new Error("System Chrome/Chromium did not exit after its verified login session was captured");
  if (exit.error || exit.signal || exit.code !== 0) throw loginBrowserExitError(exit, "did not close cleanly");
}

async function terminateOwnedLoginBrowser(
  child: ChildProcess,
  browserExit: Promise<LoginBrowserExit>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!Number.isInteger(pid) || !pid || pid < 1) {
    if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Owned system Chrome/Chromium process has no valid pid and refused termination");
    }
  } else if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const taskkill = win32.join(systemRoot, "System32", "taskkill.exe");
    const killed = spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    if (killed.error) {
      throw new Error(`Could not terminate owned system Chrome/Chromium process tree ${pid}: ${killed.error.message}`);
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  let exit = await Promise.race([browserExit, delay(3_000).then(() => undefined)]);
  if (!exit && process.platform !== "win32" && Number.isInteger(pid) && pid && pid > 0) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    exit = await Promise.race([browserExit, delay(2_000).then(() => undefined)]);
  }
  if (!exit) throw new Error("Owned system Chrome/Chromium process tree did not exit after termination");
}

async function closeOwnedLoginBrowser(
  browser: Browser,
  browserExit: Promise<LoginBrowserExit>,
): Promise<void> {
  if (browser.isConnected()) {
    const session = await browser.newBrowserCDPSession();
    // A browser attached through CDP treats Browser.close() on Playwright's Browser object as a
    // disconnect. Send the native command so the dedicated profile process really exits before
    // its sensitive temporary files are removed or transferred to the launcher-owned browser.
    void session.send("Browser.close").catch(() => {});
  }
  await requireCleanLoginBrowserExit(browserExit);
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

function writeLoginCaptureMarker(
  storageStatePath: string,
  capabilities: ChatGptWebAccountCapabilities,
): void {
  const marker: LoginCaptureMarker = {
    version: 2,
    authenticated: true,
    source: "authenticated-system-browser",
    capturedAt: new Date().toISOString(),
    ...capabilities,
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

async function verifyCapturedStateInOwnedBrowser(
  browser: Browser,
  browserExit: Promise<LoginBrowserExit>,
  storageState: Awaited<ReturnType<BrowserContext["storageState"]>>,
  timeoutMs: number,
): Promise<void> {
  const verifierContext = await browser.newContext({ storageState });
  try {
    const verifierPage = await verifierContext.newPage();
    await verifierPage.goto(CHATGPT_TEMPORARY_CHAT_URL, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await waitForAuthenticatedTemporaryChat(verifierContext, browserExit, timeoutMs);
  } finally {
    await verifierContext.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const refreshed = await loginToChatGpt(config);
  return { solAvailable: refreshed.solAvailable, proAvailable: refreshed.proAvailable };
}

export function storedBrowserLoginCapabilities(
  config: AppConfig,
): Partial<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    return {
      ...(typeof marker.solAvailable === "boolean" ? { solAvailable: marker.solAvailable } : {}),
      ...(typeof marker.proAvailable === "boolean" ? { proAvailable: marker.proAvailable } : {}),
    };
  } catch {
    return {};
  }
}

export async function loginToChatGpt(
  config: AppConfig,
  options: { timeoutMs?: number } = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Chrome/Chromium was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  const profileDir = join(dirname(config.storageStatePath), "login-profile");
  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const reusedChromeSession = basename(config.chromeExecutablePath) === "Google Chrome"
    && seedMacChromeLoginProfile(profileDir);
  // Chrome treats port 0 as an automation signal and exposes navigator.webdriver=true. Reserve a
  // normal loopback port so provider/passkey sign-in stays on Chrome's ordinary browser surface.
  const devToolsPort = await reserveLoopbackPort();
  process.stdout.write(reusedChromeSession
    ? "A dedicated Chrome window is reusing the current profile's allowlisted ChatGPT session; transfer continues automatically after verification.\n"
    : "A dedicated system Chrome/Chromium window is open. Sign in to ChatGPT and leave it open; transfer continues automatically after the authenticated Temporary Chat is verified.\n");
  const loginBrowser = spawn(config.chromeExecutablePath, [
    `--user-data-dir=${profileDir}`,
    "--profile-directory=Default",
    "--new-window",
    "--disable-background-mode",
    "--disable-extensions",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${devToolsPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    CHATGPT_TEMPORARY_CHAT_URL,
  ], {
    detached: process.platform !== "win32",
    env: process.env,
    stdio: "ignore",
  });
  const browserExit = new Promise<LoginBrowserExit>((resolveExit) => {
    loginBrowser.once("error", error => resolveExit({ code: null, signal: null, error }));
    loginBrowser.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let browser: Browser | undefined;
  let transport: ConnectOverCDPTransport | undefined;
  let browserProcessClosed = false;
  let result: BrowserLoginResult | undefined;
  let primaryError: unknown;
  try {
    const completionTimeoutMs = options.timeoutMs ?? LOGIN_COMPLETION_TIMEOUT_MS;
    const endpoint = await waitForDevToolsEndpoint(
      devToolsPort,
      browserExit,
      Math.min(LOGIN_BROWSER_START_TIMEOUT_MS, completionTimeoutMs),
    );
    transport = await openNativeCdpTransport(
      endpoint,
      Math.min(LOGIN_BROWSER_START_TIMEOUT_MS, completionTimeoutMs),
    );
    browser = await chromium.connectOverCDP(transport, {
      timeout: Math.min(LOGIN_BROWSER_START_TIMEOUT_MS, completionTimeoutMs),
    });
    const contexts = browser.contexts();
    if (contexts.length !== 1) {
      throw new Error(`System Chrome/Chromium exposed ${contexts.length} browser contexts; expected exactly one private login context`);
    }
    const context = contexts[0];
    const page = await waitForAuthenticatedTemporaryChat(context, browserExit, completionTimeoutMs);
    const capabilities = await detectChatGptAccountCapabilities(page);
    const state = await context.storageState();
    const accountSurfaceUrl = page.url();
    await verifyCapturedStateInOwnedBrowser(
      browser,
      browserExit,
      state,
      Math.min(60_000, completionTimeoutMs),
    );

    await closeOwnedLoginBrowser(browser, browserExit);
    browserProcessClosed = true;
    browser = undefined;

    atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
    writeLoginCaptureMarker(config.storageStatePath, capabilities);
    result = {
      storageStatePath: config.storageStatePath,
      accountSurfaceUrl,
      solAvailable: capabilities.solAvailable,
      proAvailable: capabilities.proAvailable,
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    if (!browserProcessClosed) {
      if (browser) {
        try {
          await closeOwnedLoginBrowser(browser, browserExit);
        } catch {
          await terminateOwnedLoginBrowser(loginBrowser, browserExit);
        }
      } else {
        transport?.close();
        await terminateOwnedLoginBrowser(loginBrowser, browserExit);
      }
      browserProcessClosed = true;
    }
    rmSync(profileDir, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
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
  if (!result) throw new Error("System-browser login completed without authenticated capture evidence");
  return result;
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LoginVerificationMarker>;
    if (marker.authenticated !== true) return false;
    if (marker.version === 1) return typeof marker.verifiedAt === "string";
    return marker.version === 2
      && marker.source === "authenticated-system-browser"
      && typeof marker.capturedAt === "string";
  } catch {
    return false;
  }
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
