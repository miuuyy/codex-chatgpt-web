import type { Locator } from "playwright-core";
import { ChatGptWebAdapterError } from "./adapter-error";

export async function throwIfChatGptThinkingFailed(turn: Locator): Promise<void> {
  const failed = await turn.evaluate(root => Array.from(root.querySelectorAll('[class~="group/activity-header"]'))
    .some(header => {
      if (header.closest('[data-user-message-bubble], [data-markdown-text-style="assistant-message"], pre, code, blockquote')) return false;
      const bounds = header.getBoundingClientRect();
      return header.isConnected && getComputedStyle(header).visibility !== "hidden"
        && (bounds.width > 0 || bounds.height > 0)
        && Array.from(header.querySelectorAll("span")).some(label => {
          const labelBounds = label.getBoundingClientRect();
          return label.children.length === 0 && getComputedStyle(label).visibility !== "hidden"
            && (labelBounds.width > 0 || labelBounds.height > 0)
            && label.textContent?.trim() === "O pensamento falhou";
        });
    }), undefined, { timeout: 2_000 });
  if (failed) throw new ChatGptWebAdapterError(
    "ChatGPT reported 'O pensamento falhou' (thinking failed) for this response. The response did not complete; review any tool results before retrying.",
    { status: 502, errorType: "server_error", code: "chatgpt_thinking_failed", retryable: false },
  );
}

/** The observed Portuguese review card can precede the assistant heading entirely. */
export async function waitForChatGptConnectorReview(
  turn: Locator,
  appName: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  onVisible?: () => Promise<void>,
): Promise<boolean> {
  const pending = () => turn.evaluate((root, name) => {
    const visible = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return element.isConnected && getComputedStyle(element).visibility !== "hidden"
        && (bounds.width > 0 || bounds.height > 0);
    };
    const label = (element: Element) => element.textContent?.replace(/\s+/g, " ").trim();
    return Array.from(root.querySelectorAll('[role="alert"]')).filter(card => {
      // User content and rendered answers cannot request a connector permission.
      if (card.closest('[data-user-message-bubble], [data-markdown-text-style="assistant-message"]')
        || !visible(card)) return false;
      const heading = `Permitir que o ChatGPT use ${name}?`;
      if (!Array.from(card.querySelectorAll("*")).some(element => label(element) === heading)) return false;
      const buttons = Array.from(card.querySelectorAll("button")).filter(visible);
      return buttons.filter(button => label(button) === "Permitir uma vez").length === 1
        && buttons.filter(button => label(button) === "Negar").length === 1;
    }).length;
  }, appName, { timeout: 2_000 });
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
  };
  checkAbort();
  const count = await pending();
  checkAbort();
  if (!count) return false;
  if (count !== 1) throw new ChatGptWebAdapterError(
    "ChatGPT exposed multiple connector review cards for this turn. Review the request in the launcher browser.",
    { status: 409, errorType: "invalid_request_error", code: "connector_review_ambiguous", retryable: false },
  );
  const deadline = Date.now() + Math.max(0, timeoutMs);
  await onVisible?.();
  // This observed card includes security review. Never activate Allow once, Always allow,
  // or Deny automatically, even when ordinary connector auto-approval is configured.
  for (;;) {
    checkAbort();
    const remaining = await pending();
    checkAbort();
    if (!remaining) return true; // The normal response/broker checks still decide completion.
    if (Date.now() >= deadline) throw new ChatGptWebAdapterError(
      "ChatGPT is waiting for a manual connector approval, not a model response. No decision was received before the review deadline. On retry, review the request in the launcher browser.",
      { status: 409, errorType: "invalid_request_error", code: "connector_review_required", retryable: false },
    );
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
}
