/**
 * ChatGPT Web concurrency is deliberately bounded. Every active Codex turn owns a real
 * browser document in the signed-in account, so unbounded fan-out would create account-level
 * traffic that is indistinguishable from spam.
 */
export const MAX_CHATGPT_BROWSER_TABS = 5;

/** FIFO serialization for stateful Project conversations; unrelated routes remain concurrent. */
export class ChatGptRouteQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const execution = previous.catch(() => {}).then(async () => {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted while queued", "AbortError");
      return task();
    });
    const tail = execution.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    if (!signal) return execution;
    if (signal.aborted) return Promise.reject(new DOMException("ChatGPT web turn aborted while queued", "AbortError"));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("ChatGPT web turn aborted while queued", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      void execution.then(
        value => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        error => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }
}
