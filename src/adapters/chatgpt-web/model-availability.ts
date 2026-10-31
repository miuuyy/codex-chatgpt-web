import type { Page, Request, Response } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapter-error";

/** Catalog entries advertise products, not remaining allowance. Only an explicit
 * startup restriction plus a matching fallback proves this pre-Send failure. */
export function chatGptReasoningLimitError(
  metadata: unknown, family: "5.6" | "6", effort: string, now = Date.now(),
): ChatGptWebAdapterError | undefined {
  if (!["medium", "high", "xhigh"].includes(effort) || !metadata || typeof metadata !== "object") return;
  const data = metadata as Record<string, unknown>;
  const requested = family === "6" ? "gpt-6-thinking" : "gpt-5-6-thinking";
  if (data.type !== "conversation_detail_metadata" || data.intended_default_model_slug !== requested
    || typeof data.default_model_slug !== "string" || data.default_model_slug === requested
    || !Array.isArray(data.blocked_features) || !Array.isArray(data.model_limits)) return;
  const restriction = data.blocked_features.find(item => item?.name === "reason"
    && typeof item.resets_after === "string" && Date.parse(item.resets_after) > now);
  const limit = data.model_limits.find(item => item?.model_slug === requested
    && typeof item.resets_after === "string" && Date.parse(item.resets_after) > now);
  if (!restriction || !limit) return;
  const reset = new Date(Math.max(Date.parse(restriction.resets_after), Date.parse(limit.resets_after))).toISOString();
  return new ChatGptWebAdapterError(
    `ChatGPT has limited GPT-${family} reasoning until ${reset} and is offering a fallback instead. `
    + "The requested model was not substituted and the pending message was not sent. "
    + "This does not establish the remaining Pro message allowance.",
    { status: 429, errorType: "rate_limit_error", code: "chatgpt_reasoning_limit", retryable: false },
  );
}

/** Passively observe only this page's own startup response. Never issue an API
 * request, inspect a different tab, or abort work after its Send is activated. */
export class ChatGptModelAvailabilityObserver {
  private page?: Page;
  private revision = 0;
  private metadata?: unknown;
  private family: "5.6" | "6";
  private effort: string;

  constructor(family: "5.6" | "6", effort: string, private readonly reject: (error: ChatGptWebAdapterError) => void) {
    this.family = family;
    this.effort = effort;
  }

  setMode(family: "5.6" | "6", effort: string): void {
    this.family = family;
    this.effort = effort;
    this.check();
  }

  private check(): void {
    if (!this.page) return;
    const error = chatGptReasoningLimitError(this.metadata, this.family, this.effort);
    if (error) this.reject(error);
  }

  private readonly onNavigation = (frame: import("playwright-core").Frame): void => {
    if (frame !== this.page?.mainFrame()) return;
    this.revision++;
    this.metadata = undefined;
  };

  private readonly onRequest = (request: Request): void => {
    if (request.method() !== "POST" || request.url() !== "https://chatgpt.com/backend-api/f/conversation") return;
    try {
      if (request.frame() === this.page?.mainFrame()) this.dispose();
    } catch { /* A detached/service-worker request cannot own this page's submission. */ }
  };

  private readonly onResponse = (response: Response): void => {
    const page = this.page;
    if (!page || response.url() !== "https://chatgpt.com/backend-api/conversation/init" || response.status() !== 200) return;
    try {
      if (response.request().frame() !== page.mainFrame()) return;
    } catch { return; }
    const revision = this.revision;
    void response.json().then(metadata => {
      if (this.page !== page || this.revision !== revision) return;
      this.metadata = metadata;
      this.check();
    }).catch(() => { /* Missing metadata is not quota evidence. DOM verification still applies. */ });
  };

  attach(page: Page): void {
    this.dispose();
    this.page = page;
    page.on("response", this.onResponse);
    page.on("request", this.onRequest);
    page.on("framenavigated", this.onNavigation);
  }

  dispose(): void {
    this.page?.off("response", this.onResponse);
    this.page?.off("request", this.onRequest);
    this.page?.off("framenavigated", this.onNavigation);
    this.page = undefined;
    this.metadata = undefined;
    this.revision++;
  }
}
