// Tests for ambient-wake.js — run: node --test desktop/ambient-wake.test.js  (no Electron, nothing gets locked)
//
// These encode a real incident. A MacBook used as an extended display via Universal Control: the borrowed
// cursor reset the CGEvent idle clock the app trusts, the app read that as "the user is back", and fired a
// real ⌃⌘Q lock. Every five minutes, for hours, while the owner worked on the other Mac and never touched
// this one. So the case that MUST hold is the boring-looking one below: CGEvent says input, hardware says
// nobody has been here for half an hour → dismiss, but do not lock.

const test = require("node:test");
const assert = require("node:assert");
const { shouldOpenAmbient, lockDecision, shouldDismissOnInferredWake, REMOTE_WAKE_MAX_PHYSICAL_IDLE } = require("./ambient-wake.js");

const open = (over = {}) => shouldOpenAmbient({ enabled: true, idle: 300, idleSeconds: 300, screenLocked: false, alreadyOpen: false, ...over });
const wake = (over = {}) => lockDecision({ forceNoLock: false, manual: false, lockOnWake: true, physicalIdleSeconds: 0.4, ...over });

// ---- opening ---------------------------------------------------------------------------------------------

test("opens once the machine has been idle long enough", () => {
  assert.equal(open(), true);
  assert.equal(open({ idle: 299 }), false);
  assert.equal(open({ idle: 301 }), true);
});

test("never opens onto a locked screen", () => {
  // It had been creating a full-screen window on an already-locked Mac every 5 minutes, which is what kept the
  // lock/reopen cycle alive long after the user had walked away.
  assert.equal(open({ screenLocked: true }), false);
  assert.equal(open({ screenLocked: true, idle: 99999 }), false);
});

test("never opens when disabled or already open", () => {
  assert.equal(open({ enabled: false }), false);
  assert.equal(open({ alreadyOpen: true }), false);
});

test("a missing or nonsense idle reading does not open the view", () => {
  for (const idle of [undefined, null, NaN, "300"]) assert.equal(open({ idle }), false);
  for (const idleSeconds of [undefined, null, NaN]) assert.equal(open({ idleSeconds }), false);
});

// ---- locking ---------------------------------------------------------------------------------------------

test("a person at the keyboard locks the machine", () => {
  const d = wake({ physicalIdleSeconds: 0.2 });
  assert.equal(d.lock, true);
  assert.match(d.why, /physical input/);
});

test("THE BUG: a Universal Control cursor dismisses the view but must not lock the machine", () => {
  // The exact shape of the incident — the app's idle clock says "input", the hardware clock says 38 minutes.
  const d = wake({ physicalIdleSeconds: 2308 });
  assert.equal(d.lock, false);
  assert.match(d.why, /Universal Control/);
  assert.match(d.why, /2308s/);
});

test("the physical-input threshold is where the two clocks are allowed to disagree", () => {
  assert.equal(wake({ physicalIdleSeconds: REMOTE_WAKE_MAX_PHYSICAL_IDLE }).lock, true);
  assert.equal(wake({ physicalIdleSeconds: REMOTE_WAKE_MAX_PHYSICAL_IDLE + 0.01 }).lock, false);
  assert.ok(REMOTE_WAKE_MAX_PHYSICAL_IDLE >= 2, "must outlast the poll interval, or a real wake reads as remote");
  assert.ok(REMOTE_WAKE_MAX_PHYSICAL_IDLE <= 30, "too generous and a genuinely remote wake locks the machine again");
});

test("an unreadable hardware clock keeps the OLD behaviour rather than silently disabling the setting", () => {
  // Windows and Linux have no equivalent, and ioreg can fail. Quietly turning off a lock the user switched on
  // is the wrong way to be safe.
  for (const phys of [null, undefined, NaN, "nope"]) {
    const d = lockDecision({ forceNoLock: false, manual: false, lockOnWake: true, physicalIdleSeconds: phys });
    assert.equal(d.lock, true, `expected a lock when the hardware clock reads ${String(phys)}`);
    assert.match(d.why, /no hardware idle clock/);
  }
});

