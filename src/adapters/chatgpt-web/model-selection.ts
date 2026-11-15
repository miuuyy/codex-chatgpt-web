import {
  type ChatGptEffortActivation,
  chatGptModelOption,
  openChatGptModelRows,
  parseChatGptEffortSliderState,
  parseChatGptModelAnnouncement,
  readChatGptModelAnnouncements,
} from "../../chatgpt-ui/model-picker";
import type { ChatGptWebAdapterEffort, ChatGptWebModelFamily } from "../../chatgpt-web-models";
import { ChatGptWebAdapterError } from "./adapter-error";

type EffortMenu = ChatGptEffortActivation;

function familyError(family: ChatGptWebModelFamily, cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    `ChatGPT model ${family} could not be selected and verified. The pending message was not sent. Check the model in the browser; if ChatGPT uses an unsupported language, select English in Settings → General → Language and reload it.`,
    { status: 400, errorType: "invalid_request_error", code: "model_version_unavailable", retryable: false, cause },
  );
}

function familyOption(menu: EffortMenu, family: ChatGptWebModelFamily, effort?: ChatGptWebAdapterEffort) {
  return chatGptModelOption(menu.menu, {
    version: family, name: family === "6" && effort === "max" ? "astra" : "sol",
  });
}

/** Model and effort are separate browser controls; a generic Pro label proves neither family. */
export async function selectChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  activate: () => Promise<EffortMenu>,
  effort?: ChatGptWebAdapterEffort,
): Promise<EffortMenu> {
  try {
    const option = await familyOption(menu, family, effort);
    if (await option.count() > 1) throw familyError(family);
    if (await option.count() === 1 && await option.getAttribute("aria-checked") === "true") return menu;
    await openChatGptModelRows(menu.menu);
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click({ timeout: 5_000 });
    // Choosing a family returns the open picker to its slider. Keep that surface:
    // Escape followed by an immediate reopen races the outgoing menu's cleanup.
    // Activation reuses the open menu and verifies its owner before returning it.
    const selected = await activate();
    const deadline = Date.now() + 1_000;
    do {
      const current = await familyOption(selected, family, effort);
      if (await current.count() > 1) throw familyError(family);
      if (await current.count() === 1 && await current.getAttribute("aria-checked") === "true") return selected;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw familyError(family);
  } catch (cause) {
    if (cause instanceof ChatGptWebAdapterError) throw cause;
    throw familyError(family, cause);
  }
}

function instantError(cause?: unknown): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    "ChatGPT Instant could not be verified while its efforts are locked. The pending message was not sent. Check the model in the browser; if ChatGPT uses an unsupported language, select English in Settings \u2192 General \u2192 Language and reload it.",
    { status: 400, errorType: "invalid_request_error", code: "model_version_unavailable", retryable: false, cause },
  );
}

/**
 * With every effort locked, Instant is the only state ChatGPT can be in. Prove it from the picker's
 * own announcement ("6 Instant, 1 of 1") rather than from the trigger label.
 */
export async function assertChatGptInstantLocked(
  menu: EffortMenu,
  family: ChatGptWebModelFamily | undefined,
  settleMs = 0,
): Promise<void> {
  const deadline = Date.now() + settleMs;
  do {
    const option = family ? await familyOption(menu, family, "low") : undefined;
    const familyChecked = !option || (await option.count() === 1 && await option.getAttribute("aria-checked") === "true");
    // A missing slider must not make evaluate() wait out Playwright's default 30 s timeout.
    const announcements = await menu.slider.count() === 1
      ? await readChatGptModelAnnouncements(menu.slider).catch(() => [])
      : [];
    const states = announcements
      .flatMap(text => {
        const state = parseChatGptModelAnnouncement(text);
        return state ? [state] : [];
      });
    if (familyChecked && states.length > 0
      && states.every(state => state.mode.toLowerCase() === "instant" && (!family || state.version === family))) return;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  throw instantError();
}

/** Choosing the model row applies Instant while the efforts are locked; the result is verified, never assumed. */
export async function selectChatGptInstantWhenEffortLocked(
  menu: EffortMenu,
  family: ChatGptWebModelFamily | undefined,
  activate: () => Promise<EffortMenu>,
): Promise<void> {
  try {
    await assertChatGptInstantLocked(menu, family);
    return;
  } catch {
    // Not Instant yet: select the requested model row below, then verify.
  }
  if (!family) throw instantError();
  try {
    const option = await familyOption(menu, family, "low");
    if (await option.count() !== 1) throw familyError(family);
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click({ timeout: 5_000 });
    await assertChatGptInstantLocked(await activate(), family, 2_000);
  } catch (cause) {
    if (cause instanceof ChatGptWebAdapterError) throw cause;
    throw familyError(family, cause);
  }
}

export function chatGptModelFamilyMatches(
  descriptions: readonly string[],
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
): boolean {
  // GPT-6 uses Sol below Pro and Astra at Pro. An old Latest picker can still use
  // 5.6 at lower efforts; that is not proof of an explicitly requested GPT-6 turn.
  const expectedName = family === "6" && effort === "max" ? "astra" : "sol";
  const expectedMode = { low: "instant", medium: "medium", high: "high", xhigh: "extra high", max: "pro" }[effort];
  const states = descriptions.flatMap(text => {
    const state = parseChatGptModelAnnouncement(text);
    return state ? [state] : [];
  });
  return states.length > 0 && states.every(state => state.version === family
    && (!state.name || state.name === expectedName)
    && (state.mode.toLowerCase() === expectedMode
      || family === "6" && effort === "max" && state.name === "astra" && /^max$/i.test(state.mode)));
}

export async function assertChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
  effortIndex: number,
  settleMs = 0,
): Promise<void> {
  const deadline = Date.now() + settleMs;
  do {
    const option = await familyOption(menu, family, effort);
    const checked = await option.count() === 1 && await option.getAttribute("aria-checked") === "true";
    const state = parseChatGptEffortSliderState(
      await menu.slider.getAttribute("aria-valuemin"), await menu.slider.getAttribute("aria-valuemax"),
      await menu.slider.getAttribute("aria-valuenow"),
    );
    const descriptions = await readChatGptModelAnnouncements(menu.slider);
    if (checked && state && state.value === state.min + effortIndex && chatGptModelFamilyMatches(descriptions, family, effort)) return;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  throw familyError(family);
}
