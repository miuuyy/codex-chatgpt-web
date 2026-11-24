import type { Locator, Page } from "playwright-core";

// Control, slider, model rows and announcement formats roll out independently.
// Keep their evidence here; do not choose an entire page version from one marker.
export const CHATGPT_EFFORT_CONTROL_VARIANTS = {
  // 2026-08-28 (7869843): neutral composer button.
  neutral: 'button[aria-haspopup="menu"][data-tone="neutral"]',
  // Tracked since 2026-08-08 (0dfacc6); original rollout date unknown.
  dropdown: 'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  // 2026-09-25 (2933410): power picker inside the markdown composer.
  codexReasoning: 'button[data-codex-intelligence-trigger="true"][data-composer-navigation-target="reasoning"][aria-haspopup="menu"]',
  // 2026-10-29 (#924): inline trigger drops tone/test ID/codex trigger; its label is localized.
  // Same structural selector independently proposed by @kaimiller144-web (#927) and @nofihq (#928).
  inlineReasoning: 'button[data-composer-navigation-target="reasoning"][data-selected-reasoning-effort][aria-haspopup="menu"]',
} as const;
export const CHATGPT_EFFORT_CONTROL_SELECTOR = Object.values(CHATGPT_EFFORT_CONTROL_VARIANTS).join(", ");
export const CHATGPT_EFFORT_MENU_SELECTOR = [
  '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  '[role="menu"]:has([data-model-picker-power-slider])',
].join(", ");
export const CHATGPT_EFFORT_ITEM_SELECTOR = '[role="menuitemradio"]';
export const CHATGPT_SLIDER_VARIANTS = {
  // Tracked since 2026-08-08 (0dfacc6): every tick explicitly declares its lock.
  reasoning: '[data-model-reasoning-effort-slider]',
  // 2026-09-25 (2933410): enabled horizontal container owns unlocked ticks.
  power: '[data-model-picker-power-slider]',
} as const;
export const CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR = Object.values(CHATGPT_SLIDER_VARIANTS).join(", ");
// 2026-10-28 (#921, 89f0ead): explicit Astra and Default expose six positions. Exact
// requested model/effort verification still runs before any submission.
export const CHATGPT_EFFORT_SLIDER_MAX_OPTIONS = 6;

// 2026-10-28 (#921): separate named rows beside GPT-6.1 and Default.
const NAMED_GPT6_ROWS = { sol: /^GPT[-\s]?6\s+Sol$/i, astra: /^GPT[-\s]?6\s+Astra$/i };
// 2026-11-23: Chat tab exposes "Latest" (6.2 Sol + 6 Pro) alongside an explicit "6" row.
// Prefer explicit version rows before falling back to Latest so Latest and 6 never collide.
const EXPLICIT_GPT6_ROW = /^(?:GPT[-\s]?)?6(?:\s+Astra)?(?:\s+Pro)?$/i;
const EXPLICIT_GPT62_ROW = /^(?:GPT[-\s]?)?6\.2(?:\s+Sol)?$/i;
// 2026-10-08 (388fca5), localized in 6.1.13: one row controls the latest family.
// A match here is only a UI target. The caller still verifies version/name/effort.
const LATEST_ROW = /^(?:Latest|最新|최신)$/i;
const GPT56_ROW = /^GPT[-\s]?5\.6\s+Sol(?:\s+Pro)?$/i;

export async function chatGptModelOption(menu: Locator, requested: {
  version: "5.6" | "6" | "6.2"; name: "sol" | "astra";
}): Promise<Locator> {
  if (requested.version === "6.2") {
    const explicit = menu.getByRole("menuitemradio", {
      name: EXPLICIT_GPT62_ROW, exact: true, includeHidden: true,
    });
    if (await explicit.count() > 0) return explicit;
    return menu.getByRole("menuitemradio", {
      name: LATEST_ROW, exact: true, includeHidden: true,
    });
  }
  if (requested.version === "6") {
    const visibleNamed = menu.getByRole("menuitemradio", {
      name: NAMED_GPT6_ROWS[requested.name], exact: true,
    }).filter({ visible: true });
    if (await visibleNamed.count() > 0) return visibleNamed;

    const visibleExplicit = menu.getByRole("menuitemradio", {
      name: EXPLICIT_GPT6_ROW, exact: true,
    }).filter({ visible: true });
    if (await visibleExplicit.count() > 0) return visibleExplicit;

    const named = menu.getByRole("menuitemradio", {
      name: NAMED_GPT6_ROWS[requested.name], exact: true, includeHidden: true,
    });
    if (await named.count() > 0) return named;

    const explicit = menu.getByRole("menuitemradio", {
      name: EXPLICIT_GPT6_ROW, exact: true, includeHidden: true,
    });
    if (await explicit.count() > 0) return explicit;
    return menu.getByRole("menuitemradio", {
      name: LATEST_ROW, exact: true, includeHidden: true,
    });
  }
  return menu.getByRole("menuitemradio", {
    name: GPT56_ROW,
    exact: true, includeHidden: true,
  });
}

