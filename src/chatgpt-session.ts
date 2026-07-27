import type { CdpPage } from "./chrome-cdp";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";

export interface ChatGptSessionState {
  url: string;
  atChatGpt: boolean;
  temporaryChat: boolean;
  loginVisible: boolean;
  sessionAuthenticated: boolean;
  accountVisible: boolean;
  composerVisible: boolean;
  webdriver: boolean;
}

const sessionStateExpression = `(async () => {
  const visible = element => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.opacity !== "0"
      && rect.width > 0
      && rect.height > 0;
  };
  const buttons = [...document.querySelectorAll("button")].filter(visible);
  const loginVisible = buttons.some(button => button.innerText.trim() === "Log in");
  const accountSelectors = [
    '[data-testid="profile-button"]',
    '[data-testid="user-menu-button"]',
    '[data-testid="accounts-profile-button"]',
    'button[aria-label*="account menu" i]',
    'button[aria-label*="profile" i]'
  ];
  const accountVisible = accountSelectors.some(selector =>
    [...document.querySelectorAll(selector)].some(visible)
  ) || buttons.some(button => /(?:profile|account) menu/i.test(button.getAttribute("aria-label") || ""));
  const composerSelectors = [
    '[data-testid="prompt-textarea"]',
    '#prompt-textarea',
    '[role="textbox"][contenteditable="true"]',
    '[contenteditable="true"][data-lexical-editor="true"]',
    'textarea[aria-label="Chat with ChatGPT"]'
  ];
  const composerVisible = composerSelectors.some(selector =>
    [...document.querySelectorAll(selector)].some(visible)
  );
  const temporaryHeading = [...document.querySelectorAll("h1, h2, h3")]
    .some(element => visible(element) && element.textContent?.trim() === "Temporary Chat");
  let sessionAuthenticated = false;
  try {
    const response = await fetch("/api/auth/session", { credentials: "include" });
    const session = response.ok ? await response.json() : null;
    sessionAuthenticated = Boolean(session?.user && session?.accessToken);
  } catch {}
  return {
    url: location.href,
    atChatGpt: location.origin === "https://chatgpt.com",
    temporaryChat: location.origin === "https://chatgpt.com"
      && location.pathname === "/"
      && new URL(location.href).searchParams.get("temporary-chat") === "true"
      && temporaryHeading,
    loginVisible,
    sessionAuthenticated,
    accountVisible,
    composerVisible,
    webdriver: navigator.webdriver === true
  };
})()`;

export async function chatGptSessionState(page: CdpPage): Promise<ChatGptSessionState> {
  return page.evaluate<ChatGptSessionState>(sessionStateExpression);
}

export async function assertAuthenticatedChatGptPage(page: CdpPage): Promise<void> {
  const state = await chatGptSessionState(page);
  if (state.webdriver) {
    throw new Error("Chrome is running in WebDriver automation mode; refusing this browser session");
  }
  if (state.loginVisible && !state.sessionAuthenticated) {
    throw new Error("ChatGPT is signed out: a visible Log in button is present");
  }
  if (!state.sessionAuthenticated && !state.accountVisible) {
    throw new Error("ChatGPT authentication could not be verified from its session or visible account controls");
  }
  if (!state.composerVisible) {
    throw new Error("ChatGPT authentication is valid but its composer is unavailable");
  }
}

export async function assertTemporaryChatPage(page: CdpPage): Promise<void> {
  const state = await chatGptSessionState(page);
  if (!state.temporaryChat) {
    throw new Error(`ChatGPT left the isolated Temporary Chat surface (${state.url})`);
  }
}

export async function detectChatGptProCapability(page: CdpPage): Promise<boolean> {
  const effortExpression = `[...document.querySelectorAll("button")]
    .filter(button => /^(?:Instant(?:\\s+5\\.5)?|Medium|High|Extra High|Pro)$/.test(button.innerText.trim()))
    .at(-1)`;
  const readMenu = () => page.evaluate<{ ready: boolean; pro: boolean }>(`(() => {
    const visible = element => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]
      .filter(visible)
      .map(element => element.textContent?.replace(/\\s+/g, " ").trim() || "");
    return {
      ready: items.some(text => /^(?:Instant(?: ?5\\.5)?|Medium|High|Extra High|Pro)$/.test(text)),
      pro: items.includes("Pro")
    };
  })()`);

  let menu = await readMenu();
  if (!menu.ready) {
    await page.clickElement(effortExpression);
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    menu = await readMenu();
    if (menu.ready) {
      await page.pressEscape().catch(() => {});
      return menu.pro;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  await page.pressEscape().catch(() => {});
  throw new Error("ChatGPT model/effort menu did not become ready");
}
