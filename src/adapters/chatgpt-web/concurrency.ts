/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam.
 */
export const MAX_CHATGPT_BROWSER_TABS = 5;

type ReleaseSlot = () => void;

interface QueuedSlot {
  resolve: (release: ReleaseSlot) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Browser workers are cached by configuration, but multiple adapters and Codex requests can still
 * share the process. Queueing at this boundary keeps the account-wide limit meaningful and avoids
 * turning ordinary fan-out into an avoidable upstream failure.
 */
export class ChatGptBrowserConcurrency {
  private active = 0;
  private readonly queued: QueuedSlot[] = [];

  acquire(signal?: AbortSignal): Promise<ReleaseSlot> {
    if (signal?.aborted) return Promise.reject(this.abortError());
    if (this.active < MAX_CHATGPT_BROWSER_TABS && this.queued.length === 0) {
      this.active += 1;
      return Promise.resolve(this.releaseSlot());
    }
    return new Promise<ReleaseSlot>((resolve, reject) => {
      const entry: QueuedSlot = { resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        entry.onAbort = () => {
          const index = this.queued.indexOf(entry);
          if (index >= 0) this.queued.splice(index, 1);
          reject(this.abortError());
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.queued.push(entry);
    });
  }

  activeCount(): number {
    return this.active;
  }

  queuedCount(): number {
    return this.queued.length;
  }

  private releaseSlot(): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.pump();
    };
  }

  private pump(): void {
    while (this.active < MAX_CHATGPT_BROWSER_TABS && this.queued.length > 0) {
      const entry = this.queued.shift()!;
      if (entry.signal?.aborted) {
        entry.reject(this.abortError());
        continue;
      }
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
      this.active += 1;
      entry.resolve(this.releaseSlot());
    }
  }

  private abortError(): DOMException {
    return new DOMException("ChatGPT browser turn queue wait aborted", "AbortError");
  }
}

export const chatGptBrowserConcurrency = new ChatGptBrowserConcurrency();
