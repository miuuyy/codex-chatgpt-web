import type { Locator, Page } from "playwright-core";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
].join(", ");
export const CHATGPT_EFFORT_CONTROL_SELECTOR = [
  'button[aria-haspopup="menu"][data-tone="neutral"]',
  'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
].join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = '[data-model-reasoning-effort-slider]';
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

function effortMenuLooksOpen(expanded: string | null, state: string | null): boolean {
  return expanded === "true" || state === "open";
}

async function effortMenuIsOpen(control: Locator): Promise<boolean> {
  const expanded = await control.getAttribute("aria-expanded").catch(() => null);
  const state = await control.getAttribute("data-state").catch(() => null);
  return effortMenuLooksOpen(expanded, state);
}

/** Escape once is not enough on some offscreen ChatGPT menus; wait until the trigger is collapsed. */
export async function closeChatGptEffortMenu(page: Page, control: Locator): Promise<boolean> {
  if (!await effortMenuIsOpen(control)) return true;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.keyboard.press("Escape").catch(() => {});
    if (typeof page.evaluate === "function") {
      await page.evaluate(() => {
        const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
        target?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      }).catch(() => {});
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!await effortMenuIsOpen(control)) return true;
  }
  // Playwright Escape often never reaches an offscreen Radix menu. Toggle the trigger in-page.
  if (typeof control.evaluate === "function") {
    await control.evaluate((element: HTMLElement) => element.click()).catch(() => {});
  } else {
    await control.click({ force: true, timeout: 1_000 }).catch(() => {});
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  if (!await effortMenuIsOpen(control)) return true;
  const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).last();
  if (typeof composer.evaluate === "function") {
    await composer.evaluate((element: HTMLElement) => element.click()).catch(() => {});
  } else {
    await composer.click({ force: true, timeout: 1_000 }).catch(() => {});
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  return !await effortMenuIsOpen(control);
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
  const pointerInit = {
    button: 0,
    pointerType: "mouse",
    isPrimary: true,
  } as const;
  await control.dispatchEvent("pointerdown", { ...pointerInit, buttons: 1 });
  // Radix opens on pointerdown and captures the pointer. Without a matching
  // pointerup, later slider clicks land on a still-captured trigger.
  await control.dispatchEvent("pointerup", { ...pointerInit, buttons: 0 });
  const pointerSurface = await waitForEffortSurface(page, control, settleMs);
  if (pointerSurface) return { method: "pointerdown", ...pointerSurface };
  throw new Error(
    "ChatGPT effort control did not expose its owned menu or structural slider after click and primary pointerdown",
  );
}

export const CHATGPT_EFFORT_TICK_LABELS = ["Instant", "Medium", "High", "Extra High", "Pro"] as const;

export function chatGptEffortSliderTickOffset(
  width: number,
  state: Pick<ChatGptEffortSliderState, "min" | "max">,
  value: number,
): number {
  const inset = Math.min(16, Math.max(4, width * 0.1));
  const usable = Math.max(1, width - inset * 2);
  const span = state.max - state.min;
  const fraction = span === 0 ? 0 : (value - state.min) / span;
  return inset + fraction * usable;
}

export async function clickChatGptEffortTickLabel(root: Locator, label: string): Promise<boolean> {
  if (typeof root.getByText === "function") {
    try {
      const tick = root.getByText(label, { exact: true }).filter({ visible: true }).last();
      if (await tick.count() > 0) {
        await tick.click({ force: true, timeout: 1_000 });
        return true;
      }
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    }
  }
  try {
    return await root.evaluate((element, tickLabel) => {
      const matches = [...element.querySelectorAll("*")].filter(node => (
        [...node.childNodes].some(child => (
          child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").replace(/\s+/g, " ").trim() === tickLabel
        ))
      ));
      const target = matches.at(-1);
      if (!(target instanceof HTMLElement)) return false;
      target.click();
      return true;
    }, label, { timeout: 1_000 });
  } catch {
    return false;
  }
}

export async function chatGptVisibleEffortRadioState(
  root: Locator,
): Promise<{ count: number; checkedIndex: number | null }> {
  try {
    return await root.evaluate(element => {
      const scope = element.closest('[role="menu"], [data-testid="composer-intelligence-picker-content"]') ?? document;
      const radios = [...scope.querySelectorAll('[role="menuitemradio"]')].filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const checkedIndex = radios.findIndex(node => (
        node.getAttribute("aria-checked") === "true" || node.getAttribute("data-state") === "checked"
      ));
      return { count: radios.length, checkedIndex: checkedIndex >= 0 ? checkedIndex : null };
    }, undefined, { timeout: 1_000 });
  } catch {
    return { count: 0, checkedIndex: null };
  }
}

