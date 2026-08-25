import type { Locator, Page } from "playwright-core";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
].join(", ");
export const CHATGPT_AUTHENTICATED_ACCOUNT_SELECTOR = [
  '[data-testid="accounts-profile-button"][role="button"]',
  '[data-testid="profile-button"][role="button"]',
  '[data-testid="user-menu-button"][role="button"]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]:has([data-animated-slider-trigger="true"])',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
].join(", ");
export const CHATGPT_EFFORT_CANONICAL_MENU_SELECTOR =
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])';
export const CHATGPT_EFFORT_MENU_SELECTORS = [
  CHATGPT_EFFORT_CANONICAL_MENU_SELECTOR,
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
] as const;
export const CHATGPT_EFFORT_MENU_SELECTOR = CHATGPT_EFFORT_MENU_SELECTORS.join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_EFFORT_SLIDER_SELECTOR = '[data-model-reasoning-effort-slider] [role="slider"]';
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 5;
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

export interface ChatGptEffortSliderState {
  min: number;
  max: number;
  value: number;
}

function safeIntegerAttribute(value: string | null): number | undefined {
  if (value === null || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function cssAttributeString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\f]/g, " ");
}

async function uniqueVisible(locator: Locator, description: string): Promise<Locator | undefined> {
  const visible = locator.filter({ visible: true });
  const count = await visible.count();
  if (count > 1) throw new Error(`ChatGPT ${description} is ambiguous (visibleCount=${count})`);
  return count === 1 ? visible.first() : undefined;
}

/** Resolve only a picker proven to belong to the selected effort control. */
export async function resolveChatGptEffortMenu(
  page: Page,
  effortControl: Locator,
  timeoutMs = 2_000,
): Promise<Locator | undefined> {
  const relationshipValues = await Promise.all([
    effortControl.getAttribute("aria-controls", { timeout: timeoutMs }).catch(() => null),
    effortControl.getAttribute("aria-owns", { timeout: timeoutMs }).catch(() => null),
  ]);
  const ownedIds = [...new Set(relationshipValues
    .flatMap(value => value?.trim().split(/\s+/) ?? [])
    .filter(Boolean))];
  if (ownedIds.length > 1) {
    throw new Error(`ChatGPT effort control owns multiple picker candidates (ownedCount=${ownedIds.length})`);
  }
  if (ownedIds.length === 1) {
    const owned = await uniqueVisible(
      page.locator(`[id="${cssAttributeString(ownedIds[0])}"]`),
      "effort menu",
    );
    if (!owned) return undefined;
    const semanticCount = await owned.locator(
      `${CHATGPT_EFFORT_ITEM_SELECTOR}, ${CHATGPT_EFFORT_SLIDER_SELECTOR}`,
    ).filter({ visible: true }).count();
    return semanticCount > 0 ? owned : undefined;
  }

  // The current picker has a purpose-specific test id. Generic global menus/groups are accepted
  // only through aria-controls/aria-owns; otherwise ownership cannot be proven safely.
  return await uniqueVisible(page.locator(CHATGPT_EFFORT_CANONICAL_MENU_SELECTOR), "effort menu");
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

async function anyVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

export async function assertAuthenticatedChatGptPage(page: Page): Promise<void> {
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR);
  if (!await anyVisible(composer)) {
    throw new Error("ChatGPT authentication could not be verified: no visible composer is present");
  }
  const accountControl = page.locator(CHATGPT_AUTHENTICATED_ACCOUNT_SELECTOR);
  if (!await anyVisible(accountControl)) {
    throw new Error("ChatGPT authentication could not be verified: no authenticated account control is present");
  }
}

