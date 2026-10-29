// Reproduction contributed by @alexalok in PR #730; explicit picker by @nofihq in #921.
import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptModelControlsNotReadyError } from "../src/adapters/chatgpt-web/browser-worker";
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

// October29: three real goals stopped on an empty new-chat composer with no model controls.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("missing initial model controls reload only a proven empty new chat once", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    let loads = 0;
    await page.route("https://chatgpt.com/**", route => {
      loads++;
      return route.fulfill({ contentType: "text/html", body: '<form><div id="prompt-textarea" contenteditable="true"></div></form>' });
    });
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.config = { useTemporaryChats: true };
    const url = "https://chatgpt.com/?temporary-chat=true";
    await page.goto(url);
    let selections = 0;
    const mode = { effort: "high", modelFamily: "6" };
    const select = async () => { if (++selections === 1) throw new ChatGptModelControlsNotReadyError(); return mode; };
    expect(await worker.selectInitialModelAndEffort(page, select, { reuseConversation: false, activeResponse: () => false })).toBe(mode);
    expect(selections).toBe(2); expect(loads).toBe(2); expect(page.url()).toBe(url);
    selections = 0;
    let failure: unknown;
    try { await worker.selectInitialModelAndEffort(page, async () => { selections++; throw new ChatGptModelControlsNotReadyError(); }, { reuseConversation: false, activeResponse: () => false }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ChatGptModelControlsNotReadyError);
    expect(selections).toBe(2); expect(loads).toBe(3);
    for (const guard of ["retained", "stream", "draft", "user", "assistant", "stop", "foreign", "cancelled", "deadline", "diagnostic-race", "rate-limit", "expired"]) {
      await page.goto(url);
      if (guard === "draft") await page.locator('#prompt-textarea').fill('Keep this draft');
      if (guard === "user") await page.locator('form').evaluate(node => node.insertAdjacentHTML('afterend', '<div data-turn-key="user"><div data-user-message-bubble>Accepted</div></div>'));
      if (guard === "assistant") await page.locator('form').evaluate(node => node.insertAdjacentHTML('afterend', '<div data-turn-key="assistant"><div data-conversation-role="assistant"></div></div>'));
      if (guard === "stop") await page.locator('form').evaluate(node => node.insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>'));
      if (guard === "rate-limit") await page.locator('form').evaluate(node => node.insertAdjacentHTML('afterend', '<div role="dialog">Too many requests, making requests too quickly</div>'));
      if (guard === "expired") await page.locator('form').evaluate(node => node.insertAdjacentHTML('afterend', '<div role="alert">Your session has expired</div>'));
      if (guard === "foreign") await page.evaluate(() => history.replaceState(null, '', '/c/foreign'));
      const controller = new AbortController(); if (guard === "cancelled") controller.abort();
      const before = loads; let calls = 0; failure = undefined;
      try { await worker.selectInitialModelAndEffort(page, async () => { calls++; throw new ChatGptModelControlsNotReadyError(); }, { reuseConversation: guard === "retained", activeResponse: () => guard === "stream", deadline: guard === "deadline" ? Date.now()-1 : undefined }, guard === "diagnostic-race" ? async () => { await page.locator('#prompt-textarea').fill('Keep late draft'); } : undefined, controller.signal); }
      catch (error) { failure = error; }
      expect(failure).toBeDefined(); expect(calls).toBeLessThanOrEqual(1); expect(loads).toBe(before);
    }
    for (const terminal of [new Error('Unknown model'), new Error('rate limit'), new Error('sign in')]) {
      await page.goto(url); const before = loads; failure = undefined;
      try { await worker.selectInitialModelAndEffort(page, async () => { throw terminal; }, { reuseConversation: false, activeResponse: () => false }); }
      catch (error) { failure = error; }
      expect(failure).toBe(terminal); expect(loads).toBe(before);
    }
  } finally { await browser.close(); }
}, 30_000);
