"use strict";
// Is the miner actually stuck? The predicate behind restarting it — and behind the dashboard's status pill.
//
// This has been wrong FOUR times, and every version failed the same way: it tried to infer a dead loop from
// the chain, and the chain is not a clock. What was tried, and what killed each one:
//
//   1. ticket older than the tip + 10 min       fired the instant any block arrived after a quiet stretch.
//                                               18 restarts in two days, median 5s after a block landed.
//   2. + require the tip to have stood 5 min    fired on the block author's HEADER timestamp, which is
//                                               written by whoever mined it and ran +51s and +214s ahead of
//                                               when the block actually reached us.
//   3. + a 180s grace for that drift            a grace cannot work: consensus allows a header two hours
//                                               ahead. Never shipped; the next incident drifted 214s.
//   4. miner's height strictly below the tip    fired on 2026-08-09 at 23:52. The chain went quiet for 35
//                                               minutes, then produced two blocks 15 SECONDS apart. The
//                                               miner polls every 30s, so it was one block behind for six
//                                               seconds through no fault of its own, and was killed for it.
//
// Every one of those was a healthy miner. The common error is inferring liveness from data the miner does not
// control: block timing, block authorship, block arrival order.
//
// So ask the miner. It stamps state.json's last_poll_at on EVERY pass of its loop — ticket or no ticket, new
// block or not — and the bridge now copies that into node.json. A loop that is running updates it every 30s;
// a loop that is blocked, wedged, or dead does not. That is a direct measurement of the thing being tested,
// with no chain inference and no clock belonging to anyone else.
//
// Split out of main.js so it can be tested: main.js needs a live Electron app, this needs nothing.
const POLL_INTERVAL_SEC = 30;          // lottery_miner.py POLL_INTERVAL_SEC — the loop's own cadence
const STALE_POLLS = 4;                 // 4 missed passes (~2 min) before calling it dead: survives a slow RPC
                                       // or a scheduler hiccup, still catches a real wedge inside two minutes

function isMinerStalled({ lastPollAgeSec, minStaleSec = POLL_INTERVAL_SEC * STALE_POLLS } = {}) {
  if (!Number.isFinite(lastPollAgeSec)) return false;   // no last_poll_at (older miner, or bridge not updated) -> never guess
  if (lastPollAgeSec < 0) return false;                 // clock skew between writer and reader -> never guess
  return lastPollAgeSec > minStaleSec;                  // the loop has missed several passes: it is not running
}

module.exports = { isMinerStalled, POLL_INTERVAL_SEC, STALE_POLLS };
