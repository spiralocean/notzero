// Tests for miner-watchdog.js — run: node --test desktop/miner-watchdog.test.js  (no Electron, no clock)
//
// The property that matters, and the one two earlier versions got wrong: being between blocks is not a stall,
// and neither is a block whose header timestamp lies about when it arrived. The cases below are REAL — every
// restart this predicate caused on a live install, with heights read from the node's own UpdateTip log.

const test = require("node:test");
const assert = require("node:assert");
const { isMinerStalled } = require("./miner-watchdog.js");

// The 18 restarts caused by the ORIGINAL predicate, over two days. Each fired within a minute of a block
// arriving; in every case the miner was already on tip+1, having just ticketed the block that landed.
const SLOW_BLOCK_ALARMS = [35, 21, 26, 50, 36, 22, 22, 25, 22, 20, 32, 28, 21, 50, 22, 52, 23, 28]
  .map((mins) => ({ ticketAgeSec: Math.max(1201, mins * 60), attemptHeight: 961_058, tipHeight: 961_057 }));

// The two that survived the first fix. Both are header-clock lies: the block arrived, the miner ticketed it
// within half a minute, and the header claimed a time AFTER our ticket.
//   2026-08-04 18:58Z  block 961057 arrived 18:38:07Z, header 18:38:58Z (+51s),  miner ticketed 961058
//   2026-08-05 23:57Z  block 961222 arrived 23:37:10Z, header 23:40:44Z (+214s), miner ticketed 961223
const HEADER_CLOCK_ALARMS = [
  { ticketAgeSec: 1204, attemptHeight: 961_058, tipHeight: 961_057 },
  { ticketAgeSec: 1201, attemptHeight: 961_223, tipHeight: 961_222 },
];

test("none of the 18 slow-block restarts are stalls — the miner was on tip+1 every time", () => {
  for (const c of SLOW_BLOCK_ALARMS) {
    assert.equal(isMinerStalled(c), false, `ticket ${c.ticketAgeSec}s old, mining #${c.attemptHeight} over tip #${c.tipHeight}`);
  }
});

test("neither header-clock restart is a stall", () => {
  for (const c of HEADER_CLOCK_ALARMS) assert.equal(isMinerStalled(c), false);
});

test("both earlier predicates fired on those — so the cases discriminate, they don't just pass", () => {
  // v1: ticket much older than the tip. v2: + tip must have stood 5 min. Fed the tip ages actually observed.
  const v1 = (t, p) => t > 1200 && t > p + 600;
  const v2 = (t, p) => t > 1200 && p > 300 && t > p;
  assert.equal(v1(1204, 5), true, "v1 fired seconds after a block landed");
  assert.equal(v2(1204, 1184), true, "v2 fired on the +51s header drift (2026-08-04)");
  assert.equal(v2(1201, 998), true, "v2 fired on the +214s header drift (2026-08-05)");
  // and the 180s grace that was nearly shipped would not have saved the second one either
  assert.equal(1201 > 998 + 180, true, "a 180s grace still fires on a 214s drift");
});

test("a genuinely hung miner IS caught — the tip moves past it", () => {
  assert.equal(isMinerStalled({ ticketAgeSec: 1800, attemptHeight: 961_057, tipHeight: 961_058 }), true, "one block behind");
  assert.equal(isMinerStalled({ ticketAgeSec: 3600, attemptHeight: 961_050, tipHeight: 961_058 }), true, "eight blocks behind");
});

test("one poll of slack: still on the height that just became the tip is not yet a stall", () => {
  // A block lands and becomes the tip while the miner is mid-attempt on it. Up to 30s later it moves to tip+1.
  assert.equal(isMinerStalled({ ticketAgeSec: 3600, attemptHeight: 961_058, tipHeight: 961_058 }), false);
});

test("a slow block is not a stall, however long it runs", () => {
  for (const mins of [21, 30, 45, 60, 90, 240]) {
    assert.equal(isMinerStalled({ ticketAgeSec: mins * 60, attemptHeight: 961_058, tipHeight: 961_057 }), false, `${mins}m slow block`);
  }
});

test("a fresh ticket is never a stall, even far behind", () => {
  assert.equal(isMinerStalled({ ticketAgeSec: 0, attemptHeight: 961_000, tipHeight: 961_058 }), false);
  assert.equal(isMinerStalled({ ticketAgeSec: 1200, attemptHeight: 961_000, tipHeight: 961_058 }), false, "exactly at the threshold");
  assert.equal(isMinerStalled({ ticketAgeSec: 1201, attemptHeight: 961_000, tipHeight: 961_058 }), true, "one second past it");
});

test("unknown or missing heights never raise an alarm", () => {
  for (const bad of [undefined, null, NaN, 0, -1, "961057"]) {
    assert.equal(isMinerStalled({ ticketAgeSec: 3600, attemptHeight: bad, tipHeight: 961_058 }), false, `attemptHeight=${bad}`);
    assert.equal(isMinerStalled({ ticketAgeSec: 3600, attemptHeight: 961_000, tipHeight: bad }), false, `tipHeight=${bad}`);
  }
  assert.equal(isMinerStalled(), false, "no arguments at all");
});

test("a missing ticket timestamp never raises an alarm", () => {
  for (const bad of [NaN, undefined, null, Infinity]) {
    assert.equal(isMinerStalled({ ticketAgeSec: bad, attemptHeight: 961_000, tipHeight: 961_058 }), false);
  }
});

test("the ticket-age threshold is overridable without changing the shape of the answer", () => {
  const args = { attemptHeight: 961_000, tipHeight: 961_058 };
  assert.equal(isMinerStalled({ ...args, ticketAgeSec: 600 }), false, "default 1200s gate holds it");
  assert.equal(isMinerStalled({ ...args, ticketAgeSec: 600, minTicketAgeSec: 300 }), true, "a lower gate flags it");
});
