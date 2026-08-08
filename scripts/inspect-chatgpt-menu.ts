import { homedir } from "node:os";
import { join } from "node:path";
import { readLauncherBrowserHostDescriptor } from "../src/launcher-browser-host";

const descriptorPath = join(homedir(), ".codex-chatgpt-web", "runtime", "launcher-browser.json");
const descriptor = readLauncherBrowserHostDescriptor(descriptorPath);
const targets = await fetch(`${descriptor.endpoint}/json`).then(response => response.json()) as Array<{
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}>;
const target = targets.find(candidate => (
  candidate.type === "page"
  && candidate.url?.startsWith("https://chatgpt.com/")
  && typeof candidate.webSocketDebuggerUrl === "string"
));
if (!target?.webSocketDebuggerUrl) throw new Error("The launcher CDP endpoint has no ChatGPT page target");

const inspectExpression = `(() => {
  const visible = (candidate) => {
    const style = getComputedStyle(candidate);
    return candidate.isConnected
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0';
  };
  const attributes = (candidate) => Object.fromEntries(
    Array.from(candidate.attributes)
      .filter(attribute => (
        attribute.name === 'class'
        || attribute.name === 'role'
        || attribute.name === 'tabindex'
        || attribute.name === 'popover'
        || attribute.name.startsWith('aria-')
        || attribute.name.startsWith('data-')
      ))
      .map(attribute => [attribute.name, attribute.value])
  );
  const describe = (candidate) => ({
    tag: candidate.tagName.toLowerCase(),
    attributes: attributes(candidate),
  });
  const effortControl = Array.from(document.querySelectorAll('button[aria-haspopup="menu"][data-tone="neutral"]'))
    .filter(visible)
    .at(-1);
  if (!effortControl) return { error: 'effort control not found' };
  const controlRect = effortControl.getBoundingClientRect();
  const region = {
    left: Math.max(0, controlRect.left - 280),
    right: Math.min(innerWidth, controlRect.right + 80),
    top: Math.max(0, controlRect.top - 520),
    bottom: Math.min(innerHeight, controlRect.bottom + 80),
  };
  const candidates = Array.from(document.querySelectorAll('*'))
    .filter((candidate) => {
      if (!visible(candidate)) return false;
      const rect = candidate.getBoundingClientRect();
      if (
        rect.right < region.left
        || rect.left > region.right
        || rect.bottom < region.top
        || rect.top > region.bottom
      ) return false;
      const text = (candidate.innerText || candidate.textContent || '').replace(/\\s+/g, ' ').trim();
      const attrs = attributes(candidate);
      return (
        (candidate.children.length === 0 && text.length > 0 && text.length <= 120)
        || candidate.tagName === 'BUTTON'
        || Object.keys(attrs).some(name => (
          name === 'role'
          || name === 'tabindex'
          || name === 'popover'
          || name === 'data-testid'
          || name === 'data-radix-collection-item'
          || name === 'aria-haspopup'
        ))
      );
    })
    .slice(0, 120)
    .map((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const ancestors = [];
      let parent = candidate.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
        ancestors.push(describe(parent));
      }
      return {
        ...describe(candidate),
        text: (candidate.innerText || candidate.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        ancestors,
      };
    });
  return {
    viewport: { width: innerWidth, height: innerHeight },
    effortControl: {
      ...describe(effortControl),
      rect: {
        x: Math.round(controlRect.x),
        y: Math.round(controlRect.y),
        width: Math.round(controlRect.width),
        height: Math.round(controlRect.height),
      },
    },
    openPopoverCount: document.querySelectorAll(':popover-open').length,
    candidates,
  };
})()`;

const controlStateExpression = `(() => {
  const visible = (candidate) => {
    const style = getComputedStyle(candidate);
    return candidate.isConnected
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && style.opacity !== '0';
  };
  const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const effortControl = Array.from(document.querySelectorAll('button[aria-haspopup="menu"][data-tone="neutral"]'))
    .filter(visible)
    .at(-1);
  if (!effortControl) return { control: null, menu: null };
  const menuSelector = '[data-testid="composer-intelligence-picker-content"][role="group"]';
  const menu = Array.from(document.querySelectorAll(menuSelector)).filter(visible).at(-1);
  const items = menu
    ? Array.from(menu.querySelectorAll('[role="menuitemradio"]')).filter(visible)
    : [];
  const target = items[2];
  return {
    control: {
      label: normalize(effortControl.innerText || effortControl.textContent),
      expanded: effortControl.getAttribute('aria-expanded'),
    },
    menu: menu ? {
      itemCount: items.length,
      target: target ? {
        label: normalize(target.innerText || target.textContent),
        checked: target.getAttribute('aria-checked'),
      } : null,
    } : null,
  };
})()`;

