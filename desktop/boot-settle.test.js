// Tests for boot-settle.js — run: node --test desktop/boot-settle.test.js  (no Electron, no wall-clock waits)
//
// The property that matters most is the one the user asked for by name: mining comes back on its own, with
// nobody at the keyboard. Every "does it wait?" test here is subordinate to that — a calm signal may only
// make the start happen sooner, never later, and a machine that never goes quiet still starts at the ceiling.

const test = require("node:test");
const assert = require("node:assert");
const {
  createBootSettle, shouldWait, settleCheck, defaultLoadPerCpu,
  FLOOR_MS, CEILING_MS, POLL_MS, CALM_SAMPLES,
} = require("./boot-settle.js");

// Fake clock: collect scheduled callbacks, advance time explicitly. Timer ids are real values (not undefined)
// so the module's `timer != null` bookkeeping is exercised rather than accidentally satisfied.
function clock() {
  let now = 1_000_000, nextId = 1;
  const q = new Map();
  const setTimer = (fn, ms) => { const id = nextId++; q.set(id, { at: now + (ms || 0), fn }); return id; };
  const clearTimer = (id) => { q.delete(id); };
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = [...q.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      q.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = until;
  };
  return { now: () => now, setTimer, clearTimer, advance, pending: () => q.size };
}

// `load` is a function of the elapsed wait, so a test can describe a machine that calms down over time.
function harness({ load = () => 0.1, ...opts } = {}) {
  const c = clock();
  const started = [];
  const status = [];
  const t0 = c.now();
  const s = createBootSettle({
    loadPerCpu: () => (typeof load === "function" ? load(c.now() - t0) : load),
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    onStatus: (m) => status.push(m),
    ...opts,
  });
  return { c, s, started, status, run: () => started.push(c.now() - t0) };
}

// --- the guarantee: it always starts, unattended -----------------------------------------------------

test("a machine that never goes quiet still starts, at the ceiling", () => {
  const h = harness({ load: () => 9.9 }); // pegged for the whole window
  h.s.schedule(h.run, { bootHidden: true, uptimeSec: 30 });
  h.c.advance(CEILING_MS - POLL_MS);
  assert.deepStrictEqual(h.started, [], "must not have started early");
  h.c.advance(POLL_MS * 2);
  assert.strictEqual(h.started.length, 1, "must start at the ceiling regardless of load");
  assert.ok(h.started[0] <= CEILING_MS + POLL_MS);
});

test("no user interaction is ever required — the poll loop starts it by itself", () => {
  const h = harness({ load: () => 0.05 });
  h.s.schedule(h.run, { bootHidden: true, uptimeSec: 30 });
  assert.deepStrictEqual(h.started, [], "nothing runs synchronously");
  h.c.advance(CEILING_MS * 2);
  assert.strictEqual(h.started.length, 1);
  assert.strictEqual(h.s.waiting(), false);
});

test("a start that throws does not strand the app mid-wait", () => {
  const h = harness();
  h.s.schedule(() => { throw new Error("boom"); }, { bootHidden: true, uptimeSec: 30 });
  h.c.advance(CEILING_MS * 2);
  assert.strictEqual(h.s.waiting(), false, "the pending start must be cleared even when it throws");
});

// --- when it waits, and when it doesn't --------------------------------------------------------------

test("a hand-launched app starts immediately", () => {
  const h = harness({ load: () => 9.9 });
  const decision = h.s.schedule(h.run, { bootHidden: false, uptimeSec: 5 });
  assert.strictEqual(decision, "immediate");
  assert.deepStrictEqual(h.started, [0], "no wait at all — the user opened it on purpose");
});

test("a post-update relaunch onto a long-running machine does not wait", () => {
  const h = harness({ load: () => 9.9 });
  const decision = h.s.schedule(h.run, { bootHidden: true, uptimeSec: 6 * 3600 });
  assert.strictEqual(decision, "immediate");
  assert.deepStrictEqual(h.started, [0]);
});

test("launched at login during a boot → it waits", () => {
  const h = harness();
  assert.strictEqual(h.s.schedule(h.run, { bootHidden: true, uptimeSec: 30 }), "waiting");
  assert.deepStrictEqual(h.started, []);
});

test("unreadable uptime on a hidden launch waits rather than gambling", () => {
  assert.strictEqual(shouldWait({ bootHidden: true, uptimeSec: null }).wait, true);
  assert.strictEqual(shouldWait({ bootHidden: true, uptimeSec: NaN }).wait, true);
});