/** Open only the model list belonging to this menu; never select a model here. */
export async function openChatGptModelRows(menu: Locator): Promise<void> {
  // Power view tracked since 2026-10-02 (b6ca2d3); the October explicit rows
  // still use it. Inactive radio rows stay attached but inert in the simple view.
  const powerView = menu.locator(':scope[data-model-picker-view], [data-model-picker-view]');
  if (await powerView.count() === 1) {
    const view = await powerView.getAttribute("data-model-picker-view");
    if (view === "simple") {
      const trigger = powerView.locator('[data-model-picker-view-toggle="true"]:not([aria-hidden="true"])')
        .filter({ visible: true });
      if (await trigger.count() !== 1) throw new Error("ChatGPT power picker has no unique model-list control");
      await trigger.click({ timeout: 5_000 });
    } else if (view !== "advanced") throw new Error("ChatGPT power picker has an unknown view");
    return;
  }
  // Pre-power expandable row, retained in b6ca2d3; covered by the classic fixture.
  const trigger = menu.locator('[role="menuitem"][aria-expanded][aria-hidden="false"]');
  if (await powerView.count() !== 0 || await trigger.count() !== 1) {
    throw new Error("ChatGPT picker has no unique model-list control");
  }
  if (await trigger.getAttribute("aria-expanded") === "false") await trigger.click({ timeout: 5_000 });
}

/** Model identity precedes the localized slider position; punctuation is not language-specific. */
export function parseChatGptModelAnnouncement(text: string): {
  version: string; name?: string; mode: string;
} | undefined {
  // #875, shipped 2026-10-21 (6f43747); 2026-11-23 live capture ("6" + "6 Pro" / "6 High"):
  // the active header can concatenate model and effort labels. Collapse only an identical repeated version.
  const normalized = text.normalize("NFKC").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim()
    .replace(/^((?:GPT[-\s]?)?(\d+(?:\.\d+)?)(?:\s+(?:Sol|Astra))?)\s+(?:GPT[-\s]?)?\2\s+/i, "$1 ");
  const match = /^(?:GPT[-\s]?)?(\d+(?:\.\d+)?)(?:\s+(Sol|Astra))?\s+([^\p{P}]+)(?:\p{P}|$)/iu.exec(normalized);
  if (!match) return undefined;
  const mode = match[3]!.trim();
  // 2026-10-25 (#911, 6140f0b): observed zh-CN labels. Translate only complete labels;
  // unknown labels still fail the exact model/effort check.
  const canonicalMode = mode === "即时" ? "instant" : mode === "中" ? "medium" : mode === "高" ? "high" : mode;
  return { version: match[1]!, ...(match[2] ? { name: match[2].toLowerCase() } : {}), mode: canonicalMode };
}

