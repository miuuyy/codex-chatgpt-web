import { expect, test } from "bun:test";
import { chromium } from "playwright-core";
import { ChatGptSubmissionRejectionObserver } from "../src/adapters/chatgpt-web/browser-worker";

const tooLong = "The message you submitted was too long, please edit it and resubmit.";
const koreanTooLong = "제출한 메시지가 너무 깁니다. 수정 후 다시 제출해 주세요.";
const koreanTooLongWithoutPunctuation = "제출한 메시지가 너무 깁니다 수정 후 다시 제출해 주세요";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a new service size alert survives removal of the current conversation DOM (#874)", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const observer = new ChatGptSubmissionRejectionObserver();
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<main><div data-turn-key='current'>Response</div></main>" }));
    await page.goto("https://chatgpt.com/c/fixture");
    observer.begin(page);
    await observer.captureAlertBaseline();
    await page.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
    await page.evaluate(text => {
      document.querySelector("main")!.innerHTML = `<aside role="alert">${text}</aside>`;
    }, tooLong);
    expect(await observer.failure()).toMatchObject({ code: "context_length_exceeded", retryable: false });
  } finally { observer.dispose(); await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("a localized Korean size alert is classified as a context-length rejection", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const observer = new ChatGptSubmissionRejectionObserver();
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: "<main><div data-turn-key='current'>Response</div></main>" }));
    await page.goto("https://chatgpt.com/c/fixture");
    for (const text of [koreanTooLong, koreanTooLongWithoutPunctuation]) {
      observer.begin(page);
      await observer.captureAlertBaseline();
      await page.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
      await page.evaluate(alert => {
        document.querySelector("main")!.innerHTML = `<aside role="alert">${alert}</aside>`;
      }, text);
      expect(await observer.failure()).toMatchObject({ status: 400, code: "context_length_exceeded", retryable: false });
    }
  } finally { observer.dispose(); await browser.close(); }
}, 20_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("size alerts require a current owned Send and exclude history, quoted text and hidden UI", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  const failures: unknown[] = [];
  const observer = new ChatGptSubmissionRejectionObserver(error => failures.push(error));
  try {
    const page = await browser.newPage();
    await page.route("**/*", route => route.fulfill({ contentType: "text/html", body: `<main><aside id="old" role="alert">${tooLong}</aside></main>` }));
    await page.goto("https://chatgpt.com/c/fixture");
    observer.begin(page);
    await observer.captureAlertBaseline();
    await page.evaluate(text => document.querySelector("main")!.insertAdjacentHTML("beforeend", `<aside id="new" role="alert">${text}</aside>`), tooLong);
    // Background requests and requests from another page do not authorize this alert.
    await page.evaluate(async () => { await fetch("/backend-api/other", { method: "POST" }); });
    const other = await browser.newPage();
    await other.route("**/*", route => route.fulfill({ body: "fixture" }));
    await other.goto("https://chatgpt.com/");
    await other.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
    expect(await observer.failure()).toBeUndefined();
    await page.locator("#new").evaluate(element => element.remove());
    await page.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
    for (const markup of [
      `<div class="markdown"><aside role="alert">${tooLong}</aside></div>`,
      `<div data-turn-key="old-turn"><aside role="alert">${tooLong}</aside></div>`,
      `<div data-user-message-bubble><aside role="alert">${tooLong}</aside></div>`,
      `<div contenteditable="true"><aside role="alert">${tooLong}</aside></div>`,
      `<aside role="alert" hidden>${tooLong}</aside>`,
      `<aside role="alert" style="visibility:hidden">${tooLong}</aside>`,
      `<aside role="alert">The model said: ${tooLong}</aside>`,
      `<div>${tooLong}</div>`,
    ]) {
      await page.evaluate(html => {
        document.querySelector("#variant")?.remove();
        document.querySelector("main")!.insertAdjacentHTML("beforeend", `<section id="variant">${html}</section>`);
      }, markup);
      expect(await observer.failure()).toBeUndefined();
    }
    expect(failures).toHaveLength(0);
    await page.evaluate(text => { document.querySelector("#variant")!.innerHTML = `<aside role="alert">${text}</aside>`; }, tooLong);
    expect(await observer.failure()).toMatchObject({ status: 400, code: "context_length_exceeded", retryable: false });
    await observer.failure();
    expect(failures).toHaveLength(1);
    // The next multipart Send records the existing alert as stale and resets the failure.
    observer.begin(page);
    await observer.captureAlertBaseline();
    await page.evaluate(async () => { await fetch("/backend-api/f/conversation", { method: "POST" }); });
    expect(await observer.failure()).toBeUndefined();
  } finally { observer.dispose(); await browser.close(); }
}, 20_000);
