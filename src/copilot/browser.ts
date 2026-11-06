import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import type { CopilotConfig, CopilotModelConfig } from "./config";
import { stripCopilotTurnMarker } from "./tool-protocol";

export const COPILOT_MAIN_SELECTORS = [
  '[role="feed"][aria-label="Chat conversation"]',
  '[data-testid="MessageListContainer"]',
  '[data-testid="m365-chat-llm-web-ui-chat-message"]',
  "#m365-copilot-app-layout-main",
  "main",
  '[role="main"]',
] as const;

export const COPILOT_READY_COMPOSER_SELECTORS = [
  '#m365-chat-editor-target-element',
  'span[role="textbox"][aria-label="Message Copilot"]',
] as const;

export const COPILOT_COMPOSER_SELECTORS = [
  ...COPILOT_READY_COMPOSER_SELECTORS,
  '[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]',
] as const;

export const COPILOT_NEW_CHAT_SELECTORS = [
  'a[aria-label="New chat"]',
  'button[aria-label="New chat"]',
  '[data-testid="new-chat-button"]',
] as const;

export const COPILOT_MODEL_BUTTON_SELECTORS = [
  'button[aria-label*="Model Selector"]',
  'button[aria-label*="Model selector"]',
  '[data-testid="model-selector"]',
  'button[aria-haspopup="menu"]',
] as const;

export const COPILOT_SEND_SELECTORS = [
  'button[aria-label="Send"]',
  'button[aria-label*="Send"]',
  'button[title="Send"]',
  '[data-testid="send-button"]',
  'button[type="submit"]',
] as const;

export const COPILOT_STOP_SELECTORS = [
  'button[aria-label*="Stop"]',
  'button[title*="Stop"]',
  '[data-testid="stop-button"]',
  '[data-testid*="stop"]',
] as const;

export const COPILOT_MESSAGE_SELECTORS = [
  '[data-testid="markdown-reply"]',
  '[data-testid="lastChatMessage"]',
  '[data-testid="ai-message"]',
  '[data-content="ai-message"]',
  '[data-testid*="assistant-message"]',
  '[data-testid*="copilot-message"]',
  '[data-author="assistant"]',
  '[data-role="assistant"]',
  '[class*="assistantMessage"]',
  '[class*="botMessage"]',
  '[data-testid^="conversation-turn"]',
  '[data-testid^="message-"]',
  'article',
  '[role="article"]',
] as const;

const UI_LABELS = new Set([
  "copy",
  "copy code",
  "copied",
  "edit",
  "regenerate",
  "retry",
  "good response",
  "bad response",
  "like",
  "dislike",
  "share",
  "sources",
  "show more",
  "show less",
  "learn more",
  "read aloud",
  "new chat",
  "stop",
  "stop generating",
  "send",
  "feedback",
  "thumbs up",
  "thumbs down",
  "message copilot",
  "ai-generated content may be incorrect",
]);

export class CopilotSignInRequiredError extends Error {
  constructor() {
    super(
      "Microsoft 365 Copilot is not signed in. Run `bun run copilot:login`, complete the Microsoft sign-in, then retry.",
    );
    this.name = "CopilotSignInRequiredError";
  }
}

export interface CopilotRunOptions {
  signal?: AbortSignal;
  onHeartbeat?: () => void;
  onProgress?: (message: string) => void;
}

export interface CopilotRunResult {
  text: string;
  transcript: string;
  elapsedMs: number;
}

export interface CopilotProbeResult {
  url: string;
  title: string;
  signedIn: boolean;
  composerMatches: number;
  modelButtonLabel: string | null;
  newChatMatches: number;
  sendMatches: number;
  stopMatches: number;
  transcript: string;
  candidates: Array<{ selector: string; count: number; lastText: string | null }>;
  html: string;
  prompt?: string;
  response?: string;
  beforeTranscript?: string;
  afterTranscript?: string;
  /** Outer HTML of the last Markdown reply, for selector debugging. */
  replyHtml?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

/** Copilot Chat can be served from either of these Microsoft hosts after redirects. */
export function isCopilotHost(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "copilot.cloud.microsoft"
      || host === "m365.cloud.microsoft"
      || host === "www.microsoft365.com";
  } catch {
    return false;
  }
}