export async function applyChatGptEffortChoice(
  sliderContainer: Locator,
  targetValue: number,
  labels: readonly string[] = CHATGPT_EFFORT_TICK_LABELS,
): Promise<number | undefined> {
  try {
    return await sliderContainer.evaluate((element, { targetValue, labels }) => {
      const fireClick = (node: EventTarget, clientX?: number, clientY?: number) => {
        const rect = node instanceof Element ? node.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
        const x = clientX ?? rect.left + rect.width / 2;
        const y = clientY ?? rect.top + rect.height / 2;
        const base = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
        };
        node.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
        node.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
        node.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
        node.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
        node.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
        if (node instanceof HTMLElement) node.click();
      };
      const exactLeaves = (root: ParentNode, label: string): HTMLElement[] => {
        const matches: HTMLElement[] = [];
        for (const node of root.querySelectorAll("*")) {
          const exact = [...node.childNodes].some(child => (
            child.nodeType === Node.TEXT_NODE
            && (child.textContent ?? "").replace(/\s+/g, " ").trim() === label
          ));
          const aria = (node.getAttribute("aria-label") ?? "").trim() === label;
          if ((exact || aria) && node instanceof HTMLElement) matches.push(node);
        }
        return matches;
      };
      const slider = element.querySelector('[role="slider"]');
      const min = Number(slider?.getAttribute("aria-valuemin") ?? 0);
      const max = Number(slider?.getAttribute("aria-valuemax") ?? 4);
      const wanted = labels[targetValue - min] ?? labels[targetValue];
      for (const input of element.querySelectorAll("input[type=range]")) {
        if (!(input instanceof HTMLInputElement)) continue;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, String(targetValue));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (wanted) {
        const menuRoot = element.closest('[role="menu"], [data-testid="composer-intelligence-picker-content"]') ?? element;
        for (const node of [...exactLeaves(element, wanted), ...exactLeaves(menuRoot, wanted)]) fireClick(node);
      }
      const rect = element.getBoundingClientRect();
      if (rect.width > 1 && rect.height > 0) {
        const inset = Math.min(16, Math.max(4, rect.width * 0.1));
        const usable = Math.max(1, rect.width - inset * 2);
        const span = max - min;
        const fraction = span === 0 ? 0 : (targetValue - min) / span;
        const x = rect.left + inset + fraction * usable;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        fireClick(element, x, y);
        if (hit && hit !== element) fireClick(hit, x, y);
      }
      const now = Number(slider?.getAttribute("aria-valuenow"));
      return Number.isFinite(now) ? now : undefined;
    }, { targetValue, labels: [...labels] }, { timeout: 2_000 });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    return undefined;
  }
}

export async function pointerNudgeChatGptEffortSlider(
  page: Page,
  sliderContainer: Locator,
  state: ChatGptEffortSliderState,
  value: number,
): Promise<void> {
  let bounds;
  try {
    bounds = await sliderContainer.boundingBox({ timeout: 1_000 });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    return;
  }
  const x = Math.max(1, Math.min(bounds.width - 1, chatGptEffortSliderTickOffset(bounds.width, state, value)));
  const y = bounds.height / 2;
  const mouse = page.mouse;
  if (mouse) {
    const fromX = Math.max(1, Math.min(bounds.width - 1, chatGptEffortSliderTickOffset(bounds.width, state, state.value)));
    try {
      if (typeof mouse.move === "function" && typeof mouse.down === "function" && typeof mouse.up === "function") {
        await mouse.move(bounds.x + fromX, bounds.y + y);
        await mouse.down();
        await mouse.move(bounds.x + x, bounds.y + y, { steps: 6 });
        await mouse.up();
      } else if (typeof mouse.click === "function") {
        await mouse.click(bounds.x + x, bounds.y + y);
      }
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    }
  }
  try {
    await sliderContainer.click({
      force: true,
      timeout: 1_000,
      position: { x, y },
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
  }
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
    return { solAvailable: true, extraHighAvailable: state.max - state.min + 1 >= 4, proAvailable: state.max - state.min + 1 >= 5 };
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
