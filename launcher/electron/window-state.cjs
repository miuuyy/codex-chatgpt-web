const { readJsonFile } = require("./json-file.cjs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");

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

function visibleWorkArea(bounds, displays) {
  let selected;
  let largestOverlap = 0;
  for (const { workArea: area } of displays) {
    if (!area) continue;
    const width = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x));
    const height = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
    if (width * height > largestOverlap) {
      selected = area;
      largestOverlap = width * height;
    }
  }
  return selected;
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
    if (displays.length === 0) {
      state.bounds.x = bounds.x;
      state.bounds.y = bounds.y;
    } else {
      const area = visibleWorkArea(positioned, displays);
      if (area) {
        // Keep the window on the display it mostly occupied, with its top edge
        // and controls reachable even when the saved desktop layout has changed.
        state.bounds.width = Math.max(MIN_WINDOW_BOUNDS.width, Math.min(state.bounds.width, area.width));
        state.bounds.height = Math.max(MIN_WINDOW_BOUNDS.height, Math.min(state.bounds.height, area.height));
        state.bounds.x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - state.bounds.width));
        state.bounds.y = Math.max(area.y, Math.min(bounds.y, area.y + area.height - state.bounds.height));
      }
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
