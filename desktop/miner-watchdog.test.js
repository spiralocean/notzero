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

// ---- incident 5: 2026-08-11, a miner killed for being NEW ------------------------------------------------
// Twice in one evening — "poll loop last ran 357s ago" and "179s ago" — both moments after the app restarted.
// Nothing was wrong. last_poll_at lives in state.json, which OUTLIVES the process that wrote it, so a fresh
// miner is judged on a dead one's last breath. Its first pass is also its slowest (node RPC, price, balance),
// so the window is real, and restarting inside it just makes it happen again.
test("a miner that only just started is never called stalled", () => {
  // The exact shape of the incident: a six-minute-old heartbeat from the previous process, 20s after launch.
  assert.equal(isMinerStalled({ lastPollAgeSec: 357, minerUptimeSec: 20 }), false, "the 05:19 firing");
  assert.equal(isMinerStalled({ lastPollAgeSec: 179, minerUptimeSec: 45 }), false, "the 06:24 firing");
});

test("the startup grace is exactly the staleness budget, and then it is over", () => {
  // A new miner gets the same allowance to produce its FIRST heartbeat that a running one gets to miss
  // passes. Longer would blind the watchdog after every restart; shorter reopens the incident above.
  const edge = POLL_INTERVAL_SEC * STALE_POLLS;
  assert.equal(isMinerStalled({ lastPollAgeSec: 9999, minerUptimeSec: edge }), false, "still within grace");
  assert.equal(isMinerStalled({ lastPollAgeSec: 9999, minerUptimeSec: edge + 0.1 }), true, "grace spent, and it never reported in");
});

test("the grace does not protect a miner that has been up a long time", () => {
  // The whole point of the watchdog: a genuinely wedged loop must still be caught, however long it has run.
  assert.equal(isMinerStalled({ lastPollAgeSec: 300, minerUptimeSec: 3600 }), true);
  assert.equal(isMinerStalled({ lastPollAgeSec: 300, minerUptimeSec: 86400 }), true);
});

test("a fresh heartbeat is alive regardless of uptime", () => {
  for (const up of [0, 5, 120, 99999]) {
    assert.equal(isMinerStalled({ lastPollAgeSec: 5, minerUptimeSec: up }), false, `uptime ${up}s`);
  }
});

test("an unknowable uptime keeps the old behaviour rather than disabling the watchdog", () => {
  // A caller that cannot say when the miner started must not thereby switch the watchdog off — that would
  // trade a rare wrong restart for never restarting a wedged miner at all, which is the worse failure.
  for (const bad of [undefined, null, NaN, Infinity, "soon", -1]) {
    assert.equal(isMinerStalled({ lastPollAgeSec: 300, minerUptimeSec: bad }), true, `minerUptimeSec=${bad}`);
  }
});
