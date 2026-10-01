import { expect, test } from "bun:test";

import { withBrowserTurnAbort } from "../src/adapters/chatgpt-web/browser-worker";

/**
 * An already-aborted turn signal must not leave the promise it was handed
 * unobserved. A browser-side rejection that arrives after the early return is
 * an unhandled rejection, which terminates the whole chatgpt-web-helper
 * process and fails every concurrent turn with it.
 */
test("an already-aborted turn signal observes the promise it is given", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const signal = AbortSignal.abort();
    // The real call site races browser observation against a progress waiter;
    // the browser branch fails on its own, after the turn signal aborted.
    const browserObservation = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("page.evaluate failed: target closed")), 5);
    });
    const raced = Promise.race([browserObservation, new Promise<never>(() => {})]);

    await expect(withBrowserTurnAbort(raced, signal)).rejects.toThrow("ChatGPT web turn aborted");
    // Give the abandoned rejection time to surface as an unhandled rejection.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("an already-aborted turn signal still reports the abort", async () => {
  const signal = AbortSignal.abort();
  await expect(withBrowserTurnAbort(Promise.resolve("value"), signal)).rejects.toThrow("ChatGPT web turn aborted");
});

test("a live turn signal still settles from the promise it observes", async () => {
  const controller = new AbortController();
  await expect(withBrowserTurnAbort(Promise.resolve("value"), controller.signal)).resolves.toBe("value");
});

test("a live turn signal still rejects from the promise it observes", async () => {
  const controller = new AbortController();
  await expect(
    withBrowserTurnAbort(Promise.reject(new Error("observation failed")), controller.signal),
  ).rejects.toThrow("observation failed");
});

test("a live turn signal still rejects when it aborts mid-flight", async () => {
  const controller = new AbortController();
  const pending = withBrowserTurnAbort(new Promise<never>(() => {}), controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("ChatGPT web turn aborted");
});
