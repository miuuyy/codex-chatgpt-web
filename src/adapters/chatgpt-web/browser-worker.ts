import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { atomicWriteFile, expandUserPath, getConfigDir } from "../../config";
import type { ChatGptConversationRoute, CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";
import { ChatGptMarkdownStream } from "./markdown";
import { resolveChatGptWebModelMode, type ChatGptWebCapabilities, type ChatGptWebModelMode } from "./model";
import { CHATGPT_INTERNAL_COMPACTION_MARKER, CHATGPT_MAX_INPUT_IMAGES, containsChatGptCompactionMarker, stripChatGptTransportMarkers, type CompiledChatGptWebPrompt, type ChatGptWebPromptImage } from "./prompt";
import { estimateCompiledChatGptWebInputTokens } from "./usage";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_ASSISTANT_MESSAGE_ROOT_SELECTOR,
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
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { ChatGptRouteQueue, MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import { canonicalChatGptUrl } from "../../persistent-route";

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

export const DEFAULT_CHATGPT_TURN_TIMEOUT_MS = 40 * 60_000;
export const CHATGPT_RESPONSE_DOM_GRACE_MS = 60_000;
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000;
export const CHATGPT_COMPLETION_SETTLE_MS = 2_000;
/**
 * ChatGPT applies composer state asynchronously, and a fast host can reach the next step before the
 * editor has taken the previous one. This is headroom for that, not a readiness check.
 */
export const CHATGPT_UI_SETTLE_MS = 250;

const settleChatGptUi = (): Promise<void> => (
  new Promise(resolveSettle => setTimeout(resolveSettle, CHATGPT_UI_SETTLE_MS))
);

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
  capabilities: ChatGptWebCapabilities;
  conversationRoute?: ChatGptConversationRoute;
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
  turnTimeoutMs: number;
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

export interface ChatGptAssistantMessageSnapshot {
  identities: string[];
}

export function newChatGptAssistantMessageIdentity(
  before: ChatGptAssistantMessageSnapshot,
  after: ChatGptAssistantMessageSnapshot,
): string | undefined {
  if (after.identities.length !== before.identities.length + 1) return undefined;
  if (before.identities.some((identity, index) => after.identities[index] !== identity)) return undefined;
  const identity = after.identities.at(-1);
  if (!identity || before.identities.includes(identity)) return undefined;
  return identity;
}

export function sameChatGptAssistantMessageSnapshot(
  left: ChatGptAssistantMessageSnapshot,
  right: ChatGptAssistantMessageSnapshot,
): boolean {
  return left.identities.length === right.identities.length
    && left.identities.every((identity, index) => right.identities[index] === identity);
}

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
    turnTimeoutMs: configured.turnTimeoutMs ?? DEFAULT_CHATGPT_TURN_TIMEOUT_MS,
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
  private readonly routeQueue = new ChatGptRouteQueue();

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
    const execute = () => useHelper ? this.launcherHelper!.run(turn) : this.runExclusive(turn);
    const run = Promise.resolve().then(() => turn.conversationRoute
      ? this.routeQueue.run(turn.conversationRoute.conversationUrl, turn.abortSignal, execute)
      : execute());
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
    const effortMenu = page.locator(CHATGPT_EFFORT_MENU_SELECTOR).last();
    const menuVisible = await effortMenu.isVisible().catch(() => false);
    const menuExpanded = await currentEffort.getAttribute("aria-expanded").catch(() => null);
    if (!menuVisible && menuExpanded !== "true") await currentEffort.press("Enter");
    const effortChoices = effortMenu.locator(CHATGPT_EFFORT_ITEM_SELECTOR);
    const effortChoice = effortChoices.nth(mode.uiEffortIndex);
    try {
      await effortChoice.waitFor({ state: "visible", timeout: 70_000 });
    } catch {
      throw new Error(
        `ChatGPT effort item index ${mode.uiEffortIndex} is unavailable`
        + `; available item count: ${await effortChoices.count().catch(() => 0)}`,
      );
    }
    const selected = await effortChoice.getAttribute("aria-checked");
    if (selected !== "true" && selected !== "false") {
      throw new Error(`ChatGPT effort item index ${mode.uiEffortIndex} has no semantic checked state`);
    }
    if (selected === "true") {
      await page.keyboard.press("Escape");
      return mode;
    }
    await effortChoice.press("Enter");

    const deadline = Date.now() + 40_000;
    let confirmed: string | null = null;
    while (Date.now() < deadline) {
      if (!await effortMenu.isVisible().catch(() => false)) {
        const expanded = await currentEffort.getAttribute("aria-expanded").catch(() => null);
        if (expanded !== "true") await currentEffort.press("Enter");
        await effortChoice.waitFor({
          state: "visible",
          timeout: Math.max(1, Math.min(5_000, deadline - Date.now())),
        });
      }
      confirmed = await effortChoice.getAttribute("aria-checked");
      if (confirmed === "true") {
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

  private async assertConversationRoutePage(page: Page, route: ChatGptConversationRoute): Promise<void> {
    let currentUrl: string;
    try {
      currentUrl = canonicalChatGptUrl(page.url());
    } catch {
      throw new Error(`ChatGPT conversation route ${route.routeKey} is no longer active`);
    }
    if (currentUrl !== route.conversationUrl) {
      throw new Error(`ChatGPT conversation route ${route.routeKey} changed unexpectedly`);
    }
    await assertAuthenticatedChatGptPage(page);
    for (const [kind, label] of [
      ["Project", route.expectedProjectLabel],
      ["conversation", route.expectedConversationLabel],
    ] as const) {
      const matches = page.getByText(label, { exact: true }).filter({ visible: true });
      if (await matches.count() < 1) {
        throw new Error(`ChatGPT conversation route ${route.routeKey} did not expose its expected ${kind} label`);
      }
    }
  }

  private async assistantMessageSnapshot(page: Page): Promise<ChatGptAssistantMessageSnapshot> {
    const roots = page.locator(CHATGPT_ASSISTANT_MESSAGE_ROOT_SELECTOR);
    const identities = await roots.evaluateAll(elements => (
      elements.map(element => element.getAttribute("data-testid") ?? "")
    ));
    if (identities.some(identity => !identity) || new Set(identities).size !== identities.length) {
      throw new Error("ChatGPT assistant-message identities are missing or ambiguous");
    }
    return { identities };
  }

  private async waitForStableAssistantMessageSnapshot(
    page: Page,
    route: ChatGptConversationRoute,
    abortSignal: AbortSignal,
    intervalMs = 250,
    requiredStableTransitions = 5,
  ): Promise<ChatGptAssistantMessageSnapshot> {
    let previous = await this.assistantMessageSnapshot(page);
    let stableTransitions = 0;
    for (;;) {
      if (abortSignal.aborted) {
        throw new DOMException("ChatGPT assistant-message history stabilization aborted", "AbortError");
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, intervalMs));
      if (abortSignal.aborted) {
        throw new DOMException("ChatGPT assistant-message history stabilization aborted", "AbortError");
      }
      await this.assertConversationRoutePage(page, route);
      const current = await this.assistantMessageSnapshot(page);
      if (sameChatGptAssistantMessageSnapshot(previous, current)) stableTransitions += 1;
      else stableTransitions = 0;
      previous = current;
      if (stableTransitions >= requiredStableTransitions) return current;
    }
  }

  private async assertConversationComposerEmpty(page: Page, route: ChatGptConversationRoute): Promise<void> {
    if ((await this.attachedPromptText(page)).trim()) {
      throw new Error(`ChatGPT conversation route ${route.routeKey} has a pre-existing composer draft`);
    }
  }

  private async waitForNewAssistantMessage(
    page: Page,
    before: ChatGptAssistantMessageSnapshot,
    abortSignal: AbortSignal,
    route?: ChatGptConversationRoute,
  ): Promise<{ identity: string; turn: Locator }> {
    for (;;) {
      if (abortSignal.aborted) throw new DOMException("ChatGPT assistant-message binding aborted", "AbortError");
      if (route) await this.assertConversationRoutePage(page, route);
      const after = await this.assistantMessageSnapshot(page);
      const identity = newChatGptAssistantMessageIdentity(before, after);
      if (identity) return { identity, turn: page.getByTestId(identity) };
      if (after.identities.length > before.identities.length + 1
        || before.identities.some((value, index) => after.identities[index] !== value)) {
        throw new Error("ChatGPT assistant-message history changed ambiguously after submission");
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
    }
  }

  private async waitForSubmissionAccepted(
    page: Page,
    userTurns: Locator,
    responseTurns: Locator,
    initialUserTurnCount: number,
    initialResponseTurnCount: number,
  ): Promise<ChatGptSubmissionEvidence> {
    const visibleStopButtons = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).filter({ visible: true });
    for (;;) {
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

  private async selectConnector(page: Page): Promise<Locator> {
    let composer = await this.activeComposer(page);
    await composer.fill("");
    if (await this.connectorIsSelected(composer)) return composer;

    const menuRows = page.locator('.__menu-item[tabindex="0"]');
    const appResult = menuRows.filter({
      has: page.getByText(this.config.appName, { exact: true }),
    });
    const menuDeadline = Date.now() + 20_000;
    let triggerAttempts = 0;
    for (;;) {
      triggerAttempts += 1;
      composer = await this.activeComposer(page);
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
    const selectedComposer = await this.activeComposer(page);
    const selectedConnector = this.selectedConnectorControl(selectedComposer);
    await selectedConnector.waitFor({ state: "visible", timeout: 10_000 });
    if (!await this.connectorIsSelected(selectedComposer)) {
      throw new Error(`ChatGPT composer did not select ${JSON.stringify(this.config.appName)} connector`);
    }
    return selectedComposer;
  }

  private async attachPrompt(page: Page, prompt: string, localTools: boolean): Promise<void> {
    if (!localTools) {
      const composer = await this.activeComposer(page);
      // Playwright's multiline fill maps through an input action that ChatGPT's Lexical editor can
      // collapse to the first paragraph on the launcher-owned Electron surface. Clear separately,
      // then transport the complete text in one CDP Input.insertText command.
      await composer.fill("");
      await composer.focus();
      await page.keyboard.insertText(prompt);
      await this.assertPromptAttached(page, prompt);
      return;
    }
    const selectedComposer = await this.selectConnector(page);
    await selectedComposer.focus();
    await page.keyboard.press("End");
    await page.keyboard.insertText(` ${prompt}`);
    await this.assertPromptAttached(page, prompt);
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

      // ChatGPT can split one assistant answer into several sibling Markdown roots around
      // reasoning/status UI. Keep only top-level visible roots, then aggregate all of them in DOM
      // order so Codex receives the complete answer instead of only the trailing fragment.
      const renderedRoots = [...root.querySelectorAll<HTMLElement>(".markdown")]
        .filter(candidate => !candidate.parentElement?.closest(".markdown"))
        .filter(visible);
      const rendered = renderedRoots.at(-1);
      const renderedChildren = rendered ? [...rendered.children] : [];
      const completionAction = rendered
        ? [...root.querySelectorAll<HTMLElement>(completionActionSelector)]
          .filter(visible)
          .find(candidate => !rendered.contains(candidate)
            && Boolean(rendered.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
        : undefined;
      const completionActionSet = new Set(completionAction ? [completionAction] : []);
      const candidates = new Map<HTMLElement, "markdown" | "status">();
      renderedRoots.forEach(candidate => candidates.set(candidate, "markdown"));
      root.querySelectorAll<HTMLElement>(
        'button, [role="status"], [aria-busy="true"], [data-testid*="cot"], [data-testid*="reason"], [data-testid*="thought"]',
      ).forEach(candidate => {
        if (completionActionSet.has(candidate)) return;
        const semantic = candidate.closest<HTMLElement>("button") ?? candidate;
        if (!candidates.has(semantic)) candidates.set(semantic, "status");
      });
      root.querySelectorAll<HTMLElement>("[data-streaming-response-status]").forEach(container => {
        if (![...candidates.keys()].some(candidate => container.contains(candidate))) {
          candidates.set(container, "status");
        }
      });
      const traceBlocks = [...candidates]
        .filter(([candidate]) => visible(candidate))
        .sort(([left], [right]) => left === right
          ? 0
          : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        .map(([candidate, kind]) => ({ kind, text: candidate.innerText.trim() }))
        .filter(block => block.text.length > 0)
        .filter((block, index, blocks) => (
          blocks.findIndex(other => other.kind === block.kind && other.text === block.text) === index
        ));
      return {
        responsePresent: true,
        visibleText: renderedRoots.map(candidate => candidate.innerText.trim()).filter(Boolean).join("\n\n"),
        fullHtml: renderedRoots.map(candidate => candidate.innerHTML).join(""),
        stableHtml: [
          ...renderedRoots.slice(0, -1).map(candidate => candidate.innerHTML),
          ...renderedChildren.slice(0, -1).map(child => child.outerHTML),
        ].join(""),
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
            ariaLabel: candidate.getAttribute("aria-label"),
            title: candidate.getAttribute("title"),
            text: candidate.innerText.trim().slice(0, 500),
          }));
        return {
          text: root.innerText.trim().slice(0, 2_000),
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
            ariaLabel: candidate.getAttribute("aria-label"),
            text: candidate.innerText.trim().slice(0, 1_000),
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
    const prepared = await turn.prepare();
    let turnConnection: Browser | undefined;
    let managedPage: Page | undefined;
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(prepared, turn.modelId);
      const deadline = Date.now() + this.config.turnTimeoutMs;
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
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=inline, promptChars=${prepared.text.length}, estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length})`,
      );
      const targetUrl = turn.conversationRoute?.conversationUrl ?? CHATGPT_TEMPORARY_CHAT_URL;
      await this.runStage(
        turn.traceId,
        turn.conversationRoute ? "conversation_navigation" : "temporary_chat_navigation",
        browserStageTimeouts.navigation,
        () => page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).then(() => undefined),
      );
      try {
        await this.runStage(turn.traceId, "composer_ready", browserStageTimeouts.composerReady, () => (
          this.activeComposer(page)
        ));
      } catch {
        throw new Error(
          turn.conversationRoute
            ? `ChatGPT web login is expired or conversation route ${turn.conversationRoute.routeKey} is unavailable`
            : "ChatGPT web login is expired or the Temporary Chat surface is unavailable",
        );
      }
      await this.runStage(turn.traceId, "session_verification", browserStageTimeouts.sessionVerification, async () => {
        await assertAuthenticatedChatGptPage(page);
        if (turn.conversationRoute) await this.assertConversationRoutePage(page, turn.conversationRoute);
        else await assertTemporaryChatPage(page);
      });
      const mode = await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, () => (
        this.selectModelAndEffort(page, turn.modelId, turn.reasoning, turn.capabilities)
      ));
      if (turn.conversationRoute) await this.assertConversationRoutePage(page, turn.conversationRoute);
      const responseTurns = page.locator(CHATGPT_ASSISTANT_MESSAGE_ROOT_SELECTOR);
      const initialAssistantMessages = turn.conversationRoute
        ? await this.runStage(
          turn.traceId,
          "assistant_history_stability",
          15_000,
          signal => this.waitForStableAssistantMessageSnapshot(page, turn.conversationRoute!, signal),
        )
        : await this.assistantMessageSnapshot(page);
      if (turn.conversationRoute) await this.assertConversationComposerEmpty(page, turn.conversationRoute);
      await this.runStage(turn.traceId, "prompt_attachment", browserStageTimeouts.promptAttachment, () => (
        this.attachPrompt(page, prepared.text, mode.localTools)
      ));
      await this.runStage(turn.traceId, "file_attachment", browserStageTimeouts.fileAttachment, () => (
        this.attachFiles(page, prepared)
      ));
      const preparedAssistantMessages = await this.assistantMessageSnapshot(page);
      if (!sameChatGptAssistantMessageSnapshot(initialAssistantMessages, preparedAssistantMessages)) {
        throw new Error("ChatGPT assistant-message history changed while the new prompt was being prepared");
      }
      const initialResponseTurnCount = initialAssistantMessages.identities.length;
      const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
      const initialUserTurnCount = await userTurns.count();
      if (turn.conversationRoute) await this.assertConversationRoutePage(page, turn.conversationRoute);
      await this.runStage(turn.traceId, "send", browserStageTimeouts.send, async () => {
        const composer = await this.activeComposer(page);
        const sendButton = composer
          .locator("xpath=ancestor::form[1]")
          .getByTestId("send-button");
        await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
        if (!await sendButton.isEnabled()) {
          throw new Error("ChatGPT send button is disabled after the complete prompt was attached");
        }
        await settleChatGptUi();
        await sendButton.press("Enter");
        const evidence = await this.waitForSubmissionAccepted(
          page,
          userTurns,
          responseTurns,
          initialUserTurnCount,
          initialResponseTurnCount,
        );
        console.info(`[chatgpt-web] browser turn ${turn.traceId} submission accepted evidence=${evidence}`);
      });
      const boundResponse = await this.runStage(
        turn.traceId,
        "response_binding",
        CHATGPT_RESPONSE_DOM_GRACE_MS,
        signal => this.waitForNewAssistantMessage(page, initialAssistantMessages, signal, turn.conversationRoute),
      );
      const responseTurn = boundResponse.turn;
      console.info(`[chatgpt-web] browser turn ${turn.traceId} response bound identity=${boundResponse.identity}`);

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
          const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
          if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (Date.now() >= deadline) throw new Error("ChatGPT web turn timed out");
        if (turn.conversationRoute) await this.assertConversationRoutePage(page, turn.conversationRoute);
        if (Date.now() - lastHeartbeat >= 10_000) {
          turn.onHeartbeat?.();
          lastHeartbeat = Date.now();
        }

        if (mode.localTools && await this.handleToolConfirmation(page)) {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }

        const snapshot = await this.responseDomSnapshot(responseTurn);
        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        const running = await stop.isVisible().catch(() => false);
        if (running) sawRunning = true;
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

      if (turn.conversationRoute) await this.assertConversationRoutePage(page, turn.conversationRoute);
      if (this.context && this.config.browserHost === "managed-chrome") {
        const state = await this.context.storageState();
        atomicWriteFile(this.config.storageStatePath, `${JSON.stringify(state)}\n`);
      }
      console.info(`[chatgpt-web] browser turn ${turn.traceId} completed (markdownChars=${finalText.length})`);
      return finalText;
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
