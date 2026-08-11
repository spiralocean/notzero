// Tests for window-bounds.js — run: node --test desktop/window-bounds.test.js  (no Electron, no GUI)
//
// Restoring a window is only interesting when the saved rectangle no longer fits the machine. Getting THAT
// wrong opens the window off-screen, which reads to a user as "the app didn't start" — strictly worse than
// forgetting the position, which is the bug this replaces. So the display-is-gone cases carry the weight here,
// and every one of them has to degrade to "keep the size, let the OS place it" rather than to a bad position.

const test = require("node:test");
const assert = require("node:assert");
const { placement } = require("./window-bounds.js");

const DEFAULTS = { width: 1280, height: 880, minWidth: 900, minHeight: 600 };
const LAPTOP = { workArea: { x: 0, y: 25, width: 1710, height: 1085 } };            // macOS: menu bar at the top
const EXTERNAL = { workArea: { x: 1710, y: 0, width: 2560, height: 1440 } };        // second display, to the right
const ABOVE = { workArea: { x: 0, y: -1440, width: 2560, height: 1440 } };          // second display, stacked above

test("no saved state → the defaults, with no position", () => {
  for (const empty of [null, undefined, {}, "garbage", 42]) {
    assert.deepEqual(placement(empty, [LAPTOP], DEFAULTS), { width: 1280, height: 880 });
  }
});

test("a saved window on a still-connected display comes back exactly where it was", () => {
  const saved = { x: 300, y: 200, width: 1400, height: 900 };
  assert.deepEqual(placement(saved, [LAPTOP, EXTERNAL], DEFAULTS), { x: 300, y: 200, width: 1400, height: 900 });
});

test("a window on the second display is restored there, not dragged to the primary", () => {
  const saved = { x: 2000, y: 300, width: 1400, height: 900 };
  assert.deepEqual(placement(saved, [LAPTOP, EXTERNAL], DEFAULTS), { x: 2000, y: 300, width: 1400, height: 900 });
});

test("unplugging the display it was on keeps the SIZE but drops the position", () => {
  // The whole point: the user's chosen size survives, and the OS picks a spot that exists.
  const saved = { x: 2000, y: 300, width: 1400, height: 900 };
  assert.deepEqual(placement(saved, [LAPTOP], DEFAULTS), { width: 1400, height: 900 });
});

test("a window stacked above the primary is dropped once that display is gone", () => {
  const saved = { x: 100, y: -1200, width: 1400, height: 900 };
  assert.deepEqual(placement(saved, [LAPTOP, ABOVE], DEFAULTS), { x: 100, y: -1200, width: 1400, height: 900 });
  assert.deepEqual(placement(saved, [LAPTOP], DEFAULTS), { width: 1400, height: 900 });
});

test("a window peeking a few pixels onto a display does not count as visible", () => {
  // Technically on-screen, practically lost. Spans 330..1730 while the only display starts at 1710, so just
  // 20px of it lands anywhere visible — not something a user can find or grab.
  const saved = { x: 330, y: 500, width: 1400, height: 900 };
  assert.deepEqual(placement(saved, [EXTERNAL], DEFAULTS), { width: 1400, height: 900 });
  // …whereas a window merely straddling the seam between two displays is genuinely visible, and stays put.
  assert.deepEqual(placement(saved, [LAPTOP, EXTERNAL], DEFAULTS), { x: 330, y: 500, width: 1400, height: 900 });
});

test("a title bar above the work area is pulled back down so the window can be dragged", () => {
  // y=0 on macOS is under the menu bar: the one part of a window you must be able to reach with a mouse.
  const saved = { x: 300, y: 0, width: 1400, height: 900 };
  assert.deepEqual(placement(saved, [LAPTOP], DEFAULTS), { x: 300, y: 25, width: 1400, height: 900 });
});

test("a size below the window's own minimums is ignored", () => {
  // BrowserWindow would clamp these anyway; passing them through would just persist a lie back to disk.
  const saved = { x: 300, y: 200, width: 400, height: 300 };
  assert.deepEqual(placement(saved, [LAPTOP], DEFAULTS), { x: 300, y: 200, width: 1280, height: 880 });
});

test("maximized is carried through, and only when it is exactly true", () => {
  assert.equal(placement({ width: 1400, height: 900, maximized: true }, [LAPTOP], DEFAULTS).maximized, true);
  for (const v of [false, "true", 1, undefined]) {
    assert.equal(placement({ width: 1400, height: 900, maximized: v }, [LAPTOP], DEFAULTS).maximized, undefined);
  }
});

test("corrupt or hostile saved state never produces a position", () => {
  // window.json is a plain file a user can edit or a crash can truncate. NaN/Infinity are the dangerous ones:
  // they pass a naive typeof check and reach BrowserWindow as a position no display contains.
  const bad = [
    { x: NaN, y: 5, width: 1400, height: 900 },
    { x: 5, y: Infinity, width: 1400, height: 900 },
    { x: "300", y: "200", width: 1400, height: 900 },
  ];
  for (const saved of bad) {
    const got = placement(saved, [LAPTOP], DEFAULTS);
    assert.equal(got.x, undefined, `x leaked through for ${JSON.stringify(saved)}`);
    assert.equal(got.y, undefined, `y leaked through for ${JSON.stringify(saved)}`);
    assert.ok(got.width >= DEFAULTS.minWidth && got.height >= DEFAULTS.minHeight);
  }
});

test("a usable position with an unusable size keeps the position, at the default size", () => {
  // The two halves are independent — a corrupt width is no reason to also forget where the window lived.
  for (const saved of [{ x: 300, y: 200, width: null, height: null }, { x: 300, y: 200 }]) {
    assert.deepEqual(placement(saved, [LAPTOP], DEFAULTS), { x: 300, y: 200, width: 1280, height: 880 });
  }
});

test("no displays reported at all → defaults rather than a crash", () => {
  // screen.getAllDisplays() returning nothing shouldn't be possible, but this runs before the window exists
  // and a throw here would take the whole launch with it.
  const saved = { x: 300, y: 200, width: 1400, height: 900 };
  for (const displays of [[], null, undefined, "nope"]) {
    assert.deepEqual(placement(saved, displays, DEFAULTS), { width: 1400, height: 900 });
  }
});
