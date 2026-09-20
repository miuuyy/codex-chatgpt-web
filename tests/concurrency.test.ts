import { expect, test } from "bun:test";
import { ChatGptBrowserConcurrency, MAX_CHATGPT_BROWSER_TABS } from "../src/adapters/chatgpt-web/concurrency";

test("browser turns queue after the account-wide limit instead of failing", async () => {
  const scheduler = new ChatGptBrowserConcurrency();
  const releases = await Promise.all(
    Array.from({ length: MAX_CHATGPT_BROWSER_TABS }, () => scheduler.acquire()),
  );
  let sixthStarted = false;
  const sixth = scheduler.acquire().then(release => {
    sixthStarted = true;
    return release;
  });

  await Bun.sleep(0);
  expect(sixthStarted).toBeFalse();
  releases[0]!();
  const releaseSixth = await sixth;
  expect(sixthStarted).toBeTrue();
  releaseSixth();
  for (const release of releases.slice(1)) release!();
  expect(scheduler.activeCount()).toBe(0);
  expect(scheduler.queuedCount()).toBe(0);
});

test("queued browser turns are admitted in FIFO order", async () => {
  const scheduler = new ChatGptBrowserConcurrency();
  const releases = await Promise.all(
    Array.from({ length: MAX_CHATGPT_BROWSER_TABS }, () => scheduler.acquire()),
  );
  const order: number[] = [];
  const queued = [1, 2, 3].map(id => scheduler.acquire().then(release => {
    order.push(id);
    return release;
  }));
  releases[0]!();
  const first = await queued[0]!;
  releases[1]!();
  const second = await queued[1]!;
  releases[2]!();
  const third = await queued[2]!;
  expect(order).toEqual([1, 2, 3]);
  first();
  second();
  third();
  for (const release of releases.slice(3)) release!();
  expect(scheduler.activeCount()).toBe(0);
});

test("cancelling a queued turn removes it without consuming a slot", async () => {
  const scheduler = new ChatGptBrowserConcurrency();
  const releases = await Promise.all(
    Array.from({ length: MAX_CHATGPT_BROWSER_TABS }, () => scheduler.acquire()),
  );
  const controller = new AbortController();
  const queued = scheduler.acquire(controller.signal);
  controller.abort();
  await expect(queued).rejects.toMatchObject({ name: "AbortError" });
  expect(scheduler.queuedCount()).toBe(0);
  for (const release of releases) release!();
  expect(scheduler.activeCount()).toBe(0);
});
