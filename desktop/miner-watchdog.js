"use strict";
// Is the miner actually stuck? The predicate behind restarting it — and behind the dashboard's status pill.
//
// This got it backwards for a long time, and the cost was invisible because the symptom looked like the cure.
// The old test was:
//
//     ageSec > 1200 && ageSec > tipAge + 600      // ">20 min old AND >10 min older than the tip"
//
// `tipAge` is the age of the NEWEST block, so it resets to ~0 every time one arrives. After any long gap
// between blocks the last ticket is necessarily old, so the instant the next block lands both halves are true
// and the miner is declared stalled. But the miner polls every 30s — it had not failed to mine that block, it
// had not been asked yet. The test fired inside that window, on a healthy miner, by construction.
//
// Measured on a real install over two days: 18 restarts, 18 of them within 60 seconds of a new block arriving,
// median 5 seconds. Not one was a stall. The longest "silence" — 52 minutes — was the chain, not the app: the
// node's own log shows block 960969 at 05:05:01 and 960970 at 05:57:40. Nothing to mine, so nothing logged.
//
// The cost was not the wasted restarts. It was that a genuine hang produces exactly this signature, so the one
// signal that would have shown a real problem was already firing daily for no reason. And a kill lands within
// seconds of a new block — precisely when the miner is about to build and possibly submit one.
//
// So: only call it stalled once the miner has HAD a chance to act on the current tip and demonstrably hasn't.
//
//   minTipAgeSec  the tip has stood this long — about ten poll cycles at POLL_INTERVAL_SEC=30.
//   ticketAge > tipAge + grace   the last ticket predates the current tip by a real margin, i.e. this block
//                 really was missed rather than merely appearing so.
//
// That grace is not padding, it is the fix for a false alarm this shipped with. tip_time is the block HEADER
// timestamp, which the block's miner sets and which routinely runs AHEAD of when the block reaches you. Seen
// on a live install at 18:58:42Z on 2026-08-04: block 961057 arrived at 18:38:07Z, our miner ticketed it 31s
// later at 18:38:38Z — correctly — but the block's header claims 18:38:58Z. Twenty seconds after our ticket.
// So by the header clock the ticket "predated the tip" and the watchdog restarted a miner that had done its
// job. A bare ticketAge > tipAge is measuring against a clock the block's author controls; the margin has to
// be wider than the drift, and 180s comfortably covers it without delaying a real hang by more than a poll or
// two. Removing the false alarms is the point — a watchdog that cries wolf is one nobody can read.
//
// Split out of main.js so it can be tested: main.js needs a live Electron app, this needs nothing.
// web/app.js mirrors this for its status pill — a browser ES module can't require() a CommonJS one without a
// build step, and this repo serves web/ raw. THIS FILE IS CANONICAL; change it and mirror it there.
function isMinerStalled({ ticketAgeSec, tipAgeSec, minTicketAgeSec = 1200, minTipAgeSec = 300, headerDriftGraceSec = 180 } = {}) {
  if (!Number.isFinite(ticketAgeSec) || ticketAgeSec <= minTicketAgeSec) return false; // no ticket yet, or a fresh one
  if (!Number.isFinite(tipAgeSec) || tipAgeSec <= minTipAgeSec) return false;          // tip unknown, or too new to blame the miner
  return ticketAgeSec > tipAgeSec + headerDriftGraceSec;                               // predates this tip by more than the header clock can explain
}

module.exports = { isMinerStalled };
