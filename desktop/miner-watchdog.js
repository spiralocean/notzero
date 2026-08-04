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
//   minTipAgeSec  the tip has stood this long — about ten poll cycles at POLL_INTERVAL_SEC=30. Not tighter,
//                 because tip_time is the block HEADER timestamp, which is miner-set and drifts minutes.
//   ticketAge > tipAge   the last ticket predates the current tip, i.e. this block really was missed.
//
// Split out of main.js so it can be tested: main.js needs a live Electron app, this needs nothing.
// web/app.js mirrors this for its status pill — a browser ES module can't require() a CommonJS one without a
// build step, and this repo serves web/ raw. THIS FILE IS CANONICAL; change it and mirror it there.
function isMinerStalled({ ticketAgeSec, tipAgeSec, minTicketAgeSec = 1200, minTipAgeSec = 300 } = {}) {
  if (!Number.isFinite(ticketAgeSec) || ticketAgeSec <= minTicketAgeSec) return false; // no ticket yet, or a fresh one
  if (!Number.isFinite(tipAgeSec) || tipAgeSec <= minTipAgeSec) return false;          // tip unknown, or too new to blame the miner
  return ticketAgeSec > tipAgeSec;                                                     // the last ticket predates this tip
}

module.exports = { isMinerStalled };
