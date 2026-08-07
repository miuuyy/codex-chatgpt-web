import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { notifyLauncherTurn, readLauncherBrowserHostDescriptor } from "../../launcher-browser-host";
import type { CompiledChatGptWebPrompt } from "./prompt";
import type { BrowserTurn, ResolvedBrowserConfig } from "./browser-worker";
import {
  CHATGPT_CAPACITY_ERROR_CODE,
  ChatGptCapacityError,
} from "./capacity-error";
import {
  CHATGPT_TRANSIENT_LIMIT_ERROR_CODE,
  ChatGptTransientLimitError,
} from "./transient-limit-error";

interface PendingTurn {
  turn: BrowserTurn;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  abortListener?: () => void;
  sent?: boolean;
}

function browserHelperArtifactFingerprint(executable: string, script: string): string {
  return createHash("sha256")
    .update(executable)
    .update("\0")
    .update(script)
    .update("\0")
    .update(readFileSync(script))
    .digest("hex");
}

type HelperMessage =
  | { type: "ready" }
  | { type: "event"; id: string; event: "heartbeat" | "reasoning" | "commentary" | "text"; text?: string; continuation?: boolean }
  | { type: "result"; id: string; text: string }
  | {
    type: "error";
    id: string;
    name?: string;
    message: string;
    code?: typeof CHATGPT_TRANSIENT_LIMIT_ERROR_CODE | typeof CHATGPT_CAPACITY_ERROR_CODE;
    stage?: string;
    dismissals?: number;
  };

export function parseLauncherBrowserHelperMessage(line: string): HelperMessage {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Launcher browser helper message is not an object");
  }
  const message = value as Record<string, unknown>;
  if (message.type === "ready") return { type: "ready" };
  if (typeof message.id !== "string" || !message.id) {
    throw new Error("Launcher browser helper message has no turn identity");
  }
  if (message.type === "event") {
    const event = message.event;
    const text = message.text;
    const continuation = message.continuation;
    if (!["heartbeat", "reasoning", "commentary", "text"].includes(String(event))) {
      throw new Error("Launcher browser helper emitted an unknown event");
    }
    if (text !== undefined && typeof text !== "string") {
      throw new Error("Launcher browser helper event text is invalid");
    }
    if (continuation !== undefined && typeof continuation !== "boolean") {
      throw new Error("Launcher browser helper continuation flag is invalid");
    }
    return {
      type: "event",
      id: message.id,
      event: event as "heartbeat" | "reasoning" | "commentary" | "text",
      ...(text !== undefined ? { text: text as string } : {}),
      ...(continuation !== undefined ? { continuation: continuation as boolean } : {}),
    };
  }
  if (message.type === "result") {
    const text = message.text;
    if (typeof text !== "string") {
      throw new Error("Launcher browser helper result text is invalid");
    }
    return { type: "result", id: message.id, text };
  }
  if (message.type === "error") {
    const errorMessage = message.message;
    const errorName = message.name;
    const errorCode = message.code;
    const stage = message.stage;
    const dismissals = message.dismissals;
    if (typeof errorMessage !== "string"
      || (errorName !== undefined && typeof errorName !== "string")
      || (errorCode !== undefined && typeof errorCode !== "string")) {
      throw new Error("Launcher browser helper error payload is invalid");
    }
    if (errorCode === CHATGPT_TRANSIENT_LIMIT_ERROR_CODE) {
      if (typeof stage !== "string"
        || stage.trim().length === 0
        || !Number.isSafeInteger(dismissals)
        || (dismissals as number) < 0) {
        throw new Error("Launcher browser helper transient-limit payload is invalid");
      }
      return {
        type: "error",
        id: message.id,
        message: errorMessage,
        ...(errorName !== undefined ? { name: errorName as string } : {}),
        code: CHATGPT_TRANSIENT_LIMIT_ERROR_CODE,
        stage,
        dismissals: dismissals as number,
      };
    }
    if (errorCode === CHATGPT_CAPACITY_ERROR_CODE) {
      if (typeof stage !== "string" || stage.trim().length === 0 || dismissals !== undefined) {
        throw new Error("Launcher browser helper capacity payload is invalid");
      }
      return {
        type: "error",
        id: message.id,
        message: errorMessage,
        ...(errorName !== undefined ? { name: errorName as string } : {}),
        code: CHATGPT_CAPACITY_ERROR_CODE,
        stage,
      };
    }
    if (stage !== undefined || dismissals !== undefined) {
      throw new Error("Launcher browser helper error metadata is invalid");
    }
    return {
      type: "error",
      id: message.id,
      message: errorMessage,
      ...(errorName !== undefined ? { name: errorName as string } : {}),
    };
  }
  throw new Error("Launcher browser helper emitted an unknown message type");
}

