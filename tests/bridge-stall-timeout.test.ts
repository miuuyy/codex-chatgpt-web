import { expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import { DEFAULT_STALL_TIMEOUT_SEC, MAX_STALL_TIMEOUT_SEC, resolveStallTimeoutSec } from "../src/stall-timeout";
import type { AdapterEvent } from "../src/types";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * The watchdog exists to end a genuinely hung upstream, and it is the only thing standing between a
 * slow turn and `upstream_stall_timeout`. Its contract is therefore the reason the chatgpt-web
 * adapter must heartbeat for the whole of a turn: silence is the only signal the bridge has.
 */
function bridged(
  events: AsyncGenerator<AdapterEvent>,
  stallTimeoutSec: number,
  heartbeatMs: number,
  now?: () => number,
): ReadableStream<Uint8Array> {
  return bridgeToResponsesSSE(
    events,
    "chatgpt-web/test",
    undefined,
    undefined,
    undefined,
    undefined,
    heartbeatMs,
    { streamPlatform: "darwin", stallTimeoutSec, ...(now ? { now } : {}) },
  );
}

test("an adapter that goes silent past the budget is cancelled after coalesced timer ticks", async () => {
  async function* silent(): AsyncGenerator<AdapterEvent> {
    await sleep(50);
    yield { type: "text_delta", text: "too late" };
    yield { type: "done", endTurn: true };
  }

  let firstClockRead = true;
  const coalescedClock = () => {
    if (firstClockRead) {
      firstClockRead = false;
      return 0;
    }
    return 1_500;
  };
  const body = await new Response(bridged(silent(), 1, 10, coalescedClock)).text();

  expect(body).toContain("upstream_stall_timeout");
  expect(body).not.toContain("too late");
});

test("an adapter that keeps heartbeating is never cancelled, however long it takes", async () => {
  async function* thinkingHard(): AsyncGenerator<AdapterEvent> {
    // Ten times the stall budget elapses, and nothing but keep-alives crosses the boundary.
    for (let beat = 0; beat < 20; beat++) {
      await sleep(100);
      yield { type: "heartbeat" };
    }
    yield { type: "text_delta", text: "answer" };
    yield { type: "done", endTurn: true };
  }

  const body = await new Response(bridged(thinkingHard(), 0.2, 10)).text();

  expect(body).not.toContain("upstream_stall_timeout");
  expect(body).toContain("answer");
  expect(body).toContain("event: response.completed");
});

test("the stall budget is configurable and falls back to the shipped default", () => {
  expect(resolveStallTimeoutSec(undefined)).toBe(DEFAULT_STALL_TIMEOUT_SEC);
  expect(resolveStallTimeoutSec(Number.NaN)).toBe(DEFAULT_STALL_TIMEOUT_SEC);
  expect(resolveStallTimeoutSec(900)).toBe(900);
  expect(resolveStallTimeoutSec(0)).toBe(1);
  expect(resolveStallTimeoutSec(Number.MAX_VALUE)).toBe(MAX_STALL_TIMEOUT_SEC);
  expect(resolveStallTimeoutSec(MAX_STALL_TIMEOUT_SEC + 1)).toBe(MAX_STALL_TIMEOUT_SEC);
});
