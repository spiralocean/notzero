// Tests for quote-bag.js — run: node --test web/quote-bag.test.js  (no browser, no canvas)
// ESM, because the repo root package.json sets "type": "module" — unlike desktop/, which is its own package.
//
// The bug this locks down was reported from use: "quotes are repeating before getting through the entire
// list". The bag was already correct WITHIN a pass — the leak was at the seam, where a quote drawn near the
// end of one bag could be drawn near the start of the next.

import test from "node:test";
import assert from "node:assert";
import { makeQuoteBag } from "./quote-bag.js";

const N = 70; // the real quote count is in this range; the properties hold for any size

function draw(n, { count = N, recent = 12, rand = Math.random } = {}) {
  const next = makeQuoteBag(count, recent, rand);
  const seq = [];
  let curr = 0;
  for (let i = 0; i < n; i++) { curr = next(curr); seq.push(curr); }
  return seq;
}

function gaps(seq) {
  const last = new Map(), out = [];
  seq.forEach((q, i) => { if (last.has(q)) out.push(i - last.get(q)); last.set(q, i); });
  return out;
}

test("every quote appears before any repeats", () => {
  const seq = draw(N);
  assert.equal(new Set(seq).size, N, "the first pass must cover the whole list");
});

test("no repeat within the recency window, over a long run", () => {
  // The real complaint. The old implementation's closest repeat here was 2.
  const seq = draw(5000);
  const g = gaps(seq);
  const min = Math.min(...g);
  assert.ok(min > 10, `closest repeat was ${min} apart; expected more than 10`);
});

test("it keeps covering the list on later passes, not just the first", () => {
  const seq = draw(N * 5);
  for (let pass = 0; pass < 5; pass++) {
    const slice = seq.slice(pass * N, (pass + 1) * N);
    // Passes are offset by the parked recent items, so a window of N is not exactly one bag — but it must
    // still be close to complete rather than drawing from a shrinking pool.
    assert.ok(new Set(slice).size >= N - 12, `pass ${pass} covered only ${new Set(slice).size} of ${N}`);
  }
});

test("order is actually shuffled, not the same sequence every run", () => {
  const a = draw(N).join(","), b = draw(N).join(",");
  assert.notEqual(a, b, "two runs produced an identical order");
});

test("a constant rand (as the e2e suite pins) still yields a full, non-repeating pass", () => {
  // tests/dashboard.spec.mjs pins Math.random to 0.4 for determinism; the bag must not degenerate under that.
  const seq = draw(N, { rand: () => 0.4 });
  assert.equal(new Set(seq).size, N);
  assert.ok(Math.min(...gaps(draw(500, { rand: () => 0.4 }))) > 10);
});

test("degenerate sizes do not hang or throw", () => {
  assert.equal(draw(5, { count: 1 }).every((i) => i === 0), true); // one quote: it is always that one
  assert.equal(new Set(draw(20, { count: 2 })).size, 2);
  assert.equal(new Set(draw(40, { count: 3, recent: 12 })).size, 3); // recent window larger than the list
});

test("remaining() reports the bag draining, for the dashboard's test hook", () => {
  const next = makeQuoteBag(N, 12);
  next(0);
  const first = next.remaining();
  next(1);
  assert.equal(next.remaining(), first - 1);
});
