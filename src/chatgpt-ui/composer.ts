import type { Locator, Page } from "playwright-core";

// Dates identify repository evidence, not completion of an upstream rollout.
// See README.md in this directory before adding or retiring a UI variant.
export const CHATGPT_COMPOSER_VARIANTS = {
  // Tracked since 2026-07-28 (17ff8f1); the original rollout date is unknown.
  lexical: '[data-testid="prompt-textarea"], #prompt-textarea, [contenteditable="true"][data-lexical-editor="true"]',
  // 2026-09-25 (2933410): markdown editor owned by the composer form.
  markdown: 'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
} as const;
export const CHATGPT_COMPOSER_SELECTOR = Object.values(CHATGPT_COMPOSER_VARIANTS).join(", ");
/** Resolve only inside the verified composer's form; multiple submitters are an error. */
export const CHATGPT_SEND_BUTTON_SELECTOR = '[data-testid="send-button"], button[type="submit"]';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 2026-11-24 (#1000): ChatGPT can append a parenthesized numeric/timestamp suffix before the
 * extension (e.g. `codex-input-image-1(20261124-215438).png`). Match the exact filename or that
 * deduplicated variant without colliding with adjacent numbered attachments.
 */
export function chatGptAttachmentNamePattern(fileName: string): RegExp {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  return new RegExp(`^${escapeRegExp(stem)}(?:\\s*\\(\\d[\\d-]*\\))?${escapeRegExp(ext)}$`);
}

export function chatGptAttachmentPreview(form: Locator, file: { name: string; mimeType: string }): Locator {
  const namePattern = chatGptAttachmentNamePattern(file.name);
  let preview = form.getByRole("group", { name: namePattern }).and(form.locator(":not([inert]):not([inert] *)"))
    .or(form.locator('.composer-attachment-surface:is(button, [role="button"]):not([inert]):not([inert] *)')
      .and(form.getByRole("button", { name: namePattern })));
  if (file.mimeType.startsWith("image/")) {
    // 2026-11-18 (#996): when preview interaction is off, the composer renders the
    // filename as the thumbnail's alt text. Its outer tile has no button role or label.
    preview = preview.or(form.locator(
      "[data-composer-attachments]:not([inert]) div.composer-attachment-surface:not([role]) > span.composer-attachment-surface > img",
    ).and(form.getByAltText(namePattern)));
  }
  return preview.filter({ visible: true });
}

// Captured in the launcher's current composer on 2026-10-09. The primary action's
// square glyph identifies Stop without its translated label. Button type/class alone
// also match voice controls; keep the observed icon and composer ownership together.
const CHATGPT_STOP_ICON_PATH = "M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z";
export const CHATGPT_STOP_VARIANTS = {
  testId: '[data-testid="stop-button"]',
  // 2026-10-09 (844a82e); tests/fixtures/chatgpt-composer-stop.html.
  primaryAction: `form[data-chatgpt-composer] button[type="button"].size-token-button-composer:has(svg.icon-primary-action > path[d="${CHATGPT_STOP_ICON_PATH}"])`,
} as const;
export const CHATGPT_STOP_BUTTON_SELECTOR = Object.values(CHATGPT_STOP_VARIANTS).join(", ");
// Captured Luna Think control (2026-09-08). The brain glyph's opening contour,
// composer pill and pressed state identify this action independently of its label.
// Other composer pills (search, tools, attachments) must not be treated as Think.
// The Free account in the DEV launcher (2026-10-11) uses an SVG sprite instead.
// #902 captured the renamed codex-icon- sprite in both English and zh-TW.
// Match the observed fragments exactly, independently of asset hash and language.
export const CHATGPT_THINK_VARIANTS = {
  // 2026-09-08 capture; tests/fixtures/chatgpt-composer-think.html.
  pill: 'button[type="button"].__composer-pill[aria-pressed]:has(> .__composer-pill-icon > svg[viewBox="0 0 24 24"] > path[d^="M14.8974 2.29998C15.8303 2.29013 16.802 2.58194 17.5566 3.22577"])',
  // 2026-10-11 capture; tests/fixtures/chatgpt-composer-think-2026-10-11.html.
  brainSprite: 'button[type="button"][aria-pressed]:has(> svg[viewBox="0 0 20 20"] > use[href$="#brain-regular-20"])',
  // 2026-10-28 (#902, dc29540); same-dated fixture, English and zh-TW evidence.
  codexSprite: 'button[type="button"][aria-pressed]:has(> svg[viewBox="0 0 20 20"] > use[href$="#codex-icon-brain-regular-20"])',
} as const;
export const CHATGPT_THINK_BUTTON_SELECTOR = Object.values(CHATGPT_THINK_VARIANTS).join(", ");

export function chatGptStopButton(page: Page): Locator {
  // A hidden copy from another layout must not hide a visible generation control.
  return page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true }).last();
}
export function chatGptThinkButtons(composer: Locator): Locator {
  const form = composer.locator("xpath=ancestor::form[1]");
  // English semantic control: #766, retained in 8d53ff6 (2026-10-12).
  // The named button can coexist with any icon generation; it is not a UI version.
  return form.locator(CHATGPT_THINK_BUTTON_SELECTOR)
    .or(form.getByRole("button", { name: "Think", exact: true }))
    .filter({ visible: true });
}
