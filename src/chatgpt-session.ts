import type { Locator, Page } from "playwright-core";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[data-testid="model-switcher-dropdown-button"]',
  'button[data-testid="composer-intelligence-picker-trigger"]',
  'button[aria-haspopup="menu"][data-testid*="model" i]',
  'button[aria-haspopup="menu"][aria-label*="model" i]',
  'button[aria-haspopup="menu"][data-tone="neutral"]',
].join(", ");
export const CHATGPT_MODEL_PICKER_ROOT_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]',
  '[data-testid*="model-picker" i]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="radiogroup"]',
  '[data-state="open"]',
].join(", ");
export const CHATGPT_MODEL_PICKER_OPTION_SELECTOR = [
  '[role="menuitemradio"]',
  '[role="menuitem"]',
  '[role="radio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="button"]',
  'button',
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"])',
  '[role="menu"]:has([role="menuitemradio"])',
  '[role="group"]:has([role="menuitemradio"])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_STOP_BUTTON_SELECTOR = '[data-testid="stop-button"]';
export const CHATGPT_COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
].join(", ");

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  const composer = page.locator(
    CHATGPT_COMPOSER_SELECTOR,
  );
  if (!await anyVisible(composer)) {
    throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
  }
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get("temporary-chat") !== "true") {
    throw new Error(`ChatGPT left the isolated Temporary Chat surface (${page.url()})`);
  }
}

export async function detectChatGptProCapability(page: Page): Promise<boolean> {
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).last();
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
  await effortButton.waitFor({ state: "visible", timeout: 30_000 });
  const menu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
  const pickerRoot = page.locator(CHATGPT_MODEL_PICKER_ROOT_SELECTOR).filter({ visible: true }).last();
  const menuVisible = await menu.isVisible().catch(() => false);
  const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
  if (!menuVisible && menuExpanded !== "true") await effortButton.press("Enter");
  try {
    const efforts = menu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
    const deadline = Date.now() + 70_000;
    while (Date.now() < deadline) {
      if (await efforts.first().isVisible().catch(() => false)) {
        if (await efforts.count() >= 5) return true;
      }
      const pro = pickerRoot.locator(CHATGPT_MODEL_PICKER_OPTION_SELECTOR).filter({
        hasText: /^\s*Pro(?:\s|$)/i,
        visible: true,
      });
      if (await pro.count() > 0) return true;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    return false;
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
