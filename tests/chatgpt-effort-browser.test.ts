import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker, setChatGptThinkMode } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_COMPOSER_SELECTOR } from "../src/chatgpt-ui/composer";
import { CHATGPT_EFFORT_CONTROL_SELECTOR, readChatGptModelControlLabel } from "../src/chatgpt-ui/model-picker";
import { detectChatGptAccountCapabilities } from "../src/chatgpt-session";
import { assertChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("pre-Send readback ignores hidden animated placeholders but rejects a real label change", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form><div id="prompt-textarea" contenteditable="true">Unsent draft</div>
      <button type="button" data-tone="neutral" aria-haspopup="menu" aria-expanded="false">
      <span aria-hidden="true" style="opacity:0;display:block">Thinking effort</span><span id="actual">GPT-6 High</span></button></form>`);
    const control = page.locator("button");
    const raw = await control.innerText();
    const mode = { selection: { url: page.url(), label: await readChatGptModelControlLabel(control) } };
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    await worker.assertSelectedEffort(page, mode);
    await page.locator('[aria-hidden="true"]').evaluate(e => { (e as HTMLElement).style.display = "inline"; });
    expect(await control.innerText()).not.toBe(raw);
    await worker.assertSelectedEffort(page, mode);
    await page.locator("#actual").evaluate(e => { e.textContent = "GPT-6 Medium"; });
    await expect(worker.assertSelectedEffort(page, mode)).rejects.toMatchObject({ code: "upstream_server_error" });
    expect(await page.locator("#prompt-textarea").innerText()).toBe("Unsent draft");
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-5.6 Pro verifies the split model/effort header before Send (#875)", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="picker" role="menu">
      <div data-model-picker-view-toggle="true"><div data-menu-row-content><span>5.6 Sol</span><span id="effort-label">5.6 Pro</span></div></div>
      <div role="menuitemradio" aria-checked="false">6</div>
      <div role="menuitemradio" aria-checked="true">GPT-5.6 Sol</div>
      <span id="status">5.6 Pro, 5 of 5.</span>
      <div role="menuitem" aria-describedby="status"><div data-model-picker-power-slider>
        <span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="4"></span>
      </div></div></div>`);
    const menu = {
      menu: page.locator("#picker"), slider: page.locator('[role="slider"]'),
    } as Parameters<typeof assertChatGptModelFamily>[0];
    await assertChatGptModelFamily(menu, "5.6", "max", 4);
    await page.locator("#effort-label").evaluate(element => { element.textContent = "6 Pro"; });
    const failure = await assertChatGptModelFamily(menu, "5.6", "max", 4).then(() => undefined, error => error);
    expect(failure).toMatchObject({ code: "model_version_unavailable", retryable: false });
  } finally { await browser.close(); }
}, 15_000);

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

// Oct 8: shared "6" row. Oct 29 (#924): localized inline trigger without the old
// tone, test ID or codex trigger. Exercise each retained control independently.
const MODEL_CONTROLS = {
  neutral: 'data-tone="neutral"',
  dropdown: 'data-testid="model-switcher-dropdown-button"',
  codexReasoning: 'data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning"',
  inlineReasoning: 'data-composer-navigation-target="reasoning" data-selected-reasoning-effort="max" aria-label="选择 ChatGPT 模型"',
} as const;

