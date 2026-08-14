// ---------------------------------------------------------------------------
// Where to put the main window on launch.
//
// The app remembers nothing about its window today, so every relaunch snaps back to a 1280x880 default. You
// only notice when something relaunches FOR you — an auto-update installs, and the window you had sized and
// placed comes back somewhere else.
//
// Restoring a saved rectangle is the easy half. The half that goes wrong is restoring one that no longer fits
// the machine: the display it was on got unplugged, the laptop left the dock, the resolution changed. Put the
// window there anyway and it opens off-screen — indistinguishable, to the user, from an app that failed to
// start. So a saved position has to EARN its way back by still being visible on some display.
//
// Pure (displays are passed in, not read from Electron) so the off-screen cases can be tested without a GUI.
// ---------------------------------------------------------------------------
"use strict";

// Enough of the window on-screen to see it and grab it. A window peeking 10px past the edge of a display is
// technically "visible" and practically lost, so require a real, draggable sliver.
const MIN_VISIBLE = 96;

function intersects(rect, area, minVisible = MIN_VISIBLE) {
  const w = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
  const h = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
  return w >= minVisible && h >= minVisible;
}

/**
 * placement(saved, displays, defaults) -> BrowserWindow geometry options.
 *
 * saved:    what was last written to disk (any shape — it's user-writable JSON, so treat it as hostile)
 * displays: [{workArea: {x, y, width, height}}], i.e. Electron's screen.getAllDisplays()
 * defaults: {width, height, minWidth, minHeight}
 *
 * Returns {width, height} (let the OS place it) or {x, y, width, height} (restore in full), plus
 * `maximized` / `fullScreen` when the window should come back in that state.
 */
function placement(saved, displays, defaults) {
  const { width: dw, height: dh, minWidth = 0, minHeight = 0 } = defaults;
  const out = { width: dw, height: dh };
  if (!saved || typeof saved !== "object") return out;

  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const w = num(saved.width), h = num(saved.height);
  // A size is usable on its own even when the position isn't — someone who widened the window keeps that
  // width on the next launch even if the display it lived on is gone.
  if (w !== null && h !== null && w >= minWidth && h >= minHeight) {
    out.width = Math.round(w);
    out.height = Math.round(h);
  }
  if (saved.maximized === true) out.maximized = true;
  // Full screen is restored only when it was EXPLICITLY recorded, never inferred from a maximised window or
  // a window that happened to fill a display. Someone who was not in full screen must not be dropped into a
  // macOS full-screen Space by a background auto-update — that is a jarring thing to do to a person, and
  // harder to get out of than it looks if the window comes back on a display they cannot see.
  if (saved.fullScreen === true) out.fullScreen = true;

  const x = num(saved.x), y = num(saved.y);
  if (x === null || y === null) return out;
  if (!Array.isArray(displays) || displays.length === 0) return out;

  const rect = { x: Math.round(x), y: Math.round(y), width: out.width, height: out.height };
  const home = displays.find((d) => d && d.workArea && intersects(rect, d.workArea));
  if (!home) return out; // the display it was on is gone → keep the size, let the OS choose the spot

  out.x = rect.x;
  // The title bar is the only way to move a window with a mouse. A saved y above the work area (a menu bar
  // appeared, or the display arrangement shifted) would put it out of reach, so pull it back down.
  out.y = Math.max(rect.y, home.workArea.y);
  return out;
}

module.exports = { placement, intersects, MIN_VISIBLE };
