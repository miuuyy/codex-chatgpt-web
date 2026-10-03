// Reproduction contributed by @alexalok in PR #730.
import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { readChatGptUsageModel } from "../src/adapters/chatgpt-web/limits";
import { assertChatGptModelFamily } from "../src/adapters/chatgpt-web/model-selection";

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
  current: { header: (value: number) => value === 4 ? "6" : "5.6", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  legacy: { header: null, status: (effort: string, value: number) => (value === 4 ? "6 " : "5.6 ") + effort + ", " + (value + 1) + " of 5." },
  future: { header: (value: number) => value === 4 ? "7" : "5.6", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  versionless: { header: () => "", status: (effort: string, value: number) => effort + ", " + (value + 1) + " of 5." },
  conflicting: { header: (value: number) => value === 4 ? "6" : "5.6", status: (effort: string, value: number) => (value === 4 ? "5.6 " : "") + effort + ", " + (value + 1) + " of 5." },
} satisfies Record<string, Picker>;

const FIXTURE = `<form><div id="prompt-textarea" contenteditable="true">Draft</div>
  <button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker" aria-expanded="false">Medium</button></form>
  <div id="picker" role="menu" aria-label="Select ChatGPT model" hidden>
    <div data-model-picker-view="simple">
      <div aria-hidden="false" data-active="true">
        <div data-explicit-model="false">
          <div role="menuitem" aria-hidden="false" aria-label="Select model" data-model-picker-view-toggle="true" tabindex="0">
            <div data-menu-row-content="true"><span><span><span id="header-version"></span><span id="header-effort" data-accent="true"></span><svg></svg></span></span></div>
          </div>
          <span aria-hidden="true"><span>Consumes usage limits faster</span></span>
        </div>
        <span aria-live="polite" id="status" role="status"></span>
        <span id="hint">Use Left and Right arrow keys to adjust power</span>
        <div role="menuitem" aria-describedby="status hint" aria-label="Power" data-reasoning-slider="true" tabindex="-1">
          <div data-menu-row-content="true"><span><div data-model-picker-power-slider style="height:30px;width:250px"></div></span></div>
        </div>
      </div>
      <div aria-hidden="true" data-active="false" inert>
        <span>Locked, opens access options</span>
        <div role="menuitemradio" aria-checked="true" data-model-selected="true" tabindex="-1"><div data-menu-row-content="true"><span>Latest</span></div></div>
        <div role="menuitemradio" aria-checked="false" tabindex="-1"><div data-menu-row-content="true"><span>GPT-5.6 Sol</span></div></div>
        <div role="menuitemradio" aria-checked="false" tabindex="-1"><div data-menu-row-content="true"><div><span>GPT-5.5</span><span>Leaving on October 14</span></div></div></div>
      </div>
    </div>
  </div>
  <script>
    const efforts = ["Instant", "Medium", "High", "Extra High", "Pro"];
    const control = document.querySelector("button"), menu = document.querySelector("#picker");
    let value = 1;
    function render() {
      document.querySelector("[data-model-picker-power-slider]").innerHTML = '<span data-orientation="horizontal" aria-disabled="false">'
        + efforts.map((_, i) => '<span data-selected="' + (i <= value) + '"></span>').join("")
        + '<span role="slider" aria-hidden="true" aria-valuemin="0" aria-valuemax="4" aria-valuenow="' + value + '"></span></span>';
      document.querySelector("#status").textContent = window.pickerStatus(efforts[value], value);
      if (window.pickerHeader === null) document.querySelector("[data-model-picker-view-toggle]")?.remove();
      else {
        document.querySelector("#header-version").textContent = window.pickerHeader(value);
        document.querySelector("#header-effort").textContent = efforts[value];
      }
    }
    control.onclick = () => {
      menu.hidden = false; control.setAttribute("aria-expanded", "true"); control.textContent = "Thinking effort"; render();
    };
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        menu.hidden = true; control.setAttribute("aria-expanded", "false"); control.textContent = efforts[value];
      } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        value = Math.max(0, Math.min(4, value + (event.key === "ArrowRight" ? 1 : -1))); render(); event.preventDefault();
      }
    });
  </script>`;

async function selectGpt6Pro(picker: Picker) {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5_000);
    const config = "<script>window.pickerHeader = " + (picker.header ? picker.header.toString() : "null")
      + "; window.pickerStatus = " + picker.status.toString() + ";</script>";
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

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro is verified from the current picker header when the slider announces only the effort", async () => {
  expect(await selectGpt6Pro(PICKERS.current)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
}, 60_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("GPT-6 Pro is still verified from the older versioned slider announcement", async () => {
  expect(await selectGpt6Pro(PICKERS.legacy)).toEqual({ ok: true, label: "Pro", usageModel: "gpt-6-pro", draft: "Draft" });
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

// Live 2026-10-02: this 3-step account shows only Instant/Medium/High in its
// header and announcement, with GPT-5.6 Sol checked in the collapsed family view.
for (const [effort, index, label] of [["low", 0, "Instant"], ["medium", 1, "Medium"], ["high", 2, "High"]] as const)
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`explicit GPT-5.6 verifies an effort-only picker at ${effort}`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const fixture = FIXTURE
      .replace('aria-checked="true" data-model-selected="true"', 'aria-checked="false"')
      .replace('aria-checked="false" tabindex="-1"><div data-menu-row-content="true"><span>GPT-5.6 Sol', 'aria-checked="true" tabindex="-1"><div data-menu-row-content="true"><span>GPT-5.6 Sol')
      .replace('id="header-effort"', 'id="header-effort" data-effort-only="true"')
      .replace('const efforts = ["Instant", "Medium", "High", "Extra High", "Pro"];', 'const efforts = ["Instant", "Medium", "High"];')
      .replace('aria-valuemax="4"', 'aria-valuemax="2"').replace('Math.min(4, value', 'Math.min(2, value')
      .replace('id="picker" role="menu"', 'id="picker" role="menu" style="opacity:0"');
    await page.setContent('<script>window.pickerHeader = () => ""; window.pickerStatus = (effort, value) => effort + ", " + (value + 1) + " of 3.";</script><div style="opacity:0">' + fixture + '</div>');
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const mode = await worker.selectModelAndEffort(page, CHATGPT_WEB_MODEL_ID, effort, {
      localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false,
    }, undefined, true, "5.6");
    expect(mode.selection.label).toBe(label);
    expect(await page.locator('[role="slider"]').getAttribute("aria-valuenow")).toBe(String(index));
    expect(await page.locator("#prompt-textarea").innerText()).toBe("Draft");
  } finally { await browser.close(); }
}, 60_000);