type ControlState = {
  control: { label: string; expanded: string | null } | null;
  menu: {
    itemCount: number;
    target: { label: string; checked: string | null } | null;
  } | null;
};

const focusEffortControlExpression = `(() => {
  const control = Array.from(document.querySelectorAll('button[aria-haspopup="menu"][data-tone="neutral"]')).at(-1);
  if (!control) return false;
  control.focus({ preventScroll: true });
  return document.activeElement === control;
})()`;

const focusHighItemExpression = `(() => {
  const menu = Array.from(document.querySelectorAll('[data-testid="composer-intelligence-picker-content"][role="group"]')).at(-1);
  const target = menu?.querySelectorAll('[role="menuitemradio"]')[2];
  if (!target) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
})()`;

const result = await new Promise<unknown>((resolveResult, rejectResult) => {
  const socket = new WebSocket(target.webSocketDebuggerUrl!);
  let nextId = 0;
  const pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  const timeout = setTimeout(() => {
    socket.close();
    rejectResult(new Error("CDP connection timed out"));
  }, 10_000);
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }) as { exceptionDetails?: unknown; result?: { value?: T } };
    if (response.exceptionDetails) throw new Error("CDP Runtime.evaluate raised an exception");
    return response.result?.value as T;
  };
  const pressEnter = async () => {
    const event = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await send("Input.dispatchKeyEvent", { ...event, type: "keyDown", text: "\r", unmodifiedText: "\r" });
    await send("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
  };
  const waitFor = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs: number): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let value = await read();
    while (!accept(value) && Date.now() < deadline) {
      await Bun.sleep(50);
      value = await read();
    }
    return value;
  };
  socket.addEventListener("open", () => {
    void (async () => {
      if (!process.argv.includes("--exercise")) return await evaluate(inspectExpression);

      let state = await evaluate<ControlState>(controlStateExpression);
      if (!state.control) throw new Error("ChatGPT effort control not found");
      if (state.menu) {
        if (!await evaluate<boolean>(focusEffortControlExpression)) throw new Error("ChatGPT effort control could not receive focus");
        await pressEnter();
        state = await waitFor(
          () => evaluate<ControlState>(controlStateExpression),
          candidate => candidate.menu === null,
          5_000,
        );
        if (state.menu) throw new Error("CDP click did not close the effort menu");
      }

      const openedAt = Date.now();
      if (!state.control) throw new Error("ChatGPT effort control disappeared");
      if (!await evaluate<boolean>(focusEffortControlExpression)) throw new Error("ChatGPT effort control could not receive focus");
      await pressEnter();
      state = await waitFor(
        () => evaluate<ControlState>(controlStateExpression),
        candidate => (candidate.menu?.itemCount ?? 0) >= 5 && candidate.menu?.target !== null,
        5_000,
      );
      if (!state.menu?.target) {
        return { ok: false, stage: "open", itemCount: state.menu?.itemCount ?? 0 };
      }

      const targetLabel = state.menu.target.label;
      const itemCount = state.menu.itemCount;
      if (!await evaluate<boolean>(focusHighItemExpression)) throw new Error("ChatGPT High item could not receive focus");
      await pressEnter();
      state = await waitFor(
        () => evaluate<ControlState>(controlStateExpression),
        candidate => candidate.control?.label === targetLabel,
        5_000,
      );
      return {
        ok: state.control?.label === targetLabel,
        stage: state.control?.label === targetLabel ? "confirmed" : "confirm",
        itemCount,
        openLatencyMs: Date.now() - openedAt,
        targetIndex: 2,
        targetLabel,
        confirmedLabel: state.control?.label ?? null,
      };
    })().then(resolveResult, rejectResult).finally(() => {
      clearTimeout(timeout);
      socket.close();
    });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number;
      error?: { message?: string };
      result?: unknown;
    };
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error?.message) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener("error", () => {
    clearTimeout(timeout);
    rejectResult(new Error("Could not connect to the ChatGPT page CDP target"));
  });
});

console.log(JSON.stringify(result, null, 2));
