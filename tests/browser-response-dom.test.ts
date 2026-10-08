import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { Locator } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, ChatGptVisibleTraceTracker, CHATGPT_COMPLETION_SETTLE_MS } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptMarkdownBuffer, ChatGptMarkdownConsistencyError, type ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

const smokeHtml = readFileSync(new URL("./fixtures/chatgpt-dil-smoke.html", import.meta.url), "utf8");
const powerCompleteHtml = readFileSync(new URL("./fixtures/chatgpt-power-complete.html", import.meta.url), "utf8");
const powerStreamingHtml = readFileSync(new URL("./fixtures/chatgpt-power-streaming.html", import.meta.url), "utf8");
// These captures are also edited as strings below. Windows checkouts use CRLF;
// normalize before inserting test variants so they exercise the same DOM everywhere.
const powerActivityHtml = readFileSync(new URL("./fixtures/chatgpt-power-activity.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const activitySummariesHtml = readFileSync(new URL("./fixtures/chatgpt-activity-summaries.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
type Snapshot = {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  markdownSegments: ChatGptMarkdownSegment[];
  completionActionVisible: boolean;
  traceBlocks: { kind: "answer" | "commentary" | "status"; text: string }[];
};

// Execute the production page callback, with only missing Domino browser APIs supplied.
async function snapshot(html: string): Promise<Snapshot> {
  return (await snapshots(html, []))[0]!;
}

async function snapshots(html: string, changes: Array<(document: Document) => void>): Promise<Snapshot[]> {
  const { createWindow } = require("@mixmark-io/domino");
  const window = createWindow(html);
  const innerText = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "innerText");
  const append = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "append");
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    configurable: true, get() { return this.textContent; },
  });
  Object.defineProperty(window.HTMLElement.prototype, "append", {
    configurable: true, value(this: HTMLElement, ...nodes: Node[]) { nodes.forEach(node => this.appendChild(node)); },
  });
  const collections = [window.document.querySelectorAll("div"), window.document.body.children].map(Object.getPrototypeOf);
  const iterators = collections.map(prototype => Object.getOwnPropertyDescriptor(prototype, Symbol.iterator));
  for (const prototype of collections) Object.defineProperty(prototype, Symbol.iterator, {
    configurable: true, value: Array.prototype[Symbol.iterator],
  });
  try {
    const context = createContext({
      document: window.document, HTMLElement: window.HTMLElement, Element: window.Element,
      Node: window.Node, NodeFilter: window.NodeFilter, performance: { timeOrigin: 1 },
      getComputedStyle: (element: HTMLElement) => ({
        display: element.style.display || "block", visibility: "visible", opacity: "1",
      }),
      MutationObserver: class { observe() {} },
    });
    const errors: unknown[] = [];
    const locator = {
      evaluate: async (callback: Function, options: unknown) => {
        try { return runInContext(`(${callback.toString()})`, context)(window.document.getElementById("turn"), options); }
        catch (error) { errors.push(error); throw error; }
      },
      page: () => ({ isClosed: () => false }),
    } as unknown as Locator;
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      responseDomSnapshot(locator: Locator): Promise<Snapshot>;
    };
    const result = [await worker.responseDomSnapshot(locator)];
    for (const change of changes) {
      change(window.document);
      result.push(await worker.responseDomSnapshot(locator));
    }
    expect(errors).toEqual([]);
    return result;
  } finally {
    collections.forEach((prototype, index) => {
      if (iterators[index]) Object.defineProperty(prototype, Symbol.iterator, iterators[index]!);
      else delete prototype[Symbol.iterator];
    });
    if (innerText) Object.defineProperty(window.HTMLElement.prototype, "innerText", innerText);
    else delete window.HTMLElement.prototype.innerText;
    if (append) Object.defineProperty(window.HTMLElement.prototype, "append", append);
    else delete window.HTMLElement.prototype.append;
  }
}

