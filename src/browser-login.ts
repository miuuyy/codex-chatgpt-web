import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import { ChromeCdpBrowser } from "./chrome-cdp";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  chatGptSessionState,
  CHATGPT_TEMPORARY_CHAT_URL,
  detectChatGptProCapability,
} from "./chatgpt-session";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  proAvailable: boolean;
}

interface LoginVerificationMarker {
  version: 2;
  authenticated: true;
  transport: "chrome-devtools";
  verifiedAt: string;
  proAvailable?: boolean;
}

interface BrowserSessionRecord {
  version: 2;
  transport: "chrome-devtools";
  profilePath: string;
  verifiedAt: string;
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

function writeVerification(config: AppConfig, proAvailable: boolean): void {
  const verifiedAt = new Date().toISOString();
  const session: BrowserSessionRecord = {
    version: 2,
    transport: "chrome-devtools",
    profilePath: config.chromeProfilePath,
    verifiedAt,
  };
  const marker: LoginVerificationMarker = {
    version: 2,
    authenticated: true,
    transport: "chrome-devtools",
    verifiedAt,
    proAvailable,
  };
  atomicWriteFile(config.storageStatePath, `${JSON.stringify(session)}\n`);
  atomicWriteFile(loginVerificationMarkerPath(config.storageStatePath), `${JSON.stringify(marker)}\n`);
}

function browser(config: AppConfig): ChromeCdpBrowser {
  return new ChromeCdpBrowser({
    executablePath: config.chromeExecutablePath,
    profilePath: config.chromeProfilePath,
    debugPort: config.chromeDebugPort,
  });
}

async function verifiedCapabilities(config: AppConfig): Promise<{ proAvailable: boolean; url: string }> {
  const controlled = browser(config);
  try {
    const page = await controlled.findOrCreatePage(CHATGPT_TEMPORARY_CHAT_URL);
    await page.navigate(CHATGPT_TEMPORARY_CHAT_URL);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const state = await chatGptSessionState(page);
      if (state.composerVisible) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    return {
      proAvailable: await detectChatGptProCapability(page),
      url: (await chatGptSessionState(page)).url,
    };
  } finally {
    controlled.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<{ proAvailable: boolean }> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await verifiedCapabilities(config);
  writeVerification(config, inspected.proAvailable);
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
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  mkdirSync(config.chromeProfilePath, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(config.storageStatePath), { recursive: true, mode: 0o700 });
  process.stdout.write(
    "A dedicated ordinary Google Chrome window is open. Sign in to ChatGPT and leave it open; setup will continue automatically.\n",
  );

  const controlled = browser(config);
  try {
    const page = await controlled.findOrCreatePage(CHATGPT_TEMPORARY_CHAT_URL);
    await page.navigate(CHATGPT_TEMPORARY_CHAT_URL);
    const loginDeadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
    let authenticatedSince: number | undefined;
    while (true) {
      const state = await chatGptSessionState(page);
      const authenticated = state.atChatGpt
        && state.temporaryChat
        && !state.loginVisible
        && (state.sessionAuthenticated || state.accountVisible)
        && state.composerVisible
        && !state.webdriver;
      if (authenticated) {
        authenticatedSince ??= Date.now();
        if (Date.now() - authenticatedSince >= 2_000) break;
      } else {
        authenticatedSince = undefined;
      }
      if (Date.now() >= loginDeadline) throw new Error("Timed out waiting for ChatGPT login to complete");
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }

    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    const proAvailable = await detectChatGptProCapability(page);
    writeVerification(config, proAvailable);
    return {
      storageStatePath: config.storageStatePath,
      accountSurfaceUrl: (await chatGptSessionState(page)).url,
      proAvailable,
    };
  } finally {
    controlled.close();
  }
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)
    || !existsSync(loginVerificationMarkerPath(config.storageStatePath))
    || !existsSync(config.chromeProfilePath)) {
    return false;
  }
  try {
    const session = JSON.parse(readFileSync(config.storageStatePath, "utf8")) as Partial<BrowserSessionRecord>;
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    return session.version === 2
      && session.transport === "chrome-devtools"
      && session.profilePath === config.chromeProfilePath
      && marker.version === 2
      && marker.authenticated === true
      && marker.transport === "chrome-devtools"
      && typeof marker.verifiedAt === "string";
  } catch {
    return false;
  }
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  const controlled = browser(config);
  try {
    const page = await controlled.newPage("about:blank");
    const webdriver = await page.evaluate<boolean>("navigator.webdriver === true");
    if (webdriver) throw new Error("Chrome unexpectedly enabled navigator.webdriver");
    await page.close();
  } finally {
    controlled.close();
  }
}
