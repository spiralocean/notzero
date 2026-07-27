// Tests for install-gate.js — run: node --test desktop/install-gate.test.js  (no Electron, no timers wall-clock)
//
// The property that matters: an update must never quit the app out from under an open modal dialog, and must
// never be silently dropped either. Timers are injected, so this runs instantly and deterministically.

const test = require("node:test");
const assert = require("node:assert");
const { deferWhileBusy } = require("./install-gate.js");

// A fake clock: collect scheduled callbacks, then advance time explicitly.
function clock() {
  let now = 0;
  const q = [];
  const setTimer = (fn, ms) => { q.push({ at: now + (ms || 0), fn }); };
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      q.sort((a, b) => a.at - b.at);
      const i = q.findIndex((t) => t.at <= until);
      if (i < 0) break;
      const t = q.splice(i, 1)[0];
      now = t.at;
      t.fn();
    }
    now = until;
  };
  return { setTimer, advance, pending: () => q.length };
}

test("nothing on screen: installs on the normal delay, exactly as the flat timer did", () => {
  const c = clock();
  let idle = 0, ran = 0;
  deferWhileBusy({ isBusy: () => false, onIdle: () => idle++, run: () => ran++, delayMs: 6000, setTimer: c.setTimer });
  assert.equal(idle, 1, "the overlay/notification fire immediately, not after the delay");
  assert.equal(ran, 0, "but the quit waits");
  c.advance(5999);
  assert.equal(ran, 0);
  c.advance(1);
  assert.equal(ran, 1, "installs at the delay");
});

test("a dialog is open: nothing happens at all — no overlay, no quit", () => {
  const c = clock();
  let idle = 0, ran = 0;
  deferWhileBusy({ isBusy: () => true, onIdle: () => idle++, run: () => ran++, delayMs: 6000, pollMs: 1000, setTimer: c.setTimer });
  c.advance(60 * 60 * 1000);   // an hour of the recap sitting open
  assert.equal(idle, 0, "the 'restarting in a moment' overlay must NOT appear while it cannot restart");
  assert.equal(ran, 0, "and it must not quit out from under the dialog");
});

test("the dialog closes: the install proceeds from there", () => {
  const c = clock();
  let open = true, idle = 0, ran = 0;
  deferWhileBusy({ isBusy: () => open, onIdle: () => idle++, run: () => ran++, delayMs: 6000, pollMs: 1000, setTimer: c.setTimer });
  c.advance(30_000);
  assert.equal(idle, 0);
  open = false;
  c.advance(1000);              // next poll notices
  assert.equal(idle, 1, "overlay appears once it is safe to restart");
  assert.equal(ran, 0);
  c.advance(6000);
  assert.equal(ran, 1, "and the install lands");
});

test("it never fires twice, however long it is left running", () => {
  const c = clock();
  let open = true, idle = 0, ran = 0;
  deferWhileBusy({ isBusy: () => open, onIdle: () => idle++, run: () => ran++, delayMs: 6000, pollMs: 1000, setTimer: c.setTimer });
  c.advance(10_000);
  open = false;
  c.advance(10_000);
  open = true;                  // a second dialog opens after the install was already released
  c.advance(60_000);
  assert.equal(idle, 1, "onIdle is once-only");
  assert.equal(ran, 1, "and so is the install — a dialog opening later cannot re-trigger or double-quit it");
});

test("a throwing isBusy installs rather than stalling forever", () => {
  const c = clock();
  let ran = 0;
  deferWhileBusy({ isBusy: () => { throw new Error("boom"); }, run: () => ran++, delayMs: 6000, setTimer: c.setTimer });
  c.advance(6000);
  assert.equal(ran, 1, "a broken predicate must not be able to wedge updates permanently");
});

test("a throwing run does not leave the gate armed to fire again", () => {
  const c = clock();
  let ran = 0;
  deferWhileBusy({ isBusy: () => false, run: () => { ran++; throw new Error("boom"); }, delayMs: 6000, setTimer: c.setTimer });
  c.advance(60_000);
  assert.equal(ran, 1);
});

test("onIdle is optional", () => {
  const c = clock();
  let ran = 0;
  deferWhileBusy({ isBusy: () => false, run: () => ran++, delayMs: 100, setTimer: c.setTimer });
  c.advance(100);
  assert.equal(ran, 1);
});
