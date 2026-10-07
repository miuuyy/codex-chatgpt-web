import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, chatGptTurnIsComplete } from "../src/adapters/chatgpt-web/browser-worker";
import { formatChatGptWebMultipartStage } from "../src/adapters/chatgpt-web/prompt";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const group = (key: string, text: string, answer: string) => `<section data-turn-key="${key}">
  <div data-user-message-bubble><pre data-search-result-target>${escape(text)}</pre></div>
  <div data-content-search-unit-key="${key}:assistant"><div data-conversation-role="assistant"></div>
    <div data-markdown-text-style="assistant-message"><p>${escape(answer)}</p></div></div>
  <div class="turn-action-controls"><button data-testid="copy-turn-action-button">Copy</button></div></section>`;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

for (const chars of [320_000, 1_000_000]) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`${chars} history characters preserve identities, active response and controls`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
      await page.route("**/*", route => route.abort());
      const text = "source line\n".repeat(Math.ceil(chars / 12)).slice(0, chars);
      const groups = Array.from({ length: 8 }, (_, index) => group(`history_${index}`,
        text.slice(index * chars / 8, (index + 1) * chars / 8), index === 7 ? "Current tool boundary" : "Earlier answer"));
      await page.setContent(`<style>pre{white-space:pre-wrap}section{padding:8px}</style><main>${groups.join("")}</main>
        <footer><button id="model">GPT-5.6</button><button id="effort">High</button>
        <div id="prompt-textarea" contenteditable="true">Unsent draft</div></footer>`);
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const payload = () => page.locator("[data-search-result-target]").allTextContents();
      const original = (await payload()).join("");
      expect(original.length).toBe(chars);
      const cache: Record<string, unknown> = {};
      const first = await worker.submissionDomState(page, cache);
      expect(first.userTurnCount).toBe(8);
      expect(first.assistantTurnCount).toBe(8);
      expect(await page.locator('[data-codex-history-render-budget="auto"]').count()).toBe(6);
      expect(await page.locator('[data-turn-key="history_6"]').getAttribute("data-codex-history-render-budget")).toBeNull();
      expect(await page.locator('[data-turn-key="history_7"]').getAttribute("data-codex-history-render-budget")).toBeNull();
      expect(await worker.submissionDomState(page, cache)).toEqual(first);
      expect(cache.cacheHits).toBeGreaterThan(0);
      expect(await page.locator("#codex-history-render-budget").count()).toBe(1);
      const current = page.locator('[data-turn-key="history_7"]');
      await current.scrollIntoViewIfNeeded();
      const response = await worker.responseDomSnapshot(current, {});
      expect(response.visibleText).toBe("Current tool boundary");
      expect(response.completionActionVisible).toBeTrue();
      expect(await current.evaluate(node => getComputedStyle(node).contentVisibility)).toBe("visible");
      const progress = new ChatGptExternalTurnProgress(), tracker = new ChatGptCompletionTracker();
      const revision = progress.recordToolBatch(1), events: string[] = [];
      tracker.observeToolBatch(revision, response.visibleText); events.push("capture");
      progress.acknowledgeToolBatch(revision); events.push("ack");
      await progress.waitForToolBatchObservation(revision); events.push("emission");
      expect(events).toEqual(["capture", "ack", "emission"]);
      const completion = { responsePresent: true, running: false, currentText: response.visibleText, completionActionVisible: true };
      expect(chatGptTurnIsComplete(completion)).toBeTrue();
      expect(chatGptTurnIsComplete({ ...completion, running: true })).toBeFalse();
      expect(await page.locator("#model").textContent()).toBe("GPT-5.6");
      expect(await page.locator("#effort").textContent()).toBe("High");
      expect(await page.locator("#prompt-textarea").textContent()).toBe("Unsent draft");
      expect(digest((await payload()).join(""))).toBe(digest(original));
      await page.locator("main").evaluate((node, html) => node.insertAdjacentHTML("beforeend", html), group("next", "Next input", "Next answer"));
      await worker.submissionDomState(page, cache);
      expect(await page.locator('[data-turn-key="history_6"]').getAttribute("data-codex-history-render-budget")).toBe("auto");
      expect(await page.locator('[data-turn-key="history_7"]').getAttribute("data-codex-history-render-budget")).toBeNull();
      expect(await page.locator('[data-turn-key="next"]').getAttribute("data-codex-history-render-budget")).toBeNull();
    } finally { await browser.close(); }
  }, 30_000);
}

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("legacy identities and nested turn wrappers retain only top-level history budgets", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(Array.from({ length: 6 }, (_, index) => `<div data-turn-id-container="legacy_${index}">
      <section data-testid="conversation-turn-${index}" data-turn="${index % 2 ? "assistant" : "user"}" data-turn-id="legacy_${index}">
      <div data-turn-id-container="legacy_${index}">Text ${index}</div></section></div>`).join(""));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    expect((await worker.submissionDomState(page)).turnIdentities).toEqual(Array.from({ length: 6 }, (_, index) => `legacy_${index}`));
    expect(await page.locator('[data-codex-history-render-budget="auto"]').count()).toBe(4);
    expect(await page.locator('[data-turn-id-container] [data-turn-id-container][data-codex-history-render-budget]').count()).toBe(0);
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("deferred receipts require exact source, a readable plain ACK and following completion", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    for (const scenario of ["valid", "hidden-source", "hidden-ack", "quoted-ack", "hidden-copy", "preceding-copy", "duplicate-answer"]) {
      const page = await browser.newPage();
      try {
        const stage = { ...formatChatGptWebMultipartStage('{"context":"earlier"}', `ctx_${"a".repeat(32)}`, 1, 2), identities: ["group:assistant:old"] };
        await page.setContent(`<main>${group("old", stage.text, stage.acknowledgement)}${group("history", "Earlier input", "Earlier answer")}</main>`);
        const baseline = await worker.captureSubmissionBaseline(page, "Final input", [stage]);
        await page.locator("main").evaluate((node, html) => { node.innerHTML = html; },
          group("persisted", stage.text, stage.acknowledgement) + group("history", "Earlier input", "Earlier answer") + group("final", "Final input", "Final answer"));
        await worker.submissionDomState(page);
        const persisted = page.locator('[data-turn-key="persisted"]');
        expect(await persisted.getAttribute("data-codex-history-render-budget")).toBe("auto");
        await persisted.evaluate((node, scenario) => {
          const source = node.querySelector<HTMLElement>("[data-search-result-target]")!;
          Object.defineProperty(source, "innerText", { get: () => "" });
          const answer = node.querySelector<HTMLElement>('[data-markdown-text-style="assistant-message"]')!;
          const copy = node.querySelector<HTMLElement>("button")!;
          if (scenario === "hidden-source") source.hidden = true;
          if (scenario === "hidden-ack") answer.style.display = "none";
          if (scenario === "quoted-ack") { const code = document.createElement("pre"); code.textContent = answer.textContent; answer.replaceChildren(code); }
          if (scenario === "hidden-copy") copy.hidden = true;
          if (scenario === "preceding-copy") node.prepend(copy.parentElement!);
          if (scenario === "duplicate-answer") answer.parentElement!.append(answer.cloneNode(true));
        }, scenario);
        if (scenario === "valid") {
          expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
          expect(stage.identities).toContain("group:assistant:persisted");
          expect(baseline.acceptedUserIdentity).toBe("group:user:final");
        } else {
          await expect(worker.currentSubmissionEvidence(page, baseline)).rejects.toThrow("acknowledged Bigger Context exchange");
          expect(stage.identities).not.toContain("group:assistant:persisted");
        }
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}, 30_000);