export class LauncherBrowserHelperClient {
  private child?: ChildProcessWithoutNullStreams;
  private childFingerprint?: string;
  private requestedFingerprint?: string;
  private recyclePromise?: Promise<void>;
  private recycleDrainResolve?: () => void;
  private dispatchTail: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;
  private closing = false;
  private ready?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private readonly pending = new Map<string, PendingTurn>();

  constructor(private readonly config: ResolvedBrowserConfig) {}

  async run(turn: BrowserTurn): Promise<string> {
    if (this.closing || turn.abortSignal?.aborted) {
      throw new DOMException("ChatGPT web turn aborted", "AbortError");
    }
    const prepared = await turn.prepare();
    try {
      const { result } = await this.withDispatchLock(async () => {
        if (this.closing) throw new DOMException("Launcher browser helper is closing", "AbortError");
        await this.ensureChild();
        if (this.closing || turn.abortSignal?.aborted) {
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        return {
          result: new Promise<string>((resolveResult, rejectResult) => {
            if (this.pending.has(turn.traceId)) {
              rejectResult(new Error(`Duplicate launcher browser turn: ${turn.traceId}`));
              return;
            }
            const pending: PendingTurn = { turn, resolve: resolveResult, reject: rejectResult };
            this.pending.set(turn.traceId, pending);
            if (turn.abortSignal) {
              const abortListener = () => {
                if (!pending.sent) {
                  this.finishWithError(
                    turn.traceId,
                    new DOMException("ChatGPT web turn aborted", "AbortError"),
                  );
                  return;
                }
                void this.send({ type: "abort", id: turn.traceId }).catch(error => {
                  this.finishWithError(
                    turn.traceId,
                    error instanceof Error ? error : new Error(String(error)),
                  );
                });
              };
              pending.abortListener = abortListener;
              turn.abortSignal.addEventListener("abort", abortListener, { once: true });
              if (turn.abortSignal.aborted) {
                abortListener();
                return;
              }
            }
            // Setting this before the synchronous write call makes an abort either prevent dispatch or
            // queue an `abort` after the `run` frame; it can never overtake the run frame in the pipe.
            pending.sent = true;
            void this.send({
              type: "run",
              id: turn.traceId,
              config: {
                appName: this.config.appName,
                browserHostDescriptorPath: this.config.browserHostDescriptorPath!,
                autoApproveToolCalls: this.config.autoApproveToolCalls,
              },
              turn: {
                traceId: turn.traceId,
                modelId: turn.modelId,
                reasoning: turn.reasoning,
                capabilities: turn.capabilities,
                prepared: {
                  text: prepared.text,
                  images: prepared.images,
                  contextAttachment: prepared.contextAttachment,
                } satisfies CompiledChatGptWebPrompt,
              },
            }).catch(error => this.finishWithError(turn.traceId, error instanceof Error ? error : new Error(String(error))));
          }),
        };
      });
      return await result;
    } finally {
      prepared.release();
    }
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeNow();
    await this.closePromise;
  }

  private async closeNow(): Promise<void> {
    this.closing = true;
    for (const id of [...this.pending.keys()]) {
      this.finishWithError(id, new DOMException("Launcher browser helper is closing", "AbortError"));
    }
    await this.dispatchTail;
    await this.recyclePromise?.catch(() => {});
    const child = this.child;
    this.child = undefined;
    this.childFingerprint = undefined;
    this.requestedFingerprint = undefined;
    this.recycleDrainResolve = undefined;
    this.ready = undefined;
    this.readyResolve = undefined;
    this.readyReject = undefined;
    if (!child) return;
    await this.sendTo(child, { type: "shutdown" }).catch(() => {});
    await this.terminateChild(child, 2_000);
  }

  private async withDispatchLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.dispatchTail;
    let release!: () => void;
    this.dispatchTail = new Promise<void>(resolveRelease => { release = resolveRelease; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async ensureChild(): Promise<void> {
    if (this.closing) throw new DOMException("Launcher browser helper is closing", "AbortError");
    await this.recyclePromise;
    if (this.closing) throw new DOMException("Launcher browser helper is closing", "AbortError");
    const descriptor = readLauncherBrowserHostDescriptor(this.config.browserHostDescriptorPath!);
    const fingerprint = browserHelperArtifactFingerprint(
      descriptor.helper.executable,
      descriptor.helper.script,
    );
    if (this.child
      && !this.child.killed
      && this.child.exitCode === null
      && this.child.signalCode === null
      && this.ready) {
      if (this.childFingerprint !== fingerprint) {
        this.requestedFingerprint = fingerprint;
        await this.beginStaleRecycle(this.child);
        return this.ensureChild();
      }
      return this.ready;
    }
    const child = spawn(descriptor.helper.executable, [descriptor.helper.script], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.childFingerprint = fingerprint;
    this.requestedFingerprint = undefined;
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
    });
    const output = createInterface({ input: child.stdout });
    output.on("line", line => this.handleLine(child, line));
    const errors = createInterface({ input: child.stderr });
    errors.on("line", line => console.info(`[chatgpt-web-helper] ${line}`));
    const failChild = (error: Error) => {
      const owned = this.child === child;
      this.handleExit(child, error);
      if (owned && Number.isInteger(child.pid) && child.exitCode === null && child.signalCode === null) {
        void this.terminateChild(child, 0).catch(cleanupError => {
          console.error(
            `[chatgpt-web-helper] process-error cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        });
      }
    };
    child.once("error", failChild);
    child.stdin.once("error", error => failChild(new Error(
      `Launcher browser helper input failed: ${error instanceof Error ? error.message : String(error)}`,
    )));
    child.once("exit", (code, signal) => this.handleExit(child, new Error(
      `Launcher browser helper exited ${signal ? `from signal ${signal}` : `with status ${code ?? 1}`}`,
    )));
    const timer = setTimeout(() => {
      if (this.child === child) this.readyReject?.(new Error("Launcher browser helper did not become ready"));
    }, 15_000);
    try {
      await this.ready;
    } catch (error) {
      if (this.child === child) {
        this.child = undefined;
        this.childFingerprint = undefined;
        this.ready = undefined;
        this.readyResolve = undefined;
        this.readyReject = undefined;
      }
      try {
        await this.terminateChild(child, 500);
      } catch (cleanupError) {
        const primary = error instanceof Error ? error.message : String(error);
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${primary}; launcher browser helper cleanup failed: ${cleanup}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private beginStaleRecycle(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.recyclePromise) return this.recyclePromise;
    const drain = this.pending.size === 0
      ? Promise.resolve()
      : new Promise<void>(resolveDrain => { this.recycleDrainResolve = resolveDrain; });
    const recycle = drain
      .then(() => this.recycleIdleChild(child))
      .finally(() => {
        if (this.recyclePromise === recycle) this.recyclePromise = undefined;
        this.recycleDrainResolve = undefined;
      });
    this.recyclePromise = recycle;
    return recycle;
  }

  private async recycleIdleChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.child !== child || this.pending.size > 0) return;
    await this.sendTo(child, { type: "shutdown" }).catch(() => {});
    await this.terminateChild(child, 2_000);
    if (this.child === child) {
      this.child = undefined;
      this.childFingerprint = undefined;
      this.requestedFingerprint = undefined;
      this.ready = undefined;
      this.readyResolve = undefined;
      this.readyReject = undefined;
    }
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) return;
    let message: HelperMessage;
    try { message = parseLauncherBrowserHelperMessage(line); }
    catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.handleExit(child, new Error(`Launcher browser helper emitted invalid protocol data: ${detail}`));
      void this.terminateChild(child, 0).catch(error => {
        console.error(`[chatgpt-web-helper] invalid-protocol cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    if (message.type === "ready") {
      this.readyResolve?.();
      this.readyResolve = undefined;
      this.readyReject = undefined;
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "event") {
      if (message.event === "heartbeat") pending.turn.onHeartbeat?.();
      else if (message.event === "reasoning" && message.text) {
        pending.turn.onReasoningSummary?.(message.text, message.continuation === true);
      }
      else if (message.event === "commentary" && message.text) pending.turn.onCommentary?.(message.text, message.continuation === true);
      else if (message.event === "text" && message.text) pending.turn.onTextDelta(message.text);
      return;
    }
    if (message.type === "result") {
      this.finish(message.id);
      pending.resolve(message.text);
    } else if (message.type === "error") {
      const error = message.code === CHATGPT_TRANSIENT_LIMIT_ERROR_CODE
        ? new ChatGptTransientLimitError(message.stage!, message.dismissals!)
        : message.code === CHATGPT_CAPACITY_ERROR_CODE
          ? new ChatGptCapacityError(message.stage!)
          : message.name === "AbortError"
            ? new DOMException(message.message, "AbortError")
            : new Error(message.message);
      this.finish(message.id);
      pending.reject(error);
    }
  }

  private finish(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.abortListener && pending.turn.abortSignal) {
      pending.turn.abortSignal.removeEventListener("abort", pending.abortListener);
    }
    this.pending.delete(id);
    if (this.pending.size === 0) {
      this.recycleDrainResolve?.();
      this.recycleDrainResolve = undefined;
    }
  }

  private finishWithError(id: string, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.finish(id);
    pending.reject(error);
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.readyReject?.(error);
    this.readyReject = undefined;
    this.readyResolve = undefined;
    this.ready = undefined;
    this.child = undefined;
    this.childFingerprint = undefined;
    this.requestedFingerprint = undefined;
    for (const id of [...this.pending.keys()]) {
      void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "end",
        traceId: id,
        helperPid: child.pid!,
        status: "failed",
        message: "Launcher browser helper exited before completing the turn",
      }).catch(controlError => {
        console.error(
          `[chatgpt-web-helper] failed to release launcher turn ${id}: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
        );
      });
      this.finishWithError(id, error);
    }
  }

  private async waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>(resolveExit => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("close", onExit);
        resolveExit(exited);
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      child.once("exit", onExit);
      child.once("close", onExit);
    });
  }

  private async terminateChild(child: ChildProcessWithoutNullStreams, gracefulTimeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    if (await this.waitForExit(child, gracefulTimeoutMs)) return;
    if (!child.kill("SIGTERM") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Launcher browser helper refused termination");
    }
    if (await this.waitForExit(child, 2_000)) return;
    if (!child.kill("SIGKILL") && child.exitCode === null && child.signalCode === null) {
      throw new Error("Launcher browser helper refused forced termination");
    }
    if (!await this.waitForExit(child, 2_000)) {
      throw new Error("Launcher browser helper did not exit after forced termination");
    }
  }

  private send(message: unknown): Promise<void> {
    const child = this.child;
    if (!child
      || child.killed
      || child.exitCode !== null
      || child.signalCode !== null) {
      return Promise.reject(new Error("Launcher browser helper is not running"));
    }
    return this.sendTo(child, message);
  }

  private async sendTo(child: ChildProcessWithoutNullStreams, message: unknown): Promise<void> {
    const encoded = `${JSON.stringify(message)}\n`;
    if (child.stdin.destroyed || child.stdin.writableEnded) {
      throw new Error("Launcher browser helper input is closed");
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(encoded, error => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
  }
}
