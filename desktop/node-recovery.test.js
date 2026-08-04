// Tests for node-recovery.js — run: node --test desktop/node-recovery.test.js  (no Electron, no wall-clock waits)
//
// The properties that matter, in the order they matter: a node that dies on its own comes back; a node that
// never started does NOT get retried behind the user's back; and a node dying in a loop stops rather than
// restarting forever. Timers and the clock are injected, so this runs instantly and deterministically.

const test = require("node:test");
const assert = require("node:assert");
const { createNodeRecovery } = require("./node-recovery.js");

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

function harness(opts = {}) {
  const c = clock();
  const retries = [];
  const logs = [];
  const r = createNodeRecovery({
    retry: () => retries.push(c.now()),
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    log: (m) => logs.push(m),
    ...opts,
  });
  return { r, c, retries, logs };
}

test("a node that came up and then died is restarted", () => {
  const { r, c, retries } = harness();
  assert.equal(r.onState("ready"), "ready");
  assert.equal(r.onState("error", "the node stopped unexpectedly (code 0)"), "scheduled");
  assert.equal(retries.length, 0, "not immediately — it backs off first");
  c.advance(5000);
  assert.equal(retries.length, 1, "restarted after the first delay");
});

test("a node that NEVER came up is left alone for the wizard to explain", () => {
  const { r, retries } = harness();
  assert.equal(r.onState("downloading-core"), "ignored");
  assert.equal(r.onState("error", "not enough free disk space"), "never-started");
  assert.equal(retries.length, 0);
});

test("retries back off and then stop, leaving the error screen up", () => {
  const { r, c, retries } = harness();
  r.onState("ready");
  for (const [i, delay] of [5000, 15000, 60000].entries()) {
    assert.equal(r.onState("error", "died"), "scheduled", `attempt ${i + 1} scheduled`);
    c.advance(delay);
    assert.equal(retries.length, i + 1);
  }
  assert.equal(r.onState("error", "died"), "exhausted", "fourth failure gives up");
  c.advance(600000);
  assert.equal(retries.length, 3, "and never retries again");
});

test("a crash loop keeps counting — coming up briefly does not refill the budget", () => {
  const { r, c, retries } = harness();
  for (let i = 0; i < 3; i++) {
    r.onState("ready");
    c.advance(60000);                  // up for only a minute, well under stableMs
    assert.equal(r.onState("error", "killed again"), "scheduled");
    c.advance(60000);
  }
  r.onState("ready");
  c.advance(60000);
  assert.equal(r.onState("error", "killed again"), "exhausted", "the loop is stopped, not retried forever");
  assert.equal(retries.length, 3);
});

test("a node that stayed up gets a fresh budget — a later death is a NEW incident", () => {
  const { r, c, retries } = harness();
  r.onState("ready");
  for (const d of [5000, 15000, 60000]) { r.onState("error", "died"); c.advance(d); }
  assert.equal(r.onState("error", "died"), "exhausted");

  r.onState("ready");
  c.advance(11 * 60 * 1000);           // stayed up past stableMs
  assert.equal(r.onState("error", "died hours later"), "scheduled", "unrelated later failure is retried");
  c.advance(5000);
  assert.equal(retries.length, 4);
});

test("a quitting app is never fought", () => {
  const { r, c, retries } = harness();
  r.onState("ready");
  assert.equal(r.onState("error", "we stopped it", { quitting: true }), "quitting");
  c.advance(600000);
  assert.equal(retries.length, 0);
});

test("a retry scheduled before quit does not fire a restart into a shutdown", () => {
  const { r, c, retries } = harness();
  r.onState("ready");
  r.onState("error", "died");
  r.cancel();                          // what before-quit does
  c.advance(600000);
  assert.equal(retries.length, 0);
  assert.equal(r.pending(), false);
});

test("only one retry is ever in flight", () => {
  const { r, c, retries } = harness();
  r.onState("ready");
  r.onState("error", "died");          // schedules at +5s
  r.onState("error", "died again");    // supersedes it; must not stack
  c.advance(600000);
  assert.equal(retries.length, 1, "two error events, one restart");
  assert.equal(c.pending(), 0, "no orphaned timer left behind");
});

test("a throwing retry does not escape into the app", () => {
  const { r, c } = harness({ retry: () => { throw new Error("boom"); } });
  r.onState("ready");
  r.onState("error", "died");
  assert.doesNotThrow(() => c.advance(5000));
});

test("states on the way up are ignored, and readiness is what arms it", () => {
  const { r } = harness();
  for (const s of ["idle", "downloading-core", "extracting", "starting", "loading-snapshot", "syncing"]) {
    assert.equal(r.onState(s), "ignored", `${s} is not an error`);
  }
  assert.equal(r.onState("error", "never came up"), "never-started");
  r.onState("ready");
  assert.equal(r.onState("error", "now it counts"), "scheduled");
});
