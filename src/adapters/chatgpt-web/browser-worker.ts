import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChromeCdpBrowser, type CdpPage } from "../../chrome-cdp";
import { expandUserPath, getConfigDir } from "../../config";
import type { CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";
import { ChatGptMarkdownStream } from "./markdown";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities, type ChatGptWebModelMode } from "./model";
import { CHATGPT_INTERNAL_COMPACTION_MARKER, containsChatGptCompactionMarker, stripChatGptTransportMarkers, type CompiledChatGptWebPrompt, type ChatGptWebPromptImage } from "./prompt";
import { estimateCompiledChatGptWebInputTokens } from "./usage";
import { ChatGptBrowserTurnPool } from "./browser-turn-pool";
import { assertAuthenticatedChatGptPage, assertTemporaryChatPage, CHATGPT_TEMPORARY_CHAT_URL } from "../../chatgpt-session";

const workers = new Map<string, ChatGptBrowserWorker>();

export const DEFAULT_CHATGPT_TURN_TIMEOUT_MS = 40 * 60_000;
export const CHATGPT_RESPONSE_DOM_GRACE_MS = 30_000;
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000;

const browserStageTimeouts = {
  browserPage: 60_000,
  navigation: 70_000,
  composerReady: 40_000,
  sessionVerification: 40_000,
  effortSelection: 120_000,
  promptAttachment: 60_000,
  fileAttachment: 120_000,
  send: 20_000,
} as const;

export interface BrowserTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  parallel: boolean;
  capabilities: ChatGptWebCapabilities;
  prepare: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  /** Visible ChatGPT reasoning-summary step titles only; never hidden chain-of-thought. */
  onReasoningSummary?: (text: string) => void;
  /** Stable visible ChatGPT prose between status/tool rows. */
  onCommentary?: (text: string, continuation?: boolean) => void;
  /** Append-only, structurally stable Markdown chunks. */
  onTextDelta: (delta: string) => void;
}

interface ResolvedBrowserConfig {
  appName: string;
  storageStatePath: string;
  chromeExecutablePath: string;
  chromeProfilePath: string;
  chromeDebugPort: number;
  turnTimeoutMs: number;
  autoApproveToolCalls: boolean;
}

export function chatGptTurnIsComplete(state: {
  responsePresent: boolean;
  running: boolean;
  currentText: string;
  completionActionVisible: boolean;
}): boolean {
  return state.responsePresent
    && !state.running
    && state.currentText.length > 0
    && state.completionActionVisible;
}

export class ChatGptCompletionTracker {
  private candidate?: { signature: string; since: number };

  constructor(private readonly stableMs = 750) {}

  update(state: Parameters<typeof chatGptTurnIsComplete>[0], now = Date.now()): boolean {
    if (!chatGptTurnIsComplete(state)) {
      this.candidate = undefined;
      return false;
    }
    const signature = state.currentText;
    if (this.candidate?.signature !== signature) {
      this.candidate = { signature, since: now };
      return false;
    }
    return now - this.candidate.since >= this.stableMs;
  }
}

export class ChatGptTurnDomHealthTracker {
  private sawResponse = false;
  private missingResponseSince?: number;
  private emptyCompletionSince?: number;

  constructor(
    private readonly missingResponseMs = CHATGPT_RESPONSE_DOM_GRACE_MS,
    private readonly emptyCompletionMs = CHATGPT_EMPTY_RESPONSE_GRACE_MS,
  ) {}

  update(state: {
    responsePresent: boolean;
    running: boolean;
    currentText: string;
    completionActionVisible: boolean;
  }, now = Date.now()): string | undefined {
    if (state.responsePresent) {
      this.sawResponse = true;
      this.missingResponseSince = undefined;
    } else {
      this.missingResponseSince ??= now;
      if (now - this.missingResponseSince >= this.missingResponseMs) {
        return this.sawResponse
          ? "ChatGPT response DOM disappeared while the browser turn was active"
          : "ChatGPT did not create a response DOM after the message was sent";
      }
    }

    const emptyCompletion = state.responsePresent
      && !state.running
      && state.currentText.length === 0
      && state.completionActionVisible;
    if (!emptyCompletion) {
      this.emptyCompletionSince = undefined;
    } else {
      this.emptyCompletionSince ??= now;
      if (now - this.emptyCompletionSince >= this.emptyCompletionMs) {
        return "ChatGPT browser turn completed without a final answer";
      }
    }
    return undefined;
  }
}

