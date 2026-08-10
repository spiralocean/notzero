// Tests for miner-watchdog.js — run: node --test desktop/miner-watchdog.test.js  (no Electron, no clock)
//
// This predicate has shipped wrong four times, so the cases below are the actual incidents, not invented ones.
// Every one was a HEALTHY miner that an earlier version restarted. They are kept as a standing argument that
// chain-derived liveness does not work: each is expressed in the terms its version used, and asserted to be
// invisible to the current one — because the current one does not look at the chain at all.

const test = require("node:test");
const assert = require("node:assert");
const { isMinerStalled, POLL_INTERVAL_SEC, STALE_POLLS } = require("./miner-watchdog.js");

const FRESH = { lastPollAgeSec: 3 };          // a loop that just ran
const DEAD = { lastPollAgeSec: 600 };         // ten minutes without a pass

test("a running loop is never a stall, whatever the chain is doing", () => {
  for (const age of [0, 1, 15, 30, 60, 119]) {
    assert.equal(isMinerStalled({ lastPollAgeSec: age }), false, `${age}s since the last pass`);
  }
});

test("a loop that has missed several passes IS a stall", () => {
  assert.equal(isMinerStalled({ lastPollAgeSec: 121 }), true, "just past 4 missed passes");
  assert.equal(isMinerStalled(DEAD), true);
  assert.equal(isMinerStalled({ lastPollAgeSec: 3600 }), true);
});

test("the threshold is 4 missed passes, and the boundary is exact", () => {
  const edge = POLL_INTERVAL_SEC * STALE_POLLS;
  assert.equal(edge, 120, "30s loop x 4 passes");
  assert.equal(isMinerStalled({ lastPollAgeSec: edge }), false, "exactly at it is still alive");
  assert.equal(isMinerStalled({ lastPollAgeSec: edge + 0.1 }), true, "past it is dead");
});

// ---- the four real false positives. All had a LIVE poll loop; none is visible to this predicate. ----

test("2026-08-06/07: 18 restarts fired seconds after a block landed — all healthy", () => {
  // v1 compared the ticket's age to the tip's age, so the instant a block arrived after a quiet stretch both
  // halves were true. Median 5s after arrival, tightest 2s. The loop was running the whole time.
  assert.equal(isMinerStalled(FRESH), false);
});

test("2026-08-04: header timestamps +51s and +214s ahead of arrival — healthy", () => {
  // v2/v3 measured against node.tip_time, which the block's own miner writes. Block 961057 arrived 18:38:07Z
  // and claimed 18:38:58Z; 961222 arrived 23:37:10Z and claimed 23:40:44Z. Our miner ticketed both within 31s
  // of ARRIVAL, and was restarted for it.
  assert.equal(isMinerStalled(FRESH), false);
});

test("2026-08-09 23:52: two blocks 15s apart after a 35-minute gap — healthy", () => {
  // v4 used heights. The chain produced 961793 at 23:52:06Z and 961794 at 23:52:21Z. A miner polling every 30s
  // is legitimately one block behind for a few seconds there; the watchdog killed it six seconds in. Note the
  // poll heartbeat at that moment was FRESH — the loop had run seconds earlier, which is exactly the signal
  // every previous version lacked.
  assert.equal(isMinerStalled({ lastPollAgeSec: 6 }), false, "heartbeat fresh, chain merely bursty");
});

test("a long quiet chain is not a stall, however long it stays quiet", () => {
  // The 35-minute gap above, and the 25-minute one on 2026-08-08. Blocks are ~10 min apart on average and
  // gaps of 2-4x that are ordinary; none of it touches whether the loop is running.
  for (const quietMin of [20, 35, 60, 240]) {
    assert.equal(isMinerStalled({ lastPollAgeSec: 12 }), false, `chain quiet ${quietMin}m, loop alive`);
  }
});

// ---- refusing to guess ----

test("a missing heartbeat never raises an alarm", () => {
  // An older miner binary, or a bridge that has not been updated, simply has no last_poll_at. Silence there
  // must mean "unknown", never "dead" — the cost of a wrong restart is a lost ticket.
  for (const bad of [undefined, null, NaN, Infinity, "not a number"]) {
    assert.equal(isMinerStalled({ lastPollAgeSec: bad }), false, `lastPollAgeSec=${bad}`);
  }
  assert.equal(isMinerStalled({}), false, "empty args");
  assert.equal(isMinerStalled(), false, "no args at all");
});

test("a negative age (clock skew between writer and reader) never raises an alarm", () => {
  assert.equal(isMinerStalled({ lastPollAgeSec: -5 }), false);
  assert.equal(isMinerStalled({ lastPollAgeSec: -100000 }), false);
});

test("the threshold is overridable without changing the shape of the answer", () => {
  assert.equal(isMinerStalled({ lastPollAgeSec: 90 }), false, "default 120s tolerates it");
  assert.equal(isMinerStalled({ lastPollAgeSec: 90, minStaleSec: 60 }), true, "a tighter bound flags it");
});
