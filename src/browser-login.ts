import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserContextOptions } from "playwright-core";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import { browserName, browserType, ensureBrowserExecutable, type BrowserEngine } from "./browser-engine";
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
  const engine = browserType(config.browserEngine);
  const verifierBrowser = await engine.launch({
    executablePath: ensureBrowserExecutable(config),
    headless: false,
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

export async function loginToChatGpt(
  config: AppConfig,
  options: { timeoutMs?: number } = {},
): Promise<BrowserLoginResult> {
  const executable = ensureBrowserExecutable(config);
  const loginExecutable = normalLoginBrowserExecutable(config.browserEngine, executable);
  const name = browserName(config.browserEngine);
  const profileDir = join(dirname(config.storageStatePath), "login-profile");
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  process.stdout.write(
    `A normal ${name} window is open. Sign in to ChatGPT, confirm that the composer is visible, then quit this dedicated ${name} instance completely.\n`,
  );
  const loginBrowser = spawn(loginExecutable, browserLoginArguments(config.browserEngine, profileDir), { env: process.env, stdio: "ignore" });
  const loginExit = await new Promise<number>((resolveExit, rejectExit) => {
    loginBrowser.once("error", rejectExit);
    loginBrowser.once("exit", (code, signal) => {
      if (signal) rejectExit(new Error(`Normal ${name} login window exited from signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (loginExit !== 0) throw new Error(`Normal ${name} login window exited with status ${loginExit}`);

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
    if (browserLoginStateExists(config)) rmSync(profileDir, { recursive: true, force: true });
  }
}

export function normalLoginBrowserExecutable(
  engine: BrowserEngine,
  automationExecutable: string,
  platform = process.platform,
  linuxFirefoxPath = "/usr/bin/firefox",
): string {
  if (engine === "firefox" && platform === "linux" && existsSync(linuxFirefoxPath)) return linuxFirefoxPath;
  return automationExecutable;
}

export function browserLoginArguments(engine: BrowserEngine, profileDir: string): string[] {
  return engine === "firefox"
    ? ["-no-remote", "-profile", profileDir, "-new-window", CHATGPT_TEMPORARY_CHAT_URL]
    : [
        `--user-data-dir=${profileDir}`,
        "--new-window",
        "--disable-background-mode",
        "--no-first-run",
        "--no-default-browser-check",
        CHATGPT_TEMPORARY_CHAT_URL,
      ];
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
