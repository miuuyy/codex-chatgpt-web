import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { atomicWriteFile, expandUserPath, getConfigDir } from "../../config";
import type { CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";
import {
  chatGptAttachmentsReady,
  chatGptFileInputAcceptsFiles,
  sameExactFileNames,
  type ChatGptAttachmentReadiness,
  type ChatGptFileInputCandidate,
} from "./attachment-readiness";
import { ChatGptMarkdownStream } from "./markdown";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities, type ChatGptWebModelMode } from "./model";
import { CHATGPT_INTERNAL_COMPACTION_MARKER, CHATGPT_MAX_INPUT_ATTACHMENTS, CHATGPT_MAX_INPUT_IMAGES, CHATGPT_TASK_CONTEXT_ENTRY_FILENAME, containsChatGptCompactionMarker, containsChatGptWebContextEnvelope, isChatGptWebContextAttachment, stripChatGptTransportMarkers, type CompiledChatGptWebPrompt, type ChatGptWebPromptImage } from "./prompt";
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
  CHATGPT_MODEL_PICKER_OPTION_SELECTOR,
  CHATGPT_MODEL_PICKER_ROOT_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_TEMPORARY_CHAT_URL,
  CHATGPT_USER_TURN_SELECTOR,
} from "../../chatgpt-session";
import { loginVerificationMarkerPath } from "../../browser-login";
import { connectLauncherBrowserHost, notifyLauncherTurn } from "../../launcher-browser-host";
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { ChatGptTransientLimitError } from "./transient-limit-error";

export {
  CHATGPT_CAPACITY_ERROR_CODE,
  ChatGptCapacityError,
  isChatGptCapacityError,
} from "./capacity-error";
export {
  CHATGPT_TRANSIENT_LIMIT_ERROR_CODE,
  ChatGptTransientLimitError,
  isChatGptTransientLimitError,
} from "./transient-limit-error";

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
export const CHATGPT_COMPLETION_SETTLE_MS = 2_000;
/**
 * ChatGPT applies composer state asynchronously, and a fast host can reach the next step before the
 * editor has taken the previous one. This is headroom for that, not a readiness check.
 */
export const CHATGPT_UI_SETTLE_MS = 250;
export const CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS = 3;
/** Minimum spacing between dismissals so a re-mounted dialog cannot burn the budget in <1s. */
export const CHATGPT_TRANSIENT_LIMIT_DISMISSAL_COOLDOWN_MS = 2_000;
/** How long to keep retrying a dialog that re-mounts after dismissal before surfacing a rate-limit error. */
export const CHATGPT_TRANSIENT_LIMIT_PERSISTENCE_GRACE_MS = 10_000;

const CHATGPT_MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"]';

const abortableSleep = (ms: number, abortSignal?: AbortSignal): Promise<void> => (
  new Promise(resolveSleep => {
    if (abortSignal?.aborted) {
      resolveSleep();
      return;
    }
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolveSleep();
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  })
);

const settleChatGptUi = (): Promise<void> => (
  new Promise(resolveSettle => setTimeout(resolveSettle, CHATGPT_UI_SETTLE_MS))
);

const assertChatGptTurnActive = (page: Page, abortSignal?: AbortSignal): void => {
  if (typeof page.isClosed === "function" && page.isClosed()) {
    throw new Error("ChatGPT browser tab was closed; the Codex turn was terminated");
  }
  if (abortSignal?.aborted) {
    throw new DOMException("ChatGPT web turn aborted", "AbortError");
  }
};

const browserStageTimeouts = {
  browserPage: 60_000,
  navigation: 70_000,
  composerReady: 40_000,
  sessionVerification: 40_000,
  effortSelection: 120_000,
  promptAttachment: 60_000,
  fileAttachment: 180_000,
  send: 20_000,
} as const;

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
    } else if (state.running) {
      // ChatGPT Pro may expose only its active-generation control before mounting the assistant
      // turn. Do not turn a healthy, visibly running generation into an application timeout.
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
  inspection: "ok" | "retry";
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  stableHtml: string;
  completionActionVisible: boolean;
  traceBlocks: ChatGptVisibleTraceBlock[];
}

const absentResponseDomSnapshot = (): ChatGptResponseDomSnapshot => ({
  inspection: "ok",
  responsePresent: false,
  visibleText: "",
  fullHtml: "",
  stableHtml: "",
  completionActionVisible: false,
  traceBlocks: [],
});