/** Read model evidence only from the slider's own active picker. */
export async function readChatGptModelAnnouncements(slider: Locator): Promise<string[]> {
  return slider.evaluate(element => {
    const doc = element.ownerDocument;
    const descriptions = (element.closest('[role="menuitem"]')?.getAttribute("aria-describedby") ?? "")
      .split(/\s+/).filter(Boolean).map(id => doc.getElementById(id)?.textContent ?? "");
    // 2026-09-29 capture (tests/chatgpt-model-family-browser.test.ts): only the effort
    // is announced ("Pro, 5 of 5"); the model
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

// #993, November 15; extended November 23 for the three-family picker (Latest, 6, GPT-5.6 Sol).
// The active list contains the model families and exactly two disabled effort rows.
// A locked upsell or an unmounted slider alone proves nothing.
const radio = '[role="menuitemradio"]';
const enabledFamily = radio + ':not([data-disabled]):not([aria-disabled="true"])';
const disabledEffort = radio + '[aria-disabled="true"][data-disabled][aria-checked="false"][data-state]';
const lockedPanel = '[data-active="true"][aria-hidden="false"]:not([inert]):not([inert] *)'
  + `:has(> ${enabledFamily}[aria-checked="true"][data-model-selected])`
  + `:has(> ${enabledFamily} [data-menu-row-content] > :text-is("6"))`
  + `:has(> ${enabledFamily} [data-menu-row-content] > :text-is("GPT-5.6 Sol"))`
  + `:has(> ${disabledEffort} ~ ${disabledEffort}):not(:has(> ${disabledEffort} ~ ${disabledEffort} ~ ${disabledEffort}))`
  + `:not(:has(> :nth-child(6 of ${radio})))`
  + ':not(:has([role="slider"]))';

export function chatGptLockedEffortPanel(menu: Locator): Locator {
  // The owned menu may itself be the advanced group. Check the panel's parent in either shape.
  return menu.locator(lockedPanel + ' >> xpath=self::*[../@data-model-picker-view="advanced"]');
}

const CHATGPT_DISABLED_EFFORT_MESSAGE =
  "ChatGPT has disabled reasoning options for the selected model. Open the model picker to see when they are available again.";

export async function disabledRowTooltip(rows: Locator): Promise<string | undefined> {
  try {
    if (await rows.count() !== 1 || await rows.getAttribute("aria-disabled") !== "true") return undefined;
    await rows.hover({ timeout: 1_500 });
    return await rows.evaluate(async element => {
      const deadline = Date.now() + 1_000;
      do {
        const ids = element.getAttribute("aria-describedby")?.trim().split(/\s+/).filter(Boolean) ?? [];
        const tooltips = ids.map(id => document.getElementById(id))
          .filter((node): node is HTMLElement => node instanceof HTMLElement && node.getAttribute("role") === "tooltip");
        const visible = tooltips.filter(node => {
          for (let current: HTMLElement | null = node; current; current = current.parentElement) {
            const style = getComputedStyle(current);
            if (!current.isConnected || current.hidden || current.getAttribute("aria-hidden") === "true"
              || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          }
          return true;
        });
        if (visible.length === 1) {
          const text = visible[0]!.textContent?.replace(/\s+/g, " ").trim();
          if (text && text.length <= 512) return text;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      return undefined;
    }, undefined, { timeout: 1_500 });
  } catch {
    // Optional UI detail must not replace the existing model-unavailable error.
    return undefined;
  }
}

export async function chatGptLockedEffortMessage(panel: Locator, label?: string): Promise<string> {
  let detail: string | undefined;
  const named = label ? panel.getByRole("menuitemradio", { name: label, exact: true }) : undefined;
  if (named && await named.count() === 1) {
    detail = await disabledRowTooltip(named);
  } else if (!label || label === "Medium" || label === "High") {
    // Localized names may differ. Only report a shared notice if both disabled rows link to it.
    const rows = panel.getByRole("menuitemradio", { disabled: true });
    if (await rows.count() === 2) {
      const first = await disabledRowTooltip(rows.nth(0));
      if (first && await disabledRowTooltip(rows.nth(1)) === first) detail = first;
    }
  }
  return detail ? `${CHATGPT_DISABLED_EFFORT_MESSAGE} ChatGPT: ${detail}` : CHATGPT_DISABLED_EFFORT_MESSAGE;
}

/** Wait for positive evidence of either picker layout, including delayed hydration. */
export async function waitForChatGptEffortRange(
  { menu, sliderContainer, slider }: ChatGptEffortActivation, timeout: number, signal?: AbortSignal,
): Promise<"slider" | "locked"> {
  const stop = new AbortController();
  const waitSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  const options = { timeout, signal: waitSignal };
  try {
    return await Promise.race([
      sliderContainer.waitFor({ state: "visible", ...options })
        .then(() => slider.waitFor({ state: "attached", ...options })).then(() => "slider" as const),
      chatGptLockedEffortPanel(menu).waitFor({ state: "visible", ...options }).then(() => "locked" as const),
    ]);
  } finally {
    stop.abort();
  }
}

export const CHATGPT_ACTIVE_EFFORT_SLIDER_SELECTOR =
  `:is(${CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR}):not([inert] *, [aria-hidden="true"] *)`;

export function chatGptEffortSlider(page: Page): { sliderContainer: Locator; slider: Locator } {
  const sliderContainer = page.locator(CHATGPT_ACTIVE_EFFORT_SLIDER_SELECTOR).filter({ visible: true });
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
