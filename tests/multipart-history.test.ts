import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { formatChatGptWebMultipartStage } from "../src/adapters/chatgpt-web/prompt";

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const group = (key: string, text: string | undefined, answer: string, complete = true) =>
  `<div data-turn-key="${key}">${text === undefined ? "" : `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${escape(text)}</div></div>`}
    <div data-content-search-unit-key="${key}:assistant"><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message"><p>${escape(answer)}</p></div></div>
    ${complete ? '<div class="turn-action-controls"><button>Copy</button></div>' : ""}</div>`;

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a new multipart user message is accepted before ChatGPT mounts its assistant area", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const stage = {
      ...formatChatGptWebMultipartStage('{"context":"earlier"}', `ctx_${"c".repeat(32)}`, 1, 2),
      identities: ["group:assistant:stage"],
    };
    await page.setContent(`<main>${group("stage", stage.text, stage.acknowledgement)}</main>`);
    const prompt = "Use the uploaded context.";
    const baseline = await worker.captureSubmissionBaseline(page, prompt, [stage]);
    await page.locator("main").evaluate((node, text) => {
      const pending = document.createElement("div");
      pending.setAttribute("data-turn-key", "final");
      pending.innerHTML = '<div data-user-message-bubble><div data-search-result-target></div></div>';
      pending.querySelector("[data-search-result-target]")!.textContent = text;
      node.append(pending);
    }, prompt);
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    expect(baseline.acceptedUserIdentity).toBe("group:user:final");
    await page.locator('[data-turn-key="final"]').evaluate((node, html) => { node.outerHTML = html; }, group("final", prompt, "Answer"));
    expect((await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 1000)).identity).toBe("group:assistant:final");
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("acknowledged multipart history can rekey without becoming a new submission", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    for (const total of [2, 6]) {
      for (const when of ["before-baseline", "before-send", "after-send", "during-rebind"]) {
        const page = await browser.newPage();
        try {
          const stages = Array.from({ length: total - 1 }, (_, index) => ({
            ...formatChatGptWebMultipartStage(JSON.stringify({ context: `part ${index + 1}` }), `ctx_${"a".repeat(32)}`, index + 1, total),
            identities: [`group:assistant:stage-${index}`],
          }));
          const history = (persisted: boolean) => stages.map((stage, index) => group(
            `${persisted ? "persisted" : "stage"}-${index}`, persisted ? stage.text : undefined, stage.acknowledgement,
          )).join("");
          const prompt = "Use the uploaded context.\nReturn the final answer.";
          await page.setContent(`<main>${history(when === "before-baseline")}</main>`);
          let baseline = await worker.captureSubmissionBaseline(page, prompt, stages);
          const render = (html: string) => page.locator("main").evaluate((node, next) => { node.innerHTML = next; }, html);
          if (when === "before-send") {
            await render(history(true));
            expect(await worker.currentSubmissionEvidence(page, baseline)).toBeUndefined();
                  }
          await render(history(when === "before-baseline" || when === "before-send") + group("final", prompt, "Answer"));
          expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
          if (when === "after-send") {
            await render(history(true) + group("final", prompt, "Answer"));
            // A same-page CDP rebind preserves the baseline but resets its observation cache.
            baseline = { ...baseline, domCache: {} };
          }
          let binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 1000);
          expect(binding.identity).toBe("group:assistant:final");
          if (when === "during-rebind") {
            await render(history(true) + group("fallback", undefined, "Answer", false));
            binding = await worker.reconcileAssistantTurnBinding(page, baseline, binding);
            expect(binding.identity).toBe("group:assistant:fallback");
            await render(history(true) + group("final", prompt, "Answer"));
            binding = await worker.reconcileAssistantTurnBinding(page, baseline, binding);
            expect(binding.identity).toBe("group:assistant:final");
          }
          expect((await worker.responseDomSnapshot(binding.locator, {})).visibleText).toBe("Answer");
        } finally { await page.close(); }
      }
    }
  } finally { await browser.close(); }
}, 30_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("multipart history does not admit mismatched, unfinished, duplicated or unrelated exchanges", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    for (const scenario of ["payload", "acknowledgement", "unfinished", "duplicate", "old-remains", "foreign", "not-acknowledged"]) {
      const page = await browser.newPage();
      try {
        const stage = {
          ...formatChatGptWebMultipartStage('{"context":"earlier"}', `ctx_${"b".repeat(32)}`, 1, 2),
          identities: ["group:assistant:stage"],
        };
        const old = group("stage", undefined, stage.acknowledgement);
        await page.setContent(`<main>${old}</main>`);
        const baseline = await worker.captureSubmissionBaseline(page, "Final request", scenario === "not-acknowledged" ? [] : [stage]);
        const remounted = group("persisted", stage.text + (scenario === "payload" ? " altered" : ""),
          stage.acknowledgement + (scenario === "acknowledgement" ? " altered" : ""), scenario !== "unfinished");
        const extra = scenario === "old-remains" ? old
          : scenario === "duplicate" ? group("duplicate", stage.text, stage.acknowledgement)
          : scenario === "foreign" ? group("foreign", "Unrelated request", "Unrelated answer") : "";
        await page.locator("main").evaluate((node, html) => { node.innerHTML = html; },
          remounted + extra + group("final", "Final request", "Answer"));
        let failure: unknown;
        try { await worker.currentSubmissionEvidence(page, baseline); }
        catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(Error);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}, 30_000);
