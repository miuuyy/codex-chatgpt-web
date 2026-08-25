import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  browserLoginStateExists,
  loginToChatGpt,
  loginVerificationMarkerPath,
  writeBrowserLoginVerificationMarker,
} from "../src/browser-login";
import {
  CHATGPT_AUTHENTICATED_ACCOUNT_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CANONICAL_MENU_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
} from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

function fakeChatGptPage(authenticated: boolean, observedSelectors: string[]) {
  const makeLocator = (kind: string, itemIndex = 0) => {
    const visible = kind === "composer" || kind === "account" || kind === "form"
      || kind === "effort" || kind === "menu" || kind === "item";
    const locator = {
      filter: () => locator,
      first: () => locator,
      last: () => locator,
      nth: (index: number) => makeLocator(kind, index),
      count: async () => visible ? (kind === "item" ? 4 : 1) : 0,
      isVisible: async () => visible,
      waitFor: async () => {
        if (kind === "slider") return await new Promise<void>(() => {});
        if (!visible) throw new Error("not visible");
      },
      getAttribute: async (name: string) => {
        if (kind === "effort" && name === "aria-expanded") return "true";
        if (kind === "item" && name === "aria-checked") return itemIndex === 2 ? "true" : "false";
        return null;
      },
      press: async () => {},
      locator: (selector: string) => {
        if (kind === "composer" && selector === "xpath=ancestor::form[1]") return makeLocator("form");
        if (kind === "form" && selector === CHATGPT_EFFORT_CONTROL_SELECTOR) return makeLocator("effort");
        if (kind === "menu" && selector === CHATGPT_EFFORT_ITEM_SELECTOR) return makeLocator("item");
        if (kind === "menu" && selector === `${CHATGPT_EFFORT_ITEM_SELECTOR}, ${CHATGPT_EFFORT_SLIDER_SELECTOR}`) {
          return makeLocator("item");
        }
        return makeLocator("missing");
      },
    };
    return locator;
  };
  return {
    goto: async () => {},
    url: () => CHATGPT_TEMPORARY_CHAT_URL,
    keyboard: { press: async () => {} },
    locator: (selector: string) => {
      observedSelectors.push(selector);
      if (selector === CHATGPT_COMPOSER_SELECTOR) return makeLocator("composer");
      if (selector === CHATGPT_AUTHENTICATED_ACCOUNT_SELECTOR) {
        return makeLocator(authenticated ? "account" : "missing");
      }
      if (selector === CHATGPT_EFFORT_CANONICAL_MENU_SELECTOR) return makeLocator("menu");
      if (selector === CHATGPT_EFFORT_SLIDER_SELECTOR) return makeLocator("slider");
      return makeLocator("missing");
    },
  };
}

async function withFakeLoginBrowsers(
  verifierAuthenticated: boolean,
  run: (observedSelectors: string[]) => Promise<void>,
): Promise<void> {
  const originalPersistent = chromium.launchPersistentContext;
  const originalLaunch = chromium.launch;
  const observedSelectors: string[] = [];
  const initialPage = fakeChatGptPage(true, observedSelectors);
  const verifierPage = fakeChatGptPage(verifierAuthenticated, observedSelectors);
  chromium.launchPersistentContext = (async () => ({
    pages: () => [initialPage],
    newPage: async () => initialPage,
    storageState: async () => ({ cookies: [], origins: [] }),
    close: async () => {},
  })) as unknown as typeof chromium.launchPersistentContext;
  chromium.launch = (async () => ({
    newContext: async () => ({
      newPage: async () => verifierPage,
      close: async () => {},
    }),
    close: async () => {},
  })) as unknown as typeof chromium.launch;
  try {
    await run(observedSelectors);
  } finally {
    chromium.launchPersistentContext = originalPersistent;
    chromium.launch = originalLaunch;
  }
}

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
    expect(firstLaunch).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(firstLaunch).not.toContain("--remote-debugging-pipe");
    expect(launches[1]).not.toContain("--headless");
    expect(existsSync(config.storageStatePath)).toBe(false);
    expect(existsSync(loginVerificationMarkerPath(config.storageStatePath))).toBe(false);
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("browser login verification uses the shared current composer selector in both stages", () => {
  expect(CHATGPT_COMPOSER_SELECTOR.split(", ")).toContain("#prompt-textarea");

  const source = readFileSync(join(import.meta.dir, "../src/browser-login.ts"), "utf8");
  expect(source).toContain("page.locator(CHATGPT_COMPOSER_SELECTOR)");
  expect(source.match(/waitForAuthenticatedComposer\(/g)).toHaveLength(3);
  expect(source).not.toContain('getByRole("textbox", { name: "Chat with ChatGPT" })');
  expect(source).not.toContain(
    "page.locator('[data-testid=\"prompt-textarea\"], [contenteditable=\"true\"][data-lexical-editor=\"true\"]')",
  );
});

test("login behavior verifies the current composer in both contexts and creates a state-bound marker", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-behavior-"));
  const executable = join(root, "fake-chrome");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    await withFakeLoginBrowsers(true, async observedSelectors => {
      const result = await loginToChatGpt(config, { timeoutMs: 100 });
      expect(result.solAvailable).toBe(true);
      expect(observedSelectors.filter(selector => selector === CHATGPT_COMPOSER_SELECTOR).length)
        .toBeGreaterThanOrEqual(4);
      expect(observedSelectors).not.toContain('textarea[aria-label="Chat with ChatGPT"]');
      expect(browserLoginStateExists(config)).toBe(true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a guest fresh verifier fails closed without writing state or marker", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-guest-"));
  const executable = join(root, "fake-chrome");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    await withFakeLoginBrowsers(false, async () => {
      await expect(loginToChatGpt(config, { timeoutMs: 100 }))
        .rejects.toThrow("no authenticated account control is present");
    });
    expect(existsSync(config.storageStatePath)).toBe(false);
    expect(existsSync(loginVerificationMarkerPath(config.storageStatePath))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a storage-state file is not trusted without a verification marker", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-state-"));
  try {
    const config = defaultConfig("browser-only");
    config.storageStatePath = join(root, "storage-state.json");
    const initialState = "{}\n";
    writeFileSync(config.storageStatePath, initialState, { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({
        version: 2,
        authenticated: true,
        verifiedAt: "2026-07-26T00:00:00.000Z",
        storageStateSha256: createHash("sha256").update(initialState).digest("hex"),
      })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);

    writeFileSync(config.storageStatePath, '{"cookies":[]}\n', { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisting a refreshed managed-browser state also refreshes its verification digest", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-refresh-"));
  try {
    const config = defaultConfig("browser-only");
    config.storageStatePath = join(root, "storage-state.json");
    writeFileSync(config.storageStatePath, '{"cookies":[{"name":"fresh"}]}\n', { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeBrowserLoginVerificationMarker(config.storageStatePath, {
      solAvailable: true,
      proAvailable: false,
    });
    expect(browserLoginStateExists(config)).toBe(true);

    writeFileSync(config.storageStatePath, '{"cookies":[{"name":"newer"}]}\n', { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