for (const scenario of ["latest", "ambiguous", "unmarked", "conflicting", "hidden-picker"] as const)
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`effort-only model evidence fails closed when ${scenario}`, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const selected = scenario === "latest" ? "Latest" : "GPT-5.6 Sol";
    await page.setContent(`<div role="menu" id="owned" ${scenario === "hidden-picker" ? 'style="display:none"' : ""}>
      <div data-model-picker-view-toggle="true"><span ${scenario === "unmarked" ? "" : 'data-effort-only="true"'}>Instant</span></div>
      <div role="menuitem" aria-describedby="announcement"><span role="slider" aria-valuemin="0" aria-valuemax="2" aria-valuenow="0"></span></div>
      <span id="announcement">${scenario === "conflicting" ? "6 Instant" : "Instant"}, 1 of 3.</span>
      <div hidden><div role="menuitemradio" aria-checked="true">${selected}</div>${scenario === "ambiguous" ? '<div role="menuitemradio" aria-checked="true">GPT-5.5</div>' : ""}</div>
    </div><div role="menu"><div role="menuitemradio" aria-checked="true">GPT-5.6 Sol</div></div>`);
    const menu = { menu: page.locator("#owned"), slider: page.locator('#owned [role="slider"]') } as Parameters<typeof assertChatGptModelFamily>[0];
    await expect(assertChatGptModelFamily(menu, "5.6", "low", 0)).rejects.toThrow();
    await expect(assertChatGptModelFamily(menu, "6", "low", 0)).rejects.toThrow();
  } finally { await browser.close(); }
}, 60_000);
