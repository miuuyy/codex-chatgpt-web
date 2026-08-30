const test = require("node:test");
const assert = require("node:assert/strict");
const {
  refreshTurnLeasesAfterSuspension,
  shouldBlockSleepForTurns,
  sweepGapIndicatesSuspension,
} = require("../electron/turn-suspension.cjs");
const { BrowserHost } = require("../electron/browser-host.cjs");

// System sleep froze the launcher for 15 minutes twice in a row; on each wake the first sweep saw
// heartbeats that were minutes stale and reaped two live turns as orphans. pmset matched both waves
// to the second. These tests pin the wake-side tolerance and the sleep-side prevention.

test("a sweep gap of multiples of the interval is recognised as a suspension", () => {
  assert.equal(sweepGapIndicatesSuspension(1_000, 1_000 + 5_000 * 6, 5_000), true);
  assert.equal(sweepGapIndicatesSuspension(1_000, 1_000 + 15 * 60_000, 5_000), true);
});

test("ordinary sweep cadence and busy-loop jitter are not a suspension", () => {
  assert.equal(sweepGapIndicatesSuspension(1_000, 6_000, 5_000), false);
  assert.equal(sweepGapIndicatesSuspension(1_000, 1_000 + 5_000 * 6 - 1, 5_000), false);
  assert.equal(sweepGapIndicatesSuspension(undefined, 99_000, 5_000), false);
});

test("a suspension re-baselines running leases and restores an unfinished bootstrap budget", () => {
  const running = { status: "running", traceId: "aaa", bootstrapReady: true, lastHeartbeatAt: 5 };
  const booting = {
    status: "running", traceId: "bbb", bootstrapReady: false,
    lastHeartbeatAt: 5, bootstrapDeadlineAt: 10,
  };
  const retained = { status: "ready", traceId: "ccc", lastHeartbeatAt: 5 };

  const refreshed = refreshTurnLeasesAfterSuspension([running, booting, retained], 1_000_000, 120_000);

  assert.deepEqual(refreshed, ["aaa", "bbb"]);
  assert.equal(running.lastHeartbeatAt, 1_000_000);
  assert.equal(booting.bootstrapDeadlineAt, 1_120_000);
  // A retained tab holds no live helper; its idle TTL keeps counting through a sleep.
  assert.equal(retained.lastHeartbeatAt, 5);
});

test("sleep is blocked exactly while a turn is running", () => {
  assert.equal(shouldBlockSleepForTurns([]), false);
  assert.equal(shouldBlockSleepForTurns([{ status: "ready" }, { status: "error" }]), false);
  assert.equal(shouldBlockSleepForTurns([{ status: "ready" }, { status: "running" }]), true);
});

test("the first sweep after a suspension refreshes stale leases instead of reaping them", () => {
  const reaped = [];
  const warnings = [];
  const tab = {
    id: "t1", traceId: "trace-1", helperPid: 42, status: "running",
    bootstrapReady: true, lastHeartbeatAt: 1_000,
  };
  const host = {
    lastTurnSweepAt: 1_000,
    turnTabs: new Map([["t1", tab]]),
    logger: { warn: (event, detail) => warnings.push({ event, detail }), info: () => {} },
    removeTurnTab: t => reaped.push(t.traceId),
    refreshTurnLeases: BrowserHost.prototype.refreshTurnLeases,
  };

  // Fifteen minutes pass without a sweep — the launcher was asleep, and so was the helper.
  BrowserHost.prototype.reapExpiredTurnTabs.call(host, 1_000 + 15 * 60_000);

  assert.deepEqual(reaped, []);
  assert.equal(tab.lastHeartbeatAt, 1_000 + 15 * 60_000);
  assert.equal(warnings[0].event, "browser.turn_leases_refreshed_after_suspension");

  // The next sweep runs on cadence; the lease is fresh, so the turn lives on.
  BrowserHost.prototype.reapExpiredTurnTabs.call(host, 1_000 + 15 * 60_000 + 5_000);
  assert.deepEqual(reaped, []);
});

test("a helper that is genuinely gone is still reaped on the ordinary cadence", () => {
  const reaped = [];
  const tab = {
    id: "t1", traceId: "trace-1", helperPid: 42, status: "running",
    bootstrapReady: true, lastHeartbeatAt: 1_000,
  };
  const host = {
    lastTurnSweepAt: 56_000,
    turnTabs: new Map([["t1", tab]]),
    logger: { warn: () => {}, info: () => {} },
    removeTurnTab: t => reaped.push(t.traceId),
    refreshTurnLeases: BrowserHost.prototype.refreshTurnLeases,
  };

  BrowserHost.prototype.reapExpiredTurnTabs.call(host, 61_000);

  assert.deepEqual(reaped, ["trace-1"]);
});
