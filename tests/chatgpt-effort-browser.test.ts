import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker, setChatGptThinkMode } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_COMPOSER_SELECTOR, detectChatGptAccountCapabilities } from "../src/chatgpt-session";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("Think uses the active editor in both composer layouts and survives its replacement", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    for (const modern of [false, true]) {
      await page.setContent(`<div contenteditable="true" data-composer-markdown role="textbox">Unrelated editor</div>
        <form data-chatgpt-composer>
          <div ${modern ? 'data-composer-markdown role="textbox"' : 'id="prompt-textarea"'} contenteditable="true"><span data-id="plugin:fixture" data-keyword="Codex Native2" contenteditable="false">Codex Native2</span></div>
          ${readFileSync(new URL("./fixtures/chatgpt-composer-think.html", import.meta.url), "utf8")}
        </form><script>(()=>{
          const button=document.querySelector('button');
          button.onclick=()=>{
            button.setAttribute('aria-pressed',String(button.getAttribute('aria-pressed')!=='true'));
            const editor=document.querySelector('form [contenteditable="true"]');
            editor.replaceWith(editor.cloneNode(true));
          };
        })();</script>`);
      const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
      expect(await composer.count()).toBe(1);
      await setChatGptThinkMode(composer, true);
      expect(await page.getByRole("button", { name: "Think" }).getAttribute("aria-pressed")).toBe("true");
      await setChatGptThinkMode(composer, false);
      expect(await page.getByRole("button", { name: "Think" }).getAttribute("aria-pressed")).toBe("false");
      expect(await composer.locator('[data-id="plugin:fixture"]').getAttribute("data-keyword")).toBe("Codex Native2");
      expect(await page.locator('body > [contenteditable]').innerText()).toBe("Unrelated editor");
    }
  } finally { await browser.close(); }
}, 30_000);

for (const picker of ["classic", "power", "gpt6"])
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`model selection reuses the ${picker} picker without racing Escape cleanup`, async () => {
  const modern = picker !== "classic";
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2_000);
    await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Draft</div>
      <button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Extra High</button></form>
      <div id="picker" role="menu" hidden><div ${modern ? 'data-model-picker-view="simple"' : ''}>
        <div id="toggle" role="menuitem" ${picker === "gpt6" ? '' : 'aria-hidden="false"'} aria-expanded="false" data-model-picker-view-toggle="true">Select model</div>
        <div id="models" hidden><div role="menuitemradio" aria-checked="true">${picker === "gpt6" ? '6' : 'Latest'}</div>
          <div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div></div>
        <span id="announcement">5.6 Extra High, 4 of 4.</span>
        <div role="menuitem" tabindex="0" aria-describedby="announcement">
          <div data-model-picker-power-slider style="height:30px;width:250px"><span data-orientation="horizontal" aria-disabled="false">
            ${Array(4).fill('<span data-selected="true"></span>').join('')}
            <span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="3" aria-valuenow="3"></span>
          </span></div></div>
      </div></div>
      <script>
        const control=document.querySelector('button'),menu=document.querySelector('#picker'),toggle=document.querySelector('#toggle');
        let selected=false;
        window.pickerOpens=0;
        function close(){menu.hidden=true;control.setAttribute('aria-expanded','false');control.textContent=selected?'5.6 Sol Extra High':'Extra High';}
        control.onclick=()=>{window.pickerOpens++;menu.hidden=false;control.setAttribute('aria-expanded','true');};
        toggle.onclick=()=>{document.querySelector('#models').hidden=false;toggle.setAttribute('aria-expanded','true');};
        document.querySelectorAll('[role=menuitemradio]')[1].onclick=()=>{
          selected=true;
          document.querySelectorAll('[role=menuitemradio]').forEach((e,i)=>e.setAttribute('aria-checked',String(i===1)));
          document.querySelector('#models').hidden=true;
        };
        document.addEventListener('keydown',e=>{if(e.key==='Escape'){close();setTimeout(close,150);}});
      </script>`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const result = await worker.selectModelAndEffort(page, "gpt-5.6-sol", "xhigh", {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
    }, undefined, false, "5.6");
    expect(result.selection.label).toBe("5.6 Sol Extra High");
    expect(await page.evaluate(() => (window as any).pickerOpens)).toBe(2);
    expect(await page.locator('#prompt-textarea').innerText()).toBe("Draft");
  } finally { await browser.close(); }
}, 30_000);

// Captured in the Plus DEV launcher on Oct 8: the new default row is just "6",
// the model toggle omits aria-hidden, and GPT-6's header shows only the effort.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 and GPT-5.6 remain distinct across effort changes and pre-send verification", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form data-chatgpt-composer>
      <div contenteditable="true" data-composer-markdown role="textbox">Draft</div>
      <button type="button" data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning"
        aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Medium</button></form>
      <div id="picker" role="menu" hidden><div data-model-picker-view="simple">
        <div role="menuitem" data-model-picker-view-toggle="true" tabindex="0"><div data-menu-row-content>Medium</div></div>
        <span id="status" role="status">6 Medium, 2 of 3.</span>
        <div role="menuitem" tabindex="-1" aria-describedby="status"><div data-model-picker-power-slider style="height:30px;width:250px"></div></div>
        <div id="models" hidden><div role="menuitemradio" aria-checked="true">6</div>
          <div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div></div>
      </div></div><script>
        const control=document.querySelector('button'),menu=document.querySelector('#picker'),view=document.querySelector('[data-model-picker-view]');
        const toggle=document.querySelector('[data-model-picker-view-toggle]'), models=document.querySelector('#models');
        const labels=['Instant','Medium','High']; let family='6',value=1;
        function render(){
          document.querySelector('#status').textContent=family+' '+labels[value]+', '+(value+1)+' of 3.';
          toggle.firstElementChild.textContent=(family==='6'?'':'5.6 Sol ')+labels[value];
          document.querySelector('[data-model-picker-power-slider]').innerHTML='<span data-orientation="horizontal" aria-disabled="false">'
            +labels.map((_,i)=>'<span data-selected="'+(i<=value)+'"></span>').join('')
            +'<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="2" aria-valuenow="'+value+'"></span></span>';
        }
        control.onclick=()=>{menu.hidden=false;control.setAttribute('aria-expanded','true');render();};
        toggle.onclick=()=>{view.setAttribute('data-model-picker-view','advanced');models.hidden=false;};
        document.querySelectorAll('[role=menuitemradio]').forEach((radio,index)=>{radio.onclick=()=>{
          family=index===0?'6':'5.6';
          document.querySelectorAll('[role=menuitemradio]').forEach((el,i)=>el.setAttribute('aria-checked',String(i===index)));
          models.hidden=true;view.setAttribute('data-model-picker-view','simple');render();
        };});
        document.addEventListener('keydown',e=>{
          if(e.key==='Escape'){menu.hidden=true;control.setAttribute('aria-expanded','false');control.textContent=(family==='6'?'':'5.6 Sol ')+labels[value];}
          if(e.key==='ArrowRight'||e.key==='ArrowLeft'){value+=e.key==='ArrowRight'?1:-1;render();e.preventDefault();}
        });render();
      </script>`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const caps = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
    for (const [family, effort] of [["5.6", "low"], ["6", "high"], ["5.6", "medium"], ["6", "medium"]] as const) {
      const selected = await worker.selectModelAndEffort(page, "gpt-5.6-sol", effort, caps, undefined, false, family);
      expect(selected.modelFamily).toBe(family);
      await worker.assertSelectedEffort(page, selected);
      expect(await page.locator('[role=menuitemradio][aria-checked=true]').textContent()).toBe(family === "6" ? "6" : "GPT-5.6 Sol");
      expect(await page.locator('[contenteditable]').innerText()).toBe("Draft");
    }
  } finally { await browser.close(); }
}, 30_000);