for (const [variant, attributes] of Object.entries(MODEL_CONTROLS))
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 and GPT-5.6 select efforts and verify before Send with " + variant, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form data-chatgpt-composer>
      <div contenteditable="true" data-composer-markdown role="textbox">Draft</div>
      <button type="button" ${attributes}
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
    expect(await page.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).count()).toBe(1);
    for (const [family, effort] of [["5.6", "low"], ["6", "high"], ["5.6", "medium"], ["6", "medium"]] as const) {
      const selected = await worker.selectModelAndEffort(page, "gpt-5.6-sol", effort, caps, undefined, false, family);
      expect(selected.modelFamily).toBe(family);
      await worker.assertSelectedEffort(page, selected);
      expect(await page.locator('[role=menuitemradio][aria-checked=true]').textContent()).toBe(family === "6" ? "6" : "GPT-5.6 Sol");
      expect(await page.locator('[contenteditable]').innerText()).toBe("Draft");
    }
    const selected = await worker.selectModelAndEffort(page, "gpt-5.6-sol", "medium", caps, undefined, false, "6");
    // An unchanged trigger must not conceal a different model in the menu.
    await page.locator('[role=menuitemradio][aria-checked=true]').evaluate(node => { node.textContent = "GPT-6.1 Sol"; });
    const wrongModel = await worker.assertSelectedEffort(page, selected).then(() => undefined, (error: unknown) => error);
    expect(wrongModel).toMatchObject({ code: "model_version_unavailable", retryable: false });
    await page.locator('[role=menuitemradio][aria-checked=true]').evaluate(node => { node.textContent = "6"; });
    // Change the slider behind the closed trigger; pre-Send must read its real value.
    await page.keyboard.press("ArrowRight");
    const wrongEffort = await worker.assertSelectedEffort(page, selected).then(() => undefined, (error: unknown) => error);
    expect(wrongEffort).toMatchObject({ code: "model_version_unavailable", retryable: false });
    expect(await page.locator('[contenteditable]').innerText()).toBe("Draft");
  } finally { await browser.close(); }
}, 30_000);

