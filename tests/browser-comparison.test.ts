import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { skipBoundChatGptComparison } from "../src/adapters/chatgpt-web/browser-worker";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("comparison skip is scoped, declines feedback, and does not accept a reply", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="other"><button>Option 1</button><button>Option 2</button><button>Skip</button></div>
      <div id="bound"><div data-markdown-text-style="assistant-message">EXACT_ACK</div>
        <button>Option 1</button><button>Option 2</button><button id="rate">I prefer this option</button>
        <button id="skip">Skip</button></div>
      <script>window.rated=false;window.skipped=0;
        document.querySelector('#rate').onclick=()=>window.rated=true;
        document.querySelector('#skip').onclick=()=>{window.skipped++;document.querySelector('#skip').remove()};</script>`);
    expect(await skipBoundChatGptComparison(page.locator("#missing"))).toBe(false);
    expect(await skipBoundChatGptComparison(page.locator("#bound"))).toBe(true);
    expect(await page.evaluate(() => (window as any).rated)).toBe(false);
    expect(await page.evaluate(() => (window as any).skipped)).toBe(1);
    expect(await page.locator("#other button").count()).toBe(3);
    expect(await page.locator('[data-markdown-text-style="assistant-message"]').innerText()).toBe("EXACT_ACK");
    expect(await skipBoundChatGptComparison(page.locator("#bound"))).toBe(false);
    await page.locator('#bound').evaluate(node => { node.innerHTML='<button>Skip</button>'; });
    expect(await skipBoundChatGptComparison(page.locator("#bound"))).toBe(false);
  } finally { await browser.close(); }
}, 15000);
