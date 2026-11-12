import { CHATGPT_COMPOSER_SELECTOR, chatGptThinkButtons } from "./chatgpt-ui/composer";
import {
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  activateChatGptEffortMenu,
  readChatGptEffortSnapshot,
  type ChatGptEffortActivation,
} from "./chatgpt-ui/model-picker";
import type { Locator, Page } from "playwright-core";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export const CHATGPT_NEW_CHAT_URL = "https://chatgpt.com/";
export function chatGptNewChatUrl(useTemporaryChats = false): string {
  return useTemporaryChats ? `${CHATGPT_NEW_CHAT_URL}?temporary-chat=true` : CHATGPT_NEW_CHAT_URL;
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

export async function assertNewChatPage(page: Page, useTemporaryChats = false): Promise<void> {
  const url = new URL(page.url());
  const expected = new URL(CHATGPT_NEW_CHAT_URL);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname
    || (url.searchParams.get("temporary-chat") === "true") !== useTemporaryChats) {
    throw new Error(`ChatGPT left the requested new chat surface (${page.url()})`);
  }
}

type ChatGptCapabilityProbeOptions = {
  selectorTimeoutMs?: number;
  stableAbsenceMs?: number;
  settleMs?: number;
  signal?: AbortSignal;
  onFailureBeforeCleanup?: (error: unknown) => Promise<void>;
};

/** Undefined means the known Luna/Think control was verified, not merely a missing picker. */
export async function waitForChatGptEffortControl(
  page: Page,
  options: ChatGptCapabilityProbeOptions = {},
): Promise<Locator | undefined> {
  const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
  const composer = composers;
  const composerForm = composer.locator("xpath=ancestor::form[1]");
  const effortButton = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
  const deadline = Date.now() + (options.selectorTimeoutMs ?? 30_000);
  const stableAbsenceMs = options.stableAbsenceMs ?? 3_000;
  let absenceSince: number | undefined;
  let presenceObservations = 0;
  while (true) {
    options.signal?.throwIfAborted();
    const effortVisible = await effortButton.isVisible();
    options.signal?.throwIfAborted();
    if (effortVisible) {
      presenceObservations += 1;
      absenceSince = undefined;
      if (presenceObservations >= 2) return effortButton;
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
        options.signal?.throwIfAborted();
        // #932: UI drift on paid accounts must not overwrite the catalog with Luna-only.
        const think = chatGptThinkButtons(composer);
        const pressed = await think.count() === 1
          ? await think.first().getAttribute("aria-pressed", { timeout: 5_000, signal: options.signal })
          : null;
        options.signal?.throwIfAborted();
        if (pressed !== "true" && pressed !== "false") {
          throw new Error("Could not identify ChatGPT's model controls. Reload ChatGPT in the launcher and retry setup.");
        }
        return undefined;
      }
      throw new Error("ChatGPT account capability probe did not reach a stable composer state");
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
}

/** Read only the selected model's rendered range; callers own selection and menu cleanup. */
export async function readChatGptEffortCapabilities(
  { sliderContainer, slider }: Pick<ChatGptEffortActivation, "sliderContainer" | "slider">,
  options: Pick<ChatGptCapabilityProbeOptions, "selectorTimeoutMs" | "signal"> = {},
): Promise<ChatGptWebAccountCapabilities & { extraHighAvailable: boolean }> {
  options.signal?.throwIfAborted();
  const timeout = options.selectorTimeoutMs ?? 70_000;
  // Model radio rows can hydrate before the effort control. They carry no evidence
  // of the account's reasoning range, so an absent slider must fail, not cache false.
  await sliderContainer.waitFor({ state: "visible", timeout, signal: options.signal });
  await slider.waitFor({ state: "attached", timeout, signal: options.signal });
  const { available } = await readChatGptEffortSnapshot(sliderContainer);
  options.signal?.throwIfAborted();
  return { solAvailable: true, extraHighAvailable: available[3] === true, proAvailable: available[4] === true };
}

export async function detectChatGptAccountCapabilities(
  page: Page,
  options: ChatGptCapabilityProbeOptions = {},
): Promise<ChatGptWebAccountCapabilities & { extraHighAvailable: boolean }> {
  let effortButton: Locator | undefined;
  try {
    effortButton = await waitForChatGptEffortControl(page, options);
  } catch (error) {
    await options.onFailureBeforeCleanup?.(error);
    throw error;
  }
  if (!effortButton) return { solAvailable: false, extraHighAvailable: false, proAvailable: false };
  try {
    const activation = await activateChatGptEffortMenu(page, effortButton, { settleMs: options.settleMs });
    options.signal?.throwIfAborted();
    return await readChatGptEffortCapabilities(activation, options);
  } catch (error) {
    await options.onFailureBeforeCleanup?.(error);
    throw error;
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
  }
}
