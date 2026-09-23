const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  normalizeWindowState,
  readWindowState,
  writeWindowState,
} = require("../electron/window-state.cjs");

const displays = [{ workArea: { x: 0, y: 0, width: 1512, height: 982 } }];

test("window state preserves visible bounds and desktop modes", () => {
  assert.deepEqual(normalizeWindowState({
    bounds: { x: 120, y: 80, width: 1280, height: 800 },
    maximized: true,
    fullscreen: false,
  }, displays), {
    bounds: { x: 120, y: 80, width: 1280, height: 800 },
    maximized: true,
    fullscreen: false,
  });
});

test("window state drops off-screen positions and enforces minimum dimensions", () => {
  assert.deepEqual(normalizeWindowState({
    bounds: { x: 9000, y: 9000, width: 200, height: 100 },
  }, displays), {
    bounds: { width: 720, height: 600 },
    maximized: false,
    fullscreen: false,
  });
});

test("window state resets positions with no usable title bar on a remaining display", () => {
  for (const bounds of [
    { x: 1511, y: 400, width: 1120, height: 720 }, // Only one pixel remains visible.
    { x: 100, y: 981, width: 1120, height: 720 }, // Title bar is below the work area.
    { x: 100, y: -700, width: 1120, height: 720 }, // Body overlaps, title bar does not.
  ]) {
    assert.deepEqual(normalizeWindowState({ bounds }, displays).bounds, { width: 1120, height: 720 });
  }
  assert.deepEqual(normalizeWindowState({
    bounds: { x: 1400, y: 10, width: 1120, height: 720 },
  }, displays).bounds, { x: 1400, y: 10, width: 1120, height: 720 });
});

test("window state caps corrupt oversized dimensions", () => {
  const state = normalizeWindowState({
    bounds: { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER },
  }, displays);
  assert.deepEqual(state.bounds, { width: 16_384, height: 16_384 });
});

test("window state is stored atomically with owner-only permissions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-window-state-"));
  const file = path.join(root, "window-state.json");
  try {
    const state = {
      bounds: { x: 20, y: 30, width: 1120, height: 720 },
      maximized: false,
      fullscreen: false,
    };
    writeWindowState(file, state);
    assert.deepEqual(readWindowState(file, displays), state);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.readdirSync(root).some((name) => name.includes(".tmp-")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
