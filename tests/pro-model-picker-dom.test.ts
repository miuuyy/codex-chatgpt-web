import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

// Opt in with an existing Chromium executable. This never connects to a user profile.
const executablePath = process.env.CHATGPT_PICKER_TEST_CHROME;
describe.skipIf(!executablePath)("offline model-picker DOM regression", () => {
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({
    executablePath: executablePath,
    headless: true,
  });
}, 20_000);
afterAll(async () => { await browser?.close(); }, 15_000);

// Matches the relevant installed ChatGPT picker structure observed 2026-09-14:
// the owned advanced view remains attached and geometrically visible while inert.
// No account, network request, or ChatGPT prompt is involved in these DOM tests.
async function fixture(initialFamily = "6") {
  const context = await browser.newContext();
  await context.route("**/*", route => route.abort());
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><style>
    [inert] { pointer-events: none; } button,[role=menuitemradio],[role=menuitem] { padding:10px; }
    [data-model-reasoning-effort-slider] {width:200px;height:20px;background:#bbb;}
    #picker { position:absolute;left:50px;top:80px;width:300px;background:#eee; }
    #decoy {position:absolute;left:600px;top:80px;}
  </style></head><body>
    <form><div id="prompt-textarea" contenteditable="true" role="textbox"></div>
      <button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Pro</button>
      <button type="submit" data-testid="send-button">Send</button>
    </form>
    <div id="picker" role="menu" hidden>
      <div role="menuitem" tabindex="0" aria-label="选择模型" aria-expanded="false">Select model</div>
      <div role="menuitem" tabindex="0" aria-label="能力" aria-describedby="live-state instructions">
        <div data-model-reasoning-effort-slider><span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="0"></span></div>
      </div>
      <div data-testid="composer-model-picker-slider-advanced-view" inert>
        <div role="group">
          <div role="menuitemradio" data-family="6" aria-checked="true">Latest</div>
          <div role="menuitemradio" data-family="5.6" aria-checked="false">GPT-5.6 Sol</div>
          <div role="menuitemradio" data-family="5.5" aria-checked="false">GPT-5.5</div>
        </div>
      </div>
      <span id="live-state"></span><span id="instructions">Use arrow keys.</span>
    </div>
    <div id="decoy" role="menu"><div role="menuitemradio" aria-checked="true">GPT-5.6 Sol</div></div>
    <script>
      const picker = document.getElementById('picker');
      const control = document.querySelector('form button[aria-haspopup]');
      const trigger = picker.querySelector('[aria-label="选择模型"]');
      const advanced = picker.querySelector('[data-testid]');
      const slider = picker.querySelector('[role="slider"]');
      const keyboard = picker.querySelector('[aria-label="能力"]');
      window.actions = []; window.family = ${JSON.stringify(initialFamily)};
      function paint(){
        const v=Number(slider.getAttribute('aria-valuenow'));
        const rendered=window.family==='6' && v<4 ? '5.6' : window.family;
        document.getElementById('live-state').textContent=rendered+' '+['Instant','Medium','High','Extra High','Pro'][v]+', item '+(v+1)+' of 5.';
        for(const row of advanced.querySelectorAll('[role="menuitemradio"]'))row.setAttribute('aria-checked',String(row.dataset.family===window.family));
      }
      function fold(){trigger.setAttribute('aria-expanded','false');advanced.inert=true;}
      control.addEventListener('click',()=>{picker.hidden=false;control.setAttribute('aria-expanded','true');fold();});
      trigger.addEventListener('click',()=>{window.actions.push('open-models');trigger.setAttribute('aria-expanded','true');advanced.inert=false;});
      for(const row of advanced.querySelectorAll('[role="menuitemradio"]'))row.addEventListener('click',()=>{window.actions.push('select:'+row.dataset.family);window.family=row.dataset.family;fold();paint();});
      keyboard.addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){slider.setAttribute('aria-valuenow',String(Number(slider.getAttribute('aria-valuenow'))+(e.key==='ArrowRight'?1:-1)));paint();}});
      document.addEventListener('keydown',e=>{if(e.key==='Escape'){picker.hidden=true;control.setAttribute('aria-expanded','false');fold();}});
      document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.actions.push('SEND');});
      document.getElementById('decoy').addEventListener('click',()=>window.actions.push('DECOY'));
      paint();
    </script></body></html>`);
  const select = (ChatGptBrowserWorker.prototype as any).selectModelAndEffort;
  return { page, context, select: (version: string, effort = "max") => select.call(
    { activeComposer: async () => page.locator("#prompt-textarea") }, page, "gpt-5.6-sol", effort,
    { localToolsEnabled: false, solAvailable: true, proAvailable: true, proModelVersion: version },
    undefined, effort === "xhigh" ? version : undefined,
  ) };
}

test("real DOM: geometrically visible inert model rows must be expanded before selection", async () => {
  const f = await fixture();
  try {
    await f.page.locator('form button[aria-haspopup]').click();
    const row = f.page.locator('#picker').getByRole('menuitemradio', { name: 'GPT-5.6 Sol', exact: true, includeHidden: true });
    expect(await row.isVisible()).toBe(true);
    expect(await row.evaluate(el => !!el.closest('[inert]'))).toBe(true);
    await f.select('5.6');
    expect(await f.page.locator('#live-state').textContent()).toBe('5.6 Pro, item 5 of 5.');
    expect(await f.page.evaluate(() => (window as any).actions)).toEqual(['open-models', 'select:5.6']);
    expect(await f.page.locator('#prompt-textarea').textContent()).toBe('');
  } finally { await f.context.close(); }
}, 15_000);

test("real DOM: hidden checked family is reused for Extra High without opening or choosing again", async () => {
  const f = await fixture('5.6');
  try {
    await f.select('5.6','xhigh');
    expect(await f.page.locator('#live-state').textContent()).toBe('5.6 Extra High, item 4 of 5.');
    expect(await f.page.evaluate(() => (window as any).actions)).toEqual([]);
  } finally { await f.context.close(); }
}, 15_000);

});