test("captured Activity progress is commentary before any assistant answer exists", async () => {
  const progress = await snapshot(powerActivityHtml);
  expect(progress.responsePresent).toBeTrue();
  expect(progress.markdownSegments).toEqual([]);
  expect(progress.completionActionVisible).toBeFalse();
  expect(progress.traceBlocks.filter(block => block.kind === "commentary").map(block => block.text)).toEqual(["Text 5\nText 6\nText 4\nText 8"]);
  const marker = '<span hidden="" data-chatgpt-agent-turn-start="">\n</span>';
  expect(powerActivityHtml).toContain(marker);
  const combined = powerActivityHtml.replace(marker, marker + '<div data-content-search-unit-key="answer"><h4 data-conversation-role="assistant"></h4><div data-markdown-text-style="assistant-message"><p>Final answer.</p></div></div>');
  const answer = await snapshot(combined);
  expect(answer.visibleText).toBe("Final answer.");
  expect(answer.traceBlocks.some(block => block.kind === "commentary")).toBeTrue();
});

test("captured activity summaries use the status stream and keep actual commentary and answers separate", async () => {
  const result = await snapshot(activitySummariesHtml);
  expect(result.visibleText).toBe("answer 1");
  expect(result.traceBlocks.filter(block => block.kind === "status").map(block => block.text))
    .toEqual(Array.from({ length: 10 }, (_, index) => `status ${index + 1}`));
  expect(result.traceBlocks.filter(block => block.kind === "commentary").map(block => block.text))
    .toEqual(["commentary 1", "commentary 2"]);
  const tracker = new ChatGptVisibleTraceTracker(0);
  const events = tracker.observe(result.traceBlocks, true);
  expect(events.map(event => event.kind)).toEqual([
    "reasoning", "commentary", ...Array(8).fill("reasoning"), "commentary", "reasoning",
  ]);
  expect(tracker.observe(result.traceBlocks, true)).toEqual([]);

  // Text, colour, and header placement do not determine the channel. The final
  // answer owns its own unit even if its renderer uses the same tone attribute.
  const changed = await snapshot(activitySummariesHtml
    .replaceAll("status 1", "commentary 1")
    .replace('data-markdown-text-style="assistant-message">\n<p>answer 1',
      'data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">\n<p>answer 1'));
  expect(changed.visibleText).toBe("answer 1");
  expect(changed.traceBlocks.filter(block => block.kind === "commentary").map(block => block.text))
    .toEqual(["commentary 1", "commentary 2"]);
  expect(changed.traceBlocks.find(block => block.kind === "status")?.text).toBe("commentary 1");

  const hidden = await snapshot(activitySummariesHtml
    .replace('<div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">',
      '<div style="display:none"><div data-markdown-text-style="assistant-message" data-markdown-text-tone="tertiary">')
    .replace('<p>status 1</p>\n</div>', '<p>status 1</p>\n</div></div>'));
  expect(hidden.traceBlocks.some(block => block.text === "status 1")).toBeFalse();
});

test("keeps an unfinished hyperlink buffered and detects changed destinations after delivery", async () => {
  const page = (href: string) => `<section id="turn"><div class="markdown"><p data-start="0" data-end="99"><strong><a${href}>Open report</a></strong>.</p><p data-start="100" data-end="115">Next paragraph.</p></div></section>`;
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const pending = await snapshot(page(""));
  expect(buffer.observe(pending.markdownSegments, 0)).toBe("");
  const linked = await snapshot(page(' href="https://example.com/report#details"'));
  expect(buffer.observe(linked.markdownSegments, 1000)).toBe("**[Open report](https://example.com/report#details)**.");
  expect(buffer.finish().markdown).toBe("**[Open report](https://example.com/report#details)**.\n\nNext paragraph.");
  const changed = await snapshot(page(' href="https://example.com/different"'));
  buffer.observe(changed.markdownSegments, 2000);
  expect(buffer.currentSnapshotIsConsistent()).toBeFalse();
  expect(() => buffer.finish()).toThrow("completed text block");
});

