// Tests for currentFleet() — run: node --test stats/*.test.js  (no network, no Cloudflare)
//
// The machine count used to sum "took N minus took N+1" across releases. Fetch counts jitter, every surplus
// on an old release became a permanent phantom, and the page reported 24 machines when the newest release
// and the awake count both said 3. These pin the replacement: the newest release is the headcount, with a
// grace period while it rolls out — and old-release noise can no longer add anything.

import test from "node:test";
import assert from "node:assert";
import { currentFleet, SETTLE_HOURS } from "./functions/api/stats.js";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600e3).toISOString().slice(0, 13);
const rel = (version, mac, win, linux, first) => ({ version, mac, win, linux, total: mac + win + linux, first });

test("no releases → zero, not a crash", () => {
  for (const empty of [[], undefined, null]) assert.equal(currentFleet(empty, NOW).count, 0);
});

test("a settled newest release is the headcount, with its platform split", () => {
  const f = currentFleet([rel("0.1.100", 2, 0, 1, hoursAgo(72)), rel("0.1.99", 2, 0, 1, hoursAgo(200))], NOW);
  assert.deepEqual(f, { count: 3, version: "0.1.100", mac: 2, win: 0, linux: 1, settling: false });
});

test("old-release jitter adds nothing — the case that reported 24", () => {
  const history = [
    rel("0.1.100", 2, 0, 1, hoursAgo(300)),
    rel("0.1.99", 2, 0, 1, hoursAgo(400)), rel("0.1.98", 2, 1, 1, hoursAgo(500)),
    rel("0.1.96", 4, 1, 3, hoursAgo(600)), rel("0.1.95", 5, 1, 3, hoursAgo(601)),
    rel("0.1.81", 6, 1, 3, hoursAgo(900)), rel("0.1.74", 5, 2, 4, hoursAgo(1500)),
  ];
  assert.equal(currentFleet(history, NOW).count, 3);
});

test("mid-rollout, the previous release stands in until the new one catches up", () => {
  const f = currentFleet([rel("0.1.101", 1, 0, 0, hoursAgo(2)), rel("0.1.100", 2, 0, 1, hoursAgo(300))], NOW);
  assert.equal(f.count, 3); assert.equal(f.version, "0.1.100"); assert.equal(f.settling, true);
});

test("mid-rollout but already ahead → the new release counts", () => {
  const f = currentFleet([rel("0.1.101", 3, 1, 1, hoursAgo(2)), rel("0.1.100", 2, 0, 1, hoursAgo(300))], NOW);
  assert.equal(f.count, 5); assert.equal(f.version, "0.1.101");
});

test("after the settle window the newest release counts even if smaller — machines really left", () => {
  const f = currentFleet([rel("0.1.101", 1, 0, 0, hoursAgo(SETTLE_HOURS + 1)), rel("0.1.100", 2, 0, 1, hoursAgo(300))], NOW);
  assert.equal(f.count, 1); assert.equal(f.settling, false);
});

test("no first-seen hour (KV unavailable) → treated as settled", () => {
  assert.equal(currentFleet([rel("0.1.101", 1, 0, 0), rel("0.1.100", 2, 0, 1)], NOW).count, 1);
});
