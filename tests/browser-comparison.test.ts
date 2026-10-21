import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { ChatGptTurnDomHealthTracker, skipBoundChatGptComparison } from "../src/adapters/chatgpt-web/browser-worker";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("comparison skip is scoped, declines feedback, and does not accept a reply", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const observed = JSON.parse(readFileSync(new URL("./fixtures/comparison-observed-controls.json", import.meta.url), "utf8"));
    expect(observed.buttons.map((button: { text: string }) => button.text)).toEqual([
      "Option 1", "Option 2", "I prefer this option", "Skip",
    ]);
    // Controls are observed; wrappers and event handlers below are synthetic scope tests.
    await page.setContent(`<div id="other"><button>Option 1</button><button>Option 2</button><button>Skip</button></div>
      <div id="bound"><div data-markdown-text-style="assistant-message">EXACT_ACK</div>
        <button>Option 1</button><button>Option 2</button><button id="rate">I prefer this option</button>
        <button id="skip">Skip</button></div>
      <script>window.rated=false;window.skipped=0;
        document.querySelector('#rate').onclick=()=>window.rated=true;
        document.querySelector('#skip').onclick=()=>{window.skipped++;
          setTimeout(()=>document.querySelectorAll('#bound button').forEach(button=>button.remove()),20)};</script>`);
    const attempt = { attempted: false };
    expect(await skipBoundChatGptComparison(page.locator("#missing"), attempt)).toBe(false);
    expect(await skipBoundChatGptComparison(page.locator("#bound"), attempt)).toBe(true);
    expect(await page.evaluate(() => (window as any).rated)).toBe(false);
    expect(await page.evaluate(() => (window as any).skipped)).toBe(1);
    expect(await page.locator("#other button").count()).toBe(3);
    expect(await page.locator('[data-markdown-text-style="assistant-message"]').innerText()).toBe("EXACT_ACK");
    expect(await skipBoundChatGptComparison(page.locator("#bound"), attempt)).toBe(false);
    await page.locator('#bound').evaluate(node => { node.innerHTML='<button>Skip</button>'; });
    expect(await skipBoundChatGptComparison(page.locator("#bound"), attempt)).toBe(false);
  } finally { await browser.close(); }
}, 15000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a no-op survey dismissal is attempted once and cannot renew the health deadline", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    // Synthetic event behavior: the real failure DOM has not been captured.
    await page.setContent(`<div id="bound"><button>Option 1</button><button>Option 2</button>
      <button id="skip">Skip</button></div>
      <script>window.clicks=0;document.querySelector('#skip').onclick=()=>window.clicks++;</script>`);
    const attempt = { attempted: false };
    const health = new ChatGptTurnDomHealthTracker(100, 100, 100);
    const stalled = { responsePresent: true, running: false, currentText: "", completionActionVisible: false };
    expect(health.update(stalled, 0)).toBeUndefined();
    const progress = await skipBoundChatGptComparison(page.locator("#bound"), attempt);
    if (progress) health.suspendForProgress();
    expect(health.update(stalled, 150)).toContain("without a final answer");
    expect(progress).toBe(false);
    expect(await skipBoundChatGptComparison(page.locator("#bound"), attempt)).toBe(false);
    expect(await skipBoundChatGptComparison(page.locator("#bound"), attempt)).toBe(false);
    expect(await page.evaluate(() => (window as any).clicks)).toBe(1);
    expect(await page.locator("#skip").isVisible()).toBe(true);
  } finally { await browser.close(); }
}, 15000);
