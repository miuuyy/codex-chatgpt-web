import {
  type ChatGptEffortActivation,
  chatGptModelOption,
  chatGptLockedEffortPanel,
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

/** #993: the selected family is active; its fixed Instant announcement lives in the inert slider view. */
export async function hasConfirmedLockedInstant(
  menu: EffortMenu,
  family: "6" | "6.2" = "6",
): Promise<boolean> {
  const panel = chatGptLockedEffortPanel(menu.menu);
  if (await panel.count() !== 1) return false;
  const option = await chatGptModelOption(panel, { version: family, name: "sol" });
  if (await option.count() !== 1 || await option.getAttribute("aria-checked") !== "true") return false;
  const fixed = panel.locator('..').locator(
    ':scope > [inert][data-active="false"][aria-hidden="true"] [role="menuitem"][aria-disabled="true"][data-reasoning-slider]'
    + ':has([data-model-picker-power-slider] [aria-disabled="true"][data-orientation="horizontal"]'
    + ' [role="slider"][aria-valuemin="0"][aria-valuemax="1"][aria-valuenow="0"])',
  );
  const descriptions = await fixed.evaluateAll(items => {
    if (items.length !== 1) return [];
    const item = items[0]!;
    const layer = item.closest("[inert]");
    return (item.getAttribute("aria-describedby") ?? "").split(/\s+/)
      .map(id => item.ownerDocument.getElementById(id))
      .filter(node => node?.getAttribute("role") === "status" && layer?.contains(node))
      .map(node => node!.textContent ?? "");
  });
  return descriptions.length === 1 && chatGptModelFamilyMatches(descriptions, family, "low");
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