test("observed resource preview hydration cannot rewrite delivered answer text", async () => {
  // Structural fragment supplied in #769; only the title/filename/type are generic.
  for (const root of ['class="markdown"', 'data-markdown-text-style="assistant-message"']) {
    const page = (label: string, type: string) => `<section id="turn"><div data-content-search-unit-key="answer">
      <h4 data-conversation-role="assistant"></h4><div ${root}>
      <p>The layout was updated.</p>
      <div data-chatgpt-copy-reference="0" data-markdown-copy="contents">
        <div><span><span class="group/resource-row relative"><span>
          <span title="${label}">${label}</span><span>${type}</span>
        </span></span></span></div>
      </div><p>Validation completed.</p>
    </div></div><button aria-label="Copy"></button></section>`;
    const before = await snapshot(page("Layout", ""));
    const after = await snapshot(page("candidate-overview.png", "PNG"));
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    expect(buffer.observe(before.markdownSegments, 0)).toBe("");
    expect(buffer.observe(after.markdownSegments, 1)).toBe("");
    expect(buffer.finish().markdown).toBe("The layout was updated.\n\nValidation completed.");
    // These snapshots use different documents; node identities must not be reused.
    expect(before.markdownSegments.map(({ key, ...content }) => content))
      .toEqual(after.markdownSegments.map(({ key, ...content }) => content));
    expect(after.markdownSegments.map(segment => segment.html).join("")).not.toContain("candidate-overview.png");
    expect(after.fullHtml).toContain("candidate-overview.png"); // The browser's original content is untouched.

    buffer.observe((await snapshot(page("Layout", "").replace("The layout was updated.", "Changed answer."))).markdownSegments, 2);
    expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
  }
});

test("file preview removal preserves a pending paragraph through movement and remounting", async () => {
  for (const remount of [false, true]) {
    const html = `<div id="turn"><div class="markdown">
      <p>Report saved:</p><p id="file">report.md</p><p id="tail">Validation completed.</p>
    </div><button aria-label="Copy"></button></div>`;
    const [before, moved, repeated, continued, changed] = await snapshots(html, [
      document => {
        const root = document.querySelector(".markdown")!;
        const file = document.querySelector("#file")!;
        root.parentElement!.appendChild(file);
        if (remount) root.innerHTML = root.innerHTML;
      },
      () => {},
      document => {
        const next = document.createElement("p");
        next.textContent = "The task is finished.";
        document.querySelector(".markdown")!.appendChild(next);
      },
      document => { document.querySelector(".markdown p")!.textContent = "A changed report."; },
    ]);
    const buffer = new ChatGptMarkdownBuffer(undefined, 0);
    expect(buffer.observe(before!.markdownSegments, 0)).toBe("Report saved:\n\nreport.md");
    expect(buffer.observe(moved!.markdownSegments, 1)).toBe("");
    expect(buffer.observe(repeated!.markdownSegments, 2)).toBe("");
    if (!remount) expect(moved!.markdownSegments.at(-1)!.key).toBe(before!.markdownSegments.at(-1)!.key);
    expect(buffer.observe(continued!.markdownSegments, 3)).toBe("\n\nValidation completed.");
    expect(buffer.finish().markdown).toBe("Report saved:\n\nreport.md\n\nValidation completed.\n\nThe task is finished.");
    buffer.observe(changed!.markdownSegments, 4);
    expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
  }
});

