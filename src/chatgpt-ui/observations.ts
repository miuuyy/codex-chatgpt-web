import { CHATGPT_COMPOSER_VARIANTS, CHATGPT_STOP_VARIANTS, CHATGPT_THINK_VARIANTS } from "./composer";
import { CHATGPT_EFFORT_CONTROL_VARIANTS, CHATGPT_SLIDER_VARIANTS } from "./model-picker";
import { CHATGPT_TURN_VARIANTS } from "./turns";

const prefixed = (component: string, variants: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(variants).map(([name, selector]) => [`${component}.${name}`, selector]));

// Diagnostics use the same selectors as execution. These names are repository-owned,
// never copied from page attributes, labels, account information or conversation text.
export const CHATGPT_UI_VARIANT_SELECTORS = {
  ...prefixed("composer", CHATGPT_COMPOSER_VARIANTS),
  ...prefixed("stop", CHATGPT_STOP_VARIANTS),
  ...prefixed("think", CHATGPT_THINK_VARIANTS),
  ...prefixed("slider", CHATGPT_SLIDER_VARIANTS),
  ...prefixed("modelControl", CHATGPT_EFFORT_CONTROL_VARIANTS),
  ...prefixed("turn", CHATGPT_TURN_VARIANTS),
};

/** Project the browser result to the exact numeric contract before it reaches logs. */
export function validateChatGptUiVariantCounts(value: unknown): Record<string, {
  attached: number; rendered: number;
}> {
  const names = Object.keys(CHATGPT_UI_VARIANT_SELECTORS);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== names.length) {
    throw new Error("ChatGPT UI variant observation has an invalid shape");
  }
  return Object.fromEntries(names.map(name => {
    const counts = (value as Record<string, unknown>)[name];
    if (!counts || typeof counts !== "object" || Array.isArray(counts) || Object.keys(counts).length !== 2) {
      throw new Error("ChatGPT UI variant observation has invalid counts");
    }
    const { attached, rendered } = counts as Record<string, unknown>;
    if (typeof attached !== "number" || typeof rendered !== "number"
      || !Number.isInteger(attached) || !Number.isInteger(rendered)
      || attached < 0 || attached > 40 || rendered < 0 || rendered > attached) {
      throw new Error("ChatGPT UI variant observation has invalid counts");
    }
    return [name, { attached, rendered }];
  }));
}

/** Runs in the page. Observations do not select a UI adapter or authorize any action. */
export function chatGptUiVariantCounts(selectors: Record<string, string>): Record<string, {
  attached: number; rendered: number;
}> {
  const rendered = (element: Element): boolean => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.matches('[hidden], [inert], [aria-hidden="true"]')) return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    return true;
  };
  return Object.fromEntries(Object.entries(selectors).map(([id, selector]) => {
    // Cap counts like the other structural diagnostics; inspect no message content.
    const nodes = [...document.querySelectorAll(selector)].slice(0, 40);
    return [id, { attached: nodes.length, rendered: nodes.filter(rendered).length }];
  }));
}
