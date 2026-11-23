// Reproduction contributed by @alexalok in PR #730; explicit picker by @nofihq in #921.
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { readChatGptUsageModel } from "../src/adapters/chatgpt-web/limits";

// October 28 picker: Default mixes model families; explicit Sol has five
// positions and explicit Astra has six. Never infer a family from Default.
const EXPLICIT_PICKER = readFileSync(new URL("./fixtures/chatgpt-model-picker-explicit-2026-10-28.html", import.meta.url), "utf8");

for (const [effort, label, usageModel] of [["high", "6 Sol High", "other"], ["xhigh", "6 Sol Extra High", "other"], ["max", "6 Astra Max", "gpt-6-pro"]] as const) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`explicit picker selects exact GPT-6 ${effort} beside GPT-6.1`, async () => {
    const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
    try {
      const page=await browser.newPage();await page.setContent(EXPLICIT_PICKER);
      const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
      const mode=await worker.selectModelAndEffort(page,CHATGPT_WEB_MODEL_ID,effort,{localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true},undefined,true,"6");
      expect(mode.selection.label).toBe(label);expect(mode.usageModel).toBe(usageModel);
      expect(await page.locator('#prompt-textarea').innerText()).toBe('Draft');
    } finally {await browser.close();}
  },30_000);
}

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("explicit picker refuses absent GPT-6 Sol and conflicting GPT-6.1 evidence",async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHATGPT_DOM_TEST_BROWSER,headless:true});
  try {
    for(const scenario of ['omitSol','conflictingHeader']){
      const page=await browser.newPage();await page.setContent('<script>window.'+scenario+'=true;</script>'+EXPLICIT_PICKER);
      const worker=Object.create(ChatGptBrowserWorker.prototype) as any;
      let failure: unknown;
      try {
        await worker.selectModelAndEffort(page,CHATGPT_WEB_MODEL_ID,'high',{localToolsEnabled:false,solAvailable:true,extraHighAvailable:true,proAvailable:true},undefined,false,'6');
      } catch (error) { failure=error; }
      expect(String(failure)).toContain('could not be selected and verified');
      expect(await page.locator('#prompt-textarea').innerText()).toBe('Draft');await page.close();
    }
  }finally{await browser.close();}
},30_000);

// Mirrors ChatGPT's power picker as captured live on 2026-09-29 (English, Pro account): the slider
// announcement reads only "Pro, 5 of 5." and the model version appears in the "Select model"
// header as <span>6</span><span data-maximum>Pro</span>. Older pickers announced "6 Pro, 5 of 5.".
type Picker = {
  /** Header version per slider value; null removes the header like older pickers. */
  header: ((value: number) => string) | null;
  /** Slider announcement per effort label and slider value. */
  status: (effort: string, value: number) => string;
};

const PICKERS = {
  splitHeader: { header: (value: number) => value === 4 ? "6" : "5.6", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  versionedAnnouncement: { header: null, status: (effort: string, value: number) => (value === 4 ? "6 " : "5.6 ") + effort + ", " + (value + 1) + " of 5." },
  future: { header: (value: number) => value === 4 ? "7" : "5.6", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  versionless: { header: () => "", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  conflicting: { header: (value: number) => value === 4 ? "6" : "5.6", status: (effort: string, value: number) => (value === 4 ? "5.6 " : "") + effort + ", " + (value + 1) + " of 5." },
} satisfies Record<string, Picker>;

const FIXTURE = readFileSync(new URL("./fixtures/chatgpt-model-picker-power-2026-09-29.html", import.meta.url), "utf8");

async function selectGpt6Pro(picker: Picker) {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    const config = "<script>window.pickerHeader = " + (picker.header ? picker.header.toString() : "null")
      + "; window.pickerStatus = (_effort, value) => "
      + JSON.stringify(["Instant", "Medium", "High", "Extra High", "Pro"].map((effort, value) => picker.status(effort, value)))
      + "[value];</script>";
    await page.setContent(config + FIXTURE);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    try {
      const mode = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "max", {
        localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true,
      }, undefined, true, "6");
      return { ok: true, label: mode.selection.label, usageModel: mode.usageModel, draft: await page.locator("#prompt-textarea").innerText() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), draft: await page.locator("#prompt-textarea").innerText() };
    }
  } finally {
    await browser.close();
  }
}

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro is verified from the September 29 split picker header when the slider announces only the effort", async () => {
  expect(await selectGpt6Pro(PICKERS.splitHeader)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro is still verified from the versioned slider announcement", async () => {
  expect(await selectGpt6Pro(PICKERS.versionedAnnouncement)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
}, 60_000);