export async function assertTemporaryChatPage(page: Page): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(CHATGPT_TEMPORARY_CHAT_URL);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.searchParams.get("temporary-chat") !== "true") {
    throw new Error(`ChatGPT left the isolated Temporary Chat surface (${page.url()})`);
  }
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: { selectorTimeoutMs?: number; stableAbsenceMs?: number } = {},
): Promise<ChatGptWebAccountCapabilities> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000;
  const remaining = (): number => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error("ChatGPT account capability probe did not reach a stable composer state");
    return value;
  };
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  let effortButton: Locator | undefined;
  while (true) {
    const composerCount = await composers.count().catch(() => 0);
    if (composerCount > 1) throw new Error(`ChatGPT account capability probe found ambiguous composers (visibleCount=${composerCount})`);
    const composer = composerCount === 1 ? composers.first() : undefined;
    const composerForm = composer?.locator("xpath=ancestor::form[1]");
    const formReady = await composerForm?.count().then(count => count === 1).catch(() => false) ?? false;
    const controls = formReady
      ? composerForm!.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true })
      : undefined;
    const controlCount = await controls?.count().catch(() => 0) ?? 0;
    if (controlCount > 1) throw new Error(`ChatGPT effort control is ambiguous (visibleCount=${controlCount})`);
    if (controlCount === 1) {
      presenceObservations += 1;
      absenceSince = undefined;
      effortButton = controls!.first();
      if (presenceObservations >= 2) break;
      remaining();
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
      continue;
    } else {
      presenceObservations = 0;
      effortButton = undefined;
    }
    const documentReady = await page.evaluate(() => document.readyState === "complete").catch(() => false);
    if (composerCount === 1 && formReady && controlCount === 0 && documentReady) {
      absenceSince ??= Date.now();
      if (Date.now() - absenceSince >= stableAbsenceMs) {
        return { solAvailable: false, proAvailable: false };
      }
    } else {
      absenceSince = undefined;
    }
    remaining();
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  if (!effortButton) throw new Error("ChatGPT effort control disappeared during capability probe");
  const menuExpanded = await effortButton.getAttribute("aria-expanded").catch(() => null);
  const menuBeforeOpen = await resolveChatGptEffortMenu(page, effortButton, remaining());
  let openedByProbe = false;
  if (!menuBeforeOpen && menuExpanded !== "true") {
    await effortButton.press("Enter", { timeout: remaining() });
    openedByProbe = true;
  }
  try {
    while (true) {
      const menu = await resolveChatGptEffortMenu(page, effortButton, remaining());
      if (menu) {
        const efforts = menu.locator(CHATGPT_EFFORT_ITEM_SELECTOR).filter({ visible: true });
        const sliders = menu.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).filter({ visible: true });
        const [effortCount, sliderCount] = await Promise.all([efforts.count(), sliders.count()]);
        if (effortCount > 0 && sliderCount > 0) {
          throw new Error("ChatGPT effort capability probe found conflicting menu and slider controls");
        }
        if (effortCount > 0) {
          if (effortCount > CHATGPT_EFFORT_SLIDER_MAX_OPTIONS) {
            throw new Error(`ChatGPT effort capability probe found unsupported option count ${effortCount}`);
          }
          const checked = await Promise.all(Array.from({ length: effortCount }, (_, index) => (
            efforts.nth(index).getAttribute("aria-checked", { timeout: remaining() })
          )));
          if (checked.filter(value => value === "true").length !== 1
            || checked.some(value => value !== "true" && value !== "false")) {
            throw new Error("ChatGPT effort capability probe found ambiguous checked state");
          }
          return { solAvailable: true, proAvailable: effortCount >= 5 };
        }
        if (sliderCount > 1) throw new Error(`ChatGPT effort capability probe found ambiguous sliders (${sliderCount})`);
        if (sliderCount === 1) {
          const slider = sliders.first();
          const state = parseChatGptEffortSliderState(
            await slider.getAttribute("aria-valuemin", { timeout: remaining() }),
            await slider.getAttribute("aria-valuemax", { timeout: remaining() }),
            await slider.getAttribute("aria-valuenow", { timeout: remaining() }),
          );
          if (!state) throw new Error("ChatGPT effort slider exposed an invalid ARIA range");
          return { solAvailable: true, proAvailable: state.max - state.min + 1 >= 5 };
        }
      }
      remaining();
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
  } finally {
    if (openedByProbe) await effortButton.press("Escape", { timeout: Math.max(1, deadline - Date.now()) }).catch(() => {});
  }
}