test("the settings that switch locking off still switch it off, whoever is at the keyboard", () => {
  assert.equal(wake({ lockOnWake: false }).lock, false);          // not enabled
  assert.equal(wake({ manual: true }).lock, false);               // ⌘⇧A preview
  assert.equal(wake({ forceNoLock: true }).lock, false);          // blur, suspend/resume, OS lock
  // …and they win even when someone genuinely is at the machine
  assert.equal(wake({ lockOnWake: false, physicalIdleSeconds: 0 }).lock, false);
  assert.equal(wake({ manual: true, physicalIdleSeconds: 0 }).lock, false);
});

test("every decision explains itself, because this one locks a computer", () => {
  for (const over of [{}, { lockOnWake: false }, { manual: true }, { forceNoLock: true },
                      { physicalIdleSeconds: 9999 }, { physicalIdleSeconds: null }]) {
    const d = wake(over);
    assert.equal(typeof d.why, "string");
    assert.ok(d.why.length > 10, `unhelpful reason for ${JSON.stringify(over)}: ${d.why}`);
  }
});

// ---- holding the view up for a cursor that is not a person -----------------------------------------------
// A Mac left running as an always-on ambient display: the saver vanished whenever a Universal Control cursor
// drifted onto that screen. Measured on the affected install, of the dismissals since 0.1.84, five were a
// real person (correctly locked) and five were a mouse wandering across. Injected input already could not
// LOCK; it should not tear the view down either — same signal, same reasoning.

const held = (over = {}) => shouldDismissOnInferredWake({ physicalIdleSeconds: 0.4, ...over });

test("a person at the keyboard still dismisses the view", () => {
  const d = held({ physicalIdleSeconds: 0.2 });
  assert.equal(d.dismiss, true);
  assert.match(d.why, /physical input/);
});

test("THE ANNOYANCE: a drifting Universal Control cursor leaves the view up", () => {
  const d = held({ physicalIdleSeconds: 1400 }); // the real number from the log line that prompted this
  assert.equal(d.dismiss, false);
  assert.match(d.why, /Universal Control/);
  assert.match(d.why, /stays up/);
});

test("the hold uses the same physical-input threshold as the lock decision", () => {
  // One notion of "is a person here", not two that can drift apart.
  assert.equal(held({ physicalIdleSeconds: REMOTE_WAKE_MAX_PHYSICAL_IDLE }).dismiss, true);
  assert.equal(held({ physicalIdleSeconds: REMOTE_WAKE_MAX_PHYSICAL_IDLE + 0.01 }).dismiss, false);
  // and the two decisions agree at the boundary, which is the point of sharing it
  for (const phys of [0, 1, REMOTE_WAKE_MAX_PHYSICAL_IDLE, 60, 1400]) {
    const dismissed = shouldDismissOnInferredWake({ physicalIdleSeconds: phys }).dismiss;
    const locked = lockDecision({ lockOnWake: true, physicalIdleSeconds: phys }).lock;
    assert.equal(dismissed, locked, `at ${phys}s both should agree a person is/is not present`);
  }
});

test("an unreadable hardware clock dismisses, rather than holding a window up on a guess", () => {
  // Wrong in the opposite direction from lockDecision, deliberately: guessing wrong about LOCKING risks
  // locking someone out, guessing wrong about HOLDING leaves an always-on-top window nobody asked to keep.
  for (const phys of [null, undefined, NaN, "nope"]) {
    const d = shouldDismissOnInferredWake({ physicalIdleSeconds: phys });
    assert.equal(d.dismiss, true, `physicalIdleSeconds=${String(phys)}`);
    assert.match(d.why, /no hardware idle clock/);
  }
});