for (const scenario of ["future", "versionless", "conflicting"] as const)
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro fails closed when the picker's model evidence is " + scenario, async () => {
  const result = await selectGpt6Pro(PICKERS[scenario]);
  expect(result.ok).toBe(false);
  expect(result.message).toContain("ChatGPT model 6 could not be selected and verified");
  expect(result.draft).toBe("Draft");
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("model evidence excludes inactive and foreign picker headers and rejects multiple active headers", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div role="menu" id="owned">
      <div data-model-picker-view-toggle="true" id="active"><div data-menu-row-content>
        <span>6</span><span>Pro</span><span hidden>5.6</span>
      </div></div>
      <div role="menuitem" aria-describedby="status"><span role="slider"></span></div>
      <span id="status">Pro, 5 of 5.</span>
      <div hidden><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
      <div inert><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
      <div aria-hidden="true"><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
      <div style="display:none"><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
      <div role="menu"><div data-model-picker-view-toggle="true">5.6 Pro</div></div>
    </div><div role="menu"><div data-model-picker-view-toggle="true">5.6 Pro</div></div>`);
    const slider = page.getByRole("slider");
    expect(await readChatGptUsageModel(slider, true)).toBe("gpt-6-pro");
    await page.locator("#active").evaluate(element => element.setAttribute("hidden", ""));
    expect(await readChatGptUsageModel(slider, true)).toBe("pro-unknown");
    await page.locator("#active").evaluate(element => {
      element.removeAttribute("hidden");
      element.after(element.cloneNode(true));
    });
    await expect(readChatGptUsageModel(slider, true)).rejects.toThrow("multiple active model headers");
  } finally {
    await browser.close();
  }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("localized position punctuation works through actual picker selection and usage readback", async () => {
  for (const separator of ["、", "،", "；", "—"]) {
    const picker: Picker = { header: null, status: (effort, value) => `${value === 4 ? "6" : "5.6"} ${effort}${separator}5 件中 ${value + 1} 番目。` };
    expect(await selectGpt6Pro(picker)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
  }
}, 60_000);

// Reconstructed from live November 23 DEV capture: Latest (6.2 Sol + 6 Pro), explicit 6 (with "6 6 <effort>" header), GPT-5.6 Sol.
const nov23Picker = (oldLatest = false) => `<form><div id="prompt-textarea" contenteditable="true">Draft</div>
  <button type="button" data-composer-navigation-target="reasoning" data-selected-reasoning-effort="medium" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">${oldLatest ? "6 Medium" : "6.2 Medium"}</button></form>
  <div id="picker" role="menu" hidden><div data-model-picker-view="simple">
    <div id="simple" data-active="true" aria-hidden="false">
      <div role="menuitem" data-model-picker-view-toggle="true" tabindex="0"><div data-menu-row-content><span id="model"></span><span id="effort"></span></div></div>
      <span role="status" id="status"></span><span id="hint">Use Left and Right arrow keys to adjust power</span>
      <div role="menuitem" aria-describedby="status hint" tabindex="-1"><div data-model-picker-power-slider style="height:30px;width:250px"></div></div>
    </div>
    <div id="advanced" aria-hidden="true" inert>
      <div role="menuitemradio" aria-checked="true" data-model-selected="true"><div data-menu-row-content><span>Latest</span></div></div>
      <div role="menuitemradio" aria-checked="false"><div data-menu-row-content><span>6</span></div></div>
      <div role="menuitemradio" aria-checked="false"><div data-menu-row-content><span>GPT-5.6 Sol</span></div></div>
    </div>
  </div></div><script>(() => {
    const oldLatest = ${JSON.stringify(oldLatest)};
    const button=document.querySelector('button'), menu=document.querySelector('#picker');
    const simple=document.querySelector('#simple'), advanced=document.querySelector('#advanced');
    const efforts=['Instant','Medium','High','Extra High','Pro'];
    let selected='Latest', value=1;
    function render() {
      const e=efforts[value];
      let modelText='', effortText='', statusText='';
      if (selected==='Latest') {
        if (value===4) { modelText='6'; effortText='6 Pro'; statusText='6 Pro, 5 of 5.'; }
        else { modelText=oldLatest?'6':'6.2'; effortText=e; statusText=(oldLatest?'6 ':'6.2 ')+e+', '+(value+1)+' of 5.'; }
      } else if (selected==='6') {
        modelText='6'; effortText='6 '+e; statusText='6 '+e+', '+(value+1)+' of 5.';
      } else {
        modelText='5.6 Sol'; effortText='5.6 '+e; statusText='5.6 '+e+', '+(value+1)+' of 5.';
      }
      document.querySelector('#model').textContent=modelText;
      document.querySelector('#effort').textContent=effortText;
      document.querySelector('#status').textContent=statusText;
      document.querySelector('[data-model-picker-power-slider]').innerHTML='<span data-orientation="horizontal" aria-disabled="false">'+efforts.map((_,i)=>'<span data-selected="'+(i<=value)+'"></span>').join('')+'<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="'+value+'"></span></span>';
    }
    function view(adv) {
      document.querySelector('[data-model-picker-view]').setAttribute('data-model-picker-view',adv?'advanced':'simple');
      simple.inert=adv; simple.setAttribute('aria-hidden',String(adv)); simple.style.display=adv?'none':'';
      advanced.inert=!adv; advanced.setAttribute('aria-hidden',String(!adv)); advanced.style.display=adv?'':'none';
    }
    button.onclick=()=>{menu.hidden=false;button.setAttribute('aria-expanded','true');view(false);render();};
    document.querySelector('[data-model-picker-view-toggle]').onclick=()=>view(true);
    for(const row of advanced.children) row.onclick=()=>{selected=row.textContent.trim();for(const other of advanced.children)other.setAttribute('aria-checked',String(other===row));view(false);render();};
    document.addEventListener('keydown',event=>{
      if(event.key==='Escape'){menu.hidden=true;button.setAttribute('aria-expanded','false');button.textContent=/^[0-9]/.test(document.querySelector('#effort').textContent)?document.querySelector('#effort').textContent:document.querySelector('#model').textContent+' '+document.querySelector('#effort').textContent;}
      else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){value=Math.max(0,Math.min(4,value+(event.key==='ArrowRight'?1:-1)));render();event.preventDefault();}
    });
    render();view(false);
  })();</script>`;

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("November 23 three-family picker selects GPT-6.2 Sol, GPT-6 (with repeated header) and GPT-5.6 without collision", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const caps = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const page = await browser.newPage();
    for (const [family, effort, expectedLabel, expectedUsage] of [
      ["6.2", "low", "6.2 Instant", "other"],
      ["6.2", "high", "6.2 High", "other"],
      ["6.2", "xhigh", "6.2 Extra High", "other"],
      ["6", "low", "6 Instant", "other"],
      ["6", "high", "6 High", "other"],
      ["6", "max", "6 Pro", "gpt-6-pro"],
      ["5.6", "high", "5.6 High", "other"],
      ["5.6", "max", "5.6 Pro", "gpt-5.6-pro"],
    ] as const) {
      await page.goto("about:blank");
      await page.setContent(nov23Picker(false));
      const mode = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, effort, caps, undefined, true, family);
      expect(mode.selection.label).toBe(expectedLabel);
      expect(mode.usageModel).toBe(expectedUsage);
      await worker.assertSelectedEffort(page, mode);
      expect(await page.locator("#prompt-textarea").innerText()).toBe("Draft");
    }
  } finally { await browser.close(); }
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("November 23 picker fails closed when 6.2 is requested on an older account whose Latest still serves GPT-6", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const caps = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: true, proAvailable: true };
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const page = await browser.newPage();
    await page.setContent(nov23Picker(true));
    let failure: unknown;
    try {
      await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, "high", caps, undefined, false, "6.2");
    } catch (error) { failure = error; }
    expect(String(failure)).toContain("ChatGPT model 6.2 could not be selected and verified");
    expect(await page.locator("#prompt-textarea").innerText()).toBe("Draft");
  } finally { await browser.close(); }
}, 30_000);