export interface ChatGptVisibleTraceBlock {
  kind: "markdown" | "status";
  text: string;
}

export interface ChatGptVisibleTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface ChatGptResponseDomSnapshot {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  stableHtml: string;
  completionActionVisible: boolean;
  traceBlocks: ChatGptVisibleTraceBlock[];
}

const absentResponseDomSnapshot = (): ChatGptResponseDomSnapshot => ({
  responsePresent: false,
  visibleText: "",
  fullHtml: "",
  stableHtml: "",
  completionActionVisible: false,
  traceBlocks: [],
});

/** Convert the public ChatGPT turn DOM into append-only Codex reasoning summaries. */
export class ChatGptVisibleTraceTracker {
  private readonly seen = new Set<string>();
  private readonly emittedCommentary = new Map<number, string>();
  private readonly commentaryChangedAt = new Map<number, number>();

  constructor(private readonly commentaryStabilityMs = 1_000) {}

  observe(blocks: ChatGptVisibleTraceBlock[], completionActionVisible: boolean, now = Date.now()): ChatGptVisibleTraceEvent[] {
    let lastMarkdown = -1;
    for (let index = 0; index < blocks.length; index++) {
      if (blocks[index]!.kind === "markdown") lastMarkdown = index;
    }
    const output: ChatGptVisibleTraceEvent[] = [];
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!;
      if (containsChatGptCompactionMarker(block.text)
        && !this.seen.has(CHATGPT_INTERNAL_COMPACTION_MARKER)) {
        this.seen.add(CHATGPT_INTERNAL_COMPACTION_MARKER);
        output.push({ kind: "reasoning", text: "Context automatically compacted" });
      }
      const text = stripChatGptTransportMarkers(block.text)
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.replace(/[\t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (!text) continue;
      // The trailing Markdown root is ambiguous while running and becomes the final answer once
      // complete. It stays owned by ChatGptMarkdownStream; earlier roots are stable commentary.
      if (block.kind === "markdown"
        && (completionActionVisible ? index === lastMarkdown : index === blocks.length - 1)) {
        continue;
      }
      if (block.kind === "markdown") {
        const previous = this.emittedCommentary.get(index);
        if (previous === text) {
          const changedAt = this.commentaryChangedAt.get(index) ?? now;
          if (now - changedAt < this.commentaryStabilityMs) break;
          continue;
        }
        this.commentaryChangedAt.set(index, now);
        if (previous && text.startsWith(previous)) {
          this.emittedCommentary.set(index, text);
          output.push({ kind: "commentary", text: text.slice(previous.length), continuation: true });
          break;
        }
        this.emittedCommentary.set(index, text);
      }
      const key = `${block.kind}\0${text}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      output.push({ kind: block.kind === "markdown" ? "commentary" : "reasoning", text });
      if (block.kind === "markdown") break;
    }
    return output;
  }
}

export function chatGptEffortLabelsMatch(current: string, desired: string): boolean {
  const normalize = (value: string) => {
    const label = value.replace(/\s+/g, " ").trim();
    return /^(?:Instant|Instant 5\.5)$/.test(label) ? "Instant 5.5" : label;
  };
  return normalize(current) === normalize(desired);
}

export function isChatGptTraceControl(block: ChatGptVisibleTraceBlock): boolean {
  return block.kind === "status" && block.text.replace(/\s+/g, " ").trim() === "Answer now";
}

export function redactChatGptUiDiagnostic(value: string): string {
  return value
    .replace(/<codex_context_json>[\s\S]*?<\/codex_context_json>/gi, "<codex_context_json>[redacted]</codex_context_json>")
    .replace(/\b(turn|binding|call)_[A-Za-z0-9_-]{12,}\b/g, "$1_[redacted]");
}

function resolveBrowserConfig(provider: CodexProviderConfig): ResolvedBrowserConfig {
  const configured = provider.chatgptWeb ?? {};
  return {
    appName: configured.appName?.trim() || "Codex Native",
    storageStatePath: resolve(expandUserPath(configured.storageStatePath?.trim() || join(getConfigDir(), "browser", "session.json"))),
    chromeExecutablePath: resolve(expandUserPath(configured.chromeExecutablePath?.trim() || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")),
    chromeProfilePath: resolve(expandUserPath(configured.chromeProfilePath?.trim() || join(getConfigDir(), "chrome-profile"))),
    chromeDebugPort: configured.chromeDebugPort ?? 17842,
    turnTimeoutMs: configured.turnTimeoutMs ?? DEFAULT_CHATGPT_TURN_TIMEOUT_MS,
    autoApproveToolCalls: configured.autoApproveToolCalls === true,
  };
}

const imageExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

export function chatGptImageFilePayloads(images: ChatGptWebPromptImage[]): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  if (images.length > 10) throw new Error("ChatGPT web accepts at most 10 input images per Codex turn");
  let totalBytes = 0;
  return images.map(image => {
    const parsed = parseDataUrl(image.imageUrl);
    if (!parsed) throw new Error(`ChatGPT web input image ${image.ref} must be an inline base64 data URL`);
    const extension = imageExtensions.get(parsed.mediaType.toLowerCase());
    if (!extension) throw new Error(`ChatGPT web input image ${image.ref} has unsupported media type: ${parsed.mediaType}`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.base64) || parsed.base64.length % 4 !== 0) {
      throw new Error(`ChatGPT web input image ${image.ref} contains invalid base64 data`);
    }
    const buffer = Buffer.from(parsed.base64, "base64");
    if (buffer.length === 0) throw new Error(`ChatGPT web input image ${image.ref} is empty`);
    if (buffer.length > 20_000_000) throw new Error(`ChatGPT web input image ${image.ref} exceeds 20 MB`);
    totalBytes += buffer.length;
    if (totalBytes > 50_000_000) throw new Error("ChatGPT web input images exceed the 50 MB per-turn limit");
    return { name: `${image.ref}.${extension}`, mimeType: parsed.mediaType.toLowerCase(), buffer };
  });
}

export function chatGptPromptFilePayloads(
  prompt: CompiledChatGptWebPrompt,
): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  return chatGptImageFilePayloads(prompt.images);
}

export class ChatGptBrowserWorker {
  static forProvider(provider: CodexProviderConfig): ChatGptBrowserWorker {
    const config = resolveBrowserConfig(provider);
    const key = JSON.stringify(config);
    let worker = workers.get(key);
    if (!worker) {
      worker = new ChatGptBrowserWorker(config);
      workers.set(key, worker);
    }
    return worker;
  }

  private browser?: ChromeCdpBrowser;
  private readonly pool = new ChatGptBrowserTurnPool(4);

  private constructor(private readonly config: ResolvedBrowserConfig) {}

  run(turn: BrowserTurn): Promise<string> {
    return this.pool.run(
      turn.parallel ? "ultra" : "exclusive",
      () => this.runIsolated(turn),
      turn.abortSignal,
    );
  }

  async close(): Promise<void> {
    await this.pool.waitForIdle();
    const browser = this.browser;
    this.browser = undefined;
    browser?.close();
  }

  private discardBrowser(): void {
    const browser = this.browser;
    this.browser = undefined;
    browser?.close();
  }

  private async runStage<T>(traceId: string, stage: string, timeoutMs: number, action: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const timeout = new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(() => {
          timedOut = true;
          rejectTimeout(new Error(`ChatGPT browser stage timed out: ${stage}`));
        }, timeoutMs);
      });
      const value = await Promise.race([action(), timeout]);
      console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} completed durationMs=${Math.round(performance.now() - startedAt)}`);
      return value;
    } catch (error) {
      console.error(`[chatgpt-web] browser turn ${traceId} stage=${stage} failed durationMs=${Math.round(performance.now() - startedAt)}: ${error instanceof Error ? error.message : String(error)}`);
      if (timedOut && this.pool.state().active <= 1) this.discardBrowser();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private ensureBrowser(): ChromeCdpBrowser {
    this.browser ??= new ChromeCdpBrowser({
      executablePath: this.config.chromeExecutablePath,
      profilePath: this.config.chromeProfilePath,
      debugPort: this.config.chromeDebugPort,
    });
    return this.browser;
  }

  /**
   * A Codex turn owns one isolated Temporary Chat document. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  private async pageForNewTurn(): Promise<CdpPage> {
    const page = await this.ensureBrowser().newPage();
    await page.activate();
    return page;
  }

  private async selectModelAndEffort(
    page: CdpPage,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
  ): Promise<ChatGptWebModelMode> {
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const effortLabel = async () => page.evaluate<string>(`(() => {
      const visible = element => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return [...document.querySelectorAll("button")]
        .filter(visible)
        .map(button => button.innerText.replace(/\\s+/g, " ").trim())
        .filter(text => /^(?:Instant(?: 5\\.5)?|Medium|High|Extra High|Pro)$/.test(text))
        .at(-1) || "";
    })()`);

    const readyDeadline = Date.now() + 70_000;
    let current = "";
    while (Date.now() < readyDeadline) {
      current = await effortLabel();
      if (current) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    if (!current) throw new Error("ChatGPT rendered the composer but its model/effort control did not become ready");
    if (chatGptEffortLabelsMatch(current, mode.uiEffortLabel)) return mode;

    await page.clickElement(`[...document.querySelectorAll("button")]
      .filter(element => /^(?:Instant(?:\\s+5\\.5)?|Medium|High|Extra High|Pro)$/.test(element.innerText.trim()))
      .at(-1)`);

    const choiceDeadline = Date.now() + 20_000;
    let choices: string[] = [];
    let selected = false;
    while (Date.now() < choiceDeadline) {
      const result = await page.evaluate<{ available: boolean; choices: string[] }>(`(() => {
        const desired = ${JSON.stringify(mode.uiEffortLabel)};
        const visible = element => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const items = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]
          .filter(visible);
        const choices = items
          .map(element => element.textContent?.replace(/\\s+/g, " ").trim() || "")
          .filter(text => /^(?:Instant(?: ?5\\.5)?|Medium|High|Extra High|Pro)$/.test(text));
        const normalize = text => /^Instant(?: ?5\\.5)?$/.test(text) ? "Instant 5.5" : text;
        const choice = items.find(element => normalize(
          element.textContent?.replace(/\\s+/g, " ").trim() || ""
        ) === normalize(desired));
        return { available: choice instanceof HTMLElement, choices };
      })()`);
      choices = result.choices;
      if (result.available) {
        await page.clickElement(`[...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')]
          .find(element => {
            const text = element.textContent?.replace(/\\s+/g, " ").trim() || "";
            const normalize = value => /^Instant(?: ?5\\.5)?$/.test(value) ? "Instant 5.5" : value;
            return normalize(text) === normalize(${JSON.stringify(mode.uiEffortLabel)});
          })`);
        selected = true;
        break;
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    if (!selected) {
      throw new Error(
        `ChatGPT effort ${JSON.stringify(mode.uiEffortLabel)} is unavailable in the authenticated account UI`
        + (choices.length > 0 ? `; available: ${choices.join(", ")}` : ""),
      );
    }

    const confirmationDeadline = Date.now() + 40_000;
    while (Date.now() < confirmationDeadline) {
      const visibleLabel = await effortLabel();
      if (chatGptEffortLabelsMatch(visibleLabel, mode.uiEffortLabel)) return mode;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error(`ChatGPT did not confirm effort ${JSON.stringify(mode.uiEffortLabel)}`);
  }

  private async attachedPromptText(page: CdpPage): Promise<string> {
    return page.evaluate<string>(`(() => {
      const visible = element => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const element = [
        ...document.querySelectorAll(
          '[data-testid="prompt-textarea"], #prompt-textarea, [role="textbox"][contenteditable="true"], [contenteditable="true"][data-lexical-editor="true"]'
        )
      ].find(visible);
      if (!(element instanceof HTMLElement)) return "";
      const clone = element.cloneNode(true);
      if (!(clone instanceof HTMLElement)) return "";
      clone.querySelectorAll("[data-inline-selection-pill], [data-inline-selection-pill-cursor-target]")
        .forEach(part => part.remove());
      const children = [...clone.children];
      return (children.length > 0
        ? children.map(child => child.textContent || "").join("\\n")
        : clone.textContent || ""
      ).trimStart();
    })()`, 20_000);
  }

  private async assertPromptAttached(page: CdpPage, prompt: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    let observed = "";
    while (Date.now() < deadline) {
      observed = await this.attachedPromptText(page);
      if (observed === prompt) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
    let commonPrefix = 0;
    while (commonPrefix < prompt.length && prompt[commonPrefix] === observed[commonPrefix]) commonPrefix += 1;
    throw new Error(
      `ChatGPT composer did not preserve the complete prompt (expectedChars=${prompt.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix})`,
    );
  }

  private async attachPrompt(page: CdpPage, prompt: string, localTools: boolean): Promise<void> {
    const composerSelector = [
      '[data-testid="prompt-textarea"]',
      "#prompt-textarea",
      '[role="textbox"][contenteditable="true"]',
      '[contenteditable="true"][data-lexical-editor="true"]',
    ].join(", ");
    if (!localTools) {
      await page.insertText(composerSelector, prompt);
      await this.assertPromptAttached(page, prompt);
      return;
    }

    await page.insertText(composerSelector, `@${this.config.appName}`);
    const appDeadline = Date.now() + 20_000;
    let appVisible = false;
    while (Date.now() < appDeadline) {
      appVisible = await page.evaluate<boolean>(`(() => {
        const expected = ${JSON.stringify(this.config.appName)};
        const visible = element => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        return [...document.querySelectorAll('[role="group"], [role="option"], [role="menuitem"]')]
          .filter(visible)
          .some(element => (element.textContent || "").replace(/\\s+/g, " ").trim().includes(expected));
      })()`);
      if (appVisible) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    if (!appVisible) throw new Error(`ChatGPT connector ${JSON.stringify(this.config.appName)} did not appear`);

    await page.clickElement(`(() => {
      const expected = ${JSON.stringify(this.config.appName)};
      const visible = element => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return [...document.querySelectorAll('[role="group"], [role="option"], [role="menuitem"]')]
        .filter(visible)
        .filter(element => (element.textContent || "").replace(/\\s+/g, " ").trim().includes(expected))
        .at(-1);
    })()`);

    const selectionDeadline = Date.now() + 10_000;
    let selected = false;
    while (Date.now() < selectionDeadline) {
      selected = await page.evaluate<boolean>(`(() => {
        const expected = ${JSON.stringify(this.config.appName)};
        const visible = element => {
          if (!(element instanceof HTMLElement)) return false;
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };
        const labelMatches = element => {
          const normalize = value => (value || "").replace(/\\s+/g, " ").trim();
          if (normalize(element.textContent) === expected) return true;
          return [...element.querySelectorAll("*")]
            .some(child => child.children.length === 0 && normalize(child.textContent) === expected);
        };
        const composer = [...document.querySelectorAll(${JSON.stringify(composerSelector)})]
          .find(visible);
        if (!(composer instanceof HTMLElement)) return false;
        return [...composer.querySelectorAll('a, [data-inline-selection-pill]')]
          .some(labelMatches);
      })()`);
      if (selected) break;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    if (!selected) throw new Error(`ChatGPT did not attach connector ${JSON.stringify(this.config.appName)}`);

    await page.appendText(composerSelector, ` ${prompt}`);
    await this.assertPromptAttached(page, prompt);
  }

  private async attachFiles(page: CdpPage, prompt: CompiledChatGptWebPrompt): Promise<void> {
    const files = chatGptPromptFilePayloads(prompt);
    if (files.length === 0) return;
    const uploadDir = join(getConfigDir(), "runtime", "uploads", crypto.randomUUID());
    mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
    try {
      const paths = files.map(file => {
        const path = join(uploadDir, file.name);
        writeFileSync(path, file.buffer, { mode: 0o600 });
        return path;
      });
      const existing = await page.evaluate<number>(
        `document.querySelectorAll('button[aria-label^="Remove file "]').length`,
      );
      await page.setInputFiles('input[data-testid="upload-photos-input"]', paths);
      const deadline = Date.now() + 60_000;
      let alerts: string[] = [];
      while (Date.now() < deadline) {
        const state = await page.evaluate<{ accepted: number; sendEnabled: boolean; alerts: string[] }>(`(() => {
          const visible = element => {
            if (!(element instanceof HTMLElement)) return false;
            const style = getComputedStyle(element);
            return style.display !== "none" && style.visibility !== "hidden";
          };
          const send = document.querySelector('[data-testid="send-button"]');
          return {
            accepted: [...document.querySelectorAll('button[aria-label^="Remove file "]')].filter(visible).length,
            sendEnabled: send instanceof HTMLButtonElement && !send.disabled,
            alerts: [...document.querySelectorAll('[role="alert"]')]
              .filter(visible)
              .map(element => element.textContent?.replace(/\\s+/g, " ").trim() || "")
              .filter(Boolean)
          };
        })()`);
        alerts = state.alerts;
        if (state.accepted >= existing + files.length && state.sendEnabled) return;
        await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
      }
      throw new Error(
        "ChatGPT did not accept all prompt attachments"
        + (alerts.length > 0 ? `: ${alerts.join(" | ")}` : ""),
      );
    } finally {
      rmSync(uploadDir, { recursive: true, force: true });
    }
  }

  private async handleToolConfirmation(page: CdpPage): Promise<boolean> {
    const waiting = await page.evaluate<boolean>(`(() => {
      const expected = ${JSON.stringify(`Allow ChatGPT to use ${this.config.appName}?`)};
      return [...document.querySelectorAll("body *")].some(element =>
        element.children.length === 0 && element.textContent?.trim() === expected
      );
    })()`);
    if (!waiting) return false;
    if (!this.config.autoApproveToolCalls) {
      throw new Error(
        `ChatGPT is waiting for confirmation to use ${this.config.appName}; set chatgptWeb.autoApproveToolCalls=true to authorize per-call "Allow once" clicks`,
      );
    }
    await page.clickElement(`[...document.querySelectorAll("button")]
      .find(element => element.innerText.trim() === "Allow once")`);
    return true;
  }

  private async responseDomSnapshot(page: CdpPage, responseIndex: number): Promise<ChatGptResponseDomSnapshot> {
    const snapshot = await page.evaluate<ChatGptResponseDomSnapshot>(`(() => {
      const root = document.querySelectorAll('section[data-testid^="conversation-turn-"][data-turn="assistant"]')
        .item(${responseIndex});
      if (!(root instanceof HTMLElement)) return ${JSON.stringify(absentResponseDomSnapshot())};
      const visible = candidate => {
        const style = getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && rect.width > 0
          && rect.height > 0;
      };
      const elementText = candidate => (
        typeof candidate.innerText === "string" ? candidate.innerText : candidate.textContent || ""
      ).trim();

      const rendered = [...root.querySelectorAll(".markdown")].at(-1);
      const renderedChildren = rendered ? [...rendered.children] : [];
      const completionAction = [...root.querySelectorAll('button[aria-label="Copy response"]')]
        .find(visible);
      const candidates = new Map();
      root.querySelectorAll(".markdown").forEach(candidate => candidates.set(candidate, "markdown"));
      root.querySelectorAll(
        'button, [role="status"], [aria-busy="true"], [data-testid*="cot"], [data-testid*="reason"], [data-testid*="thought"]',
      ).forEach(candidate => {
        if (candidate.closest('[aria-label="Response actions"]')) return;
        const semantic = candidate.closest("button") ?? candidate;
        if (!candidates.has(semantic)) candidates.set(semantic, "status");
      });
      root.querySelectorAll("[data-streaming-response-status]").forEach(container => {
        if (![...candidates.keys()].some(candidate => container.contains(candidate))) {
          candidates.set(container, "status");
        }
      });
      const traceBlocks = [...candidates]
        .filter(([candidate]) => visible(candidate))
        .sort(([left], [right]) => left === right
          ? 0
          : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        .map(([candidate, kind]) => ({ kind, text: elementText(candidate) }))
        .filter(block => block.text.length > 0)
        .filter((block, index, blocks) => (
          blocks.findIndex(other => other.kind === block.kind && other.text === block.text) === index
        ));
      return {
        responsePresent: true,
        visibleText: rendered ? elementText(rendered) : "",
        fullHtml: rendered?.innerHTML ?? "",
        stableHtml: renderedChildren.slice(0, -1).map(child => child.outerHTML).join(""),
        completionActionVisible: completionAction !== undefined,
        traceBlocks,
      };
    })()`, 2_000).catch(() => absentResponseDomSnapshot());
    snapshot.traceBlocks = snapshot.traceBlocks.filter(block => !isChatGptTraceControl(block));
    return snapshot;
  }

  private async stalledTurnDiagnostic(page: CdpPage, responseIndex: number): Promise<string> {
    const diagnostic = await page.evaluate<{ response: unknown; overlays: unknown }>(`(() => {
      const root = document.querySelectorAll('section[data-testid^="conversation-turn-"][data-turn="assistant"]')
        .item(${responseIndex});
      const elementText = candidate => (
        typeof candidate.innerText === "string" ? candidate.innerText : candidate.textContent || ""
      ).trim();
      const response = root instanceof HTMLElement
        ? (() => {
        const descriptors = [...root.querySelectorAll("[role], [data-testid], button, [aria-label]")]
          .filter(candidate => {
            const style = getComputedStyle(candidate);
            return style.visibility !== "hidden" && style.display !== "none";
          })
          .slice(-80)
          .map(candidate => ({
            tag: candidate.tagName.toLowerCase(),
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabel: candidate.getAttribute("aria-label"),
            title: candidate.getAttribute("title"),
            text: elementText(candidate).slice(0, 500),
          }));
        return {
          text: elementText(root).slice(0, 2_000),
          descriptors,
        };
      })()
        : { text: "", descriptors: [] };
      const overlays = [...document.querySelectorAll('[role="dialog"], [role="alert"], [role="status"]')]
        .filter(element => {
          const candidate = element;
          const style = getComputedStyle(candidate);
          return style.visibility !== "hidden" && style.display !== "none";
        })
        .slice(-30)
        .map(element => {
          const candidate = element;
          return {
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabel: candidate.getAttribute("aria-label"),
            text: elementText(candidate).slice(0, 1_000),
          };
        });
      return { response, overlays };
    })()`).catch(error => ({
      response: { diagnosticError: error instanceof Error ? error.message : String(error) },
      overlays: [],
    }));
    return redactChatGptUiDiagnostic(JSON.stringify(diagnostic));
  }

  private async runIsolated(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    let preparedToRelease: Awaited<ReturnType<BrowserTurn["prepare"]>> | undefined;
    let pageToClose: CdpPage | undefined;
    try {
      const prepared = await turn.prepare();
      preparedToRelease = prepared;
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(prepared, turn.modelId);
      const deadline = Date.now() + this.config.turnTimeoutMs;
      const page = await this.runStage(turn.traceId, "browser_page", browserStageTimeouts.browserPage, () => this.pageForNewTurn());
      pageToClose = page;
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=chrome-devtools, promptChars=${prepared.text.length}, estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length})`,
      );
      await this.runStage(turn.traceId, "temporary_chat_navigation", browserStageTimeouts.navigation, () => (
        page.navigate(CHATGPT_TEMPORARY_CHAT_URL, 60_000)
      ));
      try {
        await this.runStage(turn.traceId, "composer_ready", browserStageTimeouts.composerReady, async () => {
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            const visible = await page.evaluate<boolean>(`(() => {
              const shown = element => {
                if (!(element instanceof HTMLElement)) return false;
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
              };
              return [...document.querySelectorAll(
                '[data-testid="prompt-textarea"], #prompt-textarea, [role="textbox"][contenteditable="true"], [contenteditable="true"][data-lexical-editor="true"]'
              )].some(shown);
            })()`).catch(() => false);
            if (visible) return;
            await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
          }
          throw new Error("composer did not become visible");
        });
      } catch {
        throw new Error("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
      }
      await this.runStage(turn.traceId, "session_verification", browserStageTimeouts.sessionVerification, async () => {
        await assertAuthenticatedChatGptPage(page);
        await assertTemporaryChatPage(page);
      });
      const mode = await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, () => (
        this.selectModelAndEffort(page, turn.modelId, turn.reasoning, turn.capabilities)
      ));
      await this.runStage(turn.traceId, "prompt_attachment", browserStageTimeouts.promptAttachment, () => (
        this.attachPrompt(page, prepared.text, mode.localTools)
      ));
      await this.runStage(turn.traceId, "file_attachment", browserStageTimeouts.fileAttachment, () => (
        this.attachFiles(page, prepared)
      ));
      const initialResponseTurnCount = await page.evaluate<number>(
        `document.querySelectorAll('section[data-testid^="conversation-turn-"][data-turn="assistant"]').length`,
      );
      await this.runStage(turn.traceId, "send", browserStageTimeouts.send, async () => {
        const sendEnabled = await page.evaluate<boolean>(`(() => {
          const button = document.querySelector('[data-testid="send-button"]');
          return button instanceof HTMLButtonElement && !button.disabled;
        })()`);
        if (!sendEnabled) throw new Error("ChatGPT send button is unavailable");
        await page.pressEnter([
          '[data-testid="prompt-textarea"]',
          "#prompt-textarea",
          '[role="textbox"][contenteditable="true"]',
          '[contenteditable="true"][data-lexical-editor="true"]',
        ].join(", "));
      });

      let lastHeartbeat = 0;
      let finalText = "";
      let sawRunning = false;
      let loggedCompletionWait = false;
      const sentAt = Date.now();
      const visibleTrace = new ChatGptVisibleTraceTracker();
      const markdownStream = new ChatGptMarkdownStream(stripChatGptTransportMarkers);
      const completionTracker = new ChatGptCompletionTracker();
      const domHealthTracker = new ChatGptTurnDomHealthTracker();
      for (;;) {
        if (turn.abortSignal?.aborted) {
          await page.clickElement(`[...document.querySelectorAll("button")]
            .find(element => element.getAttribute("aria-label") === "Stop answering"
              || element.innerText.trim() === "Stop answering")`).catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (Date.now() >= deadline) throw new Error("ChatGPT web turn timed out");
        if (Date.now() - lastHeartbeat >= 10_000) {
          turn.onHeartbeat?.();
          lastHeartbeat = Date.now();
        }

        if (mode.localTools && await this.handleToolConfirmation(page)) {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }

        const snapshot = await this.responseDomSnapshot(page, initialResponseTurnCount);
        const running = await page.evaluate<boolean>(`(() => {
          const visible = element => {
            if (!(element instanceof HTMLElement)) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          return [...document.querySelectorAll("button")].some(element =>
            visible(element) && (
              element.getAttribute("aria-label") === "Stop answering"
              || element.innerText.trim() === "Stop answering"
            )
          );
        })()`).catch(() => false);
        if (running) sawRunning = true;
        if (snapshot.responsePresent) {
          for (const trace of visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
            if (trace.kind === "commentary") turn.onCommentary?.(trace.text, trace.continuation === true);
            else turn.onReasoningSummary?.(trace.text);
          }
          const domError = domHealthTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            completionActionVisible: snapshot.completionActionVisible,
          });
          if (domError) throw new Error(domError);
          // ChatGPT can render visible commentary Markdown between tool-status rows. Only a
          // Markdown root accompanied by the response action belongs to the final answer stream.
          if (snapshot.completionActionVisible) {
            const stableDelta = markdownStream.observeStableHtml(snapshot.stableHtml);
            if (stableDelta) turn.onTextDelta(stableDelta);
          }
          if (completionTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            completionActionVisible: snapshot.completionActionVisible,
          })) {
            if (snapshot.visibleText === "api_tool unavailable") {
              throw new Error("ChatGPT selected mode rejected the Codex Native MCP tool (api_tool unavailable)");
            }
            const final = markdownStream.finish(snapshot.fullHtml);
            if (!final.markdown && snapshot.visibleText) {
              throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
            }
            if (final.delta) turn.onTextDelta(final.delta);
            finalText = final.markdown;
            break;
          }
          if (!loggedCompletionWait && Date.now() - sentAt >= 30_000) {
            loggedCompletionWait = true;
            const diagnostic = await this.stalledTurnDiagnostic(page, initialResponseTurnCount).catch(error => JSON.stringify({
              diagnosticError: error instanceof Error ? error.message : String(error),
            }));
            console.warn(
              `[chatgpt-web] waiting for completed-turn evidence (running=${running}, sawRunning=${sawRunning}, textChars=${snapshot.visibleText.length}, completionActionVisible=${snapshot.completionActionVisible}, ui=${diagnostic})`,
            );
          }
        } else {
          const domError = domHealthTracker.update({
            responsePresent: false,
            running,
            currentText: "",
            completionActionVisible: false,
          });
          if (domError) throw new Error(domError);
        }
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
      }

      console.info(`[chatgpt-web] browser turn ${turn.traceId} completed (markdownChars=${finalText.length})`);
      return finalText;
    } finally {
      await pageToClose?.close();
      preparedToRelease?.release();
    }
  }
}
