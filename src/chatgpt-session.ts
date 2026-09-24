import type { Locator, Page } from "playwright-core";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_SAVED_CHAT_URL = "https://chatgpt.com/";

export function chatGptNewChatUrl(useSavedChats = false): string {
  return useSavedChats ? CHATGPT_SAVED_CHAT_URL : CHATGPT_TEMPORARY_CHAT_URL;
}
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"][data-composer-markdown]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  'button[data-composer-navigation-target="reasoning"][aria-haspopup="menu"]',
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = '[data-model-reasoning-effort-slider], [data-model-picker-power-slider]';
export const CHATGPT_EFFORT_SLIDER_SELECTOR = ':is([data-model-reasoning-effort-slider], [data-model-picker-power-slider]) [role="slider"]';
export const CHATGPT_SEND_BUTTON_SELECTOR = '[data-testid="send-button"], button[type="submit"]';
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;
export const CHATGPT_STOP_BUTTON_SELECTOR = '[data-testid="stop-button"], form[data-chatgpt-composer] button[aria-label="Parar"]';
export const CHATGPT_COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"], .turn-action-controls button[aria-label="Copiar"], .turn-action-controls button[aria-label="Copy"]';
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  '[data-turn-key]:has([data-conversation-role="assistant"])',
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
  '[data-turn-key]:has([data-user-message-bubble])',
].join(", ");

export interface ChatGptEffortSliderState {
  min: number;
  max: number;
  value: number;
}

export interface ChatGptEffortActivation {
  method: "already-open" | "click" | "pointerdown";
  menu: Locator;
  sliderContainer: Locator;
  slider: Locator;
}

export function chatGptEffortSlider(page: Page): { sliderContainer: Locator; slider: Locator } {
  const sliderContainer = page.locator(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR).filter({ visible: true }).last();
  // The current picker keeps ARIA values on a zero-width, aria-hidden semantic input.
  // Its visible container proves the active surface; the input proves the effort range.
  return { sliderContainer, slider: sliderContainer.locator('[role="slider"]') };
}

function effortMenuSelectorForId(menuId: string): string {
  return `[id=${JSON.stringify(menuId)}]`;
}

export async function chatGptEffortMenuForControl(page: Page, control: Locator): Promise<Locator> {
  const menuId = await control.getAttribute("aria-controls").catch(() => null);
  if (menuId) return page.locator(effortMenuSelectorForId(menuId));
  return page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last();
}

async function visibleEffortSurface(
  page: Page,
  control: Locator,
): Promise<Omit<ChatGptEffortActivation, "method"> | undefined> {
  // The exit animation keeps a closed menu's slider visible after Escape. Read the
  // owner state first: selecting that outgoing range races its removal from the DOM.
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "false" || state === "closed") return undefined;
  const menu = await chatGptEffortMenuForControl(page, control);
  const surface = chatGptEffortSlider(page);
  if (await menu.isVisible().catch(() => false) || await surface.sliderContainer.isVisible().catch(() => false)) {
    return { menu, ...surface };
  }
  return undefined;
}

async function waitForEffortSurface(
  page: Page,
  control: Locator,
  timeoutMs: number,
): Promise<Omit<ChatGptEffortActivation, "method"> | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const surface = await visibleEffortSurface(page, control);
    if (surface) return surface;
    if (Date.now() >= deadline) return undefined;
    await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
  } while (true);
}

