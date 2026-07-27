import { existsSync, mkdirSync } from "node:fs";
import { spawnDetached } from "./process";

export interface ChromeCdpConfig {
  executablePath: string;
  profilePath: string;
  debugPort: number;
}

export function chromeLaunchArguments(config: ChromeCdpConfig, initialUrl = "about:blank"): string[] {
  return [
    `--user-data-dir=${config.profilePath}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${config.debugPort}`,
    "--no-first-run",
    "--no-default-browser-check",
    initialUrl,
  ];
}

interface ChromeVersionPayload {
  Browser?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
  sessionId?: string;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function debugBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function decodeWebSocketMessage(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return String(data);
}

async function chromeVersion(port: number): Promise<Required<ChromeVersionPayload>> {
  const response = await fetch(`${debugBaseUrl(port)}/json/version`, { signal: AbortSignal.timeout(2_000) });
  if (!response.ok) throw new Error(`Chrome DevTools endpoint returned HTTP ${response.status}`);
  const payload = await response.json() as ChromeVersionPayload;
  if (!payload.Browser?.startsWith("Chrome/") || !payload.webSocketDebuggerUrl) {
    throw new Error("The configured DevTools port does not belong to Google Chrome");
  }
  const socketUrl = new URL(payload.webSocketDebuggerUrl);
  if (socketUrl.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(socketUrl.hostname)) {
    throw new Error("Chrome exposed a non-loopback DevTools WebSocket");
  }
  return payload as Required<ChromeVersionPayload>;
}

export async function ensureChromeDebugServer(
  config: ChromeCdpConfig,
  initialUrl = "about:blank",
  timeoutMs = 20_000,
): Promise<Required<ChromeVersionPayload>> {
  try {
    return await chromeVersion(config.debugPort);
  } catch {
    // Launch below.
  }
  if (!existsSync(config.executablePath)) {
    throw new Error(`Google Chrome was not found at ${config.executablePath}`);
  }
  mkdirSync(config.profilePath, { recursive: true, mode: 0o700 });
  spawnDetached(config.executablePath, chromeLaunchArguments(config, initialUrl));

  const deadline = Date.now() + timeoutMs;
  let lastError = "not reachable";
  while (Date.now() < deadline) {
    try {
      return await chromeVersion(config.debugPort);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`Chrome DevTools endpoint did not become ready: ${lastError}`);
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", event => this.handleMessage(event.data));
    socket.addEventListener("close", () => this.handleClose("Chrome DevTools connection closed"));
    socket.addEventListener("error", () => this.handleClose("Chrome DevTools connection failed"));
  }

  static async connect(webSocketDebuggerUrl: string, timeoutMs = 10_000): Promise<CdpConnection> {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("Chrome DevTools WebSocket timed out")), timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectOpen(new Error("Chrome DevTools WebSocket could not connect"));
      }, { once: true });
    });
    return new CdpConnection(socket);
  }

  private handleMessage(data: unknown): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(decodeWebSocketMessage(data)) as CdpMessage;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`Chrome DevTools ${message.error.code ?? "error"}: ${message.error.message ?? "unknown error"}`));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleClose(message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error(message));
    this.pending.clear();
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome DevTools connection is not open");
    }
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        response,
        new Promise<never>((_, rejectTimeout) => {
          timer = setTimeout(() => {
            this.pending.delete(id);
            rejectTimeout(new Error(`Chrome DevTools command timed out: ${method}`));
          }, timeoutMs);
        }),
      ]) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
    for (const pending of this.pending.values()) pending.reject(new Error("Chrome DevTools connection closed"));
    this.pending.clear();
  }
}

interface RuntimeRemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  objectId?: string;
  description?: string;
}

interface RuntimeEvaluateResult {
  result?: RuntimeRemoteObject;
  exceptionDetails?: {
    text?: string;
    exception?: RuntimeRemoteObject;
  };
}

export class CdpPage {
  constructor(
    private readonly connection: CdpConnection,
    readonly targetId: string,
    readonly sessionId: string,
  ) {}

  async enable(): Promise<void> {
    await Promise.all([
      this.connection.send("Runtime.enable", {}, this.sessionId),
      this.connection.send("Page.enable", {}, this.sessionId),
      this.connection.send("DOM.enable", {}, this.sessionId),
    ]);
  }

