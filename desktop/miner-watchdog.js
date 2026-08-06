"use strict";
// Is the miner actually stuck? The predicate behind restarting it — and behind the dashboard's status pill.
//
// This has been wrong twice, in two different ways, and both mistakes came from asking a CLOCK.
//
// First it asked: is the last ticket much older than the tip?
//
//     ageSec > 1200 && ageSec > tipAge + 600
//
// tipAge is the age of the NEWEST block, so it resets to ~0 whenever one arrives. After any long gap between
// blocks the last ticket is necessarily old, so the instant the next block landed both halves were true. The
// miner polls every 30s — it had not failed to mine that block, it had not been asked yet. Measured on a live
// install: 18 restarts in two days, all within 60s of a block arriving, median 5s. Not one was a stall.
//
// Then it asked the same question more carefully — tip must have stood 5 minutes, ticket must predate it —
// and that removed about 93% of them. The rest came from the same root cause the first fix had already
// noticed and failed to take seriously: tip_time is the block's HEADER timestamp, set by whoever mined it,
// and it routinely runs AHEAD of when the block reaches you. Two survivors, both with the miner working
// perfectly:
//
//   2026-08-04 18:58Z  block 961057 arrived 18:38:07Z, header said 18:38:58Z  (+51s)   ticket 18:38:38Z
//   2026-08-05 23:57Z  block 961222 arrived 23:37:10Z, header said 23:40:44Z  (+214s)  ticket 23:37:22Z
//
// In both the miner ticketed within 31s of the block ARRIVING, and in both the header clock made that ticket
// look older than the tip. A grace band was the obvious next patch and is a trap: consensus permits a header
// up to two hours ahead, so no margin is both safe and useful. A 180s grace chosen from the first sample
// would have fired on the second anyway.
//
// So stop asking clocks. The miner mines tip+1. If its last attempt is STRICTLY BELOW the tip it has missed a
// whole block, which no timestamp can fake — heights come from our own node's chain, not from a header field
// a stranger filled in. Strictly below, not at-or-below, because for up to one poll after a block lands the
// miner is legitimately still on the height that just became the tip. One block of slack costs ~10 minutes of
// detection latency on a real hang and removes the entire class of false alarm.
//
// The ticket-age gate stays: it is our OWN timestamp, and it keeps a brand-new install from being restarted
// before it has mined anything.
//
// Split out of main.js so it can be tested: main.js needs a live Electron app, this needs nothing.
function isMinerStalled({ ticketAgeSec, attemptHeight, tipHeight, minTicketAgeSec = 1200 } = {}) {
  if (!Number.isFinite(ticketAgeSec) || ticketAgeSec <= minTicketAgeSec) return false; // no ticket yet, or a fresh one
  if (!Number.isFinite(attemptHeight) || !Number.isFinite(tipHeight)) return false;    // heights unknown -> never guess
  if (attemptHeight <= 0 || tipHeight <= 0) return false;
  return attemptHeight < tipHeight;  // a whole block went by without the miner moving to it
}

module.exports = { isMinerStalled };
