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
  'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  'button[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"][aria-haspopup="menu"]',
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([data-model-picker-power-slider])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = '[data-model-reasoning-effort-slider], [data-model-picker-power-slider]';
export const CHATGPT_EFFORT_SLIDER_SELECTOR = '[data-model-reasoning-effort-slider] [role="slider"], [data-model-picker-power-slider] [role="slider"]';
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;

/** Model identity precedes the localized slider position; punctuation is not language-specific. */
export function parseChatGptModelAnnouncement(text: string): {
  version: string; name?: string; mode: string;
} | undefined {
  const normalized = text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
  const match = /^(?:GPT[-\s]?)?(\d+(?:\.\d+)?)(?:\s+(Sol|Astra))?\s+([^\p{P}]+)(?:\p{P}|$)/iu.exec(normalized);
  if (!match) return undefined;
  return { version: match[1]!, ...(match[2] ? { name: match[2].toLowerCase() } : {}), mode: match[3]!.trim() };
}

/** Read model evidence only from the slider's own active picker. */
export async function readChatGptModelAnnouncements(slider: Locator): Promise<string[]> {
  return slider.evaluate(element => {
    const doc = element.ownerDocument;
    const descriptions = (element.closest('[role="menuitem"]')?.getAttribute("aria-describedby") ?? "")
      .split(/\s+/).filter(Boolean).map(id => doc.getElementById(id)?.textContent ?? "");
    // Some accounts now announce only the effort ("Pro, 5 of 5"); the model
    // version is shown in the picker header as adjacent text nodes ("6" + "Pro").
    const menu = element.closest('[role="menu"]');
    const rendered = (node: Element): boolean => {
      for (let parent: Element | null = node; parent; parent = parent.parentElement) {
        if (parent.matches('[hidden], [inert], [aria-hidden="true"]')) return false;
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
      }
      return true;
    };
    const headers = [...(menu?.querySelectorAll('[data-model-picker-view-toggle="true"]') ?? [])]
      .filter(header => header.closest('[role="menu"]') === menu && rendered(header));
    if (headers.length > 1) throw new Error("ChatGPT model picker exposes multiple active model headers");
    if (headers.length === 1) {
      const content = headers[0]!.querySelector("[data-menu-row-content]") ?? headers[0]!;
      const words: string[] = [];
      const walker = doc.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement && rendered(node.parentElement)) {
          const word = node.textContent?.trim();
          if (word) words.push(word);
        }
      }
      descriptions.push(words.join(" "));
    }
    return descriptions;
  });
}
/** Resolve only inside the verified composer's form; multiple submitters are an error. */
export const CHATGPT_SEND_BUTTON_SELECTOR = '[data-testid="send-button"], button[type="submit"]';
// Captured in the launcher's current composer on 2026-10-09. The primary action's
// square glyph identifies Stop without its translated label. Button type/class alone
// also match voice controls; keep the observed icon and composer ownership together.
const CHATGPT_STOP_ICON_PATH = "M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z";
export const CHATGPT_STOP_BUTTON_SELECTOR = '[data-testid="stop-button"], '
  + `form[data-chatgpt-composer] button[type="button"].size-token-button-composer:has(svg.icon-primary-action > path[d="${CHATGPT_STOP_ICON_PATH}"])`;
// Captured Luna Think control (2026-09-08). The brain glyph's opening contour,
// composer pill and pressed state identify this action independently of its label.
// Other composer pills (search, tools, attachments) must not be treated as Think.
export const CHATGPT_THINK_BUTTON_SELECTOR = 'button[type="button"].__composer-pill[aria-pressed]:has(> .__composer-pill-icon > svg[viewBox="0 0 24 24"] > path[d^="M14.8974 2.29998C15.8303 2.29013 16.802 2.58194 17.5566 3.22577"])';
// The new footer is shared with user messages. Response extraction additionally requires
// this control to FOLLOW the last assistant answer, excluding the user's earlier footer.
export const CHATGPT_COMPLETION_ACTION_SELECTOR = 'button[data-testid="copy-turn-action-button"], [data-turn-key] .turn-action-controls button';
export const CHATGPT_ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])',
].join(", ");
export const CHATGPT_USER_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="user"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-user-message-bubble])',
].join(", ");

/** The new renderer groups both roles under the user's stable turn key. */
export function chatGptAssistantTurnSelector(identity: string): string {
  const prefix = "group:assistant:";
  return identity.startsWith(prefix)
    ? `[data-turn-key=${JSON.stringify(identity.slice(prefix.length))}]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])`
    : `[data-turn-id=${JSON.stringify(identity)}]`;
}

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
  const sliderContainer = page.locator(CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR).filter({ visible: true });
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
  const controlId = await control.getAttribute("id").catch(() => null);
  if (controlId) return page.locator(`[role="menu"][aria-labelledby~=${JSON.stringify(controlId)}]`).filter({ visible: true });
  return page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true });
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
  // Let Playwright wait for stable layout and hit testing after navigation.
  // A forced click can be delivered before the new renderer's viewport is usable.
  await control.click({ timeout: Math.max(1, settleMs) });
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

export async function readChatGptEffortSnapshot(
  sliderContainer: Locator,
  timeoutMs = 1_000,
): Promise<ChatGptEffortSliderState & { available: boolean[] }> {
  const deadline = Date.now() + timeoutMs;
  do {
    // Read the range, selection and locks in one DOM revision. Separate Playwright
    // reads can straddle hydration and combine a five-step range with four ticks.
    const snapshot = await sliderContainer.evaluate(container => {
      const sliders = container.querySelectorAll('[role="slider"]');
      const slider = sliders.length === 1 ? sliders[0] : undefined;
      const power = container.hasAttribute("data-model-picker-power-slider")
        && Boolean(container.querySelector('[data-orientation="horizontal"][aria-disabled="false"]'));
      return {
        min: slider?.getAttribute("aria-valuemin") ?? null,
        max: slider?.getAttribute("aria-valuemax") ?? null,
        value: slider?.getAttribute("aria-valuenow") ?? null,
        locks: Array.from(container.querySelectorAll("[data-selected]"), tick =>
          tick.getAttribute("data-locked") ?? (power ? "false" : null)),
      };
    });
    const state = parseChatGptEffortSliderState(snapshot.min, snapshot.max, snapshot.value);
    if (!state) throw new Error("ChatGPT effort slider exposed an invalid ARIA range");
    if (snapshot.locks.some(lock => lock !== "true" && lock !== "false")) break;
    if (snapshot.locks.length === state.max - state.min + 1) {
      return { ...state, available: snapshot.locks.map(lock => lock === "false") };
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  throw new Error("ChatGPT effort availability could not be verified from its slider ticks");
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
  const composer = composers;
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000;
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  while (true) {
    const effortVisible = await effortButton.isVisible();
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
    } else {
      absenceSince = undefined;
    }
    if (Date.now() >= deadline) {
      // ChatGPT can mount a usable composer before the account's model list arrives.
      // A short absence is not a capability result; use the complete inspection budget.
      if (absenceSince !== undefined && Date.now() - absenceSince >= stableAbsenceMs) {
        return { solAvailable: false, extraHighAvailable: false, proAvailable: false };
      }
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
    const { available } = await readChatGptEffortSnapshot(sliderContainer);
    return { solAvailable: true, extraHighAvailable: available[3] === true, proAvailable: available[4] === true };
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
