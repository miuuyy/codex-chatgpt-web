import { expect, test } from "bun:test";
import { chromium, _electron } from "playwright-core";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chatGptStopButton, ChatGptTurnDomHealthTracker, setChatGptThinkMode } from "../src/adapters/chatgpt-web/browser-worker";
import { CHATGPT_THINK_BUTTON_SELECTOR } from "../src/chatgpt-session";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("hidden duplicate Stop controls cannot turn live generation into an idle timeout", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<button data-testid="stop-button">Stop</button>'
      + '<form data-chatgpt-composer><button type="button" aria-label="Stop" hidden>Stop</button></form>');
    const health = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
    const idle = { responsePresent: true, currentText: "", completionActionVisible: false, running: false };
    const stop = chatGptStopButton(page);
    expect(await stop.isVisible()).toBeTrue();
    expect(health.update({ ...idle, running: await stop.isVisible() }, 0)).toBeUndefined();
    expect(health.update({ ...idle, running: await stop.isVisible() }, 100_000)).toBeUndefined();
    await page.getByTestId("stop-button").evaluate(element => element.remove());
    expect(await stop.isVisible()).toBeFalse();
    expect(health.update({ ...idle, running: await stop.isVisible() }, 100_000)).toBeUndefined();
    expect(health.update({ ...idle, running: await stop.isVisible() }, 100_750)).toContain("without a final answer");
  } finally {
    await browser.close();
  }
});

test.skipIf(!process.env.LAUNCHER_TEST_ELECTRON)("captured Stop is independent of language and excludes other composer actions", async () => {
  const userData = mkdtempSync(join(tmpdir(), "composer-stop-"));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const app = await _electron.launch({
    executablePath: process.env.LAUNCHER_TEST_ELECTRON,
    args: [resolve("launcher/tests/fixtures/composer-controls.cjs"), `--user-data-dir=${userData}`], env,
  });
  try {
    const page = await app.firstWindow();
    const captured = readFileSync(new URL("./fixtures/chatgpt-composer-stop.html", import.meta.url), "utf8");
    for (const label of ["Stop", "停止", "Остановить", "Parar", "停止生成", "중지", "إيقاف", "Unknown future translation", ""]) {
      await page.setContent(captured.replace('aria-label="Stop"', `aria-label="${label}"`));
      const stop = chatGptStopButton(page);
      expect(await stop.count()).toBe(1);
      const health = new ChatGptTurnDomHealthTracker(1_000, 500, 750);
      const state = { responsePresent: true, currentText: "", completionActionVisible: false, running: await stop.isVisible() };
      expect(health.update(state, 0)).toBeUndefined();
      expect(health.update(state, 180_000)).toBeUndefined();
      await page.locator("button").evaluate(button => button.setAttribute("type", "submit"));
      expect(await stop.count()).toBe(0);
    }
    // The same primary-action slot is not proof of generation without the Stop glyph.
    for (const icon of ['<path d="M0 0L20 20"/>', '<use href="/icons.svg#voice"/>']) {
      await page.setContent(captured.replace(/<path[^>]+><\/path>/, icon).replace('aria-label="Stop"', 'aria-label="Voice"'));
      expect(await chatGptStopButton(page).count()).toBe(0);
    }
    await page.setContent(captured.replace('<form data-chatgpt-composer>', '<div>').replace('</form>', '</div>'));
    expect(await chatGptStopButton(page).count()).toBe(0);
    await page.setContent(captured.replace('<button ', '<button hidden ') + '<button data-testid="stop-button">Legacy</button>');
    expect(await chatGptStopButton(page).count()).toBe(1);
    expect(await chatGptStopButton(page).getAttribute("data-testid")).toBe("stop-button");
    await page.getByTestId("stop-button").evaluate(button => button.removeAttribute("data-testid"));
    expect(await chatGptStopButton(page).count()).toBe(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
}, 20_000);

test.skipIf(!process.env.LAUNCHER_TEST_ELECTRON)("captured Think toggles independently of language without selecting other pills", async () => {
  const userData = mkdtempSync(join(tmpdir(), "composer-think-"));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const app = await _electron.launch({
    executablePath: process.env.LAUNCHER_TEST_ELECTRON,
    args: [resolve("launcher/tests/fixtures/composer-controls.cjs"), `--user-data-dir=${userData}`], env,
  });
  try {
    const page = await app.firstWindow();
    const captured = readFileSync(new URL("./fixtures/chatgpt-composer-think.html", import.meta.url), "utf8");
    for (const label of ["Think", "思考", "Думать", "생각하기", "التفكير", "Unknown future translation"]) {
      await page.setContent(`<form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true"><span data-id="plugin:fixture" data-keyword="Codex Native2" contenteditable="false">Codex Native2</span></div>
        ${captured.replace(">Think</span>", `>${label}</span>`)}
        ${captured.replace(/<path[^>]+><\/path>/, '<path d="M0 0L20 20"/>').replace(">Think</span>", ">Search</span>")}</form>
        ${captured}<script>document.querySelectorAll('form button').forEach(button => button.onclick=()=>button.setAttribute('aria-pressed',String(button.getAttribute('aria-pressed')!=='true')));</script>`);
      const composer = page.locator("#prompt-textarea");
      const think = page.locator("form").locator(CHATGPT_THINK_BUTTON_SELECTOR);
      expect(await think.count()).toBe(1);
      await setChatGptThinkMode(composer, true);
      expect(await think.getAttribute("aria-pressed")).toBe("true");
      await setChatGptThinkMode(composer, false);
      expect(await think.getAttribute("aria-pressed")).toBe("false");
      expect(await page.locator("form button").nth(1).getAttribute("aria-pressed")).toBe("false");
      expect(await page.locator("body > button").getAttribute("aria-pressed")).toBe("false");
      expect(await composer.locator('[data-id="plugin:fixture"]').getAttribute("data-keyword")).toBe("Codex Native2");
    }
    // Two genuine controls are ambiguous; do not arbitrarily choose one.
    await page.locator("form").evaluate((form, html) => form.insertAdjacentHTML("beforeend", html), captured);
    await expect(setChatGptThinkMode(page.locator("#prompt-textarea"), true)).rejects.toThrow("2 visible Think controls");
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
}, 20_000);
