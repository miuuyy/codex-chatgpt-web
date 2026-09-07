// Electron's Browser::DockHide ignores a hide that lands within one second of a DockShow, because
// macOS otherwise leaves duplicate Dock icons behind for the same process. Every show therefore
// arms a guard interval that the next hide has to wait out instead of silently losing the request.
const DOCK_SHOW_GUARD_MS = 1100;

const DISPOSED_MESSAGE = "Dock visibility control was disposed";

function createDockVisibilityController({
  dock,
  hasTray,
  now = () => Date.now(),
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (handle) => clearTimeout(handle),
}) {
  if (!dock || typeof dock.hide !== "function" || typeof dock.show !== "function") {
    throw new Error("Dock visibility control requires the macOS dock API");
  }
  if (typeof hasTray !== "function") {
    throw new Error("Dock visibility control requires a menu bar availability probe");
  }

  let desired = null;
  let running = null;
  let draining = false;
  let abortWait = null;
  let lastShowAt = -Infinity;
  let disposed = false;

  function wait(delay) {
    return new Promise((resolve, reject) => {
      const handle = schedule(() => {
        abortWait = null;
        resolve();
      }, delay);
      abortWait = () => {
        abortWait = null;
        cancel(handle);
        reject(new Error(DISPOSED_MESSAGE));
      };
    });
  }

  async function ensureVisible() {
    // A redundant show still refreshes the native guard timestamp, which would turn the next hide
    // into a silent no-op. Only transition when the Dock icon is actually hidden.
    if (dock.isVisible() === true) return;
    await dock.show();
    lastShowAt = now();
    if (dock.isVisible() !== true) throw new Error("macOS kept the Dock icon hidden");
  }

  async function ensureHidden() {
    if (!hasTray()) {
      // Never stand the launcher up with neither a Dock icon nor a menu bar entry to reopen it.
      await ensureVisible();
      throw new Error("The menu bar icon must be available before hiding the Dock icon");
    }
    if (dock.isVisible() === false) return;
    const elapsed = now() - lastShowAt;
    if (elapsed < DOCK_SHOW_GUARD_MS) await wait(DOCK_SHOW_GUARD_MS - elapsed);
    if (disposed) throw new Error(DISPOSED_MESSAGE);
    // Drop a hide that waited out the guard only to be superseded; the drain loop applies the
    // newer request instead of flashing the Dock icon away and straight back.
    if (desired !== null) return;
    // The menu bar entry can disappear while the guard interval elapses, so re-prove it rather
    // than trusting the check from before the wait.
    if (!hasTray()) throw new Error("The menu bar icon must be available before hiding the Dock icon");
    dock.hide();
    if (dock.isVisible() !== false) throw new Error("macOS kept the Dock icon visible");
  }

  async function drain() {
    try {
      while (desired !== null) {
        if (disposed) throw new Error(DISPOSED_MESSAGE);
        const target = desired;
        desired = null;
        if (target) await ensureHidden();
        else await ensureVisible();
      }
    } catch (error) {
      // Everyone awaiting this drain is told it failed, so do not strand a superseding request
      // behind a rejection that nothing would retry.
      desired = null;
      throw error;
    } finally {
      draining = false;
    }
  }

  return {
    // Resolves once the requested state is effective. Concurrent requests coalesce so the newest
    // one wins rather than replaying every intermediate transition.
    request(hidden) {
      if (disposed) return Promise.reject(new Error(DISPOSED_MESSAGE));
      desired = Boolean(hidden);
      if (!draining) {
        draining = true;
        running = drain();
      }
      return running;
    },
    pending() {
      return draining;
    },
    dispose() {
      disposed = true;
      desired = null;
      abortWait?.();
    },
  };
}

module.exports = {
  DOCK_SHOW_GUARD_MS,
  createDockVisibilityController,
};