  async evaluate<T>(expression: string, timeoutMs = 30_000): Promise<T> {
    const evaluated = await this.connection.send<RuntimeEvaluateResult>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, this.sessionId, timeoutMs);
    if (evaluated.exceptionDetails) {
      const detail = evaluated.exceptionDetails.exception?.description
        ?? evaluated.exceptionDetails.text
        ?? "unknown page exception";
      throw new Error(`Chrome page evaluation failed: ${detail}`);
    }
    return evaluated.result?.value as T;
  }

  async evaluateObject(expression: string, timeoutMs = 30_000): Promise<string> {
    const evaluated = await this.connection.send<RuntimeEvaluateResult>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: false,
      userGesture: true,
    }, this.sessionId, timeoutMs);
    if (evaluated.exceptionDetails) {
      const detail = evaluated.exceptionDetails.exception?.description
        ?? evaluated.exceptionDetails.text
        ?? "unknown page exception";
      throw new Error(`Chrome page evaluation failed: ${detail}`);
    }
    const objectId = evaluated.result?.objectId;
    if (!objectId) throw new Error("Chrome page expression did not return a DOM object");
    return objectId;
  }

  async navigate(url: string, timeoutMs = 70_000): Promise<void> {
    await this.connection.send("Page.navigate", { url }, this.sessionId, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.evaluate<boolean>(
        `document.readyState === "interactive" || document.readyState === "complete"`,
        2_000,
      ).catch(() => false);
      if (ready) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    throw new Error(`Chrome page navigation timed out: ${url}`);
  }

  async activate(): Promise<void> {
    await this.connection.send("Target.activateTarget", { targetId: this.targetId });
  }

  async insertText(selector: string, text: string): Promise<void> {
    const focused = await this.evaluate<boolean>(`(() => {
      const visible = element => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(visible);
      if (!(element instanceof HTMLElement)) return false;
      element.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return document.activeElement === element;
    })()`);
    if (!focused) throw new Error(`Chrome could not focus ${selector}`);
    await this.connection.send("Input.insertText", { text }, this.sessionId, 60_000);
  }

  async appendText(selector: string, text: string): Promise<void> {
    const focused = await this.evaluate<boolean>(`(() => {
      const visible = element => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(visible);
      if (!(element instanceof HTMLElement)) return false;
      element.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return document.activeElement === element;
    })()`);
    if (!focused) throw new Error(`Chrome could not focus ${selector}`);
    await this.connection.send("Input.insertText", { text }, this.sessionId, 60_000);
  }

  async clickElement(elementExpression: string): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number } | null>(`(async () => {
      const element = (${elementExpression});
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      let rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
        return null;
      }
      const fullyVisible = rect.top >= 0
        && rect.left >= 0
        && rect.bottom <= window.innerHeight
        && rect.right <= window.innerWidth;
      if (!fullyVisible) element.scrollIntoView({ block: "center", inline: "center" });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!(hit instanceof Element) || (hit !== element && !element.contains(hit))) return null;
      return { x, y };
    })()`);
    if (!point) throw new Error("Chrome could not resolve a visible element to click");
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
      pointerType: "mouse",
    }, this.sessionId);
    await this.connection.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
      pointerType: "mouse",
    }, this.sessionId);
  }

  async pressEscape(): Promise<void> {
    await this.connection.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 53,
    }, this.sessionId);
    await this.connection.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 53,
    }, this.sessionId);
  }

  async pressEnter(selector: string): Promise<void> {
    const focused = await this.evaluate<boolean>(`(() => {
      const visible = element => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find(visible);
      if (!(element instanceof HTMLElement)) return false;
      element.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return document.activeElement === element;
    })()`);
    if (!focused) throw new Error(`Chrome could not focus ${selector}`);
    await this.connection.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 36,
    }, this.sessionId);
    await this.connection.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 36,
    }, this.sessionId);
  }

  async setInputFiles(selector: string, files: string[]): Promise<void> {
    const objectId = await this.evaluateObject(`document.querySelector(${JSON.stringify(selector)})`);
    try {
      const requested = await this.connection.send<{ nodeId?: number }>(
        "DOM.requestNode",
        { objectId },
        this.sessionId,
      );
      if (!requested.nodeId) throw new Error(`Chrome could not resolve file input ${selector}`);
      await this.connection.send(
        "DOM.setFileInputFiles",
        { files, nodeId: requested.nodeId },
        this.sessionId,
        60_000,
      );
    } finally {
      await this.connection.send("Runtime.releaseObject", { objectId }, this.sessionId).catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.connection.send("Target.closeTarget", { targetId: this.targetId }).catch(() => {});
  }
}

export class ChromeCdpBrowser {
  private connection?: CdpConnection;
  private connecting?: Promise<void>;

  constructor(private readonly config: ChromeCdpConfig) {}

  async connect(initialUrl = "about:blank"): Promise<void> {
    if (this.connection) return;
    this.connecting ??= (async () => {
      const version = await ensureChromeDebugServer(this.config, initialUrl);
      this.connection = await CdpConnection.connect(version.webSocketDebuggerUrl);
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async newPage(url = "about:blank"): Promise<CdpPage> {
    await this.connect(url);
    const connection = this.connection!;
    const created = await connection.send<{ targetId?: string }>("Target.createTarget", { url });
    if (!created.targetId) throw new Error("Chrome did not create a page target");
    const attached = await connection.send<{ sessionId?: string }>(
      "Target.attachToTarget",
      { targetId: created.targetId, flatten: true },
    );
    if (!attached.sessionId) throw new Error("Chrome did not attach to the page target");
    const page = new CdpPage(connection, created.targetId, attached.sessionId);
    await page.enable();
    return page;
  }

  async findOrCreatePage(url: string): Promise<CdpPage> {
    await this.connect(url);
    const connection = this.connection!;
    const targets = await connection.send<{ targetInfos?: Array<{ targetId: string; type: string; url: string }> }>(
      "Target.getTargets",
    );
    const expected = new URL(url);
    const pages = targets.targetInfos?.filter(target => target.type === "page") ?? [];
    const matching = pages.find(target => target.url === url) ?? pages.find(target => {
      if (target.type !== "page") return false;
      try {
        return new URL(target.url).origin === expected.origin;
      } catch {
        return false;
      }
    });
    if (!matching) return this.newPage(url);
    const attached = await connection.send<{ sessionId?: string }>(
      "Target.attachToTarget",
      { targetId: matching.targetId, flatten: true },
    );
    if (!attached.sessionId) throw new Error("Chrome did not attach to the existing ChatGPT page");
    const page = new CdpPage(connection, matching.targetId, attached.sessionId);
    await page.enable();
    return page;
  }

  close(): void {
    this.connection?.close();
    this.connection = undefined;
  }

  async shutdownChrome(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;
    await connection.send("Browser.close").catch(() => {});
    connection.close();
  }
}