const retryResponseDomSnapshot = (): ChatGptResponseDomSnapshot => ({
  inspection: "retry",
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
  private readonly emittedReasoning = new Map<number, string>();
  private readonly reasoningCandidates = new Map<number, { text: string; changedAt: number }>();

  constructor(private readonly traceStabilityMs = 1_000) {}

  observe(blocks: ChatGptVisibleTraceBlock[], _completionActionVisible: boolean, now = Date.now()): ChatGptVisibleTraceEvent[] {
    const output: ChatGptVisibleTraceEvent[] = [];
    for (let index = 0; index < blocks.length; index++) {
      const block = blocks[index]!;
      if (containsChatGptCompactionMarker(block.text)
        && !this.seen.has(CHATGPT_INTERNAL_COMPACTION_MARKER)) {
        this.seen.add(CHATGPT_INTERNAL_COMPACTION_MARKER);
        output.push({ kind: "reasoning", text: "Context automatically compacted" });
      }
      // Every visible Markdown root belongs to the final assistant answer. ChatGPT may split one
      // answer into several roots around status/tool UI; emitting the earlier roots as commentary
      // moves most of the answer under Codex's `Working` disclosure and leaves a truncated final.
      // ChatGptMarkdownStream owns all Markdown roots; this tracker owns status/reasoning only.
      if (block.kind === "markdown") continue;
      const text = stripChatGptTransportMarkers(block.text)
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.replace(/[\t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (!text) continue;
      const candidate = this.reasoningCandidates.get(index);
      if (!candidate || candidate.text !== text) {
        this.reasoningCandidates.set(index, { text, changedAt: now });
        continue;
      }
      if (now - candidate.changedAt < this.traceStabilityMs) continue;

      const previous = this.emittedReasoning.get(index);
      if (previous === text) continue;
      this.emittedReasoning.set(index, text);

      const key = `${block.kind}\0${text}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (previous && text.startsWith(previous)) {
        output.push({ kind: "reasoning", text: text.slice(previous.length), continuation: true });
      } else {
        output.push({ kind: "reasoning", text });
      }
    }
    return output;
  }
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
  const browserHost = configured.browserHost ?? "managed-chrome";
  const browserHostDescriptorPath = configured.browserHostDescriptorPath?.trim();
  if (browserHost === "launcher" && !browserHostDescriptorPath) {
    throw new Error("Launcher browser host requires chatgptWeb.browserHostDescriptorPath");
  }
  return {
    appName: configured.appName?.trim() || "Codex Native",
    browserHost,
    ...(browserHostDescriptorPath ? { browserHostDescriptorPath: resolve(expandUserPath(browserHostDescriptorPath)) } : {}),
    storageStatePath: resolve(expandUserPath(configured.storageStatePath?.trim() || join(getConfigDir(), "browser", "storage-state.json"))),
    chromeExecutablePath: resolve(expandUserPath(configured.chromeExecutablePath?.trim() || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")),
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

export interface ChatGptPromptFilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

interface ChatGptTransientLimitRecoveryState {
  dismissals: number;
  pickerNeedsResync: boolean;
  modelNeedsVerification: boolean;
  /** Identity of the most recently dismissed dialog (empty text fingerprint tracking). */
  lastFingerprint?: string;
  /** When the most recent dismissal was made; persistence is judged against this. */
  lastDismissedAt?: number;
  /** Consecutive re-mounts of the same dialog after a verified dismissal. */
  persistentStreak?: number;
  /** Test/tuning hook: override the dismissal cooldown. */
  cooldownMs?: number;
  /** Test/tuning hook: override the persistence grace window. */
  graceMs?: number;
}

type ChatGptTransientLimitDialogInspection =
  | { kind: "none" }
  | { kind: "recognized"; dialog: Locator; fingerprint: string }
  | { kind: "ambiguous"; diagnostic: string };

type ChatGptPickerResyncMode = "defer" | "open" | "close" | "best-effort-close";

type ChatGptAdvancedPickerFocus = "advanced" | "effort-control" | "effort-value";

interface ChatGptAdvancedPickerState {
  pickerOpen: boolean;
  advancedFound: boolean;
  effortControlFound: boolean;
  effortValueFound: boolean;
  effortValueSelected: boolean | null;
  controlMatchesEffort: boolean;
  focused: boolean;
  activated?: boolean;
}

type ChatGptSubmissionWaitResult = ChatGptSubmissionEvidence | "transient_interruption";

export function chatGptPromptFilePayloads(
  prompt: CompiledChatGptWebPrompt,
): ChatGptPromptFilePayload[] {
  const contextAttachment: unknown = prompt.contextAttachment;
  if (!isChatGptWebContextAttachment(contextAttachment)) {
    throw new Error("ChatGPT web task context attachment is missing or invalid");
  }
  if (containsChatGptWebContextEnvelope(prompt.text)) {
    throw new Error("ChatGPT web prompt duplicated the task context in the composer");
  }
const files: ChatGptPromptFilePayload[] = [
    {
      name: contextAttachment.name,
      mimeType: contextAttachment.mimeType,
      buffer: contextAttachment.mimeType === "application/zip"
        ? Buffer.from(zipSync({
          [CHATGPT_TASK_CONTEXT_ENTRY_FILENAME]: strToU8(contextAttachment.text),
        }))
        : Buffer.from(contextAttachment.text, "utf8"),
    },
    ...chatGptImageFilePayloads(prompt.images),
  ];
  if (files.length > CHATGPT_MAX_INPUT_ATTACHMENTS) {
    throw new Error(`ChatGPT web accepts at most ${CHATGPT_MAX_INPUT_ATTACHMENTS} input attachments per Codex turn`);
  }
  const names = new Set<string>();
  for (const file of files) {
    if (names.has(file.name)) {
      throw new Error(`ChatGPT web prompt has duplicate attachment name: ${file.name}`);
    }
    names.add(file.name);
  }
  return files;
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
    turnAbortSignal?: AbortSignal,
  ): Promise<T> {
    if (turnAbortSignal?.aborted) {
      throw new DOMException("ChatGPT web turn aborted", "AbortError");
    }
    const startedAt = performance.now();
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortStage: (() => void) | undefined;
    try {
      const timeout = new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(() => {
          rejectTimeout(new Error(`ChatGPT browser stage timed out: ${stage}`));
          controller.abort();
        }, timeoutMs);
      });
      const pending: Promise<T | never>[] = [action(controller.signal), timeout];
      if (turnAbortSignal) {
        pending.push(new Promise<never>((_, rejectAbort) => {
          abortStage = () => {
            controller.abort();
            rejectAbort(new DOMException("ChatGPT web turn aborted", "AbortError"));
          };
          turnAbortSignal.addEventListener("abort", abortStage, { once: true });
        }));
      }
      const value = await Promise.race(pending);
      console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} completed durationMs=${Math.round(performance.now() - startedAt)}`);
      return value;
    } catch (error) {
      console.error(`[chatgpt-web] browser turn ${traceId} stage=${stage} failed durationMs=${Math.round(performance.now() - startedAt)}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (turnAbortSignal && abortStage) turnAbortSignal.removeEventListener("abort", abortStage);
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

  private async inspectTransientLimitDialog(page: Page): Promise<ChatGptTransientLimitDialogInspection> {
    const dialogs = page.locator(CHATGPT_MODAL_SELECTOR);
    const inspection = await dialogs.evaluateAll(elements => {
      const visible = (element: Element): boolean => {
        const candidate = element as HTMLElement;
        const style = getComputedStyle(candidate);
        return style.display !== "none"
          && style.visibility !== "hidden"
          && candidate.getClientRects().length > 0;
      };
      const focusableSelector = "button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[contenteditable=true],[tabindex]:not([tabindex='-1']),[role=button],[role=checkbox],[role=radio],[role=switch],[role=combobox]";
      const formControlSelector = "input, textarea, select, [contenteditable=true], [role=checkbox], [role=radio], [role=switch], [role=combobox]";
      const rateLimitPhrases = [
        "too many requests",
        "requests too quickly",
        "temporarily limited",
        "please wait a few minutes",
      ];
      const matchesRateLimitText = (text: string): boolean => {
        const lower = text.toLowerCase();
        for (const phrase of rateLimitPhrases) {
          if (lower.includes(phrase)) return true;
        }
        return false;
      };
      const visibleDialogs: Array<{ element: HTMLElement; index: number }> = [];
      for (let index = 0; index < elements.length; index += 1) {
        if (visible(elements[index])) visibleDialogs.push({ element: elements[index] as HTMLElement, index });
      }
      type DialogDescriptor = {
        index: number;
        role: string | null;
        ariaModal: string | null;
        testId: string | null;
        buttonTestId: string | null;
        buttonCount: number;
        focusableCount: number;
        formControlCount: number;
        linkCount: number;
        graphicCount: number;
        activeOnOnlyButton: boolean;
        centered: boolean;
        topmost: boolean;
        textChars: number;
        buttonTextChars: number;
        enabledButton: boolean;
        rateLimitText: boolean;
        fingerprint: string;
        recognized: boolean;
      };
      const descriptors: DialogDescriptor[] = [];
      for (let visibleIndex = 0; visibleIndex < visibleDialogs.length; visibleIndex += 1) {
        const { element, index } = visibleDialogs[visibleIndex];
        const buttons: HTMLButtonElement[] = [];
        for (const candidate of element.querySelectorAll<HTMLButtonElement>("button")) {
          if (visible(candidate)) buttons.push(candidate);
        }
        const focusables: HTMLElement[] = [];
        for (const candidate of element.querySelectorAll<HTMLElement>(focusableSelector)) {
          if (visible(candidate)) focusables.push(candidate);
        }
        const formControls: HTMLElement[] = [];
        for (const candidate of element.querySelectorAll<HTMLElement>(formControlSelector)) {
          if (visible(candidate)) formControls.push(candidate);
        }
        const links: HTMLElement[] = [];
        for (const candidate of element.querySelectorAll<HTMLElement>("a[href]")) {
          if (visible(candidate)) links.push(candidate);
        }
        const graphics: HTMLElement[] = [];
        for (const candidate of element.querySelectorAll<HTMLElement>("img, svg")) {
          if (visible(candidate)) graphics.push(candidate);
        }
        const button = buttons[0];
        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const topmost = document.elementFromPoint(centerX, centerY);
        const activeOnOnlyButton = Boolean(
          button
          && (document.activeElement === button || button.contains(document.activeElement)),
        );
        const centered = Math.abs(centerX - innerWidth / 2) <= Math.max(48, innerWidth * 0.12)
          && Math.abs(centerY - innerHeight / 2) <= Math.max(64, innerHeight * 0.18);
        const innerText = element.innerText.trim();
        const fingerprint = `${innerText.slice(0, 200)}|${button?.innerText.trim().slice(0, 50) ?? ""}`;
        const descriptor = {
          index,
          role: element.getAttribute("role"),
          ariaModal: element.getAttribute("aria-modal"),
          testId: element.getAttribute("data-testid"),
          buttonTestId: button?.getAttribute("data-testid") ?? null,
          buttonCount: buttons.length,
          focusableCount: focusables.length,
          formControlCount: formControls.length,
          linkCount: links.length,
          graphicCount: graphics.length,
          activeOnOnlyButton,
          centered,
          topmost: Boolean(topmost && element.contains(topmost)),
          textChars: innerText.length,
          buttonTextChars: button?.innerText.trim().length ?? 0,
          enabledButton: Boolean(button && !button.disabled),
          rateLimitText: matchesRateLimitText(innerText),
          fingerprint,
        };
        descriptors.push({
          ...descriptor,
          recognized: descriptor.ariaModal !== "false"
            && descriptor.buttonCount === 1
            && descriptor.focusableCount === 1
            && descriptor.formControlCount === 0
            && descriptor.linkCount === 0
            && descriptor.graphicCount === 0
            && descriptor.rateLimitText
            && descriptor.centered
            && descriptor.topmost
            && descriptor.textChars >= 80
            && descriptor.textChars <= 1_000
            && descriptor.buttonTextChars > 0
            && descriptor.enabledButton,
        });
      }
      const candidates: number[] = [];
      for (const entry of descriptors) {
        if (entry.recognized) candidates.push(entry.index);
      }
      return {
        visibleCount: visibleDialogs.length,
        candidates,
        descriptors,
      };
    }).catch((error: unknown) => ({
      kind: "ambiguous" as const,
      diagnostic: `dialog inspection failed: ${error instanceof Error ? error.message : String(error)}`,
    }));
    if (!("visibleCount" in inspection)) {
      return { kind: "ambiguous", diagnostic: inspection.diagnostic };
    }
    if (inspection.visibleCount === 0) return { kind: "none" };
    if (inspection.visibleCount === 1 && inspection.candidates.length === 1) {
      const candidate = inspection.descriptors.find(descriptor => descriptor.recognized);
      if (candidate) {
        return { kind: "recognized", dialog: dialogs.nth(candidate.index), fingerprint: candidate.fingerprint };
      }
    }
    return {
      kind: "ambiguous",
      diagnostic: JSON.stringify({
        visibleDialogs: inspection.visibleCount,
        candidates: inspection.candidates.length,
        descriptors: inspection.descriptors,
      }),
    };
  }

  private async resynchronizeEffortPicker(
    page: Page,
    abortSignal: AbortSignal | undefined,
    leaveOpen: boolean,
    required: boolean,
  ): Promise<boolean> {
    assertChatGptTurnActive(page, abortSignal);
    const composer = await this.activeComposer(page, required ? 5_000 : 1_000, abortSignal).catch(error => {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (required) throw error;
      return undefined;
    });
    if (!composer) return false;
    const control = composer
      .locator("xpath=ancestor::form[1]")
      .locator(CHATGPT_EFFORT_CONTROL_SELECTOR)
      .last();
    try {
      await control.waitFor({ state: "visible", timeout: required ? 5_000 : 1_000 });
    } catch (error) {
      if (required) throw error;
      return false;
    }
    const pickerIsOpen = async (): Promise<boolean> => (
      await page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).count().catch(() => 0) > 0
      || await control.getAttribute("aria-expanded", { timeout: 1_000 }).catch(() => null) === "true"
    );
    if (!await pickerIsOpen()) {
      assertChatGptTurnActive(page, abortSignal);
      await settleChatGptUi();
      await control.evaluate(
        element => (element as HTMLButtonElement).click(),
        undefined,
        { timeout: 5_000 },
      );
    }
    const deadline = Date.now() + 2_500;
    while (Date.now() < deadline && !await pickerIsOpen()) {
      assertChatGptTurnActive(page, abortSignal);
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
    if (!leaveOpen && await pickerIsOpen()) await page.keyboard.press("Escape");
    return true;
  }

  private async recoverTransientLimitDialogs(
    page: Page,
    recovery: ChatGptTransientLimitRecoveryState,
    abortSignal: AbortSignal | undefined,
    stage: string,
    pickerMode: ChatGptPickerResyncMode = "close",
  ): Promise<boolean> {
    let recovered = false;
    const cooldownMs = recovery.cooldownMs ?? CHATGPT_TRANSIENT_LIMIT_DISMISSAL_COOLDOWN_MS;
    const graceMs = recovery.graceMs ?? CHATGPT_TRANSIENT_LIMIT_PERSISTENCE_GRACE_MS;
    for (;;) {
      assertChatGptTurnActive(page, abortSignal);
      const inspection = await this.inspectTransientLimitDialog(page);
      if (inspection.kind === "ambiguous") {
        throw new Error(
          `ChatGPT displayed an unrecognized blocking dialog during ${stage}; refusing to activate it: ${inspection.diagnostic}`,
        );
      }
      if (inspection.kind === "recognized") {
        const now = Date.now();
        const sameDialog = recovery.lastFingerprint !== undefined
          && inspection.fingerprint === recovery.lastFingerprint
          && recovery.lastDismissedAt !== undefined
          && now - recovery.lastDismissedAt < graceMs;
        if (sameDialog) {
          recovery.persistentStreak = (recovery.persistentStreak ?? 0) + 1;
          if (recovery.persistentStreak >= CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS) {
            throw new ChatGptTransientLimitError(stage, recovery.dismissals);
          }
          await abortableSleep(cooldownMs, abortSignal);
          continue;
        }
        if (recovery.dismissals >= CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS) {
          throw new ChatGptTransientLimitError(stage, recovery.dismissals);
        }
        const cooldownRemaining = (recovery.lastDismissedAt ?? 0) + cooldownMs - now;
        if (cooldownRemaining > 0 && !sameDialog) await abortableSleep(cooldownRemaining, abortSignal);
        const action = inspection.dialog.locator("button").filter({ visible: true }).first();
        await action.evaluate(
          element => (element as HTMLButtonElement).click(),
          undefined,
          { timeout: 5_000 },
        );
        await settleChatGptUi();
        const after = await this.inspectTransientLimitDialog(page);
        if (after.kind === "ambiguous") {
          throw new Error(
            `ChatGPT displayed an unrecognized blocking dialog during ${stage}; refusing to activate it: ${after.diagnostic}`,
          );
        }
        if (after.kind === "recognized" && after.fingerprint === inspection.fingerprint) {
          recovery.lastDismissedAt = now;
          recovery.lastFingerprint = inspection.fingerprint;
          recovery.persistentStreak = 0;
          continue;
        }
        recovery.dismissals += 1;
        recovery.pickerNeedsResync = true;
        recovery.modelNeedsVerification = true;
        recovered = true;
        recovery.lastDismissedAt = now;
        recovery.lastFingerprint = inspection.fingerprint;
        recovery.persistentStreak = 0;
        continue;
      }
      if (recovery.pickerNeedsResync && pickerMode !== "defer") {
        const required = pickerMode !== "best-effort-close";
        const resynchronized = await this.resynchronizeEffortPicker(
          page,
          abortSignal,
          pickerMode === "open",
          required,
        );
        if (!resynchronized) return recovered;
        recovery.pickerNeedsResync = false;
        continue;
      }
      return recovered;
    }
  }

private async advancedPickerState(
    page: Page,
    effortLabel: string,
    focus?: ChatGptAdvancedPickerFocus,
    click = false,
  ): Promise<ChatGptAdvancedPickerState> {
    return await page.evaluate((input) => {
      const visible = (element: Element): element is HTMLElement => {
        const candidate = element as HTMLElement;
        const style = window.getComputedStyle(candidate);
        return style.display !== "none"
          && style.visibility !== "hidden"
          && candidate.getClientRects().length > 0;
      };
      const normalize = (value: string | null | undefined): string => (
        (value ?? "").replace(/\s+/g, " ").trim()
      );
      const accessibleName = (element: HTMLElement): string => normalize(
        element.getAttribute("aria-label") ?? element.innerText ?? element.textContent,
      );
const hasWord = (value: string, word: string): boolean => (
        value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).includes(word.toLocaleLowerCase())
      );
      const tokensOf = (value: string): Set<string> => new Set(
        value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean),
      );
      const desiredTokens = tokensOf(input.effortLabel);
      const matchesDesiredLabel = (value: string): boolean => {
        if (desiredTokens.size === 0) return false;
        const tokens = tokensOf(value);
        for (const token of desiredTokens) {
          if (!tokens.has(token)) return false;
        }
        return true;
      };
      const semanticSelection = (element: HTMLElement | undefined): boolean | null => {
        if (!element) return null;
        const value = element.getAttribute("aria-checked")
          ?? element.getAttribute("aria-selected")
          ?? element.getAttribute("data-state");
        if (value === "true" || value === "checked" || value === "on") return true;
        if (value === "false" || value === "unchecked" || value === "off") return false;
        return null;
      };
      const unique = <T extends Element>(values: T[]): T[] => [...new Set(values)];

      const composers = Array.from(document.querySelectorAll<HTMLElement>(input.composerSelector)).filter(visible);
      const composer = composers.at(-1);
      const form = composer?.closest("form");
      const controls = Array.from(form?.querySelectorAll<HTMLElement>(input.controlSelector) ?? []).filter(visible);
      const control = controls.at(-1);
      const roots: HTMLElement[] = [];
      const addRoot = (candidate: Element | null): void => {
        if (candidate instanceof HTMLElement && visible(candidate) && !roots.includes(candidate)) roots.push(candidate);
      };
      const controlledId = control?.getAttribute("aria-controls");
      if (controlledId) addRoot(document.getElementById(controlledId));
      for (const candidate of document.querySelectorAll<HTMLElement>(input.rootSelector)) addRoot(candidate);

const interactive = unique([
        ...roots.flatMap(root => (
          Array.from(root.querySelectorAll<HTMLElement>(input.optionSelector)).filter(visible)
        )),
        ...Array.from(document.querySelectorAll<HTMLElement>(input.optionSelector)).filter(visible),
      ]);
      const semanticRoles = new Set(["menuitemradio", "menuitem", "radio", "option"]);
      const textElements = unique([
        ...roots,
        ...roots.flatMap(root => (
          Array.from(root.querySelectorAll<HTMLElement>("*")).filter(visible)
        )),
      ]).filter(element => element !== control);
      const scoreValue = (element: HTMLElement): { element: HTMLElement; score: number; name: string } | null => {
        const name = accessibleName(element);
        const role = element.getAttribute("role") ?? "";
        const popupControl = element.matches('[aria-haspopup="menu"], [aria-haspopup="listbox"], [role="combobox"]');
        if (!matchesDesiredLabel(name)) return null;
        if (popupControl && !semanticRoles.has(role)) return null;
        const exact = name.toLocaleLowerCase() === input.effortLabel.toLocaleLowerCase();
        const tokens = tokensOf(name);
        const score = (semanticRoles.has(role) ? 8 : 0)
          + (exact ? 4 : 0)
          + (element.hasAttribute("aria-checked") || element.hasAttribute("aria-selected") ? 2 : 0)
          + (element.childElementCount === 0 ? 1 : 0)
          - (tokens.size - desiredTokens.size);
        return { element, name, score };
      };
      const advanced = unique([...interactive, ...textElements])
        .map(element => ({ element, name: accessibleName(element) }))
        .filter(candidate => hasWord(candidate.name, "Advanced"))
        .sort((left, right) => {
          const leftRole = left.element.getAttribute("role") ?? "";
          const rightRole = right.element.getAttribute("role") ?? "";
          return (rightRole ? 1 : 0) - (leftRole ? 1 : 0)
            || left.name.length - right.name.length;
        })[0]?.element;
      const effortValue = unique([...interactive, ...textElements])
        .map(scoreValue)
        .filter((candidate): candidate is { element: HTMLElement; score: number; name: string } => candidate !== null)
        .sort((left, right) => right.score - left.score)[0]?.element;
      const effortControls = unique([
        ...roots.flatMap(root => Array.from(root.querySelectorAll<HTMLElement>(
          '[role="combobox"], button[aria-haspopup="menu"], button[aria-haspopup="listbox"]',
        )).filter(visible)),
        ...Array.from(document.querySelectorAll<HTMLElement>(
          '[role="combobox"], button[aria-haspopup="menu"], button[aria-haspopup="listbox"]',
        )).filter(visible),
      ]);
      const effortControl = effortControls
        .map(element => ({ element, name: accessibleName(element) }))
        .filter(candidate => candidate.element !== control
          && candidate.element !== advanced
          && candidate.element !== effortValue
          && hasWord(candidate.name, "effort"))
        .sort((left, right) => left.name.length - right.name.length)[0]?.element
        ?? unique([...textElements, ...effortControls])
          .map(element => ({ element, name: accessibleName(element) }))
          .filter(candidate => candidate.element !== control
            && candidate.element !== advanced
            && candidate.element !== effortValue
            && hasWord(candidate.name, "effort")
            && (candidate.element.tagName === "BUTTON"
              || ["button", "tab", "menuitem", "menuitemradio"].includes(candidate.element.getAttribute("role") ?? "")))
          .sort((left, right) => left.name.length - right.name.length)[0]?.element;

      const controlName = control ? accessibleName(control) : "";
      const controlMatchesEffort = matchesDesiredLabel(controlName);

const focusTarget = input.focus === "advanced"
        ? advanced
        : input.focus === "effort-control"
          ? effortControl
          : input.focus === "effort-value"
            ? effortValue
            : undefined;
      if (focusTarget) {
        if (input.click) {
          focusTarget.click();
        } else {
          focusTarget.focus({ preventScroll: true });
        }
      }
      const selected = semanticSelection(effortValue);
      return {
        pickerOpen: roots.length > 0 || control?.getAttribute("aria-expanded") === "true",
        advancedFound: Boolean(advanced),
        effortControlFound: Boolean(effortControl),
        effortValueFound: Boolean(effortValue),
        effortValueSelected: selected ?? (controlMatchesEffort ? true : null),
        controlMatchesEffort,
        focused: Boolean(focusTarget && !input.click && document.activeElement === focusTarget),
        activated: Boolean(focusTarget && input.click),
      };
    }, {
      composerSelector: CHATGPT_COMPOSER_SELECTOR,
      controlSelector: CHATGPT_EFFORT_CONTROL_SELECTOR,
      rootSelector: CHATGPT_MODEL_PICKER_ROOT_SELECTOR,
      optionSelector: CHATGPT_MODEL_PICKER_OPTION_SELECTOR,
      effortLabel,
      focus,
      click,
    });
  }

private async waitForAdvancedPickerState(
    page: Page,
    effortLabel: string,
    abortSignal: AbortSignal | undefined,
    timeoutMs: number,
    ready: (state: ChatGptAdvancedPickerState) => boolean,
  ): Promise<ChatGptAdvancedPickerState | undefined> {
    const deadline = Date.now() + timeoutMs;
    let state: ChatGptAdvancedPickerState | undefined;
    do {
      assertChatGptTurnActive(page, abortSignal);
      state = await this.advancedPickerState(page, effortLabel);
      if (ready(state)) return state;
      await abortableSleep(100, abortSignal);
    } while (Date.now() < deadline);
    return undefined;
  }

  private async activateAdvancedPickerTarget(
    page: Page,
    effortLabel: string,
    focus: ChatGptAdvancedPickerFocus,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    assertChatGptTurnActive(page, abortSignal);
    const state = await this.advancedPickerState(page, effortLabel, focus);
    if (!state.focused) {
      const clicked = await this.advancedPickerState(page, effortLabel, focus, true);
      if (!clicked.activated) {
        throw new Error(`ChatGPT Advanced picker ${focus} control could not receive focus`);
      }
      await settleChatGptUi();
      return;
    }
    await page.keyboard.press("Enter");
    await settleChatGptUi();
  }

  private async advancedPickerDiagnostics(
    page: Page,
    effortLabel: string,
  ): Promise<string> {
    try {
      return await page.evaluate((input) => {
        const visible = (element: Element): boolean => {
          const candidate = element as HTMLElement;
          const style = window.getComputedStyle(candidate);
          return style.display !== "none"
            && style.visibility !== "hidden"
            && candidate.getClientRects().length > 0;
        };
        const options = Array.from(document.querySelectorAll<HTMLElement>(input.optionSelector))
          .filter(visible)
          .slice(-24)
          .map(element => ({
            role: element.getAttribute("role") ?? "",
            checked: element.getAttribute("aria-checked"),
            selected: element.getAttribute("aria-selected"),
            state: element.getAttribute("data-state"),
            popup: element.hasAttribute("aria-haspopup"),
            name: (element.getAttribute("aria-label") ?? element.innerText ?? element.textContent ?? "")
              .replace(/\s+/g, " ").trim().slice(0, 80),
          }));
        return JSON.stringify({
          rootCount: Array.from(document.querySelectorAll<HTMLElement>(input.rootSelector))
            .filter(visible).length,
          options,
        });
      }, {
        rootSelector: CHATGPT_MODEL_PICKER_ROOT_SELECTOR,
        optionSelector: CHATGPT_MODEL_PICKER_OPTION_SELECTOR,
        effortLabel,
      });
    } catch (error) {
      return `diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

private async selectAdvancedModelAndEffort(
    page: Page,
    currentEffort: Locator,
    mode: ChatGptWebModelMode,
    abortSignal?: AbortSignal,
  ): Promise<ChatGptWebModelMode> {
    const effortLabel = mode.displayLabel;
    let state = await this.advancedPickerState(page, effortLabel);
    if (!state.pickerOpen) {
      await currentEffort.press("Enter", { timeout: 5_000 });
      state = await this.waitForAdvancedPickerState(
        page,
        effortLabel,
        abortSignal,
        5_000,
        candidate => candidate.pickerOpen,
      ) ?? state;
    }
    if (state.advancedFound) {
      await this.activateAdvancedPickerTarget(page, effortLabel, "advanced", abortSignal);
      state = await this.waitForAdvancedPickerState(
        page,
        effortLabel,
        abortSignal,
        5_000,
        candidate => candidate.effortControlFound || candidate.effortValueFound,
      ) ?? await this.advancedPickerState(page, effortLabel);
    }
    if (state.effortControlFound && !state.effortValueFound) {
      await this.activateAdvancedPickerTarget(page, effortLabel, "effort-control", abortSignal);
      state = await this.waitForAdvancedPickerState(
        page,
        effortLabel,
        abortSignal,
        5_000,
        candidate => candidate.effortValueFound,
      ) ?? state;
    }
    if (state.effortValueFound && state.effortValueSelected !== true) {
      await this.activateAdvancedPickerTarget(page, effortLabel, "effort-value", abortSignal);
      state = await this.waitForAdvancedPickerState(
        page,
        effortLabel,
        abortSignal,
        5_000,
        candidate => candidate.controlMatchesEffort || candidate.effortValueSelected === true,
      ) ?? await this.advancedPickerState(page, effortLabel);
    }
    if (!state.controlMatchesEffort && state.effortValueSelected !== true) {
      const clicked = await this.advancedPickerState(page, effortLabel, "effort-value", true);
      if (clicked.activated) {
        state = await this.waitForAdvancedPickerState(
          page,
          effortLabel,
          abortSignal,
          5_000,
          candidate => candidate.controlMatchesEffort || candidate.effortValueSelected === true,
        ) ?? await this.advancedPickerState(page, effortLabel);
      }
    }
    if (!state.controlMatchesEffort && state.effortValueSelected !== true) {
      throw new Error(
        `ChatGPT Advanced picker did not select effort ${effortLabel}:`
        + ` ${await this.advancedPickerDiagnostics(page, effortLabel)}`,
      );
    }
    if (state.pickerOpen) await page.keyboard.press("Escape");
    return mode;
  }

  private async selectModelAndEffort(
    page: Page,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
    abortSignal?: AbortSignal,
    recovery?: ChatGptTransientLimitRecoveryState,
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
    if (recovery) {
      await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "effort selection", "open");
    }
    const effortMenu = (): Locator => (
      page.locator(CHATGPT_EFFORT_MENU_SELECTOR).filter({ visible: true }).last()
    );
    const effortChoice = (): Locator => (
      effortMenu().locator(CHATGPT_EFFORT_ITEM_SELECTOR).nth(mode.uiEffortIndex)
    );
    const effortState = async (focus = false): Promise<{
      open: boolean;
      checked: string | null;
      count: number;
      focused: boolean;
    }> => (
      page.locator(CHATGPT_EFFORT_MENU_SELECTOR).evaluateAll((menus, input) => {
        const visible = (element: Element): boolean => {
          const candidate = element as HTMLElement;
          const style = window.getComputedStyle(candidate);
          return style.display !== "none"
            && style.visibility !== "hidden"
            && candidate.getClientRects().length > 0;
        };
        const visibleMenus: Element[] = [];
        for (const menu of menus) {
          if (visible(menu)) visibleMenus.push(menu);
        }
        const menu = visibleMenus[visibleMenus.length - 1];
        const items: HTMLElement[] = [];
        if (menu) {
          for (const candidate of menu.querySelectorAll<HTMLElement>(input.itemSelector)) {
            if (visible(candidate)) items.push(candidate);
          }
        }
        const choice = items[input.itemIndex];
        if (input.focus && choice) choice.focus({ preventScroll: true });
        return {
          open: Boolean(menu),
          checked: choice?.getAttribute("aria-checked") ?? null,
          count: items.length,
          focused: Boolean(choice && document.activeElement === choice),
        };
      }, {
        focus,
        itemIndex: mode.uiEffortIndex,
        itemSelector: CHATGPT_EFFORT_ITEM_SELECTOR,
      })
    );
    const effortReadyDeadline = Date.now() + 70_000;
    const remainingEffortReadyMs = (): number => Math.max(1, effortReadyDeadline - Date.now());
    const abortIfRequested = (): void => {
      assertChatGptTurnActive(page, abortSignal);
    };
    const waitForEffortChoice = async (timeout: number): Promise<boolean> => {
      try {
        await effortChoice().waitFor({ state: "visible", timeout });
        return true;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
        return false;
      }
    };
    const controlExpanded = async (): Promise<boolean> => (
      await currentEffort.getAttribute("aria-expanded", { timeout: 1_000 }).catch(() => null)
    ) === "true";
    const pickerIsOpen = async (): Promise<boolean> => {
      const state = await effortState();
      return state.open || await controlExpanded();
    };

    if (!await pickerIsOpen()) {
      await currentEffort.press("Enter", { timeout: remainingEffortReadyMs() });
      if (!await waitForEffortChoice(Math.min(2_500, remainingEffortReadyMs()))) {
        abortIfRequested();
        const recovered = recovery
          ? await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "effort selection", "open")
          : false;
const advanced = await this.advancedPickerState(
          page,
          mode.displayLabel,
        );
        if (advanced.advancedFound
          || advanced.effortControlFound
          || advanced.effortValueFound) {
          const selectedMode = await this.selectAdvancedModelAndEffort(page, currentEffort, mode, abortSignal);
          if (recovery) recovery.modelNeedsVerification = false;
          return selectedMode;
        }
        if (!recovered && Date.now() < effortReadyDeadline && !await pickerIsOpen()) {
          await this.resynchronizeEffortPicker(page, abortSignal, true, true);
        }
      }
    }

    const advancedLayout = await this.advancedPickerState(
      page,
      mode.displayLabel,
    );
    if (advancedLayout.advancedFound
      || advancedLayout.effortControlFound
      || advancedLayout.effortValueFound) {
      const selectedMode = await this.selectAdvancedModelAndEffort(page, currentEffort, mode, abortSignal);
      if (recovery) recovery.modelNeedsVerification = false;
      return selectedMode;
    }

    let selected = await effortState();
    if (selected.count === 0) {
const advanced = await this.advancedPickerState(
        page,
        mode.displayLabel,
      );
      if (advanced.advancedFound
        || advanced.effortControlFound
        || advanced.effortValueFound) {
        const selectedMode = await this.selectAdvancedModelAndEffort(page, currentEffort, mode, abortSignal);
        if (recovery) recovery.modelNeedsVerification = false;
        return selectedMode;
      }
    }
    for (let attempt = 0; attempt < 14 && selected.checked !== "true" && selected.checked !== "false"; attempt += 1) {
      abortIfRequested();
      if (recovery) {
        await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "effort selection", "open");
      }
      if (!selected.open && !await controlExpanded()) {
        await currentEffort.press("Enter", { timeout: Math.min(5_000, remainingEffortReadyMs()) });
      }
      await waitForEffortChoice(Math.min(5_000, remainingEffortReadyMs()));
      selected = await effortState();
      if (Date.now() >= effortReadyDeadline) break;
    }
    if (selected.checked !== "true" && selected.checked !== "false") {
      if (selected.count <= mode.uiEffortIndex) {
        throw new Error(
          `ChatGPT effort item index ${mode.uiEffortIndex} is unavailable`
          + `; available item count: ${selected.count}`,
        );
      }
      throw new Error(
        `ChatGPT effort item index ${mode.uiEffortIndex} has no semantic checked state`,
      );
    }
    if (selected.checked === "true") {
      await page.keyboard.press("Escape");
      if (recovery) recovery.modelNeedsVerification = false;
      return mode;
    }
    const focused = await effortState(true);
    if (focused.checked !== "false" || !focused.focused) {
      throw new Error(`ChatGPT effort item index ${mode.uiEffortIndex} could not be focused for selection`);
    }
    await page.keyboard.press("Enter");

    const deadline = Date.now() + 40_000;
    let confirmed: string | null = null;
    while (Date.now() < deadline) {
      abortIfRequested();
      if (recovery) {
        await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "effort confirmation", "open");
      }
      let state = await effortState();
      if (!state.open) {
        if (!await controlExpanded()) {
          await currentEffort.press("Enter", { timeout: Math.max(1, Math.min(5_000, deadline - Date.now())) });
        }
        await waitForEffortChoice(Math.max(1, Math.min(5_000, deadline - Date.now())));
        state = await effortState();
      }
      confirmed = state.checked;
      if (confirmed === "true") {
        await page.keyboard.press("Escape");
        if (recovery) recovery.modelNeedsVerification = false;
        return mode;
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error(
      `ChatGPT did not confirm effort item index ${mode.uiEffortIndex}`
      + ` (aria-checked=${JSON.stringify(confirmed)})`,
    );
  }

  private async activeComposer(
    page: Page,
    timeoutMs = 30_000,
    abortSignal?: AbortSignal,
  ): Promise<Locator> {
    const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    while (Date.now() < deadline) {
      if (abortSignal?.aborted) {
        throw new DOMException("ChatGPT web turn aborted", "AbortError");
      }
      count = await composers.count();
      if (count === 1) return composers.first();
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
    throw new Error(`ChatGPT did not expose exactly one visible composer (visibleComposers=${count})`);
  }

  private async currentSubmissionEvidence(
    page: Page,
    userTurns: Locator,
    responseTurns: Locator,
    initialUserTurnCount: number,
    initialResponseTurnCount: number,
  ): Promise<ChatGptSubmissionEvidence | undefined> {
    const visibleStopButtons = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true });
    const [userTurnCount, assistantTurnCount, visibleStopButtonCount] = await Promise.all([
      userTurns.count(),
      responseTurns.count(),
      visibleStopButtons.count(),
    ]);
    return chatGptSubmissionEvidence({
      initialUserTurnCount,
      userTurnCount,
      initialAssistantTurnCount: initialResponseTurnCount,
      assistantTurnCount,
      generationRunning: visibleStopButtonCount > 0,
    });
  }

  private async waitForSubmissionAccepted(
    page: Page,
    userTurns: Locator,
    responseTurns: Locator,
    initialUserTurnCount: number,
    initialResponseTurnCount: number,
    recovery: ChatGptTransientLimitRecoveryState,
    abortSignal?: AbortSignal,
  ): Promise<ChatGptSubmissionWaitResult> {
    for (;;) {
      assertChatGptTurnActive(page, abortSignal);
      const evidence = await this.currentSubmissionEvidence(
        page,
        userTurns,
        responseTurns,
        initialUserTurnCount,
        initialResponseTurnCount,
      );
      if (evidence) return evidence;
      if (await this.recoverTransientLimitDialogs(
        page,
        recovery,
        abortSignal,
        "submission acknowledgement",
        "close",
      )) {
        const evidenceAfterRecovery = await this.currentSubmissionEvidence(
          page,
          userTurns,
          responseTurns,
          initialUserTurnCount,
          initialResponseTurnCount,
        );
        return evidenceAfterRecovery ?? "transient_interruption";
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
  }

  private async waitForSubmissionEvidenceWithoutRetry(
    page: Page,
    userTurns: Locator,
    responseTurns: Locator,
    initialUserTurnCount: number,
    initialResponseTurnCount: number,
    recovery: ChatGptTransientLimitRecoveryState,
    abortSignal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence> {
    for (;;) {
      assertChatGptTurnActive(page, abortSignal);
      const evidence = await this.currentSubmissionEvidence(
        page,
        userTurns,
        responseTurns,
        initialUserTurnCount,
        initialResponseTurnCount,
      );
      if (evidence) return evidence;
      await this.recoverTransientLimitDialogs(
        page,
        recovery,
        abortSignal,
        "ambiguous submission acknowledgement",
        "best-effort-close",
      );
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
  }

  private async attachedPromptText(page: Page, abortSignal?: AbortSignal): Promise<string> {
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    return composer.evaluate(element => {
      const clone = element.cloneNode(true) as HTMLElement;
      const removable = clone.querySelectorAll(
        '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target]',
      );
      for (const part of removable) part.remove();
      const childTexts: string[] = [];
      for (const child of clone.childNodes) {
        childTexts.push(child.textContent ?? "");
      }
      let text = "";
      for (let i = 0; i < childTexts.length; i += 1) {
        if (i > 0) text += "\n";
        text += childTexts[i];
      }
      return text.trimStart();
    }, undefined, { timeout: 20_000 });
  }

  private async assertPromptAttached(
    page: Page,
    prompt: string,
    abortSignal?: AbortSignal,
    recovery?: ChatGptTransientLimitRecoveryState,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    let observed = "";
    while (Date.now() < deadline) {
      assertChatGptTurnActive(page, abortSignal);
      const dismissalsBefore = recovery?.dismissals;
      if (recovery) {
        await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "prompt verification", "close");
      }
      observed = await this.attachedPromptText(page, abortSignal);
      if (observed === prompt) return;
      if (dismissalsBefore !== undefined && recovery!.dismissals !== dismissalsBefore) break;
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
    const keywords = await selected.evaluateAll(elements => {
      const result: Array<string | null> = [];
      for (const element of elements) result.push(element.getAttribute("data-keyword"));
      return result;
    });
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
    abortSignal?: AbortSignal,
    recovery?: ChatGptTransientLimitRecoveryState,
  ): Promise<Locator> {
    if (recovery) {
      await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "connector selection", "close");
    }
    let composer = await this.activeComposer(page, 30_000, abortSignal);
    await composer.fill("");
    if (await this.connectorIsSelected(composer)) return composer;

    const menuRows = page.locator('.__menu-item[tabindex="0"]');
    const appResult = menuRows.filter({
      has: page.getByText(this.config.appName, { exact: true }),
    });
    const menuDeadline = Date.now() + 20_000;
    let triggerAttempts = 0;
    for (;;) {
      assertChatGptTurnActive(page, abortSignal);
      if (recovery) {
        await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "connector selection", "close");
      }
      triggerAttempts += 1;
      composer = await this.activeComposer(page, 30_000, abortSignal);
      await composer.fill("");
      await composer.focus();
      await settleChatGptUi();
      await composer.pressSequentially("@c", { delay: 25 });
      try {
        await appResult.waitFor({
          state: "visible",
          timeout: Math.min(2_500, Math.max(1, menuDeadline - Date.now())),
        });
        break;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
        if (Date.now() >= menuDeadline) {
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
    const selectedComposer = await this.activeComposer(page, 30_000, abortSignal);
    const selectedConnector = this.selectedConnectorControl(selectedComposer);
    await selectedConnector.waitFor({ state: "visible", timeout: 10_000 });
    if (!await this.connectorIsSelected(selectedComposer)) {
      throw new Error(`ChatGPT composer did not select ${JSON.stringify(this.config.appName)} connector`);
    }
    return selectedComposer;
  }

  private async attachPrompt(
    page: Page,
    prompt: string,
    localTools: boolean,
    abortSignal?: AbortSignal,
    recovery?: ChatGptTransientLimitRecoveryState,
  ): Promise<void> {
    if (recovery) {
      await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "prompt insertion", "close");
    }
    if (!localTools) {
      const composer = await this.activeComposer(page, 30_000, abortSignal);
      // Playwright's multiline fill maps through an input action that ChatGPT's Lexical editor can
      // collapse to the first paragraph on the launcher-owned Electron surface. Clear separately,
      // then transport the complete text in one CDP Input.insertText command.
      await composer.fill("");
      await composer.focus();
      await page.keyboard.insertText(prompt);
      await this.assertPromptAttached(page, prompt, abortSignal, recovery);
      return;
    }
    const selectedComposer = await this.selectConnector(page, abortSignal, recovery);
    await selectedComposer.focus();
    await page.keyboard.press("End");
    await page.keyboard.insertText(` ${prompt}`);
    await this.assertPromptAttached(page, prompt, abortSignal, recovery);
  }

  private async ensurePromptAndConnector(
    page: Page,
    prompt: string,
    localTools: boolean,
    recovery: ChatGptTransientLimitRecoveryState,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    for (let attempt = 0; attempt <= CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS; attempt += 1) {
      assertChatGptTurnActive(page, abortSignal);
      const dismissalsBefore = recovery.dismissals;
      await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "composer recovery", "close");
      const composer = await this.activeComposer(page, 30_000, abortSignal);
      const promptExact = await this.attachedPromptText(page, abortSignal) === prompt;
      const connectorExact = !localTools || await this.connectorIsSelected(composer);
      if (promptExact && connectorExact) return;
      try {
        await this.attachPrompt(page, prompt, localTools, abortSignal, recovery);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (recovery.dismissals === dismissalsBefore || attempt === CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS) throw error;
        continue;
      }
      const repairedComposer = await this.activeComposer(page, 30_000, abortSignal);
      if (await this.attachedPromptText(page, abortSignal) === prompt
        && (!localTools || await this.connectorIsSelected(repairedComposer))) return;
      if (recovery.dismissals === dismissalsBefore) break;
    }
    throw new Error("ChatGPT did not preserve the complete prompt and connector state after transient recovery");
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

  private async inspectFileInput(input: Locator): Promise<ChatGptFileInputCandidate | undefined> {
    const candidate = input as unknown as { evaluate?: unknown };
    // Existing unit-test doubles predate DOM inspection. Real Playwright locators always expose
    // evaluate; keeping this branch makes the transport change backward-compatible with them.
    if (typeof candidate.evaluate !== "function") return undefined;
    return input.evaluate(element => {
      const fileInput = element as HTMLInputElement;
      return {
        accept: fileInput.accept ?? "",
        dataTestId: fileInput.getAttribute("data-testid") ?? "",
        disabled: fileInput.disabled,
        multiple: fileInput.multiple,
      };
    }).catch(() => undefined);
  }

  private async compatibleFileInput(
    page: Page,
    files: readonly ChatGptPromptFilePayload[],
    abortSignal?: AbortSignal,
  ): Promise<Locator> {
    if (abortSignal?.aborted) {
      throw new DOMException("ChatGPT web turn aborted", "AbortError");
    }
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const roots = [
      composerForm.locator('input[type="file"]'),
      page.locator('input[type="file"]'),
    ];
    const diagnostics: string[] = [];
    for (const inputs of roots) {
      if (abortSignal?.aborted) {
        throw new DOMException("ChatGPT web turn aborted", "AbortError");
      }
      const count = await inputs.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        if (abortSignal?.aborted) {
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        const input = inputs.nth(index);
        const candidate = await this.inspectFileInput(input);
        if (!candidate) continue;
        diagnostics.push(
          `${candidate.dataTestId || "unnamed"}{accept=${candidate.accept || "*"},multiple=${candidate.multiple}}`,
        );
        if (chatGptFileInputAcceptsFiles(candidate, files)) return input;
      }
    }

    const mimeTypes = [...new Set(files.map(file => file.mimeType))].join(", ");
    throw new Error(
      `ChatGPT did not expose a compatible file input for ${mimeTypes}; refusing to use an image-only upload control`
      + (diagnostics.length > 0 ? ` (inputs=${diagnostics.join(" | ")})` : ""),
    );
  }

  private async attachmentAlerts(page: Page): Promise<string[]> {
    return (await page.locator('[role="alert"]').allInnerTexts().catch(() => []))
      .map(text => text.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  private async exactAttachmentTileVisible(composerForm: Locator, name: string): Promise<boolean> {
    const tile = composerForm.getByRole("group", { name, exact: true });
    const candidate = tile as unknown as {
      isVisible?: () => Promise<boolean>;
      waitFor?: (options: { state: "visible"; timeout: number }) => Promise<void>;
    };
    if (typeof candidate.isVisible === "function") {
      if (await candidate.isVisible().catch(() => false)) return true;
      return composerForm.getByText(name, { exact: true }).isVisible().catch(() => false);
    }
    if (typeof candidate.waitFor !== "function") return false;
    try {
      await candidate.waitFor({ state: "visible", timeout: 60_000 });
      return true;
    } catch {
      return false;
    }
  }

  private async selectedInputFileNames(input: Locator): Promise<string[]> {
    const candidate = input as unknown as { evaluate?: unknown };
    if (typeof candidate.evaluate !== "function") return [];
    return input.evaluate(element => {
      const files = (element as HTMLInputElement).files;
      const names: string[] = [];
      if (files) {
        for (let index = 0; index < files.length; index += 1) {
          names.push(files[index].name);
        }
      }
      return names;
    }).catch(() => []);
  }

  private async currentSendState(composerForm: Locator): Promise<Pick<
    ChatGptAttachmentReadiness,
    "sendVisible" | "sendEnabled" | "sendAriaDisabled"
  >> {
    let send = composerForm.getByTestId("send-button");
    const filterable = send as unknown as {
      filter?: (options: { visible: boolean }) => Locator;
      isVisible?: () => Promise<boolean>;
      getAttribute?: (name: string) => Promise<string | null>;
    };
    if (typeof filterable.filter === "function") send = filterable.filter({ visible: true }).last();
    const inspected = send as unknown as {
      isVisible?: () => Promise<boolean>;
      isEnabled: () => Promise<boolean>;
      getAttribute?: (name: string) => Promise<string | null>;
    };
    const sendVisible = typeof inspected.isVisible === "function"
      ? await inspected.isVisible().catch(() => false)
      : true;
    const sendEnabled = await inspected.isEnabled().catch(() => false);
    const sendAriaDisabled = typeof inspected.getAttribute === "function"
      ? await inspected.getAttribute("aria-disabled").catch(() => null)
      : null;
    return { sendVisible, sendEnabled, sendAriaDisabled };
  }

  private async waitForPromptAttachmentsReady(
    page: Page,
    input: Locator | undefined,
    files: readonly ChatGptPromptFilePayload[],
    abortSignal?: AbortSignal,
    recovery?: ChatGptTransientLimitRecoveryState,
  ): Promise<void> {
    const expectedNames = files.map(file => file.name);
    const deadline = Date.now() + 90_000;
    let exactInputNamePolls = 0;
    let last: ChatGptAttachmentReadiness = {
      exactTilesVisible: false,
      exactInputNamePolls: 0,
      sendVisible: false,
      sendEnabled: false,
      sendAriaDisabled: null,
    };

    while (Date.now() < deadline) {
      assertChatGptTurnActive(page, abortSignal);
      if (recovery) {
        await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "attachment readiness", "close");
      }
      const composer = await this.activeComposer(page, 1_000, abortSignal).catch(error => {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        return undefined;
      });
      if (!composer) {
        await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
        continue;
      }
      // ChatGPT can replace the form while mounting an attachment. Re-resolve it on every poll;
      // never keep polling the pre-upload form or its stale send button.
      const composerForm = composer.locator("xpath=ancestor::form[1]");
      const tiles = await Promise.all(
        expectedNames.map(name => this.exactAttachmentTileVisible(composerForm, name)),
      );
      const exactTilesVisible = tiles.every(Boolean);
      if (!exactTilesVisible) {
        const alerts = await this.attachmentAlerts(page);
        if (alerts.length > 0) {
          throw new Error(`ChatGPT did not accept all prompt attachments: ${alerts.join(" | ")}`);
        }
      }

      const inputNames = input ? await this.selectedInputFileNames(input) : [];
      exactInputNamePolls = sameExactFileNames(inputNames, expectedNames)
        ? exactInputNamePolls + 1
        : 0;
      const send = await this.currentSendState(composerForm);
      last = { exactTilesVisible, exactInputNamePolls, ...send };
      if (chatGptAttachmentsReady(last)) {
        assertChatGptTurnActive(page, abortSignal);
        return;
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }

    const alerts = await this.attachmentAlerts(page);
    throw new Error(
      "ChatGPT accepted the prompt attachments but did not make the message ready to send"
      + ` (tiles=${last.exactTilesVisible}, inputNamePolls=${last.exactInputNamePolls}, `
      + `sendVisible=${last.sendVisible}, sendEnabled=${last.sendEnabled}, `
      + `ariaDisabled=${last.sendAriaDisabled ?? "unset"})`
      + (alerts.length > 0 ? `: ${alerts.join(" | ")}` : ""),
    );
  }

  private async attachFiles(
    page: Page,
    prompt: CompiledChatGptWebPrompt,
    abortSignal?: AbortSignal,
    recovery?: ChatGptTransientLimitRecoveryState,
  ): Promise<void> {
    assertChatGptTurnActive(page, abortSignal);
    if (recovery) {
      await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "file upload", "close");
    }
    const files = chatGptPromptFilePayloads(prompt);
    let input = await this.compatibleFileInput(page, files, abortSignal);
    if (recovery && await this.recoverTransientLimitDialogs(
      page,
      recovery,
      abortSignal,
      "file upload",
      "close",
    )) {
      input = await this.compatibleFileInput(page, files, abortSignal);
    }
    assertChatGptTurnActive(page, abortSignal);
    await input.setInputFiles(files);
    await this.waitForPromptAttachmentsReady(page, input, files, abortSignal, recovery);
  }

  private async attachmentTileState(
    page: Page,
    files: readonly ChatGptPromptFilePayload[],
    abortSignal?: AbortSignal,
  ): Promise<{ visible: number; total: number }> {
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const visible = (await Promise.all(
      files.map(file => this.exactAttachmentTileVisible(composerForm, file.name)),
    )).filter(Boolean).length;
    return { visible, total: files.length };
  }

  private async ensureFilesAttached(
    page: Page,
    prompt: CompiledChatGptWebPrompt,
    recovery: ChatGptTransientLimitRecoveryState,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const files = chatGptPromptFilePayloads(prompt);
    for (let attempt = 0; attempt <= CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS; attempt += 1) {
      assertChatGptTurnActive(page, abortSignal);
      const dismissalsBefore = recovery.dismissals;
      await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "attachment recovery", "close");
      const tiles = await this.attachmentTileState(page, files, abortSignal);
      if (tiles.visible === tiles.total) {
        await this.waitForPromptAttachmentsReady(page, undefined, files, abortSignal, recovery);
        return;
      }
      if (tiles.visible > 0) {
        throw new Error(
          `ChatGPT preserved only ${tiles.visible} of ${tiles.total} prompt attachments after transient recovery; refusing a duplicate upload`,
        );
      }
      try {
        await this.attachFiles(page, prompt, abortSignal, recovery);
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (recovery.dismissals === dismissalsBefore || attempt === CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS) throw error;
      }
    }
  }

  private async ensureTurnReadyForSend(
    page: Page,
    prompt: CompiledChatGptWebPrompt,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
    mode: ChatGptWebModelMode,
    recovery: ChatGptTransientLimitRecoveryState,
    abortSignal?: AbortSignal,
  ): Promise<ChatGptWebModelMode> {
    let verifiedMode = mode;
    for (let attempt = 0; attempt <= CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS; attempt += 1) {
      await this.recoverTransientLimitDialogs(page, recovery, abortSignal, "before send", "close");
      if (recovery.modelNeedsVerification) {
        verifiedMode = await this.selectModelAndEffort(
          page,
          modelId,
          reasoning,
          capabilities,
          abortSignal,
          recovery,
        );
      }
      await this.ensurePromptAndConnector(page, prompt.text, verifiedMode.localTools, recovery, abortSignal);
      await this.ensureFilesAttached(page, prompt, recovery, abortSignal);
      if (!recovery.modelNeedsVerification && !recovery.pickerNeedsResync) return verifiedMode;
    }
    throw new Error("ChatGPT transient dialog kept interrupting final message-state verification");
  }

  private async handleToolConfirmation(page: Page): Promise<boolean> {
    const heading = page.getByText(`Allow ChatGPT to use ${this.config.appName}?`, { exact: true }).last();
    if (!await heading.isVisible().catch(() => false)) return false;
    if (!this.config.autoApproveToolCalls) {
      throw new Error(
        `ChatGPT is waiting for confirmation to use ${this.config.appName}; set chatgptWeb.autoApproveToolCalls=true to authorize per-call "Allow once" clicks`,
      );
    }
    const allowOnce = page.getByRole("button", { name: "Allow once", exact: true }).last();
    await allowOnce.waitFor({ state: "visible", timeout: 10_000 });
    await allowOnce.press("Enter");
    return true;
  }

  private async responseDomSnapshot(responseTurn: Locator, running: boolean): Promise<ChatGptResponseDomSnapshot> {
    let responseCount: number;
    try {
      responseCount = await responseTurn.count();
    } catch (error) {
      if (responseTurn.page().isClosed()) {
        throw new Error("ChatGPT browser tab was closed; the Codex turn was terminated");
      }
      throw new Error(`ChatGPT response lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (responseCount === 0) return absentResponseDomSnapshot();

    const snapshot = await responseTurn.evaluate((element, input) => {
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

      // ChatGPT can split one assistant answer into several sibling Markdown roots around
      // reasoning/status UI. Keep only top-level visible roots, then aggregate all of them in DOM
      // order so Codex receives the complete answer instead of only the trailing fragment.
      const renderedRoots: HTMLElement[] = [];
      for (const candidate of root.querySelectorAll<HTMLElement>(".markdown")) {
        if (candidate.parentElement?.closest(".markdown")) continue;
        if (!visible(candidate)) continue;
        renderedRoots.push(candidate);
      }
      const rendered = renderedRoots[renderedRoots.length - 1];
      const renderedChildren: HTMLElement[] = [];
      if (rendered) {
        for (let i = 0; i < rendered.children.length; i += 1) {
          renderedChildren.push(rendered.children[i] as HTMLElement);
        }
      }
      let completionAction: HTMLElement | undefined;
      if (rendered) {
        for (const candidate of root.querySelectorAll<HTMLElement>(input.completionActionSelector)) {
          if (!visible(candidate)) continue;
          if (rendered.contains(candidate)) continue;
          if (rendered.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING) {
            completionAction = candidate;
            break;
          }
        }
      }
      const completionActionSet = new Set<HTMLElement>();
      if (completionAction) completionActionSet.add(completionAction);
      const captureAnswer = !input.running || completionAction !== undefined;
      const candidates = new Map<HTMLElement, "markdown" | "status">();
      if (captureAnswer) {
        for (const candidate of renderedRoots) candidates.set(candidate, "markdown");
      }
      for (const candidate of root.querySelectorAll<HTMLElement>(
        'button, [role="status"], [aria-busy="true"], [data-testid*="cot"], [data-testid*="reason"], [data-testid*="thought"]',
      )) {
        if (completionActionSet.has(candidate)) continue;
        const semantic = candidate.closest<HTMLElement>("button") ?? candidate;
        if (!candidates.has(semantic)) candidates.set(semantic, "status");
      }
      for (const container of root.querySelectorAll<HTMLElement>("[data-streaming-response-status]")) {
        let containsCandidate = false;
        for (const candidate of candidates.keys()) {
          if (container.contains(candidate)) {
            containsCandidate = true;
            break;
          }
        }
        if (!containsCandidate) candidates.set(container, "status");
      }
      const traceEntries: Array<[HTMLElement, "markdown" | "status"]> = [];
      for (const entry of candidates) {
        if (visible(entry[0])) traceEntries.push(entry);
      }
      const orderedEntries: Array<[HTMLElement, "markdown" | "status"]> = [];
      for (const entry of traceEntries) {
        const [element] = entry;
        let inserted = false;
        for (let i = 0; i < orderedEntries.length; i += 1) {
          const [existing] = orderedEntries[i];
          const before = element === existing
            ? 0
            : element.compareDocumentPosition(existing) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
          if (before < 0) {
            const reordered: Array<[HTMLElement, "markdown" | "status"]> = [];
            for (let k = 0; k < i; k += 1) reordered.push(orderedEntries[k]);
            reordered.push(entry);
            for (let k = i; k < orderedEntries.length; k += 1) reordered.push(orderedEntries[k]);
            orderedEntries.length = 0;
            for (const reorderedEntry of reordered) orderedEntries.push(reorderedEntry);
            inserted = true;
            break;
          }
        }
        if (!inserted) orderedEntries.push(entry);
      }
      let traceBlocks: Array<{ kind: "markdown" | "status"; text: string }> = [];
      for (const [candidate, kind] of orderedEntries) {
        const text = candidate.innerText.trim();
        if (text.length === 0) continue;
        let duplicated = false;
        for (const block of traceBlocks) {
          if (block.kind === kind && block.text === text) {
            duplicated = true;
            break;
          }
        }
        if (!duplicated) traceBlocks.push({ kind, text });
      }
      if (!captureAnswer && root.textContent?.includes(input.compactionMarker)) {
        const withMarker: Array<{ kind: "markdown" | "status"; text: string }> = [
          { kind: "markdown", text: input.compactionMarker },
        ];
        for (const block of traceBlocks) withMarker.push(block);
        traceBlocks = withMarker;
      }
      let visibleText = "";
      let fullHtml = "";
      let stableHtml = "";
      if (captureAnswer) {
        const visibleTexts: string[] = [];
        for (const candidate of renderedRoots) {
          const text = candidate.innerText.trim();
          if (text.length > 0) visibleTexts.push(text);
          fullHtml += candidate.innerHTML;
        }
        for (let i = 0; i < visibleTexts.length; i += 1) {
          if (i > 0) visibleText += "\n\n";
          visibleText += visibleTexts[i];
        }
        for (let i = 0; i < renderedRoots.length - 1; i += 1) stableHtml += renderedRoots[i].innerHTML;
        for (let i = 0; i < renderedChildren.length - 1; i += 1) stableHtml += renderedChildren[i].outerHTML;
      }
      return {
        inspection: "ok" as const,
        responsePresent: true,
        visibleText,
        fullHtml,
        stableHtml,
        completionActionVisible: completionAction !== undefined,
        traceBlocks,
      };
}, {
      completionActionSelector: CHATGPT_COMPLETION_ACTION_SELECTOR,
      compactionMarker: CHATGPT_INTERNAL_COMPACTION_MARKER,
      running,
    }, { timeout: 2_000 }).catch((error: unknown) => {
      if (responseTurn.page().isClosed()) {
        throw new Error("ChatGPT browser tab was closed; the Codex turn was terminated");
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        return retryResponseDomSnapshot();
      }
      throw new Error(`ChatGPT response inspection failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    snapshot.traceBlocks = snapshot.traceBlocks.filter(block => !isChatGptTraceControl(block));
    return snapshot;
  }

  private async stalledTurnDiagnostic(page: Page, responseTurn: Locator): Promise<string> {
    const responseState = await responseTurn.count()
      ? await responseTurn.evaluate(element => {
        const root = element as HTMLElement;
        const collected: Array<Record<string, string | null>> = [];
        for (const candidate of root.querySelectorAll<HTMLElement>("[role], [data-testid], button, [aria-label]")) {
          const style = getComputedStyle(candidate);
          if (style.visibility === "hidden" || style.display === "none") continue;
          collected.push({
            tag: candidate.tagName.toLowerCase(),
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabel: candidate.getAttribute("aria-label"),
            title: candidate.getAttribute("title"),
            text: candidate.innerText.trim().slice(0, 500),
          });
        }
        const descriptors: Array<Record<string, string | null>> = [];
        for (let i = Math.max(0, collected.length - 80); i < collected.length; i += 1) {
          descriptors.push(collected[i]);
        }
        return {
          text: root.innerText.trim().slice(0, 2_000),
          descriptors,
        };
      })
      : { text: "", descriptors: [] };
    const overlays = await page.locator('[role="dialog"], [role="alert"], [role="status"]').evaluateAll(elements => {
      const collected: Array<Record<string, string | null>> = [];
      for (const element of elements) {
        const candidate = element as HTMLElement;
        const style = getComputedStyle(candidate);
        if (style.visibility === "hidden" || style.display === "none") continue;
        collected.push({
          role: candidate.getAttribute("role"),
          testId: candidate.getAttribute("data-testid"),
          ariaLabel: candidate.getAttribute("aria-label"),
          text: candidate.innerText.trim().slice(0, 1_000),
        });
      }
      const descriptors: Array<Record<string, string | null>> = [];
      for (let i = Math.max(0, collected.length - 30); i < collected.length; i += 1) {
        descriptors.push(collected[i]);
      }
      return descriptors;
    }).catch(() => [] as Array<Record<string, string | null>>);
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
    const prepared = await turn.prepare();
    let turnConnection: Browser | undefined;
    let managedPage: Page | undefined;
    let turnPage: Page | undefined;
    let messageDispatched = false;
    let generationCompleted = false;
    const recovery: ChatGptTransientLimitRecoveryState = {
      dismissals: 0,
      pickerNeedsResync: false,
      modelNeedsVerification: false,
    };
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(prepared, turn.modelId);
      const contextFileBytes = Buffer.byteLength(prepared.contextAttachment.text, "utf8");
      const attachmentCount = prepared.images.length + 1;
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
      }, turn.abortSignal);
      turnPage = page;
      if (!launcherSurfaceId) managedPage = page;
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=context-file, promptChars=${prepared.text.length}, contextFileBytes=${contextFileBytes}, estimatedInputTokens=${estimatedInputTokens}, attachments=${attachmentCount}, images=${prepared.images.length})`,
      );
      await this.runStage(turn.traceId, "temporary_chat_navigation", browserStageTimeouts.navigation, () => (
        page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).then(() => undefined)
      ), turn.abortSignal);
      await this.runStage(turn.traceId, "transient_dialog_recovery", browserStageTimeouts.composerReady, signal => (
        this.recoverTransientLimitDialogs(page, recovery, signal, "temporary chat navigation", "defer")
      ), turn.abortSignal);
      try {
        await this.runStage(turn.traceId, "composer_ready", browserStageTimeouts.composerReady, () => (
          this.activeComposer(page)
        ), turn.abortSignal);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new Error("ChatGPT web login is expired or the Temporary Chat surface is unavailable");
      }
      await this.runStage(turn.traceId, "session_verification", browserStageTimeouts.sessionVerification, async () => {
        await assertAuthenticatedChatGptPage(page);
        await assertTemporaryChatPage(page);
      }, turn.abortSignal);
      let mode = await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, signal => (
        this.selectModelAndEffort(page, turn.modelId, turn.reasoning, turn.capabilities, signal, recovery)
      ), turn.abortSignal);
      await this.runStage(turn.traceId, "prompt_attachment", browserStageTimeouts.promptAttachment, signal => (
        this.ensurePromptAndConnector(page, prepared.text, mode.localTools, recovery, signal)
      ), turn.abortSignal);
      await this.runStage(turn.traceId, "file_attachment", browserStageTimeouts.fileAttachment, async abortSignal => {
        if (recovery.modelNeedsVerification) {
          mode = await this.selectModelAndEffort(
            page,
            turn.modelId,
            turn.reasoning,
            turn.capabilities,
            abortSignal,
            recovery,
          );
        }
        await this.ensureFilesAttached(page, prepared, recovery, abortSignal);
        await this.ensurePromptAndConnector(page, prepared.text, mode.localTools, recovery, abortSignal);
      }, turn.abortSignal);
      const responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
      const initialResponseTurnCount = await responseTurns.count();
      const responseTurn = responseTurns.nth(initialResponseTurnCount);
      const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
      const initialUserTurnCount = await userTurns.count();
      let submissionEvidence: ChatGptSubmissionEvidence | undefined;
      for (let sendAttempt = 0; sendAttempt <= CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS; sendAttempt += 1) {
        await this.runStage(turn.traceId, "send", browserStageTimeouts.send, async abortSignal => {
          mode = await this.ensureTurnReadyForSend(
            page,
            prepared,
            turn.modelId,
            turn.reasoning,
            turn.capabilities,
            mode,
            recovery,
            abortSignal,
          );
          const composer = await this.activeComposer(page, 30_000, abortSignal);
          const sendButton = composer
            .locator("xpath=ancestor::form[1]")
            .getByTestId("send-button");
          await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
          if (!await sendButton.isEnabled()) {
            throw new Error("ChatGPT send button is disabled after the complete prompt was attached");
          }
          await settleChatGptUi();
          await sendButton.press("Enter");
          messageDispatched = true;
        }, turn.abortSignal);
        // Once Enter has been dispatched, retry only when the recognized blocking dialog was
        // actually dismissed before ChatGPT exposed conclusive submission evidence.
        const submissionResult = await this.waitForSubmissionAccepted(
          page,
          userTurns,
          responseTurns,
          initialUserTurnCount,
          initialResponseTurnCount,
          recovery,
          turn.abortSignal,
        );
        if (submissionResult !== "transient_interruption") {
          submissionEvidence = submissionResult;
          break;
        }
        const promptStillPresent = await this.attachedPromptText(page, turn.abortSignal).catch(error => {
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          return false as const;
        });
        if (promptStillPresent !== prepared.text) {
          submissionEvidence = await this.waitForSubmissionEvidenceWithoutRetry(
            page,
            userTurns,
            responseTurns,
            initialUserTurnCount,
            initialResponseTurnCount,
            recovery,
            turn.abortSignal,
          );
          break;
        }
        if (sendAttempt === CHATGPT_TRANSIENT_LIMIT_MAX_DISMISSALS) {
          throw new Error(
            `ChatGPT did not acknowledge the message after ${sendAttempt + 1} bounded send activation(s)`,
          );
        }
      }
      if (!submissionEvidence) throw new Error("ChatGPT did not expose submission evidence");
      console.info(`[chatgpt-web] browser turn ${turn.traceId} submission accepted evidence=${submissionEvidence}`);

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
        if (page.isClosed()) {
          throw new Error("ChatGPT browser tab was closed; the Codex turn was terminated");
        }
        if (turn.abortSignal?.aborted) {
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (Date.now() - lastHeartbeat >= 10_000) {
          turn.onHeartbeat?.();
          lastHeartbeat = Date.now();
        }

        if (mode.localTools && await this.handleToolConfirmation(page)) {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }

        if (await this.recoverTransientLimitDialogs(
          page,
          recovery,
          turn.abortSignal,
          "response collection",
          "best-effort-close",
        )) {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }

        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        const running = await stop.isVisible().catch(() => false);
        if (running) sawRunning = true;
        const snapshot = await this.responseDomSnapshot(responseTurn, running);
        if (snapshot.inspection === "retry") {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }
        if (snapshot.responsePresent) {
          for (const trace of visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
            if (trace.kind === "commentary") turn.onCommentary?.(trace.text, trace.continuation === true);
            else turn.onReasoningSummary?.(trace.text, trace.continuation === true);
          }
          const domError = domHealthTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            completionActionVisible: snapshot.completionActionVisible,
          });
          if (domError) throw new Error(domError);
          // Commit only when ChatGPT exposes response-scoped completion actions, but keep every
          // top-level Markdown root in that response as one final-answer stream.
          if (snapshot.completionActionVisible) {
            const stableDelta = markdownStream.observeStableHtml(snapshot.stableHtml);
            if (stableDelta) turn.onTextDelta(stableDelta);
          }
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
            const final = markdownStream.finish(snapshot.fullHtml);
            if (!final.markdown && snapshot.visibleText) {
              throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
            }
            if (final.delta) turn.onTextDelta(final.delta);
            finalText = final.markdown;
            generationCompleted = true;
            break;
          }
          if (!loggedCompletionWait && Date.now() - sentAt >= 30_000) {
            loggedCompletionWait = true;
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
      console.info(`[chatgpt-web] browser turn ${turn.traceId} completed (markdownChars=${finalText.length})`);
      return finalText;
    } finally {
      if (messageDispatched && !generationCompleted && turnPage && !turnPage.isClosed()) {
        const stop = turnPage.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        if (await stop.isVisible().catch(() => false)) {
          await stop.press("Enter", { timeout: 2_000 }).catch(() => {});
        }
      }
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
