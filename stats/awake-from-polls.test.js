// Tests for awakeFromPolls() — run: node --test stats/*.test.js  (no network, no Cloudflare)
//
// This page turns request volume into headcounts, and it has now been wrong that way twice. First the
// platform split, which divided update-feed requests by a cadence and printed the result as machines —
// reported because the numbers exceeded the devices that exist. That one was replaced with installer
// fetches, a real per-machine signal. This is its sibling, and the same arithmetic: CHANGELOG.md polls
// divided by a cadence.
//
// It cannot be replaced the same way, because it measures something installers cannot: how many machines
// are awake AT A MOMENT, not how many exist. So the fix is to make the divisor honest and its bias explicit
// rather than to delete the figure — which is what these tests pin down.

import test from "node:test";
import assert from "node:assert";
import { awakeFromPolls } from "./functions/api/stats.js";

const PER_DAY = 48;          // the app's scheduled cadence: one poll per 30 min
const PER_HOUR = PER_DAY / 24;

test("the scheduled cadence maps polls to machines", () => {
  assert.equal(awakeFromPolls(0), 0);
  assert.equal(awakeFromPolls(PER_HOUR), 1, "one machine polling on schedule for an hour");
  assert.equal(awakeFromPolls(PER_HOUR * 5), 5);
  assert.equal(awakeFromPolls(PER_HOUR * 12.5), 12.5);
});

test("the divisor comes from the cadence, not from a number typed beside it", () => {
  // The bug this guards: the derivation divided by a literal `2` while CHANGELOG_PER_DAY sat unused two
  // hundred lines away, so changing the documented cadence would silently not change the maths.
  assert.equal(awakeFromPolls(24, 24), 24, "a 24/day cadence means 1 poll per hour per machine");
  assert.equal(awakeFromPolls(24, 48), 12, "the default 48/day halves it");
  assert.equal(awakeFromPolls(24, 96), 6);
});

test("it is an UPPER BOUND, and the bias only points one way", () => {
  // Every app launch adds two polls beyond the schedule, so a machine that restarted during the hour looks
  // like more than one machine. This is not a rounding quirk to be fixed here — it is unobservable from
  // request volume — so it is asserted as a known property, and the page says so rather than implying
  // precision it does not have.
  const oneMachineIdle = PER_HOUR;              // 2 polls
  const oneMachineRestarted = PER_HOUR + 2;     // + the startup pair
  assert.equal(awakeFromPolls(oneMachineIdle), 1);
  assert.ok(awakeFromPolls(oneMachineRestarted) > 1,
    "a single machine that relaunched must read HIGH — that is why the headline is a median, not a sum");
  assert.equal(awakeFromPolls(oneMachineRestarted), 2);
});

test("a release hour is where the overcount is worst", () => {
  // Ten machines, all taking an update in the same hour: each polls on schedule AND restarts.
  const machines = 10;
  const polls = machines * (PER_HOUR + 2);
  assert.equal(awakeFromPolls(polls), 20, "reads double, which is why release hours must not set the headline");
});

test("nonsense input reads as zero, never as machines", () => {
  for (const bad of [undefined, null, NaN, Infinity, -1, -100, "12", {}]) {
    assert.equal(awakeFromPolls(bad), 0, `polls=${String(bad)}`);
  }
  for (const bad of [0, -1, NaN, Infinity, null]) {
    assert.equal(awakeFromPolls(100, bad), 0, `perDay=${String(bad)}`);
  }
});

test("it stays monotonic and rounds to one decimal", () => {
  let prev = -1;
  for (let polls = 0; polls <= 60; polls++) {
    const got = awakeFromPolls(polls);
    assert.ok(got >= prev, `more polls must never mean fewer machines (at ${polls})`);
    assert.equal(got, Math.round(got * 10) / 10, "one decimal place, so the tile never shows a long float");
    prev = got;
  }
});
