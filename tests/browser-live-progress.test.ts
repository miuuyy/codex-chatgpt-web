import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chromium } from "playwright-core";
import { chatGptResponseStructures } from "../src/adapters/chatgpt-web/browser-response-structure";
import { ChatGptBrowserWorker, ChatGptCompletionTracker, ChatGptSubmissionRejectionObserver, ChatGptTurnDomHealthTracker } from "../src/adapters/chatgpt-web/browser-worker";
import { ChatGptExternalTurnProgress } from "../src/adapters/chatgpt-web/turn-progress";

test("a browser security challenge is scoped to the owned submission and never retried automatically", async () => {
  const frame = {};
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame, isClosed: () => false });
  const errors: unknown[] = [];
  const observer = new ChatGptSubmissionRejectionObserver(error => errors.push(error));
  observer.begin(page as any);
  const request = { method: () => "POST", url: () => "https://chatgpt.com/backend-api/f/conversation", frame: () => frame };
  const response = { request: () => request, status: () => 403, headers: () => ({ "cf-mitigated": "challenge" }) };
  page.emit("response", response);
  expect(await observer.failure()).toBeUndefined();
  page.emit("request", request); page.emit("response", response);
  expect(await observer.failure()).toMatchObject({ code: "chatgpt_security_check", retryable: false, status: 403 });
  expect(errors).toHaveLength(1);
  expect(observer.hasActiveResponse()).toBeFalse();
  observer.dispose();
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("response diagnostics retain wrapper ownership but omit private text, classes and identifiers", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<article><div data-content-search-unit-key="PRIVATE-unit">'
      + '<div class="PRIVATE-wrapper"><div data-conversation-role="assistant">'
      + '<div class="markdown PRIVATE-class" id="PRIVATE-id"><p>PRIVATE answer</p>'
      + '<a href="https://private.example">PRIVATE link</a></div></div></div></div>'
      + '<div class="turn-action-controls"><button aria-label="PRIVATE label">PRIVATE control</button></div></article>');
    const structure = await page.locator("article").evaluateAll(chatGptResponseStructures);
    expect(JSON.stringify(structure)).not.toContain("PRIVATE");
    expect(JSON.stringify(structure)).not.toContain("private.example");
    const nodes = structure[0]!.nodes;
    const assistant = nodes.findIndex(node => node.assistant);
    const markdown = nodes.find(node => node.markdown)!;
    expect(markdown.parent).toBe(assistant);
    expect(nodes[nodes[assistant]!.parent]!.searchUnit).toBeFalse();
    expect(nodes.some(node => node.searchUnit)).toBeTrue();
    expect(nodes.some(node => node.completionControl)).toBeTrue();
    await page.locator("article").evaluate(root => root.innerHTML = '<div class="markdown">PRIVATE</div>'.repeat(300));
    const bounded = await page.locator("article").evaluateAll(chatGptResponseStructures);
    expect(bounded[0]!.truncated).toBeTrue();
    expect(bounded[0]!.nodes.length).toBeLessThanOrEqual(200);
  } finally { await browser.close(); }
});

test.each(["requestfinished", "requestfailed"])("owned SSE keeps a quiet response alive until %s, without declaring completion", async terminal => {
  const frame = {};
  const page = Object.assign(new EventEmitter(), { mainFrame: () => frame, isClosed: () => false });
  const observer = new ChatGptSubmissionRejectionObserver();
  const request = (url = "https://chatgpt.com/backend-api/f/conversation", owner = frame) => ({
    method: () => "POST", url: () => url, frame: () => owner,
  });
  const respond = (req: unknown, status = 200) => page.emit("response", {
    request: () => req, status: () => status,
    headers: () => ({ "content-type": "text/event-stream" }), text: async () => "data: [DONE]\n\n",
  });
  const old = request();
  page.emit("request", old);
  observer.begin(page as any);
  respond(old);
  for (const other of [request(undefined, {}), request("https://chatgpt.com/backend-api/sentinel")]) {
    page.emit("request", other); respond(other);
  }
  expect(observer.hasActiveResponse()).toBeFalse();
  const failed = request(); page.emit("request", failed); respond(failed, 503);
  expect(observer.hasActiveResponse()).toBeFalse();
  const current = request(); page.emit("request", current); respond(current);
  const health = new ChatGptTurnDomHealthTracker(60_000, 10_000, 60_000);
  const state = { responsePresent: true, running: false, currentText: "", completionActionVisible: false };
  for (const now of [0, 120_000, 173_000, 382_000, 1_410_000]) {
    expect(health.update({ ...state, responseStreamActive: observer.hasActiveResponse() }, now)).toBeUndefined();
  }
  const completion = new ChatGptCompletionTracker(100);
  // An open stream never substitutes for a final answer; nor may keepalives delay proven completion.
  expect(completion.update(state, 1_410_000)).toBeFalse();
  const final = { ...state, currentText: "Final answer", completionActionVisible: true };
  expect(completion.update(final, 1_410_000)).toBeFalse();
  expect(completion.update(final, 1_410_100)).toBeTrue();
  page.emit(terminal, current);
  expect(observer.hasActiveResponse()).toBeFalse();
  expect(health.update(state, 1_410_000)).toBeUndefined();
  expect(health.update(state, 1_470_000)).toContain("without a final answer");
  expect(await observer.failure()).toBeUndefined();
  observer.dispose();
  expect(page.listenerCount("response")).toBe(0);
});