test("resource preview filtering preserves actual links, plain file labels and ordinary wrappers", async () => {
  const result = await snapshot(`<section id="turn"><div class="markdown">
    <div data-markdown-copy="contents">Ordinary content.</div>
    <div data-chatgpt-copy-reference="0" data-markdown-copy="contents">report.md</div>
    <div><span class="group/resource-row">Ordinary label.</span></div>
    <div data-chatgpt-copy-reference="1" data-markdown-copy="contents">
      <span class="group/resource-row"><a href="https://example.com/report">Download report</a></span>
    </div><p>Done.</p>
  </div><button aria-label="Copy"></button></section>`);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe(result.markdownSegments, 0);
  expect(buffer.finish().markdown).toBe("Ordinary content.\n\nreport.md\n\nOrdinary label.\n\n[Download report](https://example.com/report)\n\nDone.");
});

test("captured DIL smoke response reaches Markdown delivery and stable completion", async () => {
  // Also cover a changed CSS module hash and nested Markdown without duplicate delivery.
  for (const html of [
    smokeHtml,
    smokeHtml.replaceAll("fv0XaG_", "changed_"),
    smokeHtml.replace('<p class="w6asjq_TextBase _85PZeG_Text">', '<p class="markdown">'),
    '<section id="turn"><div class="markdown"><p>CODEX WEB GPT READY</p></div><button data-testid="copy-turn-action-button"></button></section>',
  ]) {
    const response = await snapshot(html);
    expect(response.visibleText).toBe("CODEX WEB GPT READY");
    expect(response.completionActionVisible).toBeTrue();
    const buffer = new ChatGptMarkdownBuffer();
    buffer.observe(response.markdownSegments, 0);
    expect(buffer.finish().markdown).toBe("CODEX WEB GPT READY");
    const tracker = new ChatGptCompletionTracker();
    const state = { ...response, running: false, currentText: response.visibleText, currentHtml: response.fullHtml };
    expect(tracker.update({ ...state, running: true }, 0)).toBeFalse();
    expect(tracker.update(state, 1)).toBeFalse();
    expect(tracker.update(state, 1 + CHATGPT_COMPLETION_SETTLE_MS)).toBeTrue();
    expect(response.traceBlocks.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "answer", text: "CODEX WEB GPT READY" },
    ]);
  }
});

test("captured power UI excludes the user footer during streaming and completes the assistant answer", async () => {
  // Captured from the same live DEV turn on 2026-09-25. The user already has Copy/Share
  // controls while the assistant streams; both live under one data-turn-key.
  const streaming = await snapshot(powerStreamingHtml);
  expect(streaming.visibleText).toContain("How a Rainbow Begins");
  expect(streaming.visibleText).not.toContain("No tools or apps");
  expect(streaming.completionActionVisible).toBeFalse();
  const complete = await snapshot(powerCompleteHtml);
  expect(complete.visibleText).toEndWith("STREAM_END_927");
  expect(complete.completionActionVisible).toBeTrue();
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe(complete.markdownSegments, 0);
  const markdown = buffer.finish().markdown;
  expect(markdown).toContain("## How a Rainbow Begins");
  expect(markdown).toContain("1. Sunlight enters the droplet and refracts.");
  expect(markdown).toEndWith("STREAM\\_END\\_927");
  const translated = await snapshot(powerCompleteHtml.replaceAll('aria-label="Copy"', 'aria-label="복사"'));
  expect(translated.completionActionVisible).toBeTrue();
  const noAssistant = await snapshot(powerCompleteHtml.replaceAll('data-conversation-role="assistant"', 'data-conversation-role="user"'));
  expect(noAssistant.visibleText).toBe("");
  expect(noAssistant.completionActionVisible).toBeFalse();
  const userMarkdown = await snapshot(powerCompleteHtml.replace('data-user-message-bubble="true">',
    'data-user-message-bubble="true"><div class="markdown">USER CONTENT</div>'));
  expect(userMarkdown.visibleText).toBe(complete.visibleText);
});

test("captured power response keeps its Markdown ledger through final rendering", async () => {
  const streaming = await snapshot(powerStreamingHtml);
  const complete = await snapshot(powerCompleteHtml);
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  buffer.observe(streaming.markdownSegments, 0);
  buffer.observe(complete.markdownSegments, 1000);
  expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
  expect(buffer.finish().markdown).toEndWith("STREAM\\_END\\_927");
});

