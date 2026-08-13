import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import {
  atomicWriteFile,
  CHATGPT_CONNECTOR_NAME,
  defaultChromeExecutable,
  expandUserPath,
  getConfigDir,
  isLegacyChatGptConnectorName,
  legacyChatGptConnectorMigrationMessage,
  LEGACY_CHATGPT_CONNECTOR_NAMES,
} from "../../config";
import type { CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";
import { ChatGptMarkdownBuffer, type ChatGptMarkdownSegment } from "./markdown";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptWebModelMode,
  type ChatGptWebCapabilities,
  type ChatGptWebModelMode,
} from "./model";
import {
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
  estimateCompiledChatGptWebMessageTokens,
} from "./input-tokens";
import { CHATGPT_MAX_INPUT_IMAGES, type CompiledChatGptWebPrompt, type ChatGptWebPromptImage } from "./prompt";
import { estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_MENU_SELECTOR,
  CHATGPT_EFFORT_SLIDER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
  CHATGPT_USER_TURN_SELECTOR,
  detectChatGptAccountCapabilities,
  parseChatGptEffortSliderState,
} from "../../chatgpt-session";
import { loginVerificationMarkerPath } from "../../browser-login";
import {
  connectLauncherBrowserHost,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  notifyLauncherTurn,
} from "../../launcher-browser-host";
import {
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import { ChatGptWebAdapterError } from "./adapter-error";
import {
  ChatGptLunaCheckpointStream,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";

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
const CHATGPT_SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const CHATGPT_SMOKE_EXPECTED = "CODEX WEB GPT READY";
/**
 * ChatGPT applies composer state asynchronously, and a fast host can reach the next step before the
 * editor has taken the previous one. This is headroom for that, not a readiness check.
 */
export const CHATGPT_UI_SETTLE_MS = 250;

const settleChatGptUi = (): Promise<void> => (
  new Promise(resolveSettle => setTimeout(resolveSettle, CHATGPT_UI_SETTLE_MS))
);

class ChatGptConnectorCatalogStaleError extends Error {
  constructor(
    readonly appName: string,
    readonly visibleRows: string[],
    readonly triggerAttempts: number,
  ) {
    super(`ChatGPT connector catalog is missing ${JSON.stringify(appName)}`);
    this.name = "ChatGptConnectorCatalogStaleError";
  }
}

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
  const dialog = page.locator('[role="dialog"], [data-testid="tool-approval-card"]')
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

export function assertChatGptWebInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  promptChars?: number,
): void {
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`ChatGPT web context limit is not defined for model: ${modelId}`);
  }
  if (
    modelId === CHATGPT_WEB_LUNA_MODEL_ID
    && estimatedInputTokens > CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET
  ) {
    throw new ChatGptWebAdapterError(
      `This Luna turn requires ${estimatedInputTokens.toLocaleString("en-US")} estimated input tokens, which exceeds the measured ${CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET.toLocaleString("en-US")}-token ChatGPT Free browser transport budget. Completed Luna history is already replaced by its rolling checkpoint; the remaining payload is the current Codex turn and cannot be reduced by /compact.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  const { contextWindow } = resolveChatGptWebContextLimits(modelId, effort, capabilities);
  const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
    modelId,
    effort,
    capabilities,
  );
  if (
    browserComposerCharLimit !== undefined
    && promptChars !== undefined
    && promptChars > browserComposerCharLimit
  ) {
    throw new ChatGptWebAdapterError(
      `This prompt contains ${promptChars.toLocaleString("en-US")} inline characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary for this account and effort. Run /compact, then retry this Web model.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (browserMessageTokenLimit !== undefined && estimatedMessageTokens > browserMessageTokenLimit) {
    throw new ChatGptWebAdapterError(
      `This prompt requires ${estimatedMessageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT browser message boundary for this account and effort. The model context window is ${contextWindow.toLocaleString("en-US")} tokens; run /compact to reduce the next browser message without changing that model window.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (estimatedInputTokens < contextWindow) return;
  throw new ChatGptWebAdapterError(
    `This task is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds the ${contextWindow.toLocaleString("en-US")}-token context window for this ChatGPT Web model. Switch to a model with a larger context window, run /compact, then retry this Web model.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

const browserStageTimeouts = {
  browserPage: 60_000,
  temporaryChatPreparation: 150_000,
  effortSelection: 120_000,
  promptAttachment: 60_000,
  fileAttachment: 120_000,
  send: 20_000,
} as const;

/**
 * A six-figure Input.insertText can make current ChatGPT Lexical surfaces rewrite text inside the
 * first edit even when its final UTF-16 length is unchanged. Bound only the native edit operation;
 * the resulting user message remains one exact prompt, and every prefix is still verified before
 * another irreversible edit. This is independent of model context and compaction limits.
 */
export const CHATGPT_PROMPT_INSERT_CHUNK_CHARS = 16_000;
export const CHATGPT_COMPOSER_DOCUMENT_END_KEY = process.platform === "darwin"
  ? "Meta+ArrowDown"
  : "Control+End";

function throwIfPromptAttachmentAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ChatGPT prompt attachment aborted", "AbortError");
}

function promptInsertChunkEnd(text: string, offset: number): number {
  let end = Math.min(offset + CHATGPT_PROMPT_INSERT_CHUNK_CHARS, text.length);
  if (end >= text.length) return end;
  const previousCodeUnit = text.charCodeAt(end - 1);
  const nextCodeUnit = text.charCodeAt(end);
  if (previousCodeUnit >= 0xD800 && previousCodeUnit <= 0xDBFF
    && nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
    end -= 1;
  }
  return end;
}

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
  /** Require and remove the private Luna checkpoint tail from the visible Markdown stream. */
  captureLunaCheckpoint?: boolean;
  onLunaCheckpoint?: (captured: CapturedChatGptLunaCheckpoint) => void;
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

export function stripChatGptTraceControlSuffix(block: ChatGptVisibleTraceBlock): ChatGptVisibleTraceBlock {
  if (block.kind !== "status") return block;
  const text = block.text.replace(/(?:^|\s)Answer now\s*$/, "").trimEnd();
  return text === block.text ? block : { ...block, text };
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
          const rendered = (element: Element): boolean => {
            const candidate = element as HTMLElement;
            const style = getComputedStyle(candidate);
            return candidate.isConnected
              && style.display !== "none"
              && style.visibility !== "hidden"
              && style.opacity !== "0";
          };

          const boundedText = (element: Element): string => (
            ((element as HTMLElement).innerText || element.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 1_000)
          );
          const rows = (selector: string, limit = 40) => [...document.querySelectorAll(selector)]
            .filter(rendered)
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
          const composers = [...document.querySelectorAll(composerSelector)].filter(rendered);
          const assistantTurns = [...document.querySelectorAll(assistantTurnSelector)].filter(rendered);
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
  const appName = configured.appName?.trim() || CHATGPT_CONNECTOR_NAME;
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
  if (isLegacyChatGptConnectorName(appName)) {
    throw new Error(legacyChatGptConnectorMigrationMessage(appName));
  }
  return {
    appName,
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
  private maintenanceTail: Promise<void> = Promise.resolve();
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
    return this.enqueueMaintenance("connector verification", () => this.verifyConnectorExclusive());
  }

  inspectSession(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    return this.enqueueMaintenance("session inspection", () => this.inspectSessionExclusive(detectCapabilities));
  }

  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    return this.enqueueMaintenance("smoke test", () => this.smokeTestExclusive(abortSignal));
  }

  private enqueueMaintenance<T>(name: string, action: () => Promise<T>): Promise<T> {
    const operation = this.maintenanceTail.then(() => {
      if (this.activeRuns.size > 0) {
        throw new Error(`ChatGPT ${name} requires all browser turns to finish`);
      }
      return action();
    });
    this.maintenanceTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.launcherHelper) {
      const helper = this.launcherHelper;
      this.launcherHelper = undefined;
      await helper.close();
    }
    await Promise.allSettled([...this.activeRuns.values()]);
    await this.maintenanceTail;
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
    const uiEffortIndex = mode.uiEffortIndex;
    if (uiEffortIndex === null) {
      await settleChatGptUi();
      await throwIfChatGptRateLimitDialog(page);
      const visibleControls = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
      if (await visibleControls.count() > 0) {
        throw new Error(
          "ChatGPT Luna was selected from a Luna-only capability probe, but the account now exposes a model selector; rerun setup",
        );
      }
      await captureDiagnostic?.("luna-default-confirmed");
      return mode;
    }
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
      await currentEffort.press("Enter");
    }
    await captureDiagnostic?.("effort-menu-open-requested");
    const effortChoices = effortMenu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
    const effortChoice = effortChoices.nth(uiEffortIndex);
    const effortSlider = page.locator(CHATGPT_EFFORT_SLIDER_SELECTOR).filter({ visible: true }).last();
    const waitAbort = new AbortController();
    let ready: "effort" | "slider" | "rate-limit";
    try {
      ready = await Promise.race([
        effortChoice.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "effort" as const),
        effortSlider.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "slider" as const),
        chatGptRateLimitDialog(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "rate-limit" as const),
      ]);
      if (ready === "rate-limit") await throwIfChatGptRateLimitDialog(page);
      await captureDiagnostic?.(ready === "slider" ? "effort-slider-visible" : "effort-choice-visible");
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      throw new ChatGptWebAdapterError(
        `ChatGPT effort menu did not expose item index ${uiEffortIndex}`
        + `; item count: ${await effortChoices.count().catch(() => 0)}`,
        { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false },
      );
    } finally {
      waitAbort.abort();
    }
    if (ready === "slider") {
      let sliderState = parseChatGptEffortSliderState(
        await effortSlider.getAttribute("aria-valuemin"),
        await effortSlider.getAttribute("aria-valuemax"),
        await effortSlider.getAttribute("aria-valuenow"),
      );
      if (!sliderState) {
        throw new ChatGptWebAdapterError(
          "ChatGPT effort slider exposed an invalid ARIA range",
          { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false },
        );
      }
      const targetValue = sliderState.min + uiEffortIndex;
      if (targetValue > sliderState.max) {
        throw new ChatGptWebAdapterError(
          `ChatGPT effort slider does not expose item index ${uiEffortIndex}`
          + ` (min=${sliderState.min}; max=${sliderState.max})`,
          { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: false },
        );
      }
      const sliderControl = effortSlider.locator("xpath=ancestor::*[@role='menuitem'][1]");
      while (sliderState.value !== targetValue) {
        await throwIfChatGptRateLimitDialog(page);
        const direction = targetValue > sliderState.value ? 1 : -1;
        const key = direction > 0 ? "ArrowRight" : "ArrowLeft";
        const previousValue = sliderState.value;
        await sliderControl.press(key);
        const changeDeadline = Date.now() + 5_000;
        do {
          sliderState = parseChatGptEffortSliderState(
            await effortSlider.getAttribute("aria-valuemin"),
            await effortSlider.getAttribute("aria-valuemax"),
            await effortSlider.getAttribute("aria-valuenow"),
          );
          if (!sliderState) throw new Error("ChatGPT effort slider lost its semantic ARIA state");
          if (sliderState.value !== previousValue) break;
          await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
        } while (Date.now() < changeDeadline);
        if (sliderState.value !== previousValue + direction) {
          throw new Error(
            `ChatGPT effort slider did not move exactly one step with ${key}`
            + ` (before=${previousValue}; after=${sliderState.value})`,
          );
        }
      }
      await captureDiagnostic?.("effort-selected");
      await page.keyboard.press("Escape");
      return mode;
    }
    const selected = await effortChoice.getAttribute("aria-checked");
    if (selected !== "true" && selected !== "false") {
      throw new Error(`ChatGPT effort item index ${uiEffortIndex} has no semantic checked state`);
    }
    if (selected === "true") {
      await captureDiagnostic?.("effort-selected");
      await page.keyboard.press("Escape");
      return mode;
    }
    await throwIfChatGptRateLimitDialog(page);
    await effortChoice.press("Enter");
    await captureDiagnostic?.("effort-choice-activated");

    const deadline = Date.now() + 40_000;
    let confirmed: string | null = null;
    while (Date.now() < deadline) {
      if (!await effortMenu.isVisible().catch(() => false)) {
        const expanded = await currentEffort.getAttribute("aria-expanded").catch(() => null);
        if (expanded !== "true") {
          await throwIfChatGptRateLimitDialog(page);
          await currentEffort.press("Enter");
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
        throw new Error(`ChatGPT effort item index ${uiEffortIndex} lost its semantic checked state`);
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error(
      `ChatGPT did not confirm effort item index ${uiEffortIndex}`
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

  /** Put every browser operation on one fully hydrated Temporary Chat document. */
  private async prepareTemporaryChatSurface(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
  ): Promise<Locator> {
    // Launcher verification refreshes its owned page before attaching Playwright so a newly added
    // connector is present in the catalog. Navigating again here destroys that freshly hydrated
    // document and made the first verification race a second SPA bootstrap. A leased turn starts on
    // about:blank and therefore still performs exactly one navigation through this same method.
    if (page.url() !== CHATGPT_TEMPORARY_CHAT_URL) {
      await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await captureDiagnostic?.("temporary-chat-navigation-complete");
    }
    let composer: Locator;
    try {
      composer = await this.activeComposer(page);
    } catch {
      throw new Error("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
    }
    await captureDiagnostic?.("composer-ready");
    await throwIfChatGptSessionFailureAlert(page);
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    await captureDiagnostic?.("session-verified");
    return composer;
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

  private async assertPromptAttached(
    page: Page,
    prompt: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    let observed = "";
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      observed = await this.attachedPromptText(page);
      throwIfPromptAttachmentAborted(abortSignal);
      if (observed === prompt) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
    throwIfPromptAttachmentAborted(abortSignal);
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
    if (this.config.appName === CHATGPT_CONNECTOR_NAME && !titles.includes(CHATGPT_CONNECTOR_NAME)) {
      const legacyName = LEGACY_CHATGPT_CONNECTOR_NAMES.find(name => titles.includes(name));
      if (legacyName) return legacyChatGptConnectorMigrationMessage(legacyName);
    }
    return `ChatGPT connector menu opened but exposed no row named ${JSON.stringify(this.config.appName)}`
      + ` after ${triggerAttempts} complete mention trigger attempt(s)`
      + `; create a connector with that exact name before retrying`
      + `; visible rows: ${titles.map(title => JSON.stringify(title)).join(", ")}`;
  }

  private async selectConnector(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    catalogRefreshAvailable = false,
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
          const visibleRows = await this.connectorMentionRowTitles(menuRows);
          if (catalogRefreshAvailable && visibleRows.length > 0) {
            const legacyName = LEGACY_CHATGPT_CONNECTOR_NAMES.find(name => visibleRows.includes(name));
            if (!legacyName && !visibleRows.includes(this.config.appName)) {
              throw new ChatGptConnectorCatalogStaleError(
                this.config.appName,
                visibleRows,
                triggerAttempts,
              );
            }
          }
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
    // The popup's keyboard highlight belongs to the whole attachment menu, not to the exact row
    // resolved above. Composer-level ArrowDown/Enter can therefore select "Add photos & files" or
    // another sibling group. Activate only the uniquely resolved connector row and then require the
    // exact selected-connector marker as evidence before continuing.
    // Use Playwright's real pointer activation. A DOM `dispatchEvent("click")` only fires an
    // untrusted synthetic event; ChatGPT can update the visible badge while never committing the
    // connector to the turn that is sent. Force the click only to bypass the popup's transient
    // layout movement — the event itself remains a trusted browser input event.
    await appResult.click({ force: true, timeout: 10_000 });
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
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
  ): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    if (!localTools) {
      const composer = await this.activeComposer(page);
      // Playwright's multiline fill maps through an input action that ChatGPT's Lexical editor can
      // collapse to the first paragraph on the launcher-owned Electron surface. Clear separately,
      // then transport the complete text in one CDP Input.insertText command.
      await composer.fill("");
      await composer.focus();
      await this.insertPromptText(page, prompt, abortSignal);
      await this.assertPromptAttached(page, prompt, abortSignal);
      return;
    }
    const selectedComposer = await this.selectConnector(
      page,
      captureDiagnostic,
      catalogRefreshAvailable,
    );
    await selectedComposer.focus();
    await page.keyboard.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY);
    await this.insertPromptText(page, ` ${prompt}`, abortSignal);
    await this.assertPromptAttached(page, prompt, abortSignal);
  }

  private async reanchorPromptCaret(page: Page, abortSignal?: AbortSignal): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    const composer = await this.activeComposer(page);
    await composer.focus();
    const anchored = await composer.evaluate(async element => {
      const ignoredSelector = '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]';
      const editableRootNodes = [...element.childNodes].filter(node => (
        node.nodeType === Node.TEXT_NODE
          ? (node.textContent ?? "").length > 0
          : node instanceof Element && !node.matches(ignoredSelector)
      ));
      const finalRootNode = editableRootNodes[editableRootNodes.length - 1];
      if (!finalRootNode) return false;

      const textNodes: Text[] = [];
      const collectTextNodes = (node: Node): void => {
        if (node instanceof Element && node.matches(ignoredSelector)) return;
        if (node.nodeType === Node.TEXT_NODE) {
          if ((node.textContent ?? "").length > 0) textNodes.push(node as Text);
          return;
        }
        for (const child of node.childNodes) collectTextNodes(child);
      };
      collectTextNodes(finalRootNode);
      const lastTextNode = textNodes[textNodes.length - 1];
      const cursorTarget = finalRootNode instanceof Element
        ? finalRootNode.querySelector("[data-inline-selection-pill-cursor-target]")
        : null;

      let targetNode: Node;
      let targetOffset: number;
      const cursorFollowsText = lastTextNode && cursorTarget
        ? (lastTextNode.compareDocumentPosition(cursorTarget) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        : false;
      if (cursorTarget?.parentNode && (!lastTextNode || cursorFollowsText)) {
        targetNode = cursorTarget.parentNode;
        targetOffset = [...targetNode.childNodes].indexOf(cursorTarget);
      } else if (lastTextNode) {
        targetNode = lastTextNode;
        targetOffset = lastTextNode.data.length;
      } else if (finalRootNode instanceof Element && !["AREA", "BR", "HR", "IMG", "INPUT"].includes(finalRootNode.tagName)) {
        targetNode = finalRootNode;
        targetOffset = finalRootNode.childNodes.length;
      } else {
        return false;
      }

      const selection = window.getSelection();
      if (!selection) return false;
      const selectionIsExact = (): boolean => selection.isCollapsed
        && selection.anchorNode === targetNode
        && selection.anchorOffset === targetOffset
        && selection.focusNode === targetNode
        && selection.focusOffset === targetOffset;
      if (!selectionIsExact()) {
        const range = document.createRange();
        range.setStart(targetNode, targetOffset);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      // BrowserHost disables background throttling for active turn pages. One frame lets Lexical
      // apply any selection observer before we accept the exact node-and-offset postcondition.
      await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
      return selectionIsExact();
    }, undefined, { timeout: 20_000 });
    throwIfPromptAttachmentAborted(abortSignal);
    if (!anchored) {
      throw new Error("ChatGPT composer could not re-anchor the prompt caret at the document end");
    }
  }

  private async insertPromptText(page: Page, text: string, abortSignal?: AbortSignal): Promise<void> {
    for (let offset = 0; offset < text.length;) {
      throwIfPromptAttachmentAborted(abortSignal);
      const end = promptInsertChunkEnd(text, offset);
      await page.keyboard.insertText(text.slice(offset, end));
      throwIfPromptAttachmentAborted(abortSignal);
      if (end < text.length) {
        // Lexical can rebuild the active block after an exact commit and move its native selection.
        // Re-anchor only after the verified prefix is stable, before the next irreversible edit.
        const expectedPrefix = text.slice(0, end).trimStart();
        await this.waitForPromptChunkAttached(page, expectedPrefix, abortSignal);
        await this.reanchorPromptCaret(page, abortSignal);
      }
      offset = end;
    }
  }

  private async waitForPromptChunkAttached(
    page: Page,
    expected: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 20_000;
    let observed = "";
    do {
      throwIfPromptAttachmentAborted(abortSignal);
      observed = await this.attachedPromptText(page);
      throwIfPromptAttachmentAborted(abortSignal);
      if (observed === expected) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    } while (Date.now() < deadline);
    throwIfPromptAttachmentAborted(abortSignal);
    let commonPrefix = 0;
    while (commonPrefix < expected.length && expected[commonPrefix] === observed[commonPrefix]) commonPrefix += 1;
    throw new Error(
      `ChatGPT composer did not commit a complete prompt insertion chunk`
      + ` (expectedChars=${expected.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix})`,
    );
  }

  private async verifyConnectorExclusive(): Promise<string> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    try {
      await this.selectConnector(page, undefined, true);
    } catch (error) {
      if (!(error instanceof ChatGptConnectorCatalogStaleError)) throw error;
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      await this.prepareTemporaryChatSurface(page);
      await this.selectConnector(page);
    }
    return this.config.appName;
  }

  private async inspectSessionExclusive(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    const url = page.url();
    if (!detectCapabilities) return { authenticated: true, temporary: true, url };
    const capabilities = await detectChatGptAccountCapabilities(page);
    return { authenticated: true, temporary: true, url, ...capabilities };
  }

  private async smokeTestExclusive(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    const page = await this.ensurePage();
    await this.prepareTemporaryChatSurface(page);
    const account = await detectChatGptAccountCapabilities(page);
    // Core smoke runs before the optional MCP connector is configured, so it must remain a
    // browser-only transport check. Connector setup has its own explicit verification operation.
    const capabilities: ChatGptWebCapabilities = { ...account, localToolsEnabled: false };
    const modelId = account.solAvailable ? CHATGPT_WEB_MODEL_ID : CHATGPT_WEB_LUNA_MODEL_ID;
    const reasoning = account.solAvailable ? "high" : "low";
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const traceId = `smoke_${randomUUID().replaceAll("-", "")}`;
    const response = await this.runBrowserTurn({
      traceId,
      modelId,
      reasoning,
      capabilities,
      prepare: async () => ({ text: CHATGPT_SMOKE_TEXT, images: [], release: () => {} }),
      abortSignal,
      onTextDelta: () => {},
    }, undefined, page);
    if (response.trim() !== CHATGPT_SMOKE_EXPECTED) {
      throw new Error(
        `ChatGPT smoke test returned an unexpected answer (${JSON.stringify(response.trim().slice(0, 200))})`,
      );
    }
    return { effort: mode.displayLabel, response: CHATGPT_SMOKE_EXPECTED };
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
      // Browser turn WebContents are intentionally allowed to run while their Electron view is
      // hidden or has no measured width. Layout geometry is therefore not response visibility:
      // completed Markdown can have width=0 while remaining connected, rendered and readable.
      const renderedInDom = (candidate: HTMLElement): boolean => {
        const style = getComputedStyle(candidate);
        return candidate.isConnected
          && style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0";
      };

      // ChatGPT uses the same Markdown renderer for intermediate commentary and for the final
      // answer. The stable semantic boundary is the public streaming-status container: Markdown
      // inside it is commentary; top-level Markdown outside it is the final answer stream.
      const allMarkdownRoots = [...root.querySelectorAll<HTMLElement>(".markdown")]
        .filter(candidate => !candidate.parentElement?.closest(".markdown"))
        .filter(renderedInDom);
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
          .filter(renderedInDom)
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
        .filter(([candidate]) => renderedInDom(candidate))
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
    snapshot.traceBlocks = snapshot.traceBlocks
      .map(stripChatGptTraceControlSuffix)
      .filter(block => block.text.length > 0 && !isChatGptTraceControl(block));
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
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    let lastHeartbeatFailureAt = 0;
    const sendHeartbeat = () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "heartbeat",
        traceId: turn.traceId,
        helperPid: process.pid,
      }, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS).catch(error => {
        const now = Date.now();
        if (now - lastHeartbeatFailureAt < 30_000) return;
        lastHeartbeatFailureAt = now;
        console.warn(
          `[chatgpt-web] launcher turn heartbeat failed for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }).finally(() => {
        heartbeatInFlight = false;
      });
    };
    try {
      heartbeatTimer = setInterval(sendHeartbeat, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
      return await this.runBrowserTurn(turn, surfaceId);
    } catch (error) {
      originalError = error;
      terminal = error instanceof DOMException && error.name === "AbortError" ? "aborted" : "failed";
      terminalMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      throw error;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
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

  private async runBrowserTurn(
    turn: BrowserTurn,
    launcherSurfaceId?: string,
    maintenancePage?: Page,
  ): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if ((turn.captureLunaCheckpoint === true) !== (turn.onLunaCheckpoint !== undefined)) {
      throw new Error("ChatGPT Luna checkpoint capture requires exactly one checkpoint callback");
    }
    if (turn.captureLunaCheckpoint && turn.modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
      throw new Error("Private rolling checkpoint capture is valid only for ChatGPT Luna");
    }
    const requestedMode = resolveChatGptWebModelMode(turn.modelId, turn.reasoning, turn.capabilities);
    const prepared = await turn.prepare();
    const diagnostics = new ChatGptBrowserDiagnostics(turn.traceId);
    let turnConnection: Browser | undefined;
    let managedPage: Page | undefined;
    let diagnosticPage: Page | undefined;
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(prepared, turn.modelId);
      const estimatedMessageTokens = estimateCompiledChatGptWebMessageTokens(prepared, turn.modelId);
      assertChatGptWebInputWithinLimits(
        estimatedInputTokens,
        estimatedMessageTokens,
        turn.modelId,
        requestedMode.effort,
        turn.capabilities,
        prepared.text.length,
      );
      const deadline = this.config.turnTimeoutMs === undefined
        ? undefined
        : Date.now() + this.config.turnTimeoutMs;
      const page = await this.runStage(turn.traceId, "browser_page", browserStageTimeouts.browserPage, async (abortSignal) => {
        if (maintenancePage) return maintenancePage;
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
      if (!maintenancePage && !launcherSurfaceId) managedPage = page;
      diagnosticPage = page;
      await diagnostics.capture(page, "browser-page-acquired");
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=inline, promptChars=${prepared.text.length}, estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length}, compactionTrimmedMessages=${prepared.trimmedCompactionMessages ?? 0})`,
      );
      await this.runStage(
        turn.traceId,
        "temporary_chat_preparation",
        browserStageTimeouts.temporaryChatPreparation,
        () => this.prepareTemporaryChatSurface(
          page,
          checkpoint => diagnostics.capture(page, checkpoint),
        ),
      );
      let mode: ChatGptWebModelMode;
      let catalogRefreshAvailable = requestedMode.localTools;
      for (;;) {
        mode = await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, () => (
          this.selectModelAndEffort(
            page,
            turn.modelId,
            turn.reasoning,
            turn.capabilities,
            checkpoint => diagnostics.capture(page, checkpoint),
          )
        ));
        await diagnostics.capture(page, "effort-selection-complete");
        try {
          await this.runStage(turn.traceId, "prompt_attachment", browserStageTimeouts.promptAttachment, (stageSignal) => {
            const promptAbortSignal = turn.abortSignal
              ? AbortSignal.any([stageSignal, turn.abortSignal])
              : stageSignal;
            return this.attachPrompt(
              page,
              prepared.text,
              mode.localTools,
              checkpoint => diagnostics.capture(page, checkpoint),
              promptAbortSignal,
              catalogRefreshAvailable,
            );
          });
          break;
        } catch (error) {
          if (!(error instanceof ChatGptConnectorCatalogStaleError) || !catalogRefreshAvailable) throw error;
          catalogRefreshAvailable = false;
          await diagnostics.capture(page, "connector-catalog-stale");
          await this.runStage(
            turn.traceId,
            "connector_catalog_refresh",
            browserStageTimeouts.temporaryChatPreparation,
            async () => {
              await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
              await this.prepareTemporaryChatSurface(
                page,
                checkpoint => diagnostics.capture(page, checkpoint),
              );
            },
          );
          await diagnostics.capture(page, "connector-catalog-refreshed");
        }
      }
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
      const checkpointStream = turn.captureLunaCheckpoint
        ? new ChatGptLunaCheckpointStream()
        : undefined;
      const emitMarkdownDelta = (delta: string): void => {
        const visible = checkpointStream ? checkpointStream.push(delta) : delta;
        if (visible) turn.onTextDelta(visible);
      };
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
          if (textDelta) emitMarkdownDelta(textDelta);
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
            if (final.delta) emitMarkdownDelta(final.delta);
            if (checkpointStream) {
              const completed = checkpointStream.finishOptional(snapshot.visibleText);
              if (completed.visibleRemainder) turn.onTextDelta(completed.visibleRemainder);
              if (completed.captured) turn.onLunaCheckpoint!(completed.captured);
              else console.warn(`[chatgpt-web] browser turn ${turn.traceId} completed without a Luna rolling checkpoint; preserving full native history`);
              finalText = completed.answer;
            } else {
              finalText = final.markdown;
            }
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
