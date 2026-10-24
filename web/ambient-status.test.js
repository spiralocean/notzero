// Tests for ambient-status.js — run: node --test web/ambient-status.test.js  (no browser)
//
// The case behind it: an Intel Mac's Wi-Fi stayed "connected" for 12 hours while passing no traffic. The node
// got no blocks, the ambient view said "SYNCING · 99%" all night, and a new best from four days earlier had
// never been shown anywhere the owner looked.

import test from "node:test";
import assert from "node:assert";
import "./ambient-status.js"; // a classic script: it sets globalThis.AmbientStatus

const { createNodeStatus, bestLine, STUCK_AFTER_MS } = globalThis.AmbientStatus;
const NOW = Date.parse("2026-10-24T08:00:00Z");
const node = (over = {}) => ({ reachable: true, blocks: 972815, headers: 972815, initialblockdownload: false, verificationprogress: 0.9999998, tip_time: NOW / 1000 - 300, ...over });

test("a healthy node at the tip shows nothing and counts as synced", () => {
  assert.deepEqual(createNodeStatus()(node(), NOW), { text: "", synced: true });
});

test("unreachable and genuinely syncing keep their old wording", () => {
  assert.equal(createNodeStatus()(node({ reachable: false }), NOW).text, "CONNECTING TO YOUR NODE…");
  assert.equal(createNodeStatus()(node({ headers: 972900, verificationprogress: 0.9931 }), NOW).text, "SYNCING · 99%");
});

test("an old tip seen fresh is a catch-up (just woke), not an alarm", () => {
  const s = createNodeStatus()(node({ tip_time: NOW / 1000 - 8 * 3600, verificationprogress: 0.9986 }), NOW);
  assert.equal(s.text, "CATCHING UP · FETCHING NEW BLOCKS");
  assert.equal(s.synced, false);
});

test("an old tip that STAYS old says the node isn't hearing from the network — the 12-hour night", () => {
  const update = createNodeStatus(), tip = NOW / 1000 - 3 * 3600;
  update(node({ tip_time: tip }), NOW);
  assert.match(update(node({ tip_time: tip }), NOW + STUCK_AFTER_MS - 1000).text, /^CATCHING UP/);
  assert.equal(update(node({ tip_time: tip }), NOW + STUCK_AFTER_MS + 1000).text, "NO NEW BLOCKS FOR 3 H · CHECK THIS COMPUTER’S INTERNET");
});

test("a fresh block clears the stuck clock", () => {
  const update = createNodeStatus(), old = node({ tip_time: NOW / 1000 - 3 * 3600 });
  update(old, NOW);
  update(node(), NOW + 60000);                                       // caught up
  assert.match(update(old, NOW + STUCK_AFTER_MS + 120000).text, /^CATCHING UP/); // stale again, but newly
});

const best = (daysAgo, bits = 13) => ({ zero_bits: bits, at: new Date(NOW - daysAgo * 86400e3).toISOString() });

test("an unseen best shows, however old, worded in leading zeros", () => {
  assert.equal(bestLine(best(4.2), "", NOW), "★ NEW BEST · 3 LEADING ZEROS · 4 DAYS AGO");
  assert.equal(bestLine(best(1), "", NOW), "★ NEW BEST · 3 LEADING ZEROS · 1 DAY AGO");
  assert.equal(bestLine(best(0.25), "", NOW), "★ NEW BEST · 3 LEADING ZEROS · 6 H AGO");
  assert.equal(bestLine(best(0.01), "", NOW), "★ NEW BEST · 3 LEADING ZEROS · JUST NOW");
  assert.equal(bestLine(best(0.01, 5), "", NOW), "★ NEW BEST · 1 LEADING ZERO · JUST NOW");
  assert.equal(bestLine(best(40), "", NOW), "★ NEW BEST · 3 LEADING ZEROS · 40 DAYS AGO");
});

test("dismissing it on the dashboard clears it; a newer best is unseen again", () => {
  const b = best(4.2);
  assert.equal(bestLine(b, b.at, NOW), "");
  assert.equal(bestLine(b, new Date(NOW).toISOString(), NOW), ""); // dismissed something at least as new
  assert.match(bestLine(best(0.5, 14), b.at, NOW), /^★ NEW BEST · 3 LEADING ZEROS · 12 H AGO$/);
});

test("no app server (seenAt unknown), no best, or a malformed one, shows nothing", () => {
  assert.equal(bestLine(best(1), null, NOW), "");
  for (const b of [null, undefined, {}, { zero_bits: 13 }, { zero_bits: 0, at: new Date(NOW).toISOString() }, { zero_bits: 13, at: "garbage" }])
    assert.equal(bestLine(b, "", NOW), "");
});
