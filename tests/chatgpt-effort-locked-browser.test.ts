import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_EFFORT_CONTROL_SELECTOR, chatGptEffortLocked, chatGptEffortSlider } from "../src/chatgpt-ui/model-picker";

const LOCKED = readFileSync(new URL("./fixtures/chatgpt-model-picker-limit-locked-2026-11-15.html", import.meta.url), "utf8");
const CAPABILITIES = { localToolsEnabled: false, solAvailable: true, extraHighAvailable: false, proAvailable: false };
const withBrowser = process.env.CHATGPT_DOM_TEST_BROWSER;

async function openPicker(page: Page) {
  await page.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).click();
  return { method: "already-open" as const, menu: page.locator("#picker"), ...chatGptEffortSlider(page) };
}

function slider(delayMs: number) {
  return `<form><div id="prompt-textarea" contenteditable="true"></div><button type="button" data-tone="neutral" aria-haspopup="menu" aria-controls="picker">x</button></form>
    <div id="picker" role="menu"><div id="late" data-model-picker-power-slider style="width:120px;height:24px;display:none">
      <span data-orientation="horizontal" aria-disabled="false"><span role="slider" aria-valuemin="0" aria-valuemax="4" aria-valuenow="2"></span></span></div>
      <div role="menuitemradio" aria-disabled="true" aria-checked="false">Pro</div></div>
    <script>setTimeout(() => { document.querySelector("#late").style.display = ""; }, ${delayMs});</script>`;
}

test.skipIf(!withBrowser)("a limit-locked picker is detected; a picker with a usable slider is not, even when the slider is late", async () => {
  const browser = await chromium.launch({ executablePath: withBrowser, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(LOCKED);
    expect(await chatGptEffortLocked(await openPicker(page), 300)).toBe(true);
    await page.evaluate(() => (window as unknown as { startInstant(): void }).startInstant());
    expect(await chatGptEffortLocked(await openPicker(page), 300)).toBe(true);
    await page.setContent(slider(0));
    expect(await chatGptEffortLocked(await openPicker(page), 300)).toBe(false);
    await page.setContent(slider(500));
    expect(await chatGptEffortLocked(await openPicker(page), 2_000)).toBe(false);
  } finally { await browser.close(); }
}, 30_000);

test.skipIf(!withBrowser)("locked efforts: a request above Instant fails closed with the site's own explanation and clicks nothing", async () => {
  const browser = await chromium.launch({ executablePath: withBrowser, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(LOCKED);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const failure = await worker.selectModelAndEffort(page, "gpt-5.6-sol", "high", CAPABILITIES, undefined, false, "6")
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ code: "chatgpt_effort_locked", status: 400, retryable: false });
    expect((failure as Error).message).toContain("High cannot be selected");
    expect((failure as Error).message).toContain("Limite atingido. Tente novamente após 18 de nov. de 2026.");
    expect(await page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(0);
    // The requested family is selected before the lock is judged: asking for 5.6 clicks its row first.
    const fresh = await browser.newPage();
    await fresh.setContent(LOCKED);
    await worker.selectModelAndEffort(fresh, "gpt-5.6-sol", "high", CAPABILITIES, undefined, false, "5.6").catch(() => undefined);
    expect(await fresh.locator("#m56").getAttribute("aria-checked")).toBe("true");
  } finally { await browser.close(); }
}, 30_000);

test.skipIf(!withBrowser)("locked efforts: an explicit Instant request applies and verifies 6 Instant, once, and survives the send-time check", async () => {
  const browser = await chromium.launch({ executablePath: withBrowser, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(LOCKED);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const selected = await worker.selectModelAndEffort(page, "gpt-5.6-sol", "low", CAPABILITIES, undefined, false, "6");
    expect(selected).toMatchObject({ effort: "low", modelFamily: "6", effortLocked: true });
    expect(selected.selection.label).toBe("6 Instant");
    expect(await page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
    await worker.assertSelectedEffort(page, selected);
    const again = await worker.selectModelAndEffort(page, "gpt-5.6-sol", "low", CAPABILITIES, undefined, false, "6");
    expect(again.selection.label).toBe("6 Instant");
    expect(await page.evaluate(() => (window as unknown as { clicks: number }).clicks)).toBe(1);
    expect(await page.locator("#prompt-textarea").innerText()).toBe("Draft");
    // A reopened picker without its slider must fail with a typed error, not wait out Playwright's 30 s default.
    await page.evaluate(() => { (document.querySelector("#power") as HTMLElement).hidden = true; });
    const reopened = await worker.assertSelectedEffort(page, selected).then(() => undefined, (error: unknown) => error);
    expect(reopened).toMatchObject({ code: "model_version_unavailable" });
  } finally { await browser.close(); }
}, 30_000);

for (const [name, announce, uncheckRow] of [
  ["no announcement appears", "", false],
  ["the announced mode is not Instant", "6 Thinking, 1 de 1.", false],
  ["the announced version is another model", "5.6 Instant, 1 de 1.", false],
  ["the model row is not checked", "6 Instant, 1 de 1.", true],
] as const)
test.skipIf(!withBrowser)(`locked efforts: Instant is refused when ${name}`, async () => {
  const browser = await chromium.launch({ executablePath: withBrowser, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(LOCKED);
    await page.evaluate(({ text, uncheck }) => {
      const win = window as unknown as { startInstant(): void };
      if (uncheck) document.querySelector("#m6")!.setAttribute("aria-checked", "false");
      win.startInstant = () => {
        if (!text) return;
        document.querySelector("#status")!.textContent = text;
        (document.querySelector("#power") as HTMLElement).hidden = false;
      };
    }, { text: announce, uncheck: uncheckRow });
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const failure = await worker.selectModelAndEffort(page, "gpt-5.6-sol", "low", CAPABILITIES, undefined, false, "6")
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toMatchObject({ code: "model_version_unavailable", retryable: false });
    expect((failure as Error).message).toMatch(/could not be (selected and )?verified/);
  } finally { await browser.close(); }
}, 30_000);
