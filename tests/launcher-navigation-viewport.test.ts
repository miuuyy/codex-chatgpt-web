import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";
import { activateChatGptEffortMenu } from "../src/chatgpt-session";

test.skipIf(!process.env.LAUNCHER_TEST_ELECTRON)("navigated Electron task pages stay usable before delayed resources finish", async () => {
  const userData = mkdtempSync(join(tmpdir(), "launcher-navigation-"));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key, value]) => key !== "ELECTRON_RUN_AS_NODE" && value !== undefined)) as Record<string, string>;
  const app = await _electron.launch({
    executablePath: process.env.LAUNCHER_TEST_ELECTRON,
    args: [resolve("launcher/tests/fixtures/navigation-viewport.cjs"), `--user-data-dir=${userData}`], env,
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!await app.evaluate(() => Boolean((globalThis as any).navigationFixture)) && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(await app.evaluate(() => Boolean((globalThis as any).navigationFixture))).toBe(true);
    const page = app.context().pages().find(page => page.url().endsWith("#first"))!;
    expect(page).toBeDefined();
    const url = await app.evaluate(() => (globalThis as any).navigationFixture.url);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    let navigation = 0;
    // Both selected and background documents must work with the window shown or hidden,
    // including repeated navigation and the launcher's user zoom.
    for (const zoom of [1, 1.25]) {
      for (const shown of [false, true]) {
        for (const selected of ["home", "first"]) {
          await app.evaluate((_, { zoom, shown, selected }) => {
            const { host } = (globalThis as any).navigationFixture;
            host.turnTabs.get("first").view.webContents.setZoomFactor(zoom);
            host.selectedTabId = selected;
            if (shown) host.window.showInactive(); else host.window.hide();
            host.syncViewVisibility();
          }, { zoom, shown, selected });
          await page.goto(`${url}?navigation=${++navigation}`, { waitUntil: "domcontentloaded" });
          const expectedSize = [Math.round(840 / zoom), Math.round(656 / zoom)];
          expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual(expectedSize);
          expect(await page.evaluate(() => document.readyState)).toBe("interactive");
          expect(await (await worker.activeComposer(page, 1_000)).count()).toBe(1);
          const activation = await activateChatGptEffortMenu(page, page.getByRole("button", { name: "Models", exact: true }), { settleMs: 1_000 });
          expect(activation.method).toBe("click");
          expect(await page.evaluate(() => (window as any).clicks), `zoom=${zoom}, shown=${shown}, selected=${selected}`).toBe(1);
          // An unrelated tab finishing must not close a picker in the loading page either.
          await app.evaluate(() => {
            const { host } = (globalThis as any).navigationFixture;
            host.turnTabs.get("second").view.webContents.emit("did-finish-load");
          });
          expect(await page.getByRole("menu").isVisible()).toBe(true);
          await app.evaluate(() => (globalThis as any).navigationFixture.release());
          await page.waitForLoadState("load");
          expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual(expectedSize);
          expect(await page.getByRole("menu").isVisible()).toBe(true);
        }
      }
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
}, 30_000);