export function isMicrosoftLoginUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "login.microsoftonline.com"
      || host === "login.live.com"
      || host === "account.microsoft.com"
      || host === "login.microsoft.com";
  } catch {
    return false;
  }
}

function turnMarkerFromPrompt(prompt: string): string {
  const index = prompt.lastIndexOf("[[codex-transport-turn:");
  if (index < 0) throw new Error("Compiled Copilot prompt is missing its transport marker");
  return prompt.slice(index).trim();
}

function abortError(): DOMException {
  return new DOMException("Copilot web turn aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Insert plain text at the caret of a focused contenteditable. This is the same browser editing
 * command used by the ChatGPT adapter: it avoids Markdown shortcuts that can transform large
 * prompts while typing.
 */
export function insertPlainTextIntoComposer(element: HTMLElement, value: string): boolean {
  if (document.activeElement !== element) element.focus();
  if (document.activeElement !== element) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const alreadyPlaced = selection.isCollapsed
    && selection.anchorNode !== null
    && element.contains(selection.anchorNode);
  if (!alreadyPlaced) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (!selection.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) {
    return false;
  }
  return document.execCommand("insertText", false, value);
}

/**
 * Read a Copilot reply without code-block chrome. Runs in the page, so it may reference only DOM
 * globals. Cloning keeps the live UI untouched.
 */
export function readCopilotReplyText(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement;
  for (const selector of [
    '[data-testid="one-copilot-code-identity"]',
    '[data-testid="loading-message"]',
    'button',
    '[role="status"]',
    '[aria-live]',
  ]) {
    for (const node of Array.from(clone.querySelectorAll(selector))) node.remove();
  }
  return clone.innerText;
}

function cleanAssistantText(
  value: string,
  marker: string,
  prompt: string,
  options: { sliceAtMarker?: boolean } = {},
): string {
  let text = value.replace(/\r\n?/g, "\n");
  // Transcript mode cuts at the first marker, which belongs to the current user bubble. Reply mode
  // must not cut: Copilot echoes the marker after the answer, so slicing would discard the answer.
  if (options.sliceAtMarker) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex >= 0) text = text.slice(markerIndex + marker.length);
  }
  text = stripCopilotTurnMarker(text);
  // A fallback extraction can include the user's own prompt before the answer.
  const promptTail = prompt.slice(-300).trim();
  if (promptTail) {
    const promptIndex = text.lastIndexOf(promptTail);
    if (promptIndex >= 0) text = text.slice(promptIndex + promptTail.length);
  }
  // "Copilot said:" is the label Copilot renders above its own turn in the feed. Match the
  // longer phrases first so the bare "Copilot" alternative cannot leave " said:" behind.
  text = text.replace(/^\s*(?:Copilot said|You said|Copilot|Assistant|You)\s*:?\s*/i, "");
  const lines = text.split("\n");
  while (lines.length > 0) {
    const last = lines[lines.length - 1]!.trim();
    if (last.length === 0) {
      lines.pop();
      continue;
    }
    if (UI_LABELS.has(last.toLowerCase())) {
      lines.pop();
      continue;
    }
    break;
  }
  return normalizeText(lines.join("\n"));
}

/** Clean the text of a single Copilot reply element, which may echo the turn marker. */
export function cleanCopilotReplyText(value: string, marker: string, prompt: string): string {
  return cleanAssistantText(value, marker, prompt);
}

export function extractCopilotResponseText(
  transcript: string,
  marker: string,
  prompt: string,
  beforeTranscript?: string,
): string {  if (!transcript.includes(marker)) {
    const promptTail = prompt.slice(-300).trim();
    if (promptTail && !transcript.includes(promptTail) && beforeTranscript && transcript.startsWith(beforeTranscript)) {
      // The UI virtualized both the marker and the prompt tail. The appended suffix is the new turn.
      return cleanAssistantText(transcript.slice(beforeTranscript.length), marker, prompt, { sliceAtMarker: true });
    }
  }
  return cleanAssistantText(transcript, marker, prompt, { sliceAtMarker: true });
}

