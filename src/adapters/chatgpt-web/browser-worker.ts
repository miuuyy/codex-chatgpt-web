import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { atomicWriteFile, defaultChromeExecutable, expandUserPath, getConfigDir } from "../../config";
import type { CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";
import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "./markdown";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities, type ChatGptWebModelMode } from "./model";
import { CHATGPT_MAX_INPUT_IMAGES, type CompiledChatGptWebPrompt, type ChatGptWebPromptImage } from "./prompt";
import { estimateCompiledChatGptWebInputTokens } from "./usage";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
  CHATGPT_USER_TURN_SELECTOR,
} from "../../chatgpt-session";
import { loginVerificationMarkerPath } from "../../browser-login";
import { connectLauncherBrowserHost, notifyLauncherTurn } from "../../launcher-browser-host";
import { resolveChatGptWebContextLimits } from "../../chatgpt-web-models";
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import { ChatGptWebAdapterError } from "./adapter-error";

export { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";

const workers = new Map<string, ChatGptBrowserWorker>();

export async function closeChatGptBrowserWorkers(): Promise<void> {
  const active = [...workers.values()];
  workers.clear();
  const results = await Promise.allSettled(active.map(worker => worker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT browser worker(s) failed to close`);
  }
}

export const CHATGPT_RESPONSE_DOM_GRACE_MS = 60_000;
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000;
export const CHATGPT_COMPLETION_ACTION_GRACE_MS = 60_000;
export const CHATGPT_COMPLETION_SETTLE_MS = 2_000;
export const CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS = 60_000;
/**
 * ChatGPT applies composer state asynchronously, and a fast host can reach the next step before the
 * editor has taken the previous one. This is headroom for that, not a readiness check.
 */
export const CHATGPT_UI_SETTLE_MS = 250;

const settleChatGptUi = (): Promise<void> => (
  new Promise(resolveSettle => setTimeout(resolveSettle, CHATGPT_UI_SETTLE_MS))
);

const chatGptRateLimitDialog = (page: Page): Locator => page.locator('[role="dialog"]')
  .filter({ hasText: /Too many requests/i })
  .filter({ hasText: /making requests too quickly/i })
  .last();

export async function throwIfChatGptRateLimitDialog(page: Page): Promise<void> {
  const dialog = chatGptRateLimitDialog(page);
  if (!await dialog.isVisible().catch(() => false)) return;

  const acknowledge = dialog.getByRole("button", { name: "Got it", exact: true }).last();
  if (await acknowledge.isVisible().catch(() => false)) {
    try {
      await acknowledge.press("Enter");
    } catch (error) {
      throw new ChatGptWebAdapterError(
        `ChatGPT rate-limit dialog is open, but its acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`,
        { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
      );
    }
  }
  throw new ChatGptWebAdapterError(
    "ChatGPT rate limit: too many requests are being made too quickly. Wait before retrying.",
    { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: true },
  );
}

type ChatGptTextScope = Pick<Locator, "getByText">;

const chatGptSessionFailureAlert = (page: Page): Locator => page
  .locator('[role="alert"]')
  .filter({ hasText: /Failed to load subscription/i })
  .last();

export async function throwIfChatGptSessionFailureAlert(page: Page): Promise<void> {
  if (!await chatGptSessionFailureAlert(page).isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT could not load the account subscription. Reload ChatGPT inside the launcher and retry; sign out only if the error persists.",
    { status: 503, errorType: "server_error", code: "chatgpt_subscription_unavailable", retryable: true },
  );
}

const chatGptTerminalErrorAlert = (scope: ChatGptTextScope): Locator => scope
  .getByText(/Something went wrong[\s\S]*help\.openai\.com/i)
  .last();

export async function throwIfChatGptTerminalErrorAlert(scope: ChatGptTextScope): Promise<void> {
  if (!await chatGptTerminalErrorAlert(scope).isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.",
    { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
  );
}

export async function resolveChatGptToolConfirmation(
  page: Page,
  appName: string,
  autoApprove: boolean,
  signal?: AbortSignal,
  timeoutMs = CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  onVisible?: () => Promise<void>,
): Promise<boolean> {
  const dialog = page.locator('[role="dialog"]')
    .filter({ hasText: `Allow ChatGPT to use ${appName}?` })
    .last();
  if (!await dialog.isVisible().catch(() => false)) return false;
  await onVisible?.();

  if (autoApprove) {
    const allowOnce = dialog.getByRole("button", { name: "Allow once", exact: true }).last();
    await allowOnce.waitFor({ state: "visible", timeout: 10_000 });
    await allowOnce.press("Enter");
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (!await dialog.isVisible().catch(() => false)) return true;
    await new Promise(resolveSleep => setTimeout(resolveSleep, Math.min(100, Math.max(1, deadline - Date.now()))));
  }

  if (!await dialog.isVisible().catch(() => false)) return true;
  const deny = dialog.getByRole("button", { name: "Deny", exact: true }).last();
  await deny.waitFor({ state: "visible", timeout: 5_000 });
  await deny.press("Enter");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

export function assertChatGptWebInputWithinContextWindow(
  estimatedInputTokens: number,
  effort: ChatGptWebModelMode["effort"],
): void {
  const { contextWindow } = resolveChatGptWebContextLimits(effort);
  if (estimatedInputTokens < contextWindow) return;
  throw new ChatGptWebAdapterError(
    `This task is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds the ${contextWindow.toLocaleString("en-US")}-token context window for this ChatGPT Web model. Switch to a model with a larger context window, run /compact, then retry this Web model.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

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

/**
 * CDP accepts large Input.insertText payloads, but a single oversized edit can outrun ChatGPT's
 * Lexical update path. The composer itself accepts substantially larger messages: a live probe on
 * 2026-08-06 preserved 819,343 characters and kept Send enabled when the same text arrived in
 * bounded edits. Chunk only the browser input event; the resulting user message remains one exact
 * prompt and is verified byte-for-byte after insertion.
 */
export const CHATGPT_PROMPT_INSERT_CHUNK_CHARS = 200_000;

export interface BrowserTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  capabilities: ChatGptWebCapabilities;
  prepare: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  /** Visible ChatGPT reasoning-summary step titles only; never hidden chain-of-thought. */
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  /** Stable visible ChatGPT prose between status/tool rows. */
  onCommentary?: (text: string, continuation?: boolean) => void;
  /** Append-only, structurally stable Markdown chunks. */
  onTextDelta: (delta: string) => void;
}

export interface ResolvedBrowserConfig {
  appName: string;
  browserHost: "managed-chrome" | "launcher";
  browserHostDescriptorPath?: string;
  storageStatePath: string;
  chromeExecutablePath: string;
  turnTimeoutMs?: number;
  headed: boolean;
  autoApproveToolCalls: boolean;
}

export function chatGptTurnIsComplete(state: {
  responsePresent: boolean;
  running: boolean;
  currentText: string;
  currentHtml?: string;
  completionActionVisible: boolean;
}): boolean {
  return state.responsePresent
    && !state.running
    && state.currentText.length > 0
    && state.completionActionVisible;
}

export type ChatGptSubmissionEvidence = "user_turn" | "assistant_turn" | "generation_running";

export function chatGptSubmissionEvidence(state: {
  initialUserTurnCount: number;
  userTurnCount: number;
  initialAssistantTurnCount: number;
  assistantTurnCount: number;
  generationRunning: boolean;
}): ChatGptSubmissionEvidence | undefined {
  if (state.userTurnCount > state.initialUserTurnCount) return "user_turn";
  if (state.assistantTurnCount > state.initialAssistantTurnCount) return "assistant_turn";
  if (state.generationRunning) return "generation_running";
  return undefined;
}

export class ChatGptCompletionTracker {
  private candidate?: { signature: string; since: number };

  constructor(private readonly stableMs = CHATGPT_COMPLETION_SETTLE_MS) {}

  update(state: Parameters<typeof chatGptTurnIsComplete>[0], now = Date.now()): boolean {
    if (!chatGptTurnIsComplete(state)) {
      this.candidate = undefined;
      return false;
    }
    const signature = `${state.currentText}\0${state.currentHtml ?? state.currentText}`;
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
  private missingCompletionAction?: { text: string; since: number };

  constructor(
    private readonly missingResponseMs = CHATGPT_RESPONSE_DOM_GRACE_MS,
    private readonly emptyCompletionMs = CHATGPT_EMPTY_RESPONSE_GRACE_MS,
    private readonly missingCompletionActionMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
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

    const missingCompletionAction = state.responsePresent
      && !state.running
      && state.currentText.length > 0
      && !state.completionActionVisible;
    if (!missingCompletionAction) {
      this.missingCompletionAction = undefined;
    } else if (this.missingCompletionAction?.text !== state.currentText) {
      this.missingCompletionAction = { text: state.currentText, since: now };
    } else if (now - this.missingCompletionAction.since >= this.missingCompletionActionMs) {
      return "ChatGPT stopped generating but did not expose its completed-turn action; the ChatGPT DOM may have changed";
    }
    return undefined;
  }
}

export interface ChatGptVisibleTraceBlock {
  kind: "answer" | "commentary" | "status";
  text: string;
  key?: string;
  complete?: boolean;
  uiControl?: boolean;
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
  markdownSegments: ChatGptMarkdownSegment[];
  completionActionVisible: boolean;
  traceBlocks: ChatGptVisibleTraceBlock[];
}

const absentResponseDomSnapshot = (): ChatGptResponseDomSnapshot => ({
  responsePresent: false,
  visibleText: "",
  fullHtml: "",
  markdownSegments: [],
  completionActionVisible: false,
  traceBlocks: [],
});

/** Convert the public ChatGPT turn DOM into append-only Codex reasoning summaries. */
export class ChatGptVisibleTraceTracker {
  private readonly emittedTrace = new Map<string, string>();
  private readonly traceCandidates = new Map<string, { text: string; changedAt: number }>();

  constructor(private readonly traceStabilityMs = 250) {}

  observe(blocks: ChatGptVisibleTraceBlock[], completionActionVisible: boolean, now = Date.now()): ChatGptVisibleTraceEvent[] {
    const output: ChatGptVisibleTraceEvent[] = [];
    let statusSlot = 0;
    let commentarySlot = 0;
    for (const block of blocks) {
      // Final-answer roots are carried by ChatGptMarkdownBuffer. Only Markdown roots inside
      // ChatGPT's streaming-status container are explicit intermediate commentary.
      if (block.kind === "answer") continue;
      const index = block.kind === "status" ? statusSlot++ : commentarySlot++;
      const slot = block.key ? `${block.kind}:${block.key}` : `${block.kind}:${index}`;
      const stripped = block.text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.replace(/[\t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const text = block.kind === "status" ? stripped.replace(/\s+/g, " ") : stripped;
      if (!text) continue;
      let candidate = this.traceCandidates.get(slot);
      if (!candidate || candidate.text !== text) {
        candidate = { text, changedAt: now };
        this.traceCandidates.set(slot, candidate);
        if (!completionActionVisible && this.traceStabilityMs > 0) continue;
      }
      // A commentary Markdown root remains mutable until ChatGPT appends the next reasoning item.
      // Emitting it earlier lets a tool-status boundary split one semantic paragraph into multiple
      // Codex messages. The next anchored item (or final completion evidence) is the stable boundary.
      if (block.kind === "commentary" && block.complete === false && !completionActionVisible) continue;
      if (!completionActionVisible && now - candidate.changedAt < this.traceStabilityMs) continue;

      const previous = this.emittedTrace.get(slot);
      if (previous === text) continue;
      this.emittedTrace.set(slot, text);
      const kind = block.kind === "commentary" ? "commentary" : "reasoning";

      if (previous && text.startsWith(previous)) {
        output.push({ kind, text: text.slice(previous.length), continuation: true });
      } else {
        output.push({ kind, text });
      }
    }
    return output;
  }
}

export function isChatGptTraceControl(block: ChatGptVisibleTraceBlock): boolean {
  if (block.kind !== "status") return false;
  const text = block.text.replace(/\s+/g, " ").trim();
  return block.uiControl === true || text === "Answer now" || text === "Thinking";
}

export function redactChatGptUiDiagnostic(value: string): string {
  return value
    .replace(/<codex_context_json>[\s\S]*?<\/codex_context_json>/gi, "<codex_context_json>[redacted]</codex_context_json>")
    .replace(/\b(turn|binding|call)_[A-Za-z0-9_-]{12,}\b/g, "$1_[redacted]");
}

const CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT = 10;

export function browserDiagnosticCheckpoint(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return safe || "checkpoint";
}

export function browserDiagnosticIncludesScreenshot(
  checkpoint: string,
  captureAll = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS === "1",
): boolean {
  return captureAll || checkpoint === "response-stalled-30s" || checkpoint === "turn-failed";
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
}

function pruneBrowserDiagnostics(root: string): void {
  const traces = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]{6,128}$/.test(entry.name))
    .map(entry => {
      const path = join(root, entry.name);
      return { path, modifiedAt: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const trace of traces.slice(CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT)) {
    rmSync(trace.path, { recursive: true, force: true });
  }
}

class ChatGptBrowserDiagnostics {
  private readonly root = join(getConfigDir(), "diagnostics", "browser-turns");
  private readonly directory: string;
  private sequence = 0;
  private initialized = false;

  constructor(private readonly traceId: string) {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
      throw new Error("ChatGPT browser diagnostic trace id is invalid");
    }
    this.directory = join(this.root, `${traceId}-${randomUUID().slice(0, 8)}`);
  }

  async capture(page: Page, checkpoint: string, error?: unknown): Promise<void> {
    try {
      if (!this.initialized) {
        privateDirectory(this.root);
        privateDirectory(this.directory);
        pruneBrowserDiagnostics(this.root);
        this.initialized = true;
      }
      const sequence = String(++this.sequence).padStart(2, "0");
      const stem = `${sequence}-${browserDiagnosticCheckpoint(checkpoint)}`;
      const includeScreenshot = browserDiagnosticIncludesScreenshot(checkpoint);
      const [screenshot, state] = await Promise.all([
        includeScreenshot
          ? page.screenshot({ animations: "disabled", caret: "hide", timeout: 5_000, type: "png" })
          : Promise.resolve(undefined),
        page.evaluate(({ composerSelector, effortControlSelector, effortItemSelector, assistantTurnSelector }) => {
          const visible = (element: Element): boolean => {
            const candidate = element as HTMLElement;
            const style = getComputedStyle(candidate);
            const rect = candidate.getBoundingClientRect();
            return style.display !== "none"
              && style.visibility !== "hidden"
              && style.opacity !== "0"
              && rect.width > 0
              && rect.height > 0;
          };

          const boundedText = (element: Element): string => (
            ((element as HTMLElement).innerText || element.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 1_000)
          );
          const rows = (selector: string, limit = 40) => [...document.querySelectorAll(selector)]
            .filter(visible)
            .slice(-limit)
            .map(element => ({
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              testId: element.getAttribute("data-testid"),
              ariaExpanded: element.getAttribute("aria-expanded"),
              ariaChecked: element.getAttribute("aria-checked"),
              dataState: element.getAttribute("data-state"),
              text: boundedText(element),
            }));
          const composers = [...document.querySelectorAll(composerSelector)].filter(visible);
          const assistantTurns = [...document.querySelectorAll(assistantTurnSelector)].filter(visible);
          return {
            url: location.href,
            title: document.title,
            surfaceId: (globalThis as typeof globalThis & { __CODEX_WEB_GPT_SURFACE_ID__?: unknown })
              .__CODEX_WEB_GPT_SURFACE_ID__ ?? null,
            bodyTextChars: document.body?.innerText.length ?? 0,
            composer: {
              visibleCount: composers.length,
              textChars: composers.map(element => (element.textContent ?? "").length),
              selectedConnectors: rows('[data-id^="plugin:"][data-keyword]', 20),
            },
            effortControls: rows(effortControlSelector, 10),
            effortItems: rows(effortItemSelector, 20),
            menus: rows('[role="menu"], [role="listbox"], [data-testid="composer-intelligence-picker-content"]', 20),
            connectorRows: rows('.__menu-item[tabindex="0"]', 40),
            overlays: rows('[role="dialog"], [role="alert"], [role="status"]', 30),
            turns: {
              user: document.querySelectorAll('[data-testid^="conversation-turn-"][data-message-author-role="user"]').length,
              assistant: assistantTurns.map(element => ({
                textChars: (element.textContent ?? "").length,
                htmlChars: (element as HTMLElement).innerHTML.length,
              })),
            },
          };
        }, {
          composerSelector: CHATGPT_COMPOSER_SELECTOR,
          effortControlSelector: CHATGPT_EFFORT_CONTROL_SELECTOR,
          effortItemSelector: CHATGPT_EFFORT_ITEM_SELECTOR,
          assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
        }),
      ]);
      const capturedAt = new Date().toISOString();
      if (screenshot) atomicWriteFile(join(this.directory, `${stem}.png`), screenshot);
      atomicWriteFile(join(this.directory, `${stem}.json`), `${JSON.stringify({
        version: 1,
        capturedAt,
        traceId: this.traceId,
        checkpoint,
        ...(error !== undefined ? {
          error: redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error)),
        } : {}),
        state,
      }, null, 2)}\n`);
      console.info(`[chatgpt-web] browser diagnostic trace=${this.traceId} checkpoint=${stem} path=${this.directory}`);
    } catch (captureError) {
      console.warn(
        `[chatgpt-web] browser diagnostic capture failed trace=${this.traceId}`
        + ` checkpoint=${browserDiagnosticCheckpoint(checkpoint)}:`
        + ` ${captureError instanceof Error ? captureError.message : String(captureError)}`,
      );
    }
  }
}

export function resolveBrowserConfig(provider: CodexProviderConfig): ResolvedBrowserConfig {
  const configured = provider.chatgptWeb ?? {};
  const browserHost = configured.browserHost ?? "managed-chrome";
  const browserHostDescriptorPath = configured.browserHostDescriptorPath?.trim();
  const turnTimeoutMs = configured.turnTimeoutMs;
  if (browserHost === "launcher" && !browserHostDescriptorPath) {
    throw new Error("Launcher browser host requires chatgptWeb.browserHostDescriptorPath");
  }
  if (turnTimeoutMs !== undefined
    && (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0)) {
    throw new Error("ChatGPT Web turnTimeoutMs must be a positive finite number");
  }
  return {
    appName: configured.appName?.trim() || "Codex Native",
    browserHost,
    ...(browserHostDescriptorPath ? { browserHostDescriptorPath: resolve(expandUserPath(browserHostDescriptorPath)) } : {}),
    storageStatePath: resolve(expandUserPath(configured.storageStatePath?.trim() || join(getConfigDir(), "browser", "storage-state.json"))),
    chromeExecutablePath: resolve(expandUserPath(configured.chromeExecutablePath?.trim() || defaultChromeExecutable())),
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
    headed: configured.headed !== false,
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
  if (images.length > CHATGPT_MAX_INPUT_IMAGES) {
    throw new Error(`ChatGPT web accepts at most ${CHATGPT_MAX_INPUT_IMAGES} input images per Codex turn`);
  }
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

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private managedBrowserReady?: Promise<{ browser: Browser; context: BrowserContext }>;
  private launcherHelper?: LauncherBrowserHelperClient;
  private verificationTail: Promise<void> = Promise.resolve();
  private readonly activeRuns = new Map<string, Promise<string>>();

  private constructor(private readonly config: ResolvedBrowserConfig) {}

  run(turn: BrowserTurn): Promise<string> {
    if (this.activeRuns.has(turn.traceId)) {
      return Promise.reject(new Error(`Duplicate ChatGPT web browser turn: ${turn.traceId}`));
    }
    if (this.activeRuns.size >= MAX_CHATGPT_BROWSER_TABS) {
      return Promise.reject(new Error(
        `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; close or finish a browser tab before starting another`,
      ));
    }
    const useHelper = this.config.browserHost === "launcher" && process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS !== "1";
    if (useHelper) {
      this.launcherHelper ??= new LauncherBrowserHelperClient(this.config);
    }
    const run = Promise.resolve().then(() => useHelper ? this.launcherHelper!.run(turn) : this.runExclusive(turn));
    this.activeRuns.set(turn.traceId, run);
    void run.finally(() => {
      if (this.activeRuns.get(turn.traceId) === run) this.activeRuns.delete(turn.traceId);
    }).catch(() => {});
    return run;
  }

  verifyConnector(): Promise<string> {
    const verification = this.verificationTail.then(() => {
      if (this.activeRuns.size > 0) {
        throw new Error("ChatGPT connector verification requires all browser turns to finish");
      }
      return this.verifyConnectorExclusive();
    });
    this.verificationTail = verification.then(() => undefined, () => undefined);
    return verification;
  }

  async close(): Promise<void> {
    if (this.launcherHelper) {
      const helper = this.launcherHelper;
      this.launcherHelper = undefined;
      await helper.close();
    }
    await Promise.allSettled([...this.activeRuns.values()]);
    await this.verificationTail;
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.managedBrowserReady = undefined;
    // For connectOverCDP, Playwright implements Browser.close as a transport disconnect; it does
    // not close the launcher-owned Electron process. Always release that connection and its
    // artifact directory instead of leaking one per timeout/helper lifecycle.
    if (browser) await browser.close();
  }

  private async runStage<T>(
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: (abortSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(() => {
          rejectTimeout(new Error(`ChatGPT browser stage timed out: ${stage}`));
          controller.abort();
        }, timeoutMs);
      });
      const value = await Promise.race([action(controller.signal), timeout]);
      console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} completed durationMs=${Math.round(performance.now() - startedAt)}`);
      return value;
    } catch (error) {
      console.error(`[chatgpt-web] browser turn ${traceId} stage=${stage} failed durationMs=${Math.round(performance.now() - startedAt)}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.config.browserHost === "launcher") {
      const connection = await connectLauncherBrowserHost(this.config.browserHostDescriptorPath!);
      this.browser = connection.browser;
      this.context = connection.context;
      this.page = connection.page;
      return this.page;
    }
    if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
      throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
    }
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
    }
    this.browser = await chromium.launch({
      executablePath: this.config.chromeExecutablePath,
      headless: !this.config.headed,
    });
    this.context = await this.browser.newContext({ storageState: this.config.storageStatePath });
    this.page = await this.context.newPage();
    return this.page;
  }

  private async ensureManagedBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.managedBrowserReady) return this.managedBrowserReady;
    const opening = (async () => {
      if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
        throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
      }
      if (!existsSync(this.config.chromeExecutablePath)) {
        throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
      }
      const browser = await chromium.launch({
        executablePath: this.config.chromeExecutablePath,
        headless: !this.config.headed,
      });
      const context = await browser.newContext({ storageState: this.config.storageStatePath });
      this.browser = browser;
      this.context = context;
      return { browser, context };
    })();
    this.managedBrowserReady = opening;
    try {
      return await opening;
    } catch (error) {
      if (this.managedBrowserReady === opening) this.managedBrowserReady = undefined;
      throw error;
    }
  }

  /**
   * A Codex turn owns one isolated Temporary Chat document. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  private async pageForNewTurn(): Promise<Page> {
    if (this.config.browserHost === "launcher") {
      throw new Error("Launcher turns require an explicitly leased browser surface");
    }
    const { context } = await this.ensureManagedBrowser();
    return await context.newPage();
  }

  private async selectModelAndEffort(
    page: Page,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
  ): Promise<ChatGptWebModelMode> {
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const currentEffort = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).last();
    try {
      await currentEffort.waitFor({ state: "visible", timeout: 70_000 });
    } catch {
      throw new Error("ChatGPT rendered the composer but its model/effort control did not become ready");
    }
    await settleChatGptUi();
    await throwIfChatGptRateLimitDialog(page);
    await captureDiagnostic?.("effort-control-ready");
    const effortMenu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
    const menuVisible = await effortMenu.isVisible().catch(() => false);
    const menuExpanded = await currentEffort.getAttribute("aria-expanded").catch(() => null);
    if (!menuVisible && menuExpanded !== "true") {
      await throwIfChatGptRateLimitDialog(page);
      await currentEffort.click();
    }
    await captureDiagnostic?.("effort-menu-open-requested");
    const effortChoices = effortMenu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
    const effortChoice = effortChoices.nth(mode.uiEffortIndex);
    const waitAbort = new AbortController();
    try {
      const ready = await Promise.race([
        effortChoice.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "effort" as const),
        chatGptRateLimitDialog(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "rate-limit" as const),
      ]);
      if (ready === "rate-limit") await throwIfChatGptRateLimitDialog(page);
      await captureDiagnostic?.("effort-choice-visible");
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      throw new ChatGptWebAdapterError(
        `ChatGPT effort menu did not expose item index ${mode.uiEffortIndex}`
        + `; item count: ${await effortChoices.count().catch(() => 0)}`,
        { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false },
      );
    } finally {
      waitAbort.abort();
    }
    const selected = await effortChoice.getAttribute("aria-checked");
    if (selected !== "true" && selected !== "false") {
      throw new Error(`ChatGPT effort item index ${mode.uiEffortIndex} has no semantic checked state`);
    }
    if (selected === "true") {
      await captureDiagnostic?.("effort-selected");
      await page.keyboard.press("Escape");
      return mode;
    }
    await throwIfChatGptRateLimitDialog(page);
    await effortChoice.click();
    await captureDiagnostic?.("effort-choice-clicked");

    const deadline = Date.now() + 40_000;
    let confirmed: string | null = null;
    while (Date.now() < deadline) {
      if (!await effortMenu.isVisible().catch(() => false)) {
        const expanded = await currentEffort.getAttribute("aria-expanded").catch(() => null);
        if (expanded !== "true") {
          await throwIfChatGptRateLimitDialog(page);
          await currentEffort.click();
        }
        await effortChoice.waitFor({
          state: "visible",
          timeout: Math.max(1, Math.min(5_000, deadline - Date.now())),
        });
      }
      confirmed = await effortChoice.getAttribute("aria-checked");
      if (confirmed === "true") {
        await captureDiagnostic?.("effort-selected");
        await page.keyboard.press("Escape");
        return mode;
      }
      if (confirmed !== "false") {
        throw new Error(`ChatGPT effort item index ${mode.uiEffortIndex} lost its semantic checked state`);
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error(
      `ChatGPT did not confirm effort item index ${mode.uiEffortIndex}`
      + ` (aria-checked=${JSON.stringify(confirmed)})`,
    );
  }

  private async activeComposer(page: Page, timeoutMs = 30_000): Promise<Locator> {
    const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    while (Date.now() < deadline) {
      count = await composers.count();
      if (count === 1) return composers.first();
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
    throw new Error(`ChatGPT did not expose exactly one visible composer (visibleComposers=${count})`);
  }

  private async waitForSubmissionAccepted(
    page: Page,
    userTurns: Locator,
    responseTurns: Locator,
    responseTurn: Locator,
    initialUserTurnCount: number,
    initialResponseTurnCount: number,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence> {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    const visibleStopButtons = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true });
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptTerminalErrorAlert(responseTurn);
      const [userTurnCount, assistantTurnCount, visibleStopButtonCount] = await Promise.all([
        userTurns.count(),
        responseTurns.count(),
        visibleStopButtons.count(),
      ]);
      const evidence = chatGptSubmissionEvidence({
        initialUserTurnCount,
        userTurnCount,
        initialAssistantTurnCount: initialResponseTurnCount,
        assistantTurnCount,
        generationRunning: visibleStopButtonCount > 0,
      });
      if (evidence) return evidence;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
  }

  private async attachedPromptText(page: Page): Promise<string> {
    const composer = await this.activeComposer(page);
    return composer.evaluate(element => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(
        '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]',
      )
        .forEach(part => part.remove());
      return [...clone.childNodes]
        .map(child => child.textContent ?? "")
        .join("\n")
        .trimStart();
    }, undefined, { timeout: 20_000 });
  }

  private async assertPromptAttached(page: Page, prompt: string): Promise<void> {
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

  private selectedConnectorControl(composer: Locator): Locator {
    return composer
      .locator('[data-id^="plugin:"][data-keyword]')
      .filter({ hasText: this.config.appName, visible: true });
  }

  private async connectorIsSelected(composer: Locator): Promise<boolean> {
    const selected = this.selectedConnectorControl(composer);
    const keywords = await selected.evaluateAll(elements => (
      elements.map(element => element.getAttribute("data-keyword"))
    ));
    const exactMatches = keywords.filter(keyword => keyword === this.config.appName).length;
    if (exactMatches > 1) {
      throw new Error(`ChatGPT composer exposed duplicate ${JSON.stringify(this.config.appName)} connector selections`);
    }
    return exactMatches === 1;
  }

  private async connectorMentionRowTitles(menuRows: Locator): Promise<string[]> {
    const texts = await menuRows.filter({ visible: true }).allInnerTexts().catch(() => [] as string[]);
    return texts
      .map(text => (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim())
      .filter(title => title.length > 0);
  }

  private async connectorMentionFailure(menuRows: Locator, triggerAttempts: number): Promise<string> {
    const titles = await this.connectorMentionRowTitles(menuRows);
    if (titles.length === 0) {
      return `ChatGPT connector menu did not open after ${triggerAttempts} complete mention trigger attempt(s)`;
    }
    return `ChatGPT connector menu opened but exposed no row named ${JSON.stringify(this.config.appName)}`
      + ` after ${triggerAttempts} complete mention trigger attempt(s)`
      + `; visible rows: ${titles.map(title => JSON.stringify(title)).join(", ")}`;
  }

  private async selectConnector(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
  ): Promise<Locator> {
    let composer = await this.activeComposer(page);
    await composer.fill("");
    if (await this.connectorIsSelected(composer)) {
      await captureDiagnostic?.("connector-already-selected");
      return composer;
    }

    const menuRows = page.locator('.__menu-item[tabindex="0"]');
    const appResult = menuRows.filter({
      has: page.getByText(this.config.appName, { exact: true }),
    });
    const menuDeadline = Date.now() + 20_000;
    let triggerAttempts = 0;
    let firstMenuCaptured = false;
    for (;;) {
      triggerAttempts += 1;
      composer = await this.activeComposer(page);
      await composer.fill("");
      await composer.focus();
      await settleChatGptUi();
      await composer.pressSequentially("@c", { delay: 25 });
      if (!firstMenuCaptured) {
        firstMenuCaptured = true;
        await captureDiagnostic?.("connector-mention-triggered");
      }
      try {
        await appResult.waitFor({
          state: "visible",
          timeout: Math.min(2_500, Math.max(1, menuDeadline - Date.now())),
        });
        await captureDiagnostic?.("connector-menu-visible");
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
        if (Date.now() >= menuDeadline) {
          await captureDiagnostic?.("connector-menu-missing");
          throw new Error(await this.connectorMentionFailure(menuRows, triggerAttempts));
        }
      }
    }
    if (await appResult.count() !== 1) {
      throw new Error(
        `ChatGPT connector menu did not expose one exact ${JSON.stringify(this.config.appName)} row`
        + `; visible rows: ${(await this.connectorMentionRowTitles(menuRows)).map(title => JSON.stringify(title)).join(", ")}`,
      );
    }
    // The composer keeps its own keyboard highlight, which is not guaranteed to follow the
    // exact connector row resolved above. Pressing Enter on the composer can therefore activate
    // "Add photos & files" and open the operating-system file picker. Dispatch the activation to
    // the resolved row itself; this also avoids viewport-coordinate differences in embedded
    // Chromium across macOS, Windows, and Linux.
    await appResult.dispatchEvent("click");
    // Selecting a connector replaces the Lexical composer subtree. Resolve the active composer
    // again instead of returning the pre-selection locator, otherwise the real turn can focus a
    // detached/hidden editor even though verification just succeeded.
    const selectedComposer = await this.activeComposer(page);
    const selectedConnector = this.selectedConnectorControl(selectedComposer);
    await selectedConnector.waitFor({ state: "visible", timeout: 10_000 });
    if (!await this.connectorIsSelected(selectedComposer)) {
      throw new Error(`ChatGPT composer did not select ${JSON.stringify(this.config.appName)} connector`);
    }
    await captureDiagnostic?.("connector-selected");
    return selectedComposer;
  }

  private async attachPrompt(
    page: Page,
    prompt: string,
    localTools: boolean,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
  ): Promise<void> {
    if (!localTools) {
      const composer = await this.activeComposer(page);
      // Playwright's multiline fill maps through an input action that ChatGPT's Lexical editor can
      // collapse to the first paragraph on the launcher-owned Electron surface. Clear separately,
      // then transport the complete text in one CDP Input.insertText command.
      await composer.fill("");
      await composer.focus();
      await this.insertPromptText(page, prompt);
      await this.assertPromptAttached(page, prompt);
      return;
    }
    const selectedComposer = await this.selectConnector(page, captureDiagnostic);
    await selectedComposer.focus();
    await page.keyboard.press("End");
    await this.insertPromptText(page, ` ${prompt}`);
    await this.assertPromptAttached(page, prompt);
  }

  private async insertPromptText(page: Page, text: string): Promise<void> {
    for (let offset = 0; offset < text.length; offset += CHATGPT_PROMPT_INSERT_CHUNK_CHARS) {
      await page.keyboard.insertText(text.slice(offset, offset + CHATGPT_PROMPT_INSERT_CHUNK_CHARS));
    }
  }

  private async verifyConnectorExclusive(): Promise<string> {
    const page = await this.ensurePage();
    if (page.url() !== CHATGPT_TEMPORARY_CHAT_URL) {
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    try {
      await this.activeComposer(page);
    } catch {
      throw new Error("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
    }
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    await this.selectConnector(page);
    return this.config.appName;
  }

  private async attachFiles(page: Page, prompt: CompiledChatGptWebPrompt): Promise<void> {
    const files = chatGptPromptFilePayloads(prompt);
    if (files.length === 0) return;
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const input = page.locator('input[data-testid="upload-photos-input"]');
    await input.waitFor({ state: "attached", timeout: 20_000 });
    await input.setInputFiles(files);
    try {
      await Promise.all(files.map(file => (
        composerForm.getByRole("group", { name: file.name, exact: true })
          .waitFor({ state: "visible", timeout: 60_000 })
      )));
    } catch {
      const alerts = (await page.locator('[role="alert"]').allInnerTexts().catch(() => []))
        .map(text => text.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      throw new Error(
        `ChatGPT did not accept all prompt attachments`
        + (alerts.length > 0 ? `: ${alerts.join(" | ")}` : ""),
      );
    }
    const send = composerForm.getByTestId("send-button");
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await send.isEnabled().catch(() => false)) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error("ChatGPT accepted the prompt attachments but did not make the message ready to send");
  }

  private async responseDomSnapshot(responseTurn: Locator): Promise<ChatGptResponseDomSnapshot> {
    const snapshot = await responseTurn.evaluate((element, completionActionSelector) => {
      const root = element as HTMLElement;
      const visible = (candidate: HTMLElement): boolean => {
        const style = getComputedStyle(candidate);
        const rect = candidate.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && rect.width > 0
          && rect.height > 0;
      };

      // ChatGPT uses the same Markdown renderer for intermediate commentary and for the final
      // answer. The stable semantic boundary is the public streaming-status container: Markdown
      // inside it is commentary; top-level Markdown outside it is the final answer stream.
      const allMarkdownRoots = [...root.querySelectorAll<HTMLElement>(".markdown")]
        .filter(candidate => !candidate.parentElement?.closest(".markdown"))
        .filter(visible);
      const commentaryRoots = allMarkdownRoots.filter(candidate => (
        candidate.closest("[data-streaming-response-status]") !== null
      ));
      const renderedRoots = allMarkdownRoots.filter(candidate => (
        candidate.closest("[data-streaming-response-status]") === null
      ));
      const markdownSegments = renderedRoots.flatMap((markdownRoot, rootIndex) => {
        const rootIsComplete = rootIndex < renderedRoots.length - 1;
        const hasDirectText = [...markdownRoot.childNodes].some(node => (
          node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
        ));
        const children = [...markdownRoot.children] as HTMLElement[];
        if (hasDirectText || children.length === 0) {
          return markdownRoot.innerHTML.trim() ? [{
            key: `${rootIndex}:root`,
            html: markdownRoot.innerHTML,
            text: markdownRoot.innerText.trim(),
            streamable: rootIsComplete,
          }] : [];
        }

        return children.flatMap((child, childIndex) => {
          const tag = child.tagName.toLowerCase();
          const childIsComplete = rootIsComplete || childIndex < children.length - 1;
          const listItems = tag === "ol" || tag === "ul"
            ? [...child.children].filter(candidate => candidate.tagName === "LI") as HTMLElement[]
            : [];
          if (listItems.length === 0) {
            return [{
              key: `${rootIndex}:${childIndex}:${tag}`,
              html: child.outerHTML,
              text: child.innerText.trim(),
              streamable: childIsComplete,
            }];
          }

          const group = `${rootIndex}:${childIndex}:${tag}`;
          const orderedStart = tag === "ol" ? Number(child.getAttribute("start") ?? "1") : undefined;
          return listItems.map((item, itemIndex) => {
            const shell = child.cloneNode(false) as HTMLElement;
            shell.removeAttribute("data-is-last-node");
            if (orderedStart !== undefined && Number.isFinite(orderedStart)) {
              shell.setAttribute("start", String(orderedStart + itemIndex));
            }
            shell.append(item.cloneNode(true));
            return {
              key: `${rootIndex}:${childIndex}:${tag}:${itemIndex}`,
              html: shell.outerHTML,
              text: item.innerText.trim(),
              group,
              streamable: childIsComplete || itemIndex < listItems.length - 1,
            };
          });
        });
      });
      const rendered = renderedRoots.at(-1);
      const completionAction = rendered
        ? [...root.querySelectorAll<HTMLElement>(completionActionSelector)]
          .filter(visible)
          .find(candidate => !rendered.contains(candidate)
            && Boolean(rendered.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
        : undefined;
      const completionActionSet = new Set(completionAction ? [completionAction] : []);
      const candidates = new Map<HTMLElement, ChatGptVisibleTraceBlock["kind"]>();
      renderedRoots.forEach(candidate => candidates.set(candidate, "answer"));
      commentaryRoots.forEach(candidate => candidates.set(candidate, "commentary"));
      const overlapsRenderedAnswer = (candidate: HTMLElement): boolean => renderedRoots.some(rendered => (
        candidate.contains(rendered) || rendered.contains(candidate)
      ));
      const overlapsCommentary = (candidate: HTMLElement): boolean => commentaryRoots.some(commentary => (
        candidate.contains(commentary) || commentary.contains(candidate)
      ));
      const statusSemantic = (candidate: HTMLElement): HTMLElement => {
        return candidate.closest<HTMLElement>("button") ?? candidate;
      };
      const traceText = (candidate: HTMLElement): string => {
        const ariaLabel = candidate.getAttribute("aria-label")?.trim();
        if (ariaLabel) return ariaLabel;
        // Animated ChatGPT action counters visually split a phrase around the changing number, so
        // `innerText` can become `Searching websites\n3`. The button's screen-reader label already
        // carries the stable semantic phrase (`Searching 3 websites`) without enclosing unrelated
        // commentary from the surrounding streaming-status container.
        const screenReaderText = [...candidate.querySelectorAll<HTMLElement>(".sr-only")]
          .map(element => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
          .find(Boolean);
        return screenReaderText || candidate.innerText.trim();
      };
      const traceKey = (candidate: HTMLElement, kind: ChatGptVisibleTraceBlock["kind"]): string | undefined => {
        const statusContainer = candidate.closest<HTMLElement>("[data-streaming-response-status]");
        const itemAnchor = candidate.closest<HTMLElement>("[data-item-anchor]");
        if (!statusContainer || !itemAnchor) return undefined;
        const anchorIndex = [...statusContainer.querySelectorAll<HTMLElement>("[data-item-anchor]")]
          .indexOf(itemAnchor);
        return anchorIndex >= 0 ? `${kind}:anchor:${anchorIndex}` : undefined;
      };
      root.querySelectorAll<HTMLElement>(
        'button, [role="status"], [aria-busy="true"], [data-testid*="cot"], [data-testid*="reason"], [data-testid*="thought"]',
      ).forEach(candidate => {
        if (completionActionSet.has(candidate)) return;
        if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)) return;
        const semantic = statusSemantic(candidate);
        // A renderer may wrap the final Markdown in a reason/status container. That wrapper and
        // its descendants still belong exclusively to the final-answer stream; assigning either
        // side to the trace stream duplicates or truncates the answer under Codex's `Working` UI.
        if (!overlapsRenderedAnswer(semantic)
          && !overlapsCommentary(semantic)
          && !candidates.has(semantic)) {
          candidates.set(semantic, "status");
        }
      });
      root.querySelectorAll<HTMLElement>("[data-streaming-response-status]").forEach(container => {
        if (!overlapsRenderedAnswer(container)
          && !overlapsCommentary(container)
          && ![...candidates.keys()].some(candidate => container.contains(candidate))) {
          candidates.set(container, "status");
        }
      });
      const traceByKey = new Map<string, ChatGptVisibleTraceBlock>();
      [...candidates]
        .filter(([candidate]) => visible(candidate))
        .sort(([left], [right]) => left === right
          ? 0
          : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        .map(([candidate, kind]) => ({
          kind,
          text: traceText(candidate),
          key: traceKey(candidate, kind),
          // Footer controls such as the model picker and overflow menu are siblings of the final
          // Markdown inside the assistant turn. They are UI, not model trace. Real action buttons
          // are scoped by ChatGPT's streaming-status container.
          uiControl: candidate.matches("button")
            && candidate.closest("[data-streaming-response-status]") === null,
        }))
        .filter(block => block.text.length > 0)
        .forEach((block, index) => {
          const key = block.key ?? `${block.kind}:fallback:${index}`;
          const previous = traceByKey.get(key);
          if (!previous || block.text.length > previous.text.length) traceByKey.set(key, block);
        });
      const traceBlocks = [...traceByKey.values()].map((block, index, blocks) => ({
        ...block,
        ...(block.kind === "commentary" ? { complete: index < blocks.length - 1 } : {}),
      }));
      return {
        responsePresent: true,
        visibleText: renderedRoots.map(candidate => candidate.innerText.trim()).filter(Boolean).join("\n\n"),
        fullHtml: renderedRoots.map(candidate => candidate.innerHTML).join(""),
        markdownSegments,
        completionActionVisible: completionAction !== undefined,
        traceBlocks,
      };
    }, CHATGPT_COMPLETION_ACTION_SELECTOR, { timeout: 2_000 }).catch(() => {
      if (responseTurn.page().isClosed()) {
        throw new Error("ChatGPT browser tab was closed; the Codex turn was terminated");
      }
      return absentResponseDomSnapshot();
    });
    snapshot.traceBlocks = snapshot.traceBlocks.filter(block => !isChatGptTraceControl(block));
    return snapshot;
  }

  private async stalledTurnDiagnostic(page: Page, responseTurn: Locator): Promise<string> {
    const responseState = await responseTurn.count()
      ? await responseTurn.evaluate(element => {
        const root = element as HTMLElement;
        const descriptors = [...root.querySelectorAll<HTMLElement>("[role], [data-testid], button, [aria-label]")]
          .filter(candidate => {
            const style = getComputedStyle(candidate);
            return style.visibility !== "hidden" && style.display !== "none";
          })
          .slice(-80)
          .map(candidate => ({
            tag: candidate.tagName.toLowerCase(),
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            titleChars: candidate.getAttribute("title")?.length ?? 0,
            textChars: candidate.innerText.trim().length,
          }));
        return {
          textChars: root.innerText.trim().length,
          htmlChars: root.innerHTML.length,
          descriptors,
        };
      })
      : { text: "", descriptors: [] };
    const overlays = await page.locator('[role="dialog"], [role="alert"], [role="status"]').evaluateAll(elements => (
      elements
        .filter(element => {
          const candidate = element as HTMLElement;
          const style = getComputedStyle(candidate);
          return style.visibility !== "hidden" && style.display !== "none";
        })
        .slice(-30)
        .map(element => {
          const candidate = element as HTMLElement;
          return {
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            textChars: candidate.innerText.trim().length,
          };
        })
    )).catch(() => [] as Array<Record<string, string | null>>);
    return redactChatGptUiDiagnostic(JSON.stringify({ response: responseState, overlays }));
  }

  private async runExclusive(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (this.config.browserHost !== "launcher") return this.runBrowserTurn(turn);

    const lease = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
      phase: "start",
      traceId: turn.traceId,
      helperPid: process.pid,
    });
    const surfaceId = lease.surfaceId;
    if (!surfaceId) throw new Error("Launcher did not lease a browser tab for the ChatGPT turn");
    let terminal: "completed" | "failed" | "aborted" = "completed";
    let terminalMessage: string | undefined;
    let originalError: unknown;
    try {
      return await this.runBrowserTurn(turn, surfaceId);
    } catch (error) {
      originalError = error;
      terminal = error instanceof DOMException && error.name === "AbortError" ? "aborted" : "failed";
      terminalMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      throw error;
    } finally {
      try {
        await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
          phase: "end",
          traceId: turn.traceId,
          helperPid: process.pid,
          status: terminal,
          ...(terminalMessage ? { message: terminalMessage } : {}),
        });
      } catch (controlError) {
        if (!originalError) throw controlError;
        console.error(
          `[chatgpt-web] launcher turn-end notification failed after browser error: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
        );
      }
    }
  }

  private async runBrowserTurn(turn: BrowserTurn, launcherSurfaceId?: string): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    const requestedMode = resolveChatGptWebModelMode(turn.modelId, turn.reasoning, turn.capabilities);
    const prepared = await turn.prepare();
    const diagnostics = new ChatGptBrowserDiagnostics(turn.traceId);
    let turnConnection: Browser | undefined;
    let managedPage: Page | undefined;
    let diagnosticPage: Page | undefined;
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(prepared, turn.modelId);
      assertChatGptWebInputWithinContextWindow(
        estimatedInputTokens,
        requestedMode.effort,
      );
      const deadline = this.config.turnTimeoutMs === undefined
        ? undefined
        : Date.now() + this.config.turnTimeoutMs;
      const page = await this.runStage(turn.traceId, "browser_page", browserStageTimeouts.browserPage, async (abortSignal) => {
        if (!launcherSurfaceId) {
          const managed = await this.pageForNewTurn();
          if (abortSignal.aborted) {
            await managed.close().catch(() => {});
            throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
          }
          return managed;
        }
        const connection = await connectLauncherBrowserHost(
          this.config.browserHostDescriptorPath!,
          browserStageTimeouts.browserPage,
          launcherSurfaceId,
          abortSignal,
        );
        if (abortSignal.aborted) {
          await connection.browser.close().catch(() => {});
          throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
        }
        turnConnection = connection.browser;
        return connection.page;
      });
      if (!launcherSurfaceId) managedPage = page;
      diagnosticPage = page;
      await diagnostics.capture(page, "browser-page-acquired");
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=inline, promptChars=${prepared.text.length}, estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length})`,
      );
      await this.runStage(turn.traceId, "temporary_chat_navigation", browserStageTimeouts.navigation, () => (
        page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).then(() => undefined)
      ));
      await diagnostics.capture(page, "temporary-chat-navigation-complete");
      try {
        await this.runStage(turn.traceId, "composer_ready", browserStageTimeouts.composerReady, () => (
          this.activeComposer(page)
        ));
      } catch {
        throw new Error("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
      }
      await diagnostics.capture(page, "composer-ready");
      await this.runStage(turn.traceId, "session_verification", browserStageTimeouts.sessionVerification, async () => {
        await throwIfChatGptSessionFailureAlert(page);
        await assertAuthenticatedChatGptPage(page);
        await assertTemporaryChatPage(page);
      });
      await diagnostics.capture(page, "session-verified");
      const mode = await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, () => (
        this.selectModelAndEffort(
          page,
          turn.modelId,
          turn.reasoning,
          turn.capabilities,
          checkpoint => diagnostics.capture(page, checkpoint),
        )
      ));
      await diagnostics.capture(page, "effort-selection-complete");
      await this.runStage(turn.traceId, "prompt_attachment", browserStageTimeouts.promptAttachment, () => (
        this.attachPrompt(page, prepared.text, mode.localTools, checkpoint => diagnostics.capture(page, checkpoint))
      ));
      await diagnostics.capture(page, "prompt-attachment-complete");
      await this.runStage(turn.traceId, "file_attachment", browserStageTimeouts.fileAttachment, () => (
        this.attachFiles(page, prepared)
      ));
      await diagnostics.capture(page, "file-attachment-complete");
      const responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
      const initialResponseTurnCount = await responseTurns.count();
      const responseTurn = responseTurns.nth(initialResponseTurnCount);
      const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
      const initialUserTurnCount = await userTurns.count();
      await this.runStage(turn.traceId, "send", browserStageTimeouts.send, async (stageSignal) => {
        const composer = await this.activeComposer(page);
        const sendButton = composer
          .locator("xpath=ancestor::form[1]")
          .getByTestId("send-button");
        await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
        if (!await sendButton.isEnabled()) {
          throw new Error("ChatGPT send button is disabled after the complete prompt was attached");
        }
        await settleChatGptUi();
        await diagnostics.capture(page, "send-ready");
        await throwIfChatGptSessionFailureAlert(page);
        await sendButton.press("Enter");
        const evidence = await this.waitForSubmissionAccepted(
          page,
          userTurns,
          responseTurns,
          responseTurn,
          initialUserTurnCount,
          initialResponseTurnCount,
          stageSignal,
        );
        console.info(`[chatgpt-web] browser turn ${turn.traceId} submission accepted evidence=${evidence}`);
      });
      await diagnostics.capture(page, "send-accepted");

      let lastHeartbeat = 0;
      let finalText = "";
      let sawRunning = false;
      let loggedCompletionWait = false;
      let capturedResponse = false;
      const sentAt = Date.now();
      const visibleTrace = new ChatGptVisibleTraceTracker();
      const markdownBuffer = new ChatGptMarkdownBuffer();
      const completionTracker = new ChatGptCompletionTracker();
      const domHealthTracker = new ChatGptTurnDomHealthTracker();
      for (;;) {
        if (page.isClosed()) {
          throw new Error("ChatGPT browser tab was closed; the Codex turn was terminated");
        }
        if (turn.abortSignal?.aborted) {
          const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
          if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new Error("ChatGPT web turn timed out");
        }
        if (Date.now() - lastHeartbeat >= 10_000) {
          turn.onHeartbeat?.();
          lastHeartbeat = Date.now();
        }

        await throwIfChatGptSessionFailureAlert(page);
        await throwIfChatGptTerminalErrorAlert(responseTurn);

        if (mode.localTools && await resolveChatGptToolConfirmation(
          page,
          this.config.appName,
          this.config.autoApproveToolCalls,
          turn.abortSignal,
          CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
          () => diagnostics.capture(page, "tool-confirmation-visible"),
        )) {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }

        const snapshot = await this.responseDomSnapshot(responseTurn);
        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        const running = await stop.isVisible().catch(() => false);
        if (running) sawRunning = true;
        if (snapshot.responsePresent) {
          if (!capturedResponse) {
            capturedResponse = true;
            await diagnostics.capture(page, "response-visible");
          }
          const textDelta = markdownBuffer.observe(snapshot.markdownSegments);
          for (const trace of visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
            if (trace.kind === "commentary") turn.onCommentary?.(trace.text, trace.continuation === true);
            else turn.onReasoningSummary?.(trace.text, trace.continuation === true);
          }
          if (textDelta) turn.onTextDelta(textDelta);
          const domError = domHealthTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            completionActionVisible: snapshot.completionActionVisible,
          });
          if (domError) throw new Error(domError);
          if (completionTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            currentHtml: snapshot.fullHtml,
            completionActionVisible: snapshot.completionActionVisible,
          })) {
            if (snapshot.visibleText === "api_tool unavailable") {
              throw new Error("ChatGPT selected mode rejected the Codex Native MCP tool (api_tool unavailable)");
            }
            const final = markdownBuffer.finish();
            if (!final.markdown && snapshot.visibleText) {
              throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
            }
            if (final.delta) turn.onTextDelta(final.delta);
            finalText = final.markdown;
            break;
          }
          if (!loggedCompletionWait && Date.now() - sentAt >= 30_000) {
            loggedCompletionWait = true;
            await diagnostics.capture(page, "response-stalled-30s");
            const diagnostic = await this.stalledTurnDiagnostic(page, responseTurn).catch(error => JSON.stringify({
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

      if (this.context && this.config.browserHost === "managed-chrome") {
        const state = await this.context.storageState();
        atomicWriteFile(this.config.storageStatePath, `${JSON.stringify(state)}\n`);
      }
      await diagnostics.capture(page, "turn-completed");
      console.info(`[chatgpt-web] browser turn ${turn.traceId} completed (markdownChars=${finalText.length})`);
      return finalText;
    } catch (error) {
      if (diagnosticPage && !diagnosticPage.isClosed()) {
        await diagnostics.capture(diagnosticPage, "turn-failed", error);
      }
      throw error;
    } finally {
      prepared.release();
      if (turnConnection) {
        await turnConnection.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to release launcher browser connection for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      } else if (managedPage && !managedPage.isClosed()) {
        await managedPage.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to close managed browser tab for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }
}