test("reported code-block containers preserve code while their localized toolbar changes", async () => {
  // #631 supplied the finished structure: a generic DIV around
  // [data-markdown-copy="code-block"] > DIV > CODE, without a PRE.
  // Exercise changing UI text inside that container through the production extraction callback.
  const code = '  first = "コード"\n\n  print(first)\n  # ```\n';
  for (const block of ["div", "pre"]) {
    for (const label of ["コード", "Code", "代码"]) {
      const html = (toolbar: string, value = code) => `<section id="turn" data-turn-key="response">
        <div data-content-search-unit-key="response:assistant"><h4 data-conversation-role="assistant">ChatGPT said:</h4>
        <div data-markdown-text-style="assistant-message">
          <p data-start="0" data-end="10">Example</p>
          <div data-start="12" data-end="100"><${block} data-markdown-copy="code-block">
            ${toolbar}<div class="overflow-auto p-2"><code class="language-python whitespace-pre block"><span>${value}</span></code></div>
          </${block}></div>
          <p data-start="102" data-end="120">Done.</p>
        </div></div></section>`;
      const during = await snapshot(html(`<div>${label}<button>Copy</button></div>`));
      const after = await snapshot(html(""));
      expect(during.markdownSegments[1]?.text).toBe(code.trim());
      expect(after.markdownSegments[1]?.text).toBe(code.trim());
      expect(during.markdownSegments[1]).toMatchObject({ sourceStart: 12, sourceEnd: 100 });
      const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
      buffer.observe(during.markdownSegments, 0);
      buffer.observe(after.markdownSegments, 1000);
      expect(buffer.currentSnapshotIsConsistent()).toBeTrue();
      expect(buffer.finish().markdown).toBe(`Example\n\n\`\`\`python\n${code}\`\`\`\n\nDone.`);

      // Ignore the toolbar, never an actual change to code already sent to Codex.
      const changed = await snapshot(html("", code.replace("print(first)", "print(other)")));
      buffer.observe(changed.markdownSegments, 2000);
      expect(() => buffer.finish()).toThrow("ChatGPT changed a completed text block");
    }
  }
});

test("writing card controls cannot rewrite delivered content, but edited email text still can", async () => {
  const html = (toolbar: string, body = "Hello <strong>Alex</strong>.") => `<section id="turn"><div class="markdown">
    <p data-start="0" data-end="10">Drafts</p>
    <div data-markdown-copy="rich-block" data-start="12" data-end="200">
      <div>${toolbar}<button>Copy</button></div>
      <div data-markdown-copy-content="true"><p>${body}</p><p>See <a href="https://example.com/">details</a>.</p>
        <pre><code class="language-text">line 1\n  line 2</code></pre></div>
      <footer>Email format</footer>
    </div><p data-start="202" data-end="220">Done.</p></div></section>`;
  const during = await snapshot(html("メール"));
  const complete = await snapshot(html(""));
  expect(during.markdownSegments).toEqual(complete.markdownSegments);
  expect(during.markdownSegments.map(segment => segment.text).join("\n")).not.toContain("メール");
  expect(during.markdownSegments.map(segment => segment.text).join("\n")).not.toContain("Email format");
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  buffer.observe(during.markdownSegments, 0);
  buffer.observe(complete.markdownSegments, 1000);
  const output = buffer.finish().markdown;
  expect(output).toContain("Hello **Alex**.");
  expect(output).toContain("[details](https://example.com/)");
  expect(output).toContain("line 1\n  line 2");
  buffer.observe((await snapshot(html("", "Hello Sam."))).markdownSegments, 2000);
  expect(() => buffer.finish()).toThrow("ChatGPT changed a completed text block");
});