test.each(["accepted", "late-accepted", "cancelled", "press-failed"])("a blocked Enter command is handled once: %s", async outcome => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  const progress = new ChatGptExternalTurnProgress();
  const tracker = new ChatGptCompletionTracker();
  const hidden = { filter() { return this; }, last() { return this; },
    isVisible: async () => outcome === "late-accepted" && presses > 0 ? new Promise<boolean>(() => {}) : false };
  const page = { isClosed: () => false, locator: () => hidden };
  const controller = new AbortController();
  let presses = 0;
  let activationCancelled = false;
  let submitted = false;
  const button = {
    waitFor: async () => {}, isEnabled: async () => true,
    press: async (_key: string, options: { signal: AbortSignal }) => {
      presses++;
      if (outcome === "press-failed") throw new Error("keypress rejected");
      if (outcome === "accepted") progress.recordToolBatch(1);
      else if (outcome === "late-accepted") setTimeout(() => progress.recordToolBatch(1), 10);
      else setTimeout(() => controller.abort(), 10);
      await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => {
        activationCancelled = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true }));
    },
  };
  worker.activeComposer = async () => ({ locator: () => ({ locator: () => button }) });
  // Reproduce a renderer that cannot answer a DOM read after Enter; MCP is still observable.
  worker.currentSubmissionEvidence = () => new Promise(() => {});
  const send = worker.sendAttachedPrompt(page, {}, undefined, controller.signal, progress, {
    onSendActivated: async () => {}, onSubmitted: () => { submitted = true; },
  }, tracker);
  if (outcome === "accepted" || outcome === "late-accepted") {
    expect(await send).toBe("mcp_tool_call");
    expect(submitted).toBeTrue();
    const boundary = new AbortController();
    const observation = progress.waitForToolBatchObservation(progress.snapshot().lastToolBatchRevision, boundary.signal);
    boundary.abort();
    await expect(observation).rejects.toMatchObject({ name: "AbortError" });
  } else if (outcome === "cancelled") {
    await expect(send).rejects.toMatchObject({ name: "AbortError" });
  } else {
    await expect(send).rejects.toThrow("keypress rejected");
  }
  expect(presses).toBe(1);
  if (outcome !== "press-failed") expect(activationCancelled).toBeTrue();
  expect(submitted).toBe(outcome === "accepted" || outcome === "late-accepted");
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("real Enter accepts MCP while the renderer is still busy handling the key", async () => {
  const progress = new ChatGptExternalTurnProgress();
  let calls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/invoke") {
      calls++;
      progress.recordToolBatch(1);
      return new Response("received");
    }
    return new Response('<form data-chatgpt-composer><div id="prompt-textarea" contenteditable="true">test</div>'
      + '<button type="submit">Send</button></form><script>'
      + 'document.querySelector("button").onkeydown=event=>{if(event.key!=="Enter")return;event.preventDefault();'
      + 'fetch("/invoke",{method:"POST"});const end=performance.now()+2500;while(performance.now()<end){}}</script>',
      { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const baseline = await worker.captureSubmissionBaseline(page, "test");
    const started = performance.now();
    const accepted = await worker.runStage("slow_enter_test", "send", 1_500, (signal: AbortSignal) =>
      worker.sendAttachedPrompt(page, baseline, undefined, signal, progress, undefined, new ChatGptCompletionTracker()));
    expect(accepted).toBe("mcp_tool_call");
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(calls).toBe(1);
  } finally { await browser.close(); server.stop(true); }
}, 10_000);
