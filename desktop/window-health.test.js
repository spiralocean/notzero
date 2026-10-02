// Tests for window-health.js — run: node --test desktop/window-health.test.js  (no Electron, no GUI)
//
// Two ways to get this wrong. Miss a blank window and the user is back to staring at black after a reboot.
// Call a fine window blank and the app reloads under them — worst of all on every focus while it's covered,
// which is why "couldn't capture" has to stay distinct from "captured nothing".

const test = require("node:test");
const assert = require("node:assert");
const { isBlank, createWindowHealth } = require("./window-health.js");

const px = (r, g, b, n = 1) => Buffer.from(Array.from({ length: n }, () => [b, g, r, 255]).flat()); // BGRA, like macOS
const BG = px(0x05, 0x04, 0x0a, 64); // the window's backgroundColor, #05040a

test("a window of pure background is blank", () => {
  assert.equal(isBlank(BG), true);
});

test("one drawn pixel anywhere is enough to call it painted", () => {
  assert.equal(isBlank(Buffer.concat([BG, px(0xf7, 0x93, 0x1a)])), false);     // bitcoin orange
  assert.equal(isBlank(Buffer.concat([px(0x30, 0x30, 0x40), BG])), false);     // a dim border
});

test("scaling blur near the background still counts as blank", () => {
  assert.equal(isBlank(Buffer.concat([BG, px(0x10, 0x0c, 0x14, 8)])), true);
});

test("an empty capture is 'unknown', not blank", () => {
  for (const empty of [null, undefined, Buffer.alloc(0)]) assert.equal(isBlank(empty), null);
});

test("healthy and unknown probes never reload", () => {
  const h = createWindowHealth();
  for (const p of [{ blank: false }, { blank: null }, {}, undefined]) assert.equal(h.verdict(p), "ok");
});

test("each kind of sick window reloads", () => {
  for (const p of [{ blank: true }, { stuckLoading: true }, { captureTimedOut: true }]) {
    assert.equal(createWindowHealth().verdict(p), "reload");
  }
});

test("reloads are capped, then it gives up instead of looping", () => {
  let t = 0;
  const h = createWindowHealth({ now: () => t, maxReloads: 3, windowMs: 120000 });
  for (let i = 0; i < 3; i++) { t += 15000; assert.equal(h.verdict({ blank: true }), "reload"); }
  t += 15000;
  assert.equal(h.verdict({ blank: true }), "give-up");
});

test("old reloads age out — a fresh incident later gets its own budget", () => {
  let t = 0;
  const h = createWindowHealth({ now: () => t, maxReloads: 3, windowMs: 120000 });
  for (let i = 0; i < 3; i++) h.verdict({ blank: true });
  t += 120001;
  assert.equal(h.verdict({ blank: true }), "reload");
});

test("a window seen healthy clears the history; an unknown probe does not", () => {
  const h = createWindowHealth({ now: () => 0, maxReloads: 2 });
  h.verdict({ blank: true }); h.verdict({ blank: true });
  h.verdict({ blank: null });
  assert.equal(h.verdict({ blank: true }), "give-up");
  h.verdict({ blank: false });
  assert.equal(h.verdict({ blank: true }), "reload");
});
