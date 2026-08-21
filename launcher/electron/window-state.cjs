const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { readJsonFile } = require("./json-file.cjs");

const DEFAULT_WINDOW_STATE = Object.freeze({
  bounds: { width: 1120, height: 720 },
  maximized: false,
  fullscreen: false,
});
const MIN_WINDOW_BOUNDS = Object.freeze({ width: 720, height: 600 });
const MAX_WINDOW_DIMENSION = 16_384;

function finiteNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function overlapsDisplay(bounds, displays) {
  return displays.some((display) => {
    const area = display?.workArea;
    if (!area) return false;
    return bounds.x < area.x + area.width
      && bounds.x + bounds.width > area.x
      && bounds.y < area.y + area.height
      && bounds.y + bounds.height > area.y;
  });
}

function normalizeWindowState(value, displays = []) {
  const saved = value && typeof value === "object" ? value : {};
  const bounds = saved.bounds && typeof saved.bounds === "object" ? saved.bounds : {};
  const state = {
    bounds: {
      width: Math.min(
        MAX_WINDOW_DIMENSION,
        Math.max(MIN_WINDOW_BOUNDS.width, finiteNumber(bounds.width, DEFAULT_WINDOW_STATE.bounds.width)),
      ),
      height: Math.min(
        MAX_WINDOW_DIMENSION,
        Math.max(MIN_WINDOW_BOUNDS.height, finiteNumber(bounds.height, DEFAULT_WINDOW_STATE.bounds.height)),
      ),
    },
    maximized: saved.maximized === true,
    fullscreen: saved.fullscreen === true,
  };
  if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    const positioned = { ...state.bounds, x: bounds.x, y: bounds.y };
    if (displays.length === 0 || overlapsDisplay(positioned, displays)) {
      state.bounds.x = bounds.x;
      state.bounds.y = bounds.y;
    }
  }
  return state;
}

function readWindowState(filePath, displays = []) {
  try {
    return normalizeWindowState(readJsonFile(filePath), displays);
  } catch {
    return normalizeWindowState(null, displays);
  }
}

function writeWindowState(filePath, state) {
  writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function captureWindowState(window) {
  return {
    bounds: window.isMaximized() || window.isFullScreen() ? window.getNormalBounds() : window.getBounds(),
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
  };
}

function trackWindowState(window, filePath, onError) {
  let timer = null;
  const capture = () => {
    timer = null;
    if (window.isDestroyed()) return;
    try {
      writeWindowState(filePath, captureWindowState(window));
    } catch (error) {
      onError?.(error);
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(capture, 400);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    window.on(event, schedule);
  }
  window.on("close", () => {
    if (timer) clearTimeout(timer);
    capture();
  });
}

module.exports = {
  DEFAULT_WINDOW_STATE,
  MIN_WINDOW_BOUNDS,
  captureWindowState,
  normalizeWindowState,
  readWindowState,
  trackWindowState,
  writeWindowState,
};