export function isCopilotPlaceholder(text: string): boolean {
  const value = text.trim();
  if (value.length === 0) return true;
  if (/^(thinking|working|generating|responding|searching|analyzing|reasoning|please wait)[.…]*$/i.test(value)) {
    return true;
  }
  return value.length < 2;
}

export class CopilotBrowser {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private ownsContext = false;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly config: CopilotConfig) {}

  private async withTurn<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Copilot browser is closed");
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async launch(): Promise<{ browser?: Browser; context: BrowserContext }> {
    if (this.config.browser.mode === "cdp") {
      if (!this.config.browser.cdpUrl) throw new Error("Copilot browser CDP URL is not configured");
      const browser = await chromium.connectOverCDP(this.config.browser.cdpUrl);
      const context = browser.contexts()[0] ?? await browser.newContext();
      return { browser, context };
    }
    if (!existsSync(this.config.browser.chromeExecutablePath)) {
      throw new Error(
        `Configured Chrome executable does not exist: ${this.config.browser.chromeExecutablePath}`,
      );
    }
    const context = await chromium.launchPersistentContext(this.config.browser.userDataDir, {
      executablePath: this.config.browser.chromeExecutablePath,
      headless: !this.config.browser.headed,
      viewport: { width: 1440, height: 960 },
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    return { context };
  }

  private async ensurePage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) {
      if (!this.context) {
        const launched = await this.launch();
        this.browser = launched.browser;
        this.context = launched.context;
        // A CDP-attached context belongs to the user's browser; closing it would close their tabs.
        this.ownsContext = this.config.browser.mode === "persistent";
      }
      const pages = this.context.pages();
      const existing = pages.find(page => isCopilotHost(page.url()))
        ?? pages.find(page => !page.isClosed());
      this.page = existing ?? await this.context.newPage();
      this.page.setDefaultTimeout(30_000);
      if (!isCopilotHost(this.page.url())) {
        await this.page.goto(this.config.copilotUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      }
    }
    // Revalidate even a cached page: the Copilot SPA renders its shell briefly and then redirects
    // to Microsoft sign-in when the session has expired. Returning a cached page without this
    // check makes `login` report a signed-in session while the window shows the login form.
    await this.waitForCopilotReady(this.page);
    return this.page;
  }

  private async waitForCopilotReady(page: Page, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastUrl = page.url();
    let loginSince: number | undefined;
    while (Date.now() < deadline) {
      if (page.isClosed()) throw new Error("Copilot browser page was closed");
      const url = page.url();
      lastUrl = url;
      if (isMicrosoftLoginUrl(url)) {
        // A valid session still bounces through login.microsoftonline.com for silent SSO before
        // returning to Copilot. Only treat it as signed out when the credential form is actually
        // shown and the page remains there.
        loginSince ??= Date.now();
        const stuckMs = Date.now() - loginSince;
        if (stuckMs >= 5_000) {
          const credentialForm = page.locator(
            'input[type="password"], input[name="loginfmt"], input[type="email"]',
          ).first();
          if (await credentialForm.isVisible().catch(() => false)) {
            throw new CopilotSignInRequiredError();
          }
        }
        if (stuckMs >= 30_000) throw new CopilotSignInRequiredError();
        await sleep(500);
        continue;
      }
      loginSince = undefined;
      if (isCopilotHost(url)) {
        const composer = page.locator(COPILOT_READY_COMPOSER_SELECTORS.join(", ")).first();
        if (await composer.isVisible().catch(() => false)) {
          // The shell can render the composer before authentication finishes. Require the page to
          // remain on a Copilot host with the composer visible before declaring readiness.
          await sleep(3_000);
          if (
            !page.isClosed()
            && isCopilotHost(page.url())
            && await composer.isVisible().catch(() => false)
          ) {
            return;
          }
        }
      }
      await sleep(500);
    }
    throw new Error(
      `Copilot did not become ready at ${lastUrl}. Sign in with \`bun run copilot:login\` and verify the tenant exposes Copilot Chat.`,
    );
  }

  private async composer(page: Page): Promise<Locator> {
    const locator = page.locator(COPILOT_COMPOSER_SELECTORS.join(", ")).first();
    await locator.waitFor({ state: "visible", timeout: 30_000 });
    return locator;
  }

  private async openNewChat(page: Page): Promise<void> {
    for (const selector of COPILOT_NEW_CHAT_SELECTORS) {
      const control = page.locator(selector).first();
      if (!(await control.isVisible().catch(() => false))) continue;
      await control.click({ timeout: 10_000 }).catch(() => undefined);
      await sleep(750);
      await this.composer(page);
      return;
    }
    await page.goto(this.config.copilotUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await this.waitForCopilotReady(page);
    await sleep(500);
  }

  private async modelButton(page: Page): Promise<Locator | undefined> {
    for (const selector of COPILOT_MODEL_BUTTON_SELECTORS) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, 5); index += 1) {
        const candidate = locator.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        // The generic aria-haspopup fallback can match source, attachment, or profile menus.
        // Only accept it when its label actually looks like Copilot's model picker.
        if (selector === 'button[aria-haspopup="menu"]') {
          const label = `${await candidate.getAttribute("aria-label").catch(() => "") ?? ""} `
            + `${await candidate.innerText().catch(() => "")}`;
          if (!/model|auto|gpt|copilot|quick|think/i.test(label)) continue;
        }
        return candidate;
      }
    }
    return undefined;
  }

  private async modelButtonLabel(page: Page): Promise<string | null> {
    const button = await this.modelButton(page);
    if (!button) return null;
    return (await button.getAttribute("aria-label").catch(() => null))
      ?? (await button.innerText().catch(() => null));
  }

  /** The selected model as shown on the picker button, without its "Model Selector" suffix. */
  private async modelSelectionLabel(page: Page): Promise<string> {
    const button = await this.modelButton(page);
    if (!button) return "";
    const text = normalizeText(await button.innerText().catch(() => ""));
    if (text) return text.split("\n")[0]!.trim();
    const aria = await button.getAttribute("aria-label").catch(() => "");
    return (aria ?? "").replace(/,\s*Model Selector.*$/i, "").trim();
  }

  /**
   * A picker entry can be a model family (for example "GPT") whose concrete models are shown in a
   * submenu with tenant-specific names ("GPT-5.6 Sol Quick response"). Match both the exact label
   * and a family prefix, but not a label that merely occurs inside another model's name.
   */
  private modelMatches(current: string, wanted: string): boolean {
    const selected = current.trim().toLowerCase();
    const target = wanted.trim().toLowerCase();
    if (!selected || !target) return false;
    if (selected === target) return true;
    return selected.startsWith(`${target} `)
      || selected.startsWith(`${target}-`)
      || selected.startsWith(`${target}(`);
  }

  private async lastVisibleMenu(page: Page): Promise<Locator | undefined> {
    const menus = page.locator('[role="menu"], [role="listbox"]');
    const count = await menus.count().catch(() => 0);
    for (let index = count - 1; index >= 0; index -= 1) {
      const menu = menus.nth(index);
      if (await menu.isVisible().catch(() => false)) return menu;
    }
    return undefined;
  }

  /** Pick the first concrete model in an open submenu, ignoring further nested triggers. */
  private async selectFirstSubmenuOption(page: Page): Promise<boolean> {
    const menu = await this.lastVisibleMenu(page);
    if (!menu) return false;
    const options = menu.locator('[role="menuitemradio"], [role="menuitem"], [role="option"]');
    const count = await options.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      if (!(await option.isVisible().catch(() => false))) continue;
      if ((await option.getAttribute("aria-haspopup").catch(() => null)) === "menu") continue;
      await option.click({ timeout: 10_000 });
      await sleep(750);
      return true;
    }
    return false;
  }

  private async selectModel(page: Page, model: CopilotModelConfig): Promise<void> {
    const button = await this.modelButton(page);
    if (!button) {
      if (model.menuLabel.toLowerCase() === "auto") return;
      throw new Error(
        `Copilot model selector was not found; cannot select ${JSON.stringify(model.menuLabel)}. `
          + "Open Copilot and verify the model picker is visible.",
      );
    }
    const current = await this.modelSelectionLabel(page);
    if (this.modelMatches(current, model.menuLabel)) return;
    await button.click({ timeout: 10_000 });
    await sleep(500);

    const candidates: Locator[] = [
      page.getByRole("menuitem", { name: model.menuLabel, exact: true }),
      page.getByRole("option", { name: model.menuLabel, exact: true }),
      page.getByRole("menuitemradio", { name: model.menuLabel, exact: true }),
      page.getByText(model.menuLabel, { exact: true }),
      page.locator(`[role="menuitem"]:has-text(${JSON.stringify(model.menuLabel)})`),
      page.locator(`[role="option"]:has-text(${JSON.stringify(model.menuLabel)})`),
    ];
    for (const candidate of candidates) {
      const count = await candidate.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, 5); index += 1) {
        const item = candidate.nth(index);
        if (!(await item.isVisible().catch(() => false))) continue;
        const opensSubmenu = await item.evaluate(element => {
          const menuItem = element.closest('[role="menuitem"], [role="menuitemradio"], [role="option"]');
          return menuItem?.getAttribute("aria-haspopup") === "menu";
        }).catch(() => false);
        await item.click({ timeout: 10_000 });
        await sleep(750);
        let updated = await this.modelSelectionLabel(page);
        if (this.modelMatches(updated, model.menuLabel)) return;
        if (opensSubmenu && await this.selectFirstSubmenuOption(page)) {
          updated = await this.modelSelectionLabel(page);
          if (this.modelMatches(updated, model.menuLabel)) return;
        }
        throw new Error(
          `Copilot did not retain model ${JSON.stringify(model.menuLabel)}; the selector now shows ${JSON.stringify(updated)}.`,
        );
      }
    }

    const menuText = await page.locator('[role="menu"], [role="listbox"]').first()
      .innerText({ timeout: 2_000 }).catch(() => "");
    throw new Error(
      `Copilot model ${JSON.stringify(model.menuLabel)} is not available in this tenant. `
        + `Visible options: ${menuText ? JSON.stringify(normalizeText(menuText).slice(0, 500)) : "(none)"}`,
    );
  }

  private async insertPrompt(page: Page, prompt: string): Promise<void> {
    const composer = await this.composer(page);
    await composer.click({ timeout: 10_000 });
    await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
    await page.keyboard.press("Backspace").catch(() => undefined);
    const inserted = await composer.evaluate(insertPlainTextIntoComposer, prompt).catch(() => false);
    if (!inserted) {
      await page.keyboard.insertText(prompt);
    }
    await sleep(400);
    const marker = turnMarkerFromPrompt(prompt);
    const observed = await composer.innerText().catch(() => "");
    if (marker && !observed.includes(marker)) {
      // The editor may normalize the marker's brackets or split it across nodes. Verify only that
      // a substantial suffix of the prompt reached the composer, then let the send acceptance
      // check decide whether Copilot actually received the turn.
      const suffix = prompt.slice(-120).replace(/\s+/g, " ").trim();
      if (!observed.replace(/\s+/g, " ").includes(suffix)) {
        throw new Error("Copilot composer did not retain the compiled prompt; the message was not sent.");
      }
    }
  }

  private async sendButton(page: Page): Promise<Locator | undefined> {
    for (const selector of COPILOT_SEND_SELECTORS) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= Math.max(0, count - 5); index -= 1) {
        const candidate = locator.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        if (!(await candidate.isEnabled().catch(() => false))) continue;
        return candidate;
      }
    }
    return undefined;
  }

  private async transcript(page: Page): Promise<string> {
    for (const selector of COPILOT_MAIN_SELECTORS) {
      const main = page.locator(selector).first();
      if (!(await main.count().catch(() => 0))) continue;
      const text = await main.innerText({ timeout: 5_000 }).catch(() => "");
      if (text.trim()) return text;
    }
    return await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  }

  private async waitForPromptAccepted(
    page: Page,
    marker: string,
    beforeTranscript: string,
    timeoutMs: number,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const transcript = await this.transcript(page);
      if (transcript.includes(marker)) return transcript;
      // The user bubble may be virtualized or strip the marker. A substantial transcript change
      // after pressing Enter is still evidence that the composer accepted the turn.
      if (transcript.length > beforeTranscript.length + 40 && transcript !== beforeTranscript) {
        return transcript;
      }
      await sleep(300);
    }
    return this.transcript(page);
  }

  private async sendPrompt(page: Page, prompt: string): Promise<{ accepted: string; before: string }> {
    const composer = await this.composer(page);
    const markerLine = turnMarkerFromPrompt(prompt);
    const marker = markerLine;
    const before = await this.transcript(page);
    await composer.click({ timeout: 10_000 });
    await composer.press("Enter").catch(() => undefined);
    let transcript = await this.waitForPromptAccepted(page, marker, before, 2_500);
    if (!transcript.includes(marker) && transcript.length <= before.length + 40) {
      const send = await this.sendButton(page);
      if (!send) {
        throw new Error(
          "Copilot did not accept the prompt. Pressing Enter had no effect and no enabled Send button was found.",
        );
      }
      await send.click({ timeout: 10_000 });
      transcript = await this.waitForPromptAccepted(page, marker, before, this.config.sendTimeoutMs);
    }
    if (!transcript.includes(marker) && transcript.length <= before.length + 40) {
      throw new Error(
        "Copilot did not accept the prompt within the send timeout. The composer may require a different send action.",
      );
    }
    return { accepted: transcript, before };
  }

  private async isGenerating(page: Page): Promise<boolean> {
    for (const selector of COPILOT_STOP_SELECTORS) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < Math.min(count, 5); index += 1) {
        if (await locator.nth(index).isVisible().catch(() => false)) return true;
      }
    }
    return await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll('button, [role="button"]'));
      return controls.some(control => {
        const label = `${control.getAttribute("aria-label") ?? ""} ${control.textContent ?? ""}`.trim();
        if (!/^stop\b/i.test(label)) return false;
        const element = control as HTMLElement;
        return element.offsetParent !== null && !element.hasAttribute("disabled");
      });
    }).catch(() => false);
  }

  private async stopGeneration(page: Page): Promise<void> {
    for (const selector of COPILOT_STOP_SELECTORS) {
      const control = page.locator(selector).first();
      if (await control.isVisible().catch(() => false)) {
        await control.click({ timeout: 2_000 }).catch(() => undefined);
        return;
      }
    }
    await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll('button, [role="button"]'));
      const stop = controls.find(control => {
        const label = `${control.getAttribute("aria-label") ?? ""} ${control.textContent ?? ""}`.trim();
        return /^stop\b/i.test(label);
      }) as HTMLElement | undefined;
      stop?.click();
    }).catch(() => undefined);
  }

  private async waitForResponse(
    page: Page,
    marker: string,
    prompt: string,
    beforeTranscript: string,
    beforeReply: string,
    options: CopilotRunOptions,
    startedAt: number,
  ): Promise<{ text: string; transcript: string }> {
    const deadline = startedAt + this.config.turnTimeoutMs;
    let lastTranscript = "";
    let lastChangeAt = Date.now();
    let lastHeartbeatAt = Date.now();
    let lastProgressAt = 0;
    let sawGenerating = false;

    while (Date.now() < deadline) {
      throwIfAborted(options.signal);
      if (page.isClosed()) throw new Error("Copilot browser page was closed during the turn");
      const generating = await this.isGenerating(page);
      sawGenerating ||= generating;
      const transcript = await this.transcript(page);
      if (transcript !== lastTranscript) {
        lastTranscript = transcript;
        lastChangeAt = Date.now();
      }
      const reply = await this.latestReplyText(page, marker, prompt);
      const text = reply && reply !== beforeReply
        ? reply
        : extractCopilotResponseText(transcript, marker, prompt, beforeTranscript);
      const placeholder = isCopilotPlaceholder(text);
      const stableFor = Date.now() - lastChangeAt;
      const minimumWaitElapsed = Date.now() - startedAt >= 1_500;
      if (!generating && !placeholder && minimumWaitElapsed && stableFor >= this.config.responseStableMs) {
        return { text, transcript };
      }
      if (Date.now() - lastHeartbeatAt >= 5_000) {
        lastHeartbeatAt = Date.now();
        options.onHeartbeat?.();
      }
      if (Date.now() - lastProgressAt >= 15_000) {
        lastProgressAt = Date.now();
        options.onProgress?.(
          `waiting for Copilot${generating || sawGenerating ? " to finish generating" : ""}; `
            + `${text.length.toLocaleString()} response characters observed`,
        );
      }
      await sleep(500);
    }
    const transcript = await this.transcript(page);
    const reply = await this.latestReplyText(page, marker, prompt);
    const text = reply && reply !== beforeReply
      ? reply
      : extractCopilotResponseText(transcript, marker, prompt, beforeTranscript);
    if (!isCopilotPlaceholder(text)) return { text, transcript };
    await this.stopGeneration(page).catch(() => undefined);
    throw new Error(
      `Copilot did not produce a readable answer within ${Math.round(this.config.turnTimeoutMs / 1_000)} seconds. `
        + `Last transcript: ${JSON.stringify(normalizeText(transcript).slice(-1_000))}`,
    );
  }

  /**
   * Read the body of the most recent Copilot answer from its Markdown container. This avoids the
   * feed's "You said"/"Copilot said" labels and the follow-up suggestion chips.
   */
  private async latestReplyText(page: Page, marker: string, prompt: string): Promise<string> {
    for (const selector of ['[data-testid="markdown-reply"]', '[data-testid="lastChatMessage"]'] as const) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
      for (let index = count - 1; index >= Math.max(0, count - 8); index -= 1) {
        const element = locator.nth(index);
        if (!(await element.isVisible().catch(() => false))) continue;
        const raw = normalizeText(await element.evaluate(readCopilotReplyText).catch(() => ""));
        if (raw.length < 2) continue;
        const text = cleanCopilotReplyText(raw, marker, prompt);
        if (text.length > 0) return text;
      }
    }
    return "";
  }

  /** Open (or attach to) Copilot and verify that the page is usable without sending a turn. */
  async open(): Promise<{ url: string; title: string }> {
    return this.withTurn(async () => {
      const page = await this.ensurePage();
      return {
        url: page.url(),
        title: await page.title().catch(() => ""),
      };
    });
  }

  async runPrompt(
    prompt: string,
    model: CopilotModelConfig,
    options: CopilotRunOptions = {},
  ): Promise<CopilotRunResult> {
    return this.withTurn(async () => {
      const startedAt = Date.now();
      throwIfAborted(options.signal);
      const page = await this.ensurePage();
      const marker = turnMarkerFromPrompt(prompt);
      try {
        if (this.config.newChatPerTurn) await this.openNewChat(page);
        await this.selectModel(page, model);
        options.onProgress?.(`using Copilot model ${JSON.stringify(await this.modelSelectionLabel(page))}`);
        await this.insertPrompt(page, prompt);
        const beforeReply = await this.latestReplyText(page, marker, prompt);
        options.onProgress?.("submitting prompt to Copilot");
        const submission = await this.sendPrompt(page, prompt);
        options.onProgress?.("waiting for Copilot response");
        const result = await this.waitForResponse(
          page,
          marker,
          prompt,
          submission.before,
          beforeReply,
          options,
          startedAt,
        );
        let text = result.text;
        if (isCopilotPlaceholder(text)) {
          text = await this.latestReplyText(page, marker, prompt);
        }
        if (isCopilotPlaceholder(text)) {
          throw new Error(
            "Copilot completed the turn without readable response text. "
              + "Run `bun run copilot:probe` and inspect the saved diagnostics.",
          );
        }
        return { text, transcript: result.transcript, elapsedMs: Date.now() - startedAt };
      } catch (error) {
        if (options.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          await this.stopGeneration(page).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async probe(prompt?: string): Promise<CopilotProbeResult> {
    return this.withTurn(async () => {
      const page = await this.ensurePage();
      const signedIn = !/login\.microsoftonline\.com|login\.live\.com/i.test(page.url());
      const candidates: CopilotProbeResult["candidates"] = [];
      for (const selector of COPILOT_MESSAGE_SELECTORS) {
        const locator = page.locator(selector);
        const count = await locator.count().catch(() => 0);
        let lastText: string | null = null;
        if (count > 0) {
          const last = locator.last();
          lastText = await last.innerText({ timeout: 2_000 }).catch(() => null);
        }
        candidates.push({ selector, count, lastText });
      }
      const html = await page.locator(COPILOT_MAIN_SELECTORS.join(", ")).first()
        .innerHTML({ timeout: 5_000 }).catch(() => "");
      const result: CopilotProbeResult = {
        url: page.url(),
        title: await page.title().catch(() => ""),
        signedIn,
        composerMatches: await page.locator(COPILOT_COMPOSER_SELECTORS.join(", ")).count().catch(() => 0),
        modelButtonLabel: await this.modelButtonLabel(page),
        newChatMatches: await page.locator(COPILOT_NEW_CHAT_SELECTORS.join(", ")).count().catch(() => 0),
        sendMatches: await page.locator(COPILOT_SEND_SELECTORS.join(", ")).count().catch(() => 0),
        stopMatches: await page.locator(COPILOT_STOP_SELECTORS.join(", ")).count().catch(() => 0),
        transcript: (await this.transcript(page)).slice(0, 20_000),
        candidates,
        html: html.slice(0, 100_000),
      };
      if (prompt) {
        const markerId = randomUUID().replaceAll("-", "");
        const fullPrompt = `${prompt}\n\n[[codex-transport-turn:${markerId}]]`;
        const marker = `[[codex-transport-turn:${markerId}]]`;
        const before = await this.transcript(page);
        await this.insertPrompt(page, fullPrompt);
        const beforeReply = await this.latestReplyText(page, marker, fullPrompt);
        const submission = await this.sendPrompt(page, fullPrompt);
        const after = await this.waitForResponse(
          page,
          marker,
          fullPrompt,
          submission.before,
          beforeReply,
          {},
          Date.now(),
        );
        result.prompt = prompt;
        result.beforeTranscript = before.slice(0, 20_000);
        result.afterTranscript = after.transcript.slice(0, 40_000);
        result.response = after.text;
        result.replyHtml = await page.locator('[data-testid="markdown-reply"]').last()
          .evaluate(element => element.outerHTML)
          .catch(() => "");
      }
      return result;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const context = this.context;
    const browser = this.browser;
    this.context = undefined;
    this.browser = undefined;
    this.page = undefined;
    if (!this.ownsContext) {
      await browser?.close().catch(() => undefined);
      return;
    }
    await context?.close().catch(() => undefined);
  }
}

const browsers = new Map<string, CopilotBrowser>();

export function copilotBrowserForConfig(config: CopilotConfig): CopilotBrowser {
  const key = JSON.stringify({
    browser: config.browser,
    copilotUrl: config.copilotUrl,
    turnTimeoutMs: config.turnTimeoutMs,
    sendTimeoutMs: config.sendTimeoutMs,
    responseStableMs: config.responseStableMs,
    newChatPerTurn: config.newChatPerTurn,
  });
  let browser = browsers.get(key);
  if (!browser) {
    browser = new CopilotBrowser(config);
    browsers.set(key, browser);
  }
  return browser;
}

export async function closeCopilotBrowsers(): Promise<void> {
  const open = [...browsers.values()];
  browsers.clear();
  await Promise.allSettled(open.map(browser => browser.close()));
}
