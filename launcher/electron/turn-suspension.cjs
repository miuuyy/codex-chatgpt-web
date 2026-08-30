"use strict";

/**
 * System sleep freezes both sides of the turn-lease protocol at once: the helper cannot send
 * heartbeats and the launcher cannot observe them. On wake every stalled timer fires together, and
 * without these guards the first sweep after a sleep reaped live turns as orphans — pmset logged
 * 'Idle Sleep' 41 seconds into two running turns, and both died on the next DarkWake to the second.
 */

/**
 * The turn-lease sweep runs on a short fixed interval for the whole life of the launcher. A gap
 * between consecutive sweeps far larger than that interval means the process was suspended, not
 * busy: nothing the launcher does blocks its event loop for multiples of the sweep interval.
 */
function sweepGapIndicatesSuspension(lastSweepAt, now, sweepIntervalMs) {
  if (typeof lastSweepAt !== "number" || !Number.isFinite(lastSweepAt)) return false;
  return now - lastSweepAt >= sweepIntervalMs * 6;
}

/**
 * Re-baseline every lease that depends on time passing. A running tab's helper gets a full
 * heartbeat window to prove it survived the sleep; a tab still bootstrapping gets its bootstrap
 * budget back. Returns the refreshed trace ids so the caller can log the decision.
 */
function refreshTurnLeasesAfterSuspension(tabs, now, bootstrapTimeoutMs) {
  const refreshed = [];
  for (const tab of tabs) {
    if (tab.status !== "running") continue;
    tab.lastHeartbeatAt = now;
    if (tab.bootstrapReady !== true) tab.bootstrapDeadlineAt = now + bootstrapTimeoutMs;
    refreshed.push(tab.traceId);
  }
  return refreshed;
}

/**
 * A power-save blocker belongs up exactly while at least one browser turn is running: an idle Mac
 * otherwise sleeps mid-turn, and no amount of wake-side tolerance recovers the minutes ChatGPT
 * spent frozen.
 */
function shouldBlockSleepForTurns(tabs) {
  for (const tab of tabs) {
    if (tab.status === "running") return true;
  }
  return false;
}

module.exports = {
  sweepGapIndicatesSuspension,
  refreshTurnLeasesAfterSuspension,
  shouldBlockSleepForTurns,
};