test("nested writing cards keep the outer prose and cards without a unique body lose nothing", async () => {
  const response = await snapshot(`<section id="turn"><div class="markdown">
    <div data-markdown-copy="rich-block"><p>Outer prose</p>
      <div data-markdown-copy="rich-block"><div>Toolbar</div>
        <div data-markdown-copy-content="true"><p>Inner body</p></div></div></div>
    <div data-markdown-copy="rich-block"><div data-markdown-copy-content="true">First</div>
      <div data-markdown-copy-content="true">Second</div></div>
    <p>End</p></div></section>`);
  const text = response.markdownSegments.map(segment => segment.text).join("\n");
  expect(text).toContain("Outer prose");
  expect(text).toContain("Inner body");
  expect(text).toContain("First");
  expect(text).toContain("Second");
  expect(text).not.toContain("Toolbar");
});

test("ordinary prose, inline code and legacy fenced code keep their meaning", async () => {
  const response = await snapshot(`<section id="turn" data-turn="assistant">
    <div data-message-author-role="assistant"><div class="markdown">
      <p>Code: <code>/tmp/file.ts</code></p>
      <pre data-start="30" data-end="80"><code class="language-text">/tmp/file.ts\n\n[[note]]\n\`\`\`\nend</code></pre>
      <p>Done.</p>
    </div></div></section>`);
  const buffer = new ChatGptMarkdownBuffer();
  buffer.observe(response.markdownSegments, 0);
  expect(buffer.finish().markdown).toBe("Code: [/tmp/file.ts](</tmp/file.ts>)\n\n````text\n/tmp/file.ts\n\n[[note]]\n```\nend\n````\n\nDone.");
});

test("DIL response extraction preserves ownership, commentary and completion boundaries", async () => {
  for (const html of [
    smokeHtml.replace('data-message-author-role="assistant"', 'data-message-author-role="user"'),
    smokeHtml.replace("fv0XaG_DilResponseRoot", "unrelated-widget"),
    smokeHtml.replace('dir="auto"', 'dir="auto" style="display:none"'),
    smokeHtml.replace('class="grow"', 'class="grow" data-streaming-response-status="thinking"'),
    smokeHtml.replace('class="grow"', 'class="grow" data-testid="cot-v5"'),
  ]) {
    const response = await snapshot(html);
    expect(response.visibleText).toBe("");
    expect(response.completionActionVisible).toBeFalse();
  }
  const noCopy = await snapshot(smokeHtml.replace('data-testid="copy-turn-action-button"', 'data-testid="other-action"'));
  expect(noCopy.visibleText).toBe("CODEX WEB GPT READY");
  expect(noCopy.completionActionVisible).toBeFalse();
});

test("KaTeX hydration keeps the same formula identity while real formula edits still fail", async () => {
  const html = (rendered: string, source = "x_1") => `<section id="turn"><div class="markdown">
    <p>Value <span class="katex"><span class="katex-mathml"><math><semantics>
      <mrow><mi>x</mi><mn>1</mn></mrow><annotation encoding="application/x-tex">${source}</annotation>
    </semantics></math></span><span class="katex-html" aria-hidden="true">${rendered}</span></span>.</p>
    <p>Done.</p></div></section>`;
  const initial = await snapshot(html("x 1"));
  const hydrated = await snapshot(html("x1"));
  expect(initial.markdownSegments[0]?.text).toBe("Value x_1.");
  expect(hydrated.markdownSegments[0]?.text).toBe(initial.markdownSegments[0]?.text);
  const buffer = new ChatGptMarkdownBuffer(undefined, 0);
  buffer.observe(initial.markdownSegments, 0);
  buffer.observe(hydrated.markdownSegments, 1);
  expect(buffer.finish().markdown).toBe(String.raw`Value \(x_1\).` + "\n\nDone.");
  buffer.observe((await snapshot(html("x2", "x_2"))).markdownSegments, 2);
  expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
});
