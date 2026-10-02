import { expect, test } from "bun:test";
import { chromium, type Locator, type Page } from "playwright-core";
import { ChatGptBrowserWorker } from "../src/adapters/chatgpt-web/browser-worker";

for (const authenticated of [true, false]) {
  test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)(`document verification preserves the page and requires an authenticated session (${authenticated})`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
    try {
      const page = await browser.newPage();
      let documents = 0;
      let authRequests = 0;
      let submissions = 0;
      await page.route("**/*", async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() !== "GET") { submissions++; await route.abort(); return; }
        if (url.origin !== "https://chatgpt.com") { await route.abort(); return; }
        if (url.pathname === "/api/auth/session") {
          authRequests++;
          await route.fulfill({ status: 200, contentType: "application/json",
            body: JSON.stringify(authenticated ? { user: { id: "fixture-user" } } : {}) });
          return;
        }
        if (url.pathname !== "/") { await route.abort(); return; }
        documents++;
        await route.fulfill(documents === 1 ? {
          status: 403, contentType: "text/html", headers: { "cf-mitigated": "challenge" },
          body: '<!doctype html><title>Verification pending fixture</title><script>setTimeout(()=>location.replace(location.href),250)</script>',
        } : {
          status: 200, contentType: "text/html",
          body: '<!doctype html><form><div id="prompt-textarea" contenteditable="true" style="min-height:40px"></div></form>',
        });
      });
      const worker = Object.create(ChatGptBrowserWorker.prototype) as {
        prepareChatSurface(page: Page): Promise<Locator>;
      };
      if (authenticated) {
        const composer = await worker.prepareChatSurface(page);
        expect(await composer.isVisible()).toBeTrue();
      } else {
        await expect(worker.prepareChatSurface(page)).rejects.toMatchObject({ code: "chatgpt_sign_in_required", retryable: false });
      }
      expect(documents).toBe(2); // one initial navigation and the document's own normal transition
      expect(authRequests).toBe(1);
      expect(submissions).toBe(0);
      expect(page.isClosed()).toBeFalse();
    } finally {
      await browser.close();
    }
  }, 45_000);
}

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("cancelling pending document verification stops the wait without sending or closing another page", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    let submissions = 0;
    await page.route("**/*", async route => {
      if (route.request().method() !== "GET") { submissions++; await route.abort(); return; }
      await route.fulfill({ status: 403, contentType: "text/html", headers: { "cf-mitigated": "challenge" },
        body: "<!doctype html><title>Verification pending fixture</title>" });
    });
    const controller = new AbortController();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      prepareChatSurface(page: Page, capture: (checkpoint: string) => Promise<void>, saved: boolean, signal: AbortSignal): Promise<Locator>;
    };
    await expect(worker.prepareChatSurface(page, async checkpoint => {
      if (checkpoint === "security-check-pending") setTimeout(() => controller.abort(), 50);
    }, false, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(submissions).toBe(0);
    expect(page.isClosed()).toBeFalse();
  } finally {
    await browser.close();
  }
}, 45_000);
