export type ChatGptBrowserTurnLane = "exclusive" | "ultra";

interface PendingTurn<T> {
  lane: ChatGptBrowserTurnLane;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface ChatGptBrowserTurnPoolState {
  active: number;
  queued: number;
  exclusive: boolean;
}

function abortError(): DOMException {
  return new DOMException("ChatGPT web turn aborted", "AbortError");
}

/**
 * Normal ChatGPT Web turns keep exclusive browser access. Ultra turns may share
 * the authenticated profile, but each running task owns a separate CDP page.
 */
export class ChatGptBrowserTurnPool {
  private readonly queue: PendingTurn<unknown>[] = [];
  private readonly idleWaiters = new Set<() => void>();
  private activeUltra = 0;
  private exclusiveActive = false;

  constructor(private readonly maxUltraTurns: number) {
    if (!Number.isSafeInteger(maxUltraTurns) || maxUltraTurns < 1) {
      throw new Error("ChatGPT browser Ultra concurrency must be a positive integer");
    }
  }

  state(): ChatGptBrowserTurnPoolState {
    return {
      active: this.activeUltra + (this.exclusiveActive ? 1 : 0),
      queued: this.queue.length,
      exclusive: this.exclusiveActive,
    };
  }

  run<T>(lane: ChatGptBrowserTurnLane, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const pending: PendingTurn<T> = { lane, run: task, resolve, reject, signal };
      if (signal) {
        pending.onAbort = () => {
          const index = this.queue.indexOf(pending as PendingTurn<unknown>);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(abortError());
          this.notifyIdle();
          this.drain();
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.queue.push(pending as PendingTurn<unknown>);
      this.drain();
    });
  }

  waitForIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  private isIdle(): boolean {
    return !this.exclusiveActive && this.activeUltra === 0 && this.queue.length === 0;
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private drain(): void {
    if (this.exclusiveActive) return;
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      if (next.lane === "exclusive") {
        if (this.activeUltra > 0) return;
        this.queue.shift();
        this.start(next, true);
        return;
      }
      if (this.activeUltra >= this.maxUltraTurns) return;
      this.queue.shift();
      this.start(next, false);
    }
    this.notifyIdle();
  }

  private start(turn: PendingTurn<unknown>, exclusive: boolean): void {
    if (turn.signal && turn.onAbort) {
      turn.signal.removeEventListener("abort", turn.onAbort);
    }
    if (exclusive) this.exclusiveActive = true;
    else this.activeUltra += 1;
    void Promise.resolve()
      .then(turn.run)
      .then(turn.resolve, turn.reject)
      .finally(() => {
        if (exclusive) this.exclusiveActive = false;
        else this.activeUltra -= 1;
        this.drain();
        this.notifyIdle();
      });
  }
}
