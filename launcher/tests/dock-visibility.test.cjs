const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DOCK_SHOW_GUARD_MS,
  createDockVisibilityController,
} = require("../electron/dock-visibility.cjs");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function createDock({ visible = true, obeysHide = true, deferShow = false } = {}) {
  const calls = [];
  let shown = visible;
  let finishShow = null;
  return {
    calls,
    releaseShow() {
      const release = finishShow;
      finishShow = null;
      release();
    },
    hide() {
      calls.push("hide");
      if (obeysHide) shown = false;
    },
    show() {
      calls.push("show");
      if (!deferShow) {
        shown = true;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        finishShow = () => {
          shown = true;
          resolve();
        };
      });
    },
    isVisible: () => shown,
  };
}

function createClock(start = 10_000) {
  let current = start;
  const timers = new Set();
  return {
    now: () => current,
    schedule(callback, delay) {
      const timer = { at: current + delay, callback };
      timers.add(timer);
      return timer;
    },
    cancel(timer) {
      timers.delete(timer);
    },
    async advance(ms) {
      current += ms;
      for (const timer of [...timers]) {
        if (timer.at <= current) {
          timers.delete(timer);
          timer.callback();
        }
      }
      await flush();
    },
    pending: () => timers.size,
  };
}

function controllerFor(dock, { hasTray = () => true, clock = createClock() } = {}) {
  return {
    clock,
    controller: createDockVisibilityController({
      dock,
      hasTray,
      now: clock.now,
      schedule: clock.schedule.bind(clock),
      cancel: clock.cancel.bind(clock),
    }),
  };
}

test("enabling hides the Dock icon once a menu bar entry exists", async () => {
  const dock = createDock();
  const { controller } = controllerFor(dock);
  await controller.request(true);
  assert.deepEqual(dock.calls, ["hide"]);
  assert.equal(dock.isVisible(), false);
});

test("hiding is refused without a menu bar entry and leaves the Dock icon reachable", async () => {
  const dock = createDock();
  const { controller } = controllerFor(dock, { hasTray: () => false });
  await assert.rejects(controller.request(true), /menu bar icon must be available/);
  assert.deepEqual(dock.calls, []);
  assert.equal(dock.isVisible(), true);
});

test("a Dock icon hidden without a menu bar entry is restored before the refusal", async () => {
  const dock = createDock({ visible: false });
  const { controller } = controllerFor(dock, { hasTray: () => false });
  await assert.rejects(controller.request(true), /menu bar icon must be available/);
  assert.deepEqual(dock.calls, ["show"]);
  assert.equal(dock.isVisible(), true);
});

test("showing an already visible Dock icon never re-arms the native hide guard", async () => {
  const dock = createDock();
  const { controller, clock } = controllerFor(dock);
  await controller.request(false);
  assert.deepEqual(dock.calls, []);
  // A redundant show would refresh Electron's DockShow timestamp and turn this hide into a
  // silent no-op, which is exactly how a toggle ends up disagreeing with the Dock.
  await controller.request(true);
  assert.deepEqual(dock.calls, ["hide"]);
  assert.equal(clock.pending(), 0);
});

test("a hide inside the native guard interval waits the interval out instead of being ignored", async () => {
  const dock = createDock({ visible: false });
  const { controller, clock } = controllerFor(dock);
  await controller.request(false);
  assert.deepEqual(dock.calls, ["show"]);

  const hidden = controller.request(true);
  await flush();
  assert.deepEqual(dock.calls, ["show"], "the hide must not run while the guard is armed");

  // Literal timings: a shrunken guard constant would already have hidden by now.
  await clock.advance(1099);
  assert.deepEqual(dock.calls, ["show"], "the hide must wait out the full native guard interval");

  await clock.advance(1);
  await hidden;
  assert.deepEqual(dock.calls, ["show", "hide"]);
  assert.equal(dock.isVisible(), false);
});

test("a deferred hide is dropped when a newer request wants the Dock icon back", async () => {
  const dock = createDock({ visible: false });
  const { controller, clock } = controllerFor(dock);
  await controller.request(false);

  const pending = controller.request(true);
  await flush();
  controller.request(false);
  await clock.advance(DOCK_SHOW_GUARD_MS);
  await pending;

  assert.deepEqual(dock.calls, ["show"], "the superseded hide must not flash the Dock icon");
  assert.equal(dock.isVisible(), true);
});

test("a hide the system ignores is reported instead of being recorded as applied", async () => {
  const dock = createDock({ obeysHide: false });
  const { controller } = controllerFor(dock);
  await assert.rejects(controller.request(true), /kept the Dock icon visible/);
  assert.deepEqual(dock.calls, ["hide"]);
});

test("disposal cancels a deferred hide and stops further transitions", async () => {
  const dock = createDock({ visible: false });
  const { controller, clock } = controllerFor(dock);
  await controller.request(false);

  const pending = controller.request(true);
  await flush();
  controller.dispose();

  await assert.rejects(pending, /disposed/);
  await assert.rejects(controller.request(true), /disposed/);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(dock.calls, ["show"]);
});

test("the guard interval is never shortened below the documented native minimum", () => {
  // Electron's Browser::DockHide ignores a hide within one second of a DockShow; the extra margin
  // absorbs clock granularity. Shortening this reintroduces silently ignored hides.
  assert.ok(DOCK_SHOW_GUARD_MS >= 1100, `guard interval ${DOCK_SHOW_GUARD_MS}ms is too short`);
});

test("a request made after the queue drains still runs instead of reporting a phantom success", async () => {
  const dock = createDock();
  const { controller } = controllerFor(dock);

  // The Dock is already visible, so this request settles without any native call. A follow-up that
  // lands as that drain finishes must start a new one rather than inherit its resolved promise.
  const settled = controller.request(false);
  const followUp = settled.then(() => controller.request(true));
  await settled;
  await followUp;

  assert.deepEqual(dock.calls, ["hide"]);
  assert.equal(dock.isVisible(), false);
  assert.equal(controller.pending(), false);
});

test("one drain applies every queued transition, not just the first", async () => {
  const dock = createDock({ visible: false, deferShow: true });
  const { controller, clock } = controllerFor(dock);

  const shown = controller.request(false);
  await flush();
  assert.deepEqual(dock.calls, ["show"]);

  // Queued while the show is still in flight, so both targets belong to the same drain.
  controller.request(true);
  dock.releaseShow();
  await flush();
  await clock.advance(1100);
  await shown;

  assert.deepEqual(dock.calls, ["show", "hide"]);
  assert.equal(dock.isVisible(), false);
});

test("losing the menu bar entry during the guard wait aborts the hide", async () => {
  const dock = createDock({ visible: false });
  let tray = true;
  const { controller, clock } = controllerFor(dock, { hasTray: () => tray });
  await controller.request(false);

  const hidden = controller.request(true);
  // Attach the expectation before the clock advances; the rejection lands inside advance().
  const refused = assert.rejects(hidden, /menu bar icon must be available/);
  await flush();
  tray = false;
  await clock.advance(1100);
  await refused;
  assert.deepEqual(dock.calls, ["show"]);
  assert.equal(dock.isVisible(), true);
});