// Reuse the dated five/six-position fixtures: the trigger and menu roll out independently.
for (const variant of ["neutral", "inlineReasoning"] as const)
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("dated power and explicit pickers verify before Send with " + variant, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    for (const [fixture, effort, label] of [
      ["power-2026-09-29", "max", "Pro"],
      ["explicit-2026-10-28", "high", "6 Sol High"],
      ["explicit-2026-10-28", "xhigh", "6 Sol Extra High"],
      ["explicit-2026-10-28", "max", "6 Astra Max"],
    ] as const) {
      const page = await browser.newPage();
      const html = readFileSync(new URL("./fixtures/chatgpt-model-picker-" + fixture + ".html", import.meta.url), "utf8");
      const config = fixture.startsWith("power")
        ? '<script>window.pickerHeader = value => value === 4 ? "6" : "5.6"; window.pickerStatus = (effort, value) => effort + ", " + (value + 1) + " of 5.";</script>'
        : "";
      await page.setContent(config + html.replace('data-tone="neutral"', MODEL_CONTROLS[variant]));
      expect(await page.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).count()).toBe(1);
      const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
      const selected = await worker.selectModelAndEffort(page, "gpt-5.6-sol", effort, {
        localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
      }, undefined, false, "6");
      expect(selected.selection.label).toBe(label);
      await worker.assertSelectedEffort(page, selected);
      expect(await page.locator('#prompt-textarea').innerText()).toBe("Draft");
      await page.close();
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

// Sliderless-picker reproduction and initial regression cases contributed in #876.
for (const scenario of ["immediate", "delayed", "missing-family", "cancelled-slider"])
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`smoke handles a sliderless default picker (${scenario})`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const abort = new AbortController();
    await page.exposeFunction("cancelSmoke", () => abort.abort());
    await page.setContent(`<form data-chatgpt-composer>
      <div contenteditable="true" data-composer-markdown role="textbox">Draft</div>
      <button type="button" ${scenario === "delayed" ? "hidden" : ""} data-codex-intelligence-trigger="true" data-composer-navigation-target="reasoning"
        aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Medium</button></form>
      <div id="picker" role="menu" hidden><div data-model-picker-view="advanced">
        <div role="menuitemradio" aria-checked="true">6</div>
        <div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div>
        <div id="effort"></div>
      </div></div><script>
        const control=document.querySelector('button'),menu=document.querySelector('#picker');
        const view=document.querySelector('[data-model-picker-view]');
        if (${scenario === "delayed"}) setTimeout(()=>{control.hidden=false;},300);
        control.onclick=()=>{menu.hidden=false;control.setAttribute('aria-expanded','true');};
        document.querySelectorAll('[role=menuitemradio]')[1].onclick=()=>{
          document.querySelectorAll('[role=menuitemradio]').forEach((el,i)=>el.setAttribute('aria-checked',String(i===1)));
          view.setAttribute('data-model-picker-view','simple');
          if (${scenario === "cancelled-slider"}) {setTimeout(()=>window.cancelSmoke(),100);return;}
          document.querySelector('#effort').innerHTML='<span id="status" role="status">5.6 Sol High, 3 of 5.</span>'
            +'<div role="menuitem" tabindex="0" aria-describedby="status">'
            +'<div data-model-picker-power-slider style="height:30px;width:250px">'
            +'<span data-orientation="horizontal" aria-disabled="false">'
            +Array.from({length:5},(_,i)=>'<span data-selected="'+(i<=2)+'"></span>').join('')
            +'<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2"></span></span></div></div>';
          control.textContent='5.6 Sol High';
        };
        if (${scenario === "missing-family"}) document.querySelectorAll('[role=menuitemradio]')[1].remove();
        document.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.hidden=true;control.setAttribute('aria-expanded','false');}});
      </script>`);
    expect(await page.locator('[role=slider]').count()).toBe(0);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.ensurePage = async () => page;
    worker.prepareChatSurface = async () => {};
    worker.activeComposer = async () => page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    let turns = 0;
    worker.runBrowserTurn = async (options: any) => {
      turns += 1;
      expect(options.modelFamily).toBe("5.6");
      expect(options.reasoning).toBe("high");
      expect(options.capabilities).toEqual({
        solAvailable: true, extraHighAvailable: true, proAvailable: true, localToolsEnabled: false,
      });
      expect(await page.locator('[role=menuitemradio][aria-checked=true]').textContent()).toBe("GPT-5.6 Sol");
      expect(await page.locator('#picker').isVisible()).toBe(false);
      return "CODEX WEB GPT READY";
    };
    if (scenario === "missing-family" || scenario === "cancelled-slider") {
      const failure = await worker.smokeTestExclusive(abort.signal)
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject(scenario === "missing-family"
        ? { code: "model_version_unavailable", retryable: false }
        : { name: "AbortError" });
      expect(turns).toBe(0);
      expect(await page.locator('#picker').isVisible()).toBe(false);
      expect(await page.getByRole('textbox').innerText()).toBe('Draft');
    } else {
      expect(await worker.smokeTestExclusive(abort.signal)).toMatchObject({ response: "CODEX WEB GPT READY" });
      expect(turns).toBe(1);
    }
  } finally { await browser.close(); }
}, 15_000);

// Keep the real probe's full hydration budget; absence alone must never pass smoke.
for (const recognizedThink of [true, false])
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`smoke requires positive Luna control evidence (Think=${recognizedThink})`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<form data-chatgpt-composer>
      <div contenteditable="true" data-composer-markdown role="textbox">Draft</div>
      ${recognizedThink ? '<button type="button" aria-pressed="false">Think</button>' : ''}
    </form>`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.ensurePage = async () => page;
    worker.prepareChatSurface = async () => {};
    worker.activeComposer = async () => page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    let turns = 0;
    worker.runBrowserTurn = async (options: any) => {
      turns += 1;
      expect(options.modelFamily).toBeUndefined();
      expect(options.reasoning).toBe("low");
      expect(options.capabilities).toEqual({
        solAvailable: false, extraHighAvailable: false, proAvailable: false, localToolsEnabled: false,
      });
      return "CODEX WEB GPT READY";
    };
    if (recognizedThink) {
      expect(await worker.smokeTestExclusive()).toMatchObject({ response: "CODEX WEB GPT READY" });
      expect(turns).toBe(1);
    } else {
      await expect(worker.smokeTestExclusive()).rejects.toThrow("Could not identify ChatGPT's model controls");
      expect(turns).toBe(0);
    }
  } finally { await browser.close(); }
}, 40_000);
