import { expect, test } from "bun:test";
import {
  ChatGptBrowserObservationTimeoutError,
  createChatGptSurfaceRebindBudget,
  isTransientObservationConnectionError,
  MAX_CHATGPT_PRO_SURFACE_REBINDS,
  MAX_CHATGPT_SURFACE_REBINDS,
  observationRetryDelayMs,
  retryChatGptObservation,
} from "../src/adapters/chatgpt-web/observation-retry";

test("Pro Ultra CDP recovery is twice the ordinary rebind budget", () => {
  expect(MAX_CHATGPT_PRO_SURFACE_REBINDS).toBe(MAX_CHATGPT_SURFACE_REBINDS * 2);
  const budget = createChatGptSurfaceRebindBudget(MAX_CHATGPT_PRO_SURFACE_REBINDS);
  let consumed = 0;
  while (budget.consume()) consumed += 1;
  expect(consumed).toBe(6);
  expect(budget.consume()).toBe(false);
});

test("connection recovery retries the read with exponential backoff", async () => {
  let reads = 0;
  const attempts: number[] = [];
  const delays: number[] = [];
  const result = await retryChatGptObservation(async () => {
    if (++reads < 3) throw new Error("read ECONNRESET");
    return "same response";
  }, async attempt => { attempts.push(attempt); }, undefined, async ms => { delays.push(ms); }, undefined, () => 1);
  expect(result).toBe("same response");
  expect(reads).toBe(3);
  expect(attempts).toEqual([1, 2]);
  expect(delays).toEqual([500, 1000]);
});

test("failed reconnects share the bounded retry budget", async () => {
  let reads = 0;
  let reconnects = 0;
  const failure = new Error("connect ECONNREFUSED");
  await expect(retryChatGptObservation(async () => {
    reads++;
    throw new Error("WebSocket disconnected");
  }, async () => { reconnects++; throw failure; }, undefined, async () => {})).rejects.toBe(failure);
  expect(reads).toBe(1);
  expect(reconnects).toBe(MAX_CHATGPT_SURFACE_REBINDS);
});

test("a temporarily unavailable reconnect can recover the original observation", async () => {
  let connected = false;
  let reconnects = 0;
  const result = await retryChatGptObservation(async () => {
    if (!connected) throw new Error("Browser connection closed");
    return "original turn";
  }, async () => {
    if (++reconnects === 1) throw new Error("ECONNREFUSED");
    connected = true;
  }, undefined, async () => {});
  expect(result).toBe("original turn");
  expect(reconnects).toBe(2);
});

test("terminal errors, closed tabs, and programming errors are not retried", async () => {
  for (const error of [
    new DOMException("aborted", "AbortError"),
    new Error("Target page has been closed"),
    new TypeError("invalid snapshot"),
    Object.assign(new Error("connection closed"), { retryable: false }),
  ]) {
    let recoveries = 0;
    await expect(retryChatGptObservation(async () => { throw error; }, async () => {
      recoveries++;
    }, undefined, async () => {})).rejects.toBe(error);
    expect(recoveries).toBe(0);
  }
});

test("cancellation during backoff prevents reconnect and another read", async () => {
  const controller = new AbortController();
  let recoveries = 0;
  await expect(retryChatGptObservation(async () => { throw new Error("EPIPE"); }, async () => {
    recoveries++;
  }, controller.signal, async () => { controller.abort(); })).rejects.toMatchObject({ name: "AbortError" });
  expect(recoveries).toBe(0);
});

test("an aborted backoff timer exits promptly", async () => {
  const controller = new AbortController();
  const result = retryChatGptObservation(async () => { throw new Error("ECONNRESET"); }, async () => {}, controller.signal);
  queueMicrotask(() => controller.abort());
  await expect(result).rejects.toMatchObject({ name: "AbortError" });
});

test("structured and wrapped transport errors recover, but terminal causes do not", () => {
  const socket = Object.assign(new Error("socket unavailable"), { code: "UND_ERR_SOCKET" });
  expect(isTransientObservationConnectionError(new TypeError("fetch failed", { cause: socket }))).toBeTrue();
  expect(isTransientObservationConnectionError(Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" }))).toBeTrue();
  expect(isTransientObservationConnectionError(Object.assign(new Error("Session closed."), { name: "ProtocolError" }))).toBeTrue();
  expect(isTransientObservationConnectionError(Object.assign(new Error("net::ERR_CONNECTION_RESET"), { name: "TargetClosedError" }))).toBeTrue();
  expect(isTransientObservationConnectionError(new ChatGptBrowserObservationTimeoutError(5_000))).toBeTrue();
  expect(isTransientObservationConnectionError(Object.assign(new Error("locator.evaluate: Timeout 2000ms exceeded"), { name: "TimeoutError" }))).toBeFalse();
  expect(isTransientObservationConnectionError(Object.assign(new Error("bad credentials"), { code: "EACCES" }))).toBeFalse();
  expect(isTransientObservationConnectionError(Object.assign(new Error("ECONNRESET", { cause: socket }), { retryable: false }))).toBeFalse();
  expect(isTransientObservationConnectionError(new Error("ECONNRESET", { cause: new DOMException("cancelled", "AbortError") }))).toBeFalse();
  const cyclic = new Error("unrelated error");
  cyclic.cause = cyclic;
  expect(isTransientObservationConnectionError(cyclic)).toBeFalse();
});

test("cancellation during a successful read cannot return a stale result", async () => {
  const controller = new AbortController();
  await expect(retryChatGptObservation(async () => {
    controller.abort();
    return "late result";
  }, async () => {}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});

test("connection and DOM rebinds share one surface budget", async () => {
  const budget = createChatGptSurfaceRebindBudget();
  let recoveries = 0;
  await expect(retryChatGptObservation(async () => {
    throw new Error("Browser connection closed");
  }, async () => { recoveries++; }, undefined, async () => {}, budget)).rejects.toThrow("Browser connection closed");
  expect(recoveries).toBe(MAX_CHATGPT_SURFACE_REBINDS);
  expect(budget.remaining).toBe(0);

  let laterRecoveries = 0;
  await expect(retryChatGptObservation(async () => {
    throw new ChatGptBrowserObservationTimeoutError(5);
  }, async () => { laterRecoveries++; }, undefined, async () => {}, budget))
    .rejects.toBeInstanceOf(ChatGptBrowserObservationTimeoutError);
  expect(laterRecoveries).toBe(0);
});

test("observation retry delay uses full jitter under a reconnect cap", () => {
  expect(observationRetryDelayMs(0, () => 0)).toBe(0);
  expect(observationRetryDelayMs(0, () => 1)).toBe(500);
  expect(observationRetryDelayMs(1, () => 1)).toBe(1_000);
  expect(observationRetryDelayMs(2, () => 1)).toBe(2_000);
  expect(observationRetryDelayMs(4, () => 1)).toBe(8_000);
  expect(observationRetryDelayMs(8, () => 1)).toBe(8_000);
});