// --- floor and calm ----------------------------------------------------------------------------------

test("an already-quiet machine still serves the floor, then starts", () => {
  const h = harness({ load: () => 0.05 });
  h.s.schedule(h.run, { bootHidden: true, uptimeSec: 30 });
  h.c.advance(FLOOR_MS - POLL_MS);
  assert.deepStrictEqual(h.started, [], "the floor is a minimum, not a target");
  h.c.advance(POLL_MS * 2);
  assert.strictEqual(h.started.length, 1);
  assert.ok(h.started[0] >= FLOOR_MS && h.started[0] < FLOOR_MS + POLL_MS * 2);
});

test("a stampede that clears starts well before the ceiling", () => {
  const busyFor = 4 * 60 * 1000;
  const h = harness({ load: (elapsed) => (elapsed < busyFor ? 4.0 : 0.1) });
  h.s.schedule(h.run, { bootHidden: true, uptimeSec: 30 });
  h.c.advance(CEILING_MS);
  assert.strictEqual(h.started.length, 1);
  assert.ok(h.started[0] >= busyFor, "must not start while still busy");
  assert.ok(h.started[0] < busyFor + POLL_MS * (CALM_SAMPLES + 2), `expected shortly after calm, got ${h.started[0]}ms`);
  assert.ok(h.started[0] < CEILING_MS, "the calm signal must beat the ceiling");
});

test("one dip in a stampede is not 'settled'", () => {
  // Calm for a single poll at ~2min, busy either side. The streak must reset and not trip the start.
  const dipAt = 2 * 60 * 1000;
  const h = harness({ load: (e) => (e >= dipAt && e < dipAt + POLL_MS ? 0.1 : 5.0) });
  h.s.schedule(h.run, { bootHidden: true, uptimeSec: 30 });
  h.c.advance(CEILING_MS - POLL_MS);
  assert.deepStrictEqual(h.started, [], "a lone calm sample must not count as settled");
});

// --- platforms with no load average ------------------------------------------------------------------

test("no load signal (Windows) degrades to the floor, not the ceiling", () => {
  const h = harness({ load: () => null });
  h.s.schedule(h.run, { bootHidden: true, uptimeSec: 30 });
  h.c.advance(CEILING_MS);
  assert.strictEqual(h.started.length, 1);
  assert.ok(h.started[0] < FLOOR_MS + POLL_MS * 2, `expected a floor-length wait, got ${h.started[0]}ms`);
});

test("defaultLoadPerCpu returns a per-core number or null, never a bare load", () => {
  const v = defaultLoadPerCpu();
  assert.ok(v === null || (Number.isFinite(v) && v >= 0), `unexpected ${v}`);
  if (v !== null) assert.ok(v < 200, "looks like a raw load average, not per-core");
});

// --- overrides ---------------------------------------------------------------------------------------

test("the ceiling outranks every other branch", () => {
  // Busy machine, past the ceiling but also below the floor (floor > ceiling is nonsense config, and the
  // point is that no ordering of the other rules can defeat the deadline).
  const v = settleCheck({ waitedMs: 999_999, loadPerCpu: 9.9, floorMs: 10 ** 9, ceilingMs: 1000 });
  assert.strictEqual(v.start, true);
});

test("startNow skips the remaining wait", () => {
  const h = harness({ load: () => 9.9 });
  h.s.schedule(h.run, { bootHidden: true, uptimeSec: 30 });
  h.c.advance(POLL_MS);
  h.s.startNow("user opened the window");
  assert.strictEqual(h.started.length, 1);
  h.c.advance(CEILING_MS * 2);
  assert.strictEqual(h.started.length, 1, "must not start a second time");
});

test("cancel drops the pending start — quitting never spawns a node", () => {
  const h = harness();
  h.s.schedule(h.run, { bootHidden: true, uptimeSec: 30 });
  assert.strictEqual(h.s.cancel(), true);
  h.c.advance(CEILING_MS * 2);
  assert.deepStrictEqual(h.started, [], "a cancelled wait must never fire");
  assert.strictEqual(h.c.pending(), 0, "and must not leave a timer running");
});

test("status messages keep flowing while it waits", () => {
  const h = harness({ load: () => 9.9 });
  h.s.schedule(h.run, { bootHidden: true, uptimeSec: 30 });
  h.c.advance(POLL_MS * 4);
  assert.ok(h.status.length >= 4, "the UI must never sit on one stale line");
  assert.ok(h.status.every((m) => typeof m === "string" && m.length > 0));
});