for (const scenario of ["hydrate", "shrink", "locked", "pro-disappears"])
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`real slider ${scenario} keeps the requested available effort`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Draft</div>
      <button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Instant</button></form>
      <div id="picker" role="menu" hidden><div role="menuitem" tabindex="0"><div data-model-picker-power-slider style="height:30px;width:250px"></div></div></div>
      <script>
        let value=0, max=4, opens=0;
        const scenario=${JSON.stringify(scenario)}, control=document.querySelector('button'), menu=document.querySelector('#picker');
        function render(ticks=max+1) {
          document.querySelector('[data-model-picker-power-slider]').innerHTML='<span data-orientation="horizontal" aria-disabled="false">'
            +Array.from({length:ticks},(_,i)=>'<span data-selected="'+(i<=value)+'"'+(scenario==='locked'&&opens>1&&i===2?' data-locked="true"':'')+'></span>').join('')
            +'<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="'+max+'" aria-valuenow="'+value+'"></span></span>';
        }
        control.onclick=()=>{
          opens++; menu.hidden=false; control.setAttribute('aria-expanded','true');
          if(opens>1&&(scenario==='shrink'||scenario==='pro-disappears'))max=3;
          value=Math.min(value,max); render(scenario==='hydrate'&&opens===1?4:max+1);
          if(scenario==='hydrate'&&opens===1)setTimeout(()=>{max=3;render()},100);
        };
        document.addEventListener('keydown',e=>{
          if(e.key==='Escape'){menu.hidden=true;control.setAttribute('aria-expanded','false');control.textContent=['Instant','Medium','High','Extra High','Pro'][value];}
          else if(e.key==='ArrowRight'||e.key==='ArrowLeft'){value+=e.key==='ArrowRight'?1:-1;render();e.preventDefault();}
        });
        render();
      </script>`);
    if (scenario === "hydrate") {
      expect(await detectChatGptAccountCapabilities(page)).toEqual({ solAvailable: true, extraHighAvailable: true, proAvailable: false });
    } else {
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const effort = scenario === "pro-disappears" ? "max" : scenario === "locked" ? "high" : "xhigh";
      const result = worker.selectModelAndEffort(page, "gpt-5.6-sol", effort, {
        localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
      });
      if (scenario === "shrink") expect((await result).selection.label).toBe("Extra High");
      else {
        // Await Playwright before asserting: Bun's async rejection matcher can stall its I/O.
        const failure = await result.then(() => undefined, (error: unknown) => error);
        expect(failure).toMatchObject({ retryable: false });
      }
    }
    expect(await page.locator('#prompt-textarea').innerText()).toBe("Draft");
    await page.close();
  } finally { await browser.close(); }
}, 120_000);
