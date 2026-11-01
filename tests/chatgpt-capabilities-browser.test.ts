import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { detectChatGptAccountCapabilities } from "../src/chatgpt-session";
import { ChatGptBrowserWorker, setChatGptThinkMode } from "../src/adapters/chatgpt-web/browser-worker";

const browserPath = process.env.CHATGPT_DOM_TEST_BROWSER;
const probe = { selectorTimeoutMs: 150, stableAbsenceMs: 0 };

test.skipIf(!browserPath)("setup reads the October inline control on paid accounts and rejects stale Luna selection (#932)", async () => {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    for (const { paidRange, locked } of [
      { paidRange: 3, locked: false }, { paidRange: 5, locked: false }, { paidRange: 5, locked: true },
    ]) {
      const page = await browser.newPage();
      let html = readFileSync(new URL('./fixtures/chatgpt-model-picker-power-2026-09-29.html', import.meta.url), 'utf8')
        .replace('data-tone="neutral"', 'data-composer-navigation-target="reasoning" data-selected-reasoning-effort="medium" aria-label="选择 ChatGPT 模型"');
      if (paidRange === 3) html = html.replace('["Instant", "Medium", "High", "Extra High", "Pro"]', '["Instant", "Medium", "High"]')
        .replaceAll('aria-valuemax="4"', 'aria-valuemax="2"').replace('Math.min(4,', 'Math.min(2,');
      await page.setContent('<script>window.pickerHeader=()=>"6";window.pickerStatus=(effort,value)=>`6 ${effort}, ${value+1}.`;</script>' + html);
      await page.evaluate(({ locked }) => {
        const control = document.querySelector('button')!;
        control.addEventListener('keydown', event => {
          if (event.key === 'Enter') event.preventDefault();
        });
        document.querySelector('form')!.dataset.submissions = '0';
        document.querySelector('form')!.addEventListener('submit', event => {
          event.preventDefault();
          const form = document.querySelector('form')!;
          form.dataset.submissions = String(Number(form.dataset.submissions) + 1);
        });
        if (locked) {
          const original = control.onclick!;
          control.onclick = function (event) {
            original.call(this, event);
            const ticks = document.querySelectorAll('[data-orientation="horizontal"] > [data-selected]');
            for (const tick of Array.from(ticks).slice(3)) tick.setAttribute('data-locked', 'true');
          };
        }
      }, { locked });
      const composer = page.locator('#prompt-textarea');
      const draft = await composer.innerHTML();
      expect(await detectChatGptAccountCapabilities(page, probe)).toEqual({
        solAvailable: true, extraHighAvailable: paidRange === 5 && !locked, proAvailable: paidRange === 5 && !locked,
      });
      expect(await page.locator('#picker').isVisible()).toBeFalse();
      expect(await composer.innerHTML()).toBe(draft);
      expect(await page.locator('form').getAttribute('data-submissions')).toBe('0');
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      for (const reasoning of ['low', 'medium']) {
        await expect(worker.selectModelAndEffort(page, 'gpt-5.6-luna', reasoning,
          { localToolsEnabled: false, solAvailable: false, extraHighAvailable: false, proAvailable: false }))
          .rejects.toMatchObject({ code: 'chatgpt_capabilities_stale', retryable: false });
      }
      expect(await composer.innerHTML()).toBe(draft);
      await page.close();
    }
  } finally { await browser.close(); }
}, 20_000);

test.skipIf(!browserPath)("only a unique recognized Think control proves a Luna account, without clicking or submitting", async () => {
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  try {
    const page = await browser.newPage();
    const think = readFileSync(new URL('./fixtures/chatgpt-composer-think-2026-10-28.html', import.meta.url), 'utf8');
    for (const controls of [think, '<button type="button" aria-pressed="true">Think</button>']) {
      await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Keep my draft</div>${controls}</form>`);
      const before = await page.locator('form').innerHTML();
      expect(await detectChatGptAccountCapabilities(page, probe)).toEqual({ solAvailable: false, extraHighAvailable: false, proAvailable: false });
      expect(await page.locator('form').innerHTML()).toBe(before);
    }
    for (const controls of [
      '', '<button aria-haspopup="menu" data-composer-navigation-target="reasoning">6 High</button>',
      '<button type="button" aria-pressed="false" hidden>Think</button>',
      '<button type="button">Think</button>',
      '<button type="button" aria-pressed="false">Think harder</button>',
      '<button type="button" aria-pressed="false">Think</button><button type="button" aria-pressed="true">Think</button>',
    ]) {
      await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Keep my draft</div>${controls}</form>
        <button type="button" aria-pressed="false">Think</button>`);
      await expect(detectChatGptAccountCapabilities(page, probe)).rejects.toThrow("Could not identify ChatGPT's model controls");
      expect(await page.locator('#prompt-textarea').innerText()).toBe('Keep my draft');
    }
    await page.setContent('<form><div id="prompt-textarea" contenteditable="true">Keep my draft</div></form>');
    await expect(setChatGptThinkMode(page.locator('#prompt-textarea'), false))
      .rejects.toMatchObject({ code: 'chatgpt_model_controls_unavailable', retryable: false });
    expect(await page.locator('#prompt-textarea').innerText()).toBe('Keep my draft');
  } finally { await browser.close(); }
}, 60_000);
