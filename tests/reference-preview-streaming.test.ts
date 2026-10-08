import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import type { Locator } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMarkdownBuffer, ChatGptMarkdownConsistencyError, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

// Production DOM projection, with a persistent document so hydration keeps node ownership.
async function frames(html: string, changes: Array<(document: Document) => void>) {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(`<section id="turn"><div class="markdown">${html}</div><button aria-label="Copy"></button></section>`);
  const prototype = window.HTMLElement.prototype;
  const innerText = Object.getOwnPropertyDescriptor(prototype, "innerText");
  const append = Object.getOwnPropertyDescriptor(prototype, "append");
  const collections = [window.document.querySelectorAll("div"), window.document.body.children].map(Object.getPrototypeOf);
  const iterators = collections.map(p => Object.getOwnPropertyDescriptor(p, Symbol.iterator));
  Object.defineProperty(prototype, "innerText", { configurable: true, get() { return this.textContent; } });
  Object.defineProperty(prototype, "append", { configurable: true, value(this: HTMLElement, ...nodes: Node[]) { nodes.forEach(n => this.appendChild(n)); } });
  collections.forEach(p => Object.defineProperty(p, Symbol.iterator, { configurable: true, value: Array.prototype[Symbol.iterator] }));
  try {
    const context = createContext({
      document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
      Node: window.Node, NodeFilter: window.NodeFilter, performance: { timeOrigin: 1 },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      MutationObserver: class { observe() {} },
    });
    const locator = {
      evaluate: async (callback: Function, options: unknown) => runInContext(`(${callback.toString()})`, context)(window.document.getElementById("turn"), options),
      page: () => ({ isClosed: () => false }),
    } as unknown as Locator;
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      responseDomSnapshot(locator: Locator): Promise<{ markdownSegments: ChatGptMarkdownSegment[] }>;
    };
    const result = [(await worker.responseDomSnapshot(locator)).markdownSegments];
    for (const change of changes) {
      change(window.document);
      result.push((await worker.responseDomSnapshot(locator)).markdownSegments);
    }
    return result;
  } finally {
    collections.forEach((p, i) => iterators[i] ? Object.defineProperty(p, Symbol.iterator, iterators[i]!) : delete p[Symbol.iterator]);
    if (innerText) Object.defineProperty(prototype, "innerText", innerText); else delete prototype.innerText;
    if (append) Object.defineProperty(prototype, "append", append); else delete prototype.append;
  }
}

// Observed reference wrapper and spinner; only the previous four-character label is generic.
const reference = '<div id="reference" class="contents" data-chatgpt-copy-reference="0" data-markdown-copy="contents">View</div>';
const spinner = '<div><div class="inline-flex h-fit w-fit items-center justify-center leading-none contain-layout contain-paint contain-style motion-safe:animate-spin"></div></div>';

test("a reference label becoming an empty loading control cannot abort final delivery", async () => {
  const snapshots = await frames(`<p>Intro.</p>${reference}<p>Closing note.</p>`, [
    document => { document.getElementById("reference")!.innerHTML = spinner; },
  ]);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  for (const [i, snapshot] of snapshots.entries()) buffer.observe(snapshot, i);
  expect(buffer.finish().markdown).toBe("Intro.\n\nClosing note.");
});

test("reference hydration keeps the final download link and title without streaming draft controls", async () => {
  const snapshots = await frames(`<p>Intro.</p>${reference}<p>Closing note.</p>`, [
    document => { document.getElementById("reference")!.innerHTML = spinner; },
    document => { document.getElementById("reference")!.innerHTML = '<span class="group/resource-row">preview.pngPNG</span>'; },
    document => { document.getElementById("reference")!.innerHTML = spinner; },
    document => { document.getElementById("reference")!.innerHTML = '<span class="group/resource-row"><a href="https://example.com/report">Download report</a></span>'; },
  ]);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  for (const [i, snapshot] of snapshots.entries()) expect(buffer.observe(snapshot, i)).toBe("");
  expect(buffer.finish()).toEqual({
    markdown: "Intro.\n\n[Download report](https://example.com/report)\n\nClosing note.",
    delta: "Intro.\n\n[Download report](https://example.com/report)\n\nClosing note.",
  });
});

test("reference deferral survives removal and root remount without losing plain labels", async () => {
  const snapshots = await frames(`<p>Intro.</p>${reference}<p>Closing note.</p>`, [
    document => { document.getElementById("reference")!.remove(); },
    document => { document.querySelector(".markdown")!.outerHTML = `<div class="markdown"><p>Intro.</p>${reference}<p>Closing note.</p></div>`; },
  ]);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  for (const [i, snapshot] of snapshots.entries()) expect(buffer.observe(snapshot, i)).toBe("");
  expect(buffer.finish().markdown).toBe("Intro.\n\nView\n\nClosing note.");
});

test("a later reference cannot authorize edits to text that was already delivered", async () => {
  const snapshots = await frames('<p id="lead">Committed.</p><p id="tail">Closing note.</p>', [
    document => { document.getElementById("tail")!.insertAdjacentHTML("beforebegin", reference); },
    document => { document.getElementById("lead")!.textContent = "A real edit."; },
  ]);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  expect(buffer.observe(snapshots[0]!, 0)).toBe("Committed.");
  expect(buffer.observe(snapshots[1]!, 1)).toBe("");
  buffer.observe(snapshots[2]!, 2);
  expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
});

test("ordinary wrappers still stream and complete-only summaries remain supported", async () => {
  const [snapshot] = await frames('<div data-markdown-copy="contents">Ordinary content.</div><p>Closing note.</p>', []);
  const stream = new ChatGptMarkdownBuffer(undefined, 0);
  expect(stream.observe(snapshot!, 0)).toBe("Ordinary content.");
  expect(stream.finish().markdown).toBe("Ordinary content.\n\nClosing note.");
  const complete = new ChatGptMarkdownBuffer(undefined, 0, "complete");
  expect(complete.observe(snapshot!, 0)).toBe("");
  expect(complete.finish().markdown).toBe("Ordinary content.\n\nClosing note.");
});
