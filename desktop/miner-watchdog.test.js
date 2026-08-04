// Tests for miner-watchdog.js — run: node --test desktop/miner-watchdog.test.js  (no Electron, no clock)
//
// The property that matters, and the one the old test got backwards: being between blocks is not a stall.
// The regression cases below are REAL — every restart this predicate caused on a live install over two days,
// with the tip age measured from the node's own UpdateTip log. All eighteen were healthy miners.

const test = require("node:test");
const assert = require("node:assert");
const { isMinerStalled } = require("./miner-watchdog.js");

// (ticketAgeSec, tipAgeSec) at the moment the old watchdog fired. Ticket ages come from the app's own warning
// line, which rounds to the minute (`Math.round(ageSec / 60)`), so they are accurate to ±30s — the 20m entry
// is written as 1210s because the old predicate required strictly more than 1200 for it to have fired at all.
// Tip ages are exact: seconds between the node's UpdateTip for that block and the watchdog firing.
const REAL_FALSE_ALARMS = [
  [35 * 60, 50], [21 * 60, 3], [26 * 60, 6], [50 * 60, 6], [36 * 60, 3], [22 * 60, 10],
  [22 * 60, 4], [25 * 60, 9], [22 * 60, 5], [1210, 4], [32 * 60, 5], [28 * 60, 7],
  [21 * 60, 4], [50 * 60, 3], [22 * 60, 6], [52 * 60, 7], [23 * 60, 5], [28 * 60, 2],
];

test("every restart this actually caused on a live install was a false alarm", () => {
  for (const [ticketAgeSec, tipAgeSec] of REAL_FALSE_ALARMS) {
    assert.equal(
      isMinerStalled({ ticketAgeSec, tipAgeSec }), false,
      `ticket ${ticketAgeSec / 60}m old, tip ${tipAgeSec}s old — the miner simply had not polled yet`,
    );
  }
});

test("the old test fired on all of them — proving these cases discriminate", () => {
  const old = (ticketAgeSec, tipAgeSec) => ticketAgeSec > 1200 && ticketAgeSec > tipAgeSec + 600;
  for (const [ticketAgeSec, tipAgeSec] of REAL_FALSE_ALARMS) {
    assert.equal(old(ticketAgeSec, tipAgeSec), true, "old predicate should fire (that was the bug)");
  }
});

test("a genuinely hung miner IS caught", () => {
  // Miner frozen; blocks keep arriving every ~10 min. Five minutes after one lands, it should be flagged.
  assert.equal(isMinerStalled({ ticketAgeSec: 52 * 60, tipAgeSec: 5 * 60 + 1 }), true);
  assert.equal(isMinerStalled({ ticketAgeSec: 90 * 60, tipAgeSec: 9 * 60 }), true);
  assert.equal(isMinerStalled({ ticketAgeSec: 3 * 3600, tipAgeSec: 10 * 60 }), true);
});

test("a slow block is not a stall, however long it runs", () => {
  // No block for an hour: tip and ticket age together, so the ticket never predates the tip.
  for (const mins of [21, 30, 45, 60, 90]) {
    assert.equal(isMinerStalled({ ticketAgeSec: mins * 60, tipAgeSec: mins * 60 }), false, `${mins}m slow block`);
    assert.equal(isMinerStalled({ ticketAgeSec: mins * 60, tipAgeSec: mins * 60 + 30 }), false, "tip slightly older");
  }
});

test("a fresh ticket is never a stall", () => {
  assert.equal(isMinerStalled({ ticketAgeSec: 0, tipAgeSec: 3600 }), false);
  assert.equal(isMinerStalled({ ticketAgeSec: 1200, tipAgeSec: 3600 }), false, "exactly at the threshold");
  assert.equal(isMinerStalled({ ticketAgeSec: 1201, tipAgeSec: 3600 }), false, "still younger than the tip");
});

test("an unknown or missing tip time never raises an alarm", () => {
  for (const tipAgeSec of [Infinity, NaN, undefined, null]) {
    assert.equal(isMinerStalled({ ticketAgeSec: 3600, tipAgeSec }), false, `tipAge=${tipAgeSec}`);
  }
});

test("a missing ticket timestamp never raises an alarm", () => {
  for (const ticketAgeSec of [NaN, undefined, null, Infinity]) {
    assert.equal(isMinerStalled({ ticketAgeSec, tipAgeSec: 3600 }), false, `ticketAge=${ticketAgeSec}`);
  }
  assert.equal(isMinerStalled(), false, "no arguments at all");
});

test("the tip must have STOOD before the miner is blamed — the boundary", () => {
  const ticketAgeSec = 60 * 60;
  assert.equal(isMinerStalled({ ticketAgeSec, tipAgeSec: 299 }), false, "just under: the miner may not have polled");
  assert.equal(isMinerStalled({ ticketAgeSec, tipAgeSec: 300 }), false, "exactly at the threshold");
  assert.equal(isMinerStalled({ ticketAgeSec, tipAgeSec: 301 }), true, "past it, and the ticket predates the tip");
});

test("thresholds are overridable without changing the shape of the answer", () => {
  const args = { ticketAgeSec: 40 * 60, tipAgeSec: 120 };
  assert.equal(isMinerStalled(args), false, "default 300s grace covers a 120s-old tip");
  assert.equal(isMinerStalled({ ...args, minTipAgeSec: 60 }), true, "a shorter grace flags it");
});