async function clearGhostEffortState(page: Page, control: Locator): Promise<void> {
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  if (expanded === "true" || state === "open") {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

export async function activateChatGptEffortMenu(
  page: Page,
  control: Locator,
  options: { settleMs?: number } = {},
): Promise<ChatGptEffortActivation> {
  const openSurface = await visibleEffortSurface(page, control);
  if (openSurface) return { method: "already-open", ...openSurface };

  const settleMs = options.settleMs ?? 3_000;
  await clearGhostEffortState(page, control);
  await control.click({ force: true, timeout: Math.max(1, settleMs) });
  const clickedSurface = await waitForEffortSurface(page, control, settleMs);
  if (clickedSurface) return { method: "click", ...clickedSurface };

  await clearGhostEffortState(page, control);
  await control.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
  const pointerSurface = await waitForEffortSurface(page, control, settleMs);
  if (pointerSurface) return { method: "pointerdown", ...pointerSurface };
  throw new Error(
    "ChatGPT effort control did not expose its owned menu or structural slider after click and primary pointerdown",
  );
}

function safeIntegerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseChatGptEffortSliderState(
  rawMin: string | null,
  rawMax: string | null,
  rawValue: string | null,
): ChatGptEffortSliderState | undefined {
  const min = safeIntegerAttribute(rawMin);
  const max = safeIntegerAttribute(rawMax);
  const value = safeIntegerAttribute(rawValue);
  if (min === undefined || max === undefined || value === undefined) return undefined;
  const optionCount = max - min + 1;
  if (optionCount < 1 || optionCount > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS) return undefined;
  if (value < min || value > max) return undefined;
  return { min, max, value };
}

export async function readChatGptEffortAvailability(
  sliderContainer: Locator,
  state: ChatGptEffortSliderState,
): Promise<boolean[]> {
  // Plus exposes a fourth ARIA position for a locked Pro upsell. Only the ticks
  // carry both attributes; the slider root also has data-locked and is not a choice.
  const locks = await sliderContainer.evaluate(container => {
    // The new power slider omits data-locked on available ticks. Only accept this
    // contract for its identified, enabled slider, retaining explicit lock values.
    const modern = container.matches('[data-model-picker-power-slider]')
      && Boolean(container.querySelector('[data-orientation="horizontal"][aria-disabled="false"]'));
    return Array.from(container.querySelectorAll(modern ? '[data-selected]' : '[data-locked][data-selected]'),
      tick => tick.getAttribute('data-locked') ?? (modern ? 'false' : null));
  });
  if (locks.length !== state.max - state.min + 1
    || locks.some(lock => lock !== "true" && lock !== "false")) {
    throw new Error("ChatGPT effort availability could not be verified from its slider ticks");
  }
  return locks.map(lock => lock === "false");
}

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
  await assertNewChatPage(page);
}

export async function assertNewChatPage(page: Page, useSavedChats = false): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(chatGptNewChatUrl(useSavedChats));
  if (url.origin !== expected.origin || url.pathname !== expected.pathname
    || (url.searchParams.get("temporary-chat") === "true") === useSavedChats) {
    throw new Error(`ChatGPT left the requested new ${useSavedChats ? "saved" : "Temporary"} Chat surface (${page.url()})`);
  }
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: { selectorTimeoutMs?: number; stableAbsenceMs?: number } = {},
): Promise<ChatGptWebAccountCapabilities & { extraHighAvailable: boolean }> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const composer = composers.last();
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000;
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  while (true) {
    const effortVisible = await effortButton.isVisible().catch(() => false);
    if (effortVisible) {
      presenceObservations += 1;
      absenceSince = undefined;
      if (presenceObservations >= 2) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
      continue;
    }
    presenceObservations = 0;
    const composerReady = await composers.count().then(count => count === 1).catch(() => false);
    const formReady = await composerForm.count().then(count => count === 1).catch(() => false);
    const documentReady = await page.evaluate(() => document.readyState === "complete").catch(() => false);
    if (composerReady && formReady && documentReady) {
      absenceSince ??= Date.now();
      if (Date.now() - absenceSince >= stableAbsenceMs) {
        return { solAvailable: false, extraHighAvailable: false, proAvailable: false };
      }
    } else {
      absenceSince = undefined;
    }
    if (Date.now() >= deadline) {
      throw new Error("ChatGPT account capability probe did not reach a stable composer state");
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  const menu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
  const menuVisible = await menu.isVisible().catch(() => false);
  const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
  if (!menuVisible && menuExpanded !== "true") await effortButton.press("Enter");
  try {
    const { sliderContainer, slider } = chatGptEffortSlider(page);
    const timeout = options.selectorTimeoutMs ?? 70_000;
    // Model radio rows can hydrate before the effort control. They carry no evidence
    // of the account's reasoning range, so an absent slider must fail, not cache false.
    await sliderContainer.waitFor({ state: "visible", timeout });
    await slider.waitFor({ state: "attached", timeout });
    const state = parseChatGptEffortSliderState(
      await slider.getAttribute("aria-valuemin"),
      await slider.getAttribute("aria-valuemax"),
      await slider.getAttribute("aria-valuenow"),
    );
    if (!state) {
      throw new Error(
        "ChatGPT model controls are unavailable. Reload ChatGPT and run Repair again.",
        { cause: new Error("ChatGPT effort slider exposed an invalid ARIA range") },
      );
    }
    const available = await readChatGptEffortAvailability(sliderContainer, state);
    return { solAvailable: true, extraHighAvailable: available[3] === true, proAvailable: available[4] === true };
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
