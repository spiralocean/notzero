// ---------------------------------------------------------------------------
// Two decisions the ambient view has to get right: when to OPEN, and whether waking it should LOCK the machine.
//
// Both were wrong in the same way — they trusted powerMonitor.getSystemIdleTime(), which on macOS reads the
// CGEvent clock. That clock counts INJECTED input. Universal Control and Sidecar deliver a cursor from another
// Mac at exactly that layer, with no HID device behind it, so a pointer drifting across a screen is
// indistinguishable from someone sitting down at the keyboard.
//
// Diagnosed on a real install, 2026-08-11: a MacBook used as an extended display, hardware idle 38 minutes,
// yet the app's idle clock kept resetting. Every five minutes the ambient view opened, read the borrowed
// cursor as "the user is back", and fired a real ⌃⌘Q lock (macHardLock). Moving the mouse onto that screen
// locked the machine. It then kept reopening on the already-locked screen and locking it again.
//
// The fix for the lock is to consult a SECOND clock. IOHIDSystem's HIDIdleTime counts physical hardware only,
// so the two clocks disagreeing is precisely the signal: CGEvent says "input", hardware says "nobody here" →
// the input came from somewhere else, and locking this machine is not what the user asked for. Dismissing is
// still right (the view is covering a screen someone is using); locking is not.
//
// Pure, with both clocks and the lock state injected, so the case that caused this can be tested without a
// second Mac and without locking anybody's screen.
// ---------------------------------------------------------------------------
"use strict";

// How stale the hardware clock has to be before a "wake" is treated as injected rather than physical. A person
// reaching for the keyboard registers hardware input within the same second; a few seconds of slack covers the
// gap between the poll and the read without letting a genuinely remote wake through.
const REMOTE_WAKE_MAX_PHYSICAL_IDLE = 5;

/**
 * Should the idle poller open the ambient view right now?
 *
 * screenLocked is the one that matters for the bug: opening a full-screen window on a machine that is already
 * locked accomplishes nothing, and it kept the lock/reopen cycle alive for hours.
 */
function shouldOpenAmbient({ enabled, idle, idleSeconds, screenLocked, alreadyOpen } = {}) {
  if (alreadyOpen) return false;
  if (!enabled) return false;
  if (screenLocked) return false;
  return Number.isFinite(idle) && Number.isFinite(idleSeconds) && idle >= idleSeconds;
}

/**
 * Waking the ambient view always dismisses it. Should it also lock the machine?
 *
 * physicalIdleSeconds: seconds since real hardware input, or null when it can't be read (non-macOS, or ioreg
 * failed). null means "unknown" and deliberately keeps the old behaviour rather than silently disabling a
 * security setting the user switched on.
 *
 * -> { lock, why } — `why` is logged, because this decision locks someone's computer and left no trace before.
 */
function lockDecision({ forceNoLock, manual, lockOnWake, physicalIdleSeconds } = {}) {
  if (forceNoLock) return { lock: false, why: "caller asked not to lock" };
  if (manual) return { lock: false, why: "manual preview never locks" };
  if (!lockOnWake) return { lock: false, why: "lockOnWake is off" };
  const phys = typeof physicalIdleSeconds === "number" && Number.isFinite(physicalIdleSeconds) ? physicalIdleSeconds : null;
  if (phys === null) return { lock: true, why: "woken by input; no hardware idle clock to check against" };
  if (phys > REMOTE_WAKE_MAX_PHYSICAL_IDLE)
    return { lock: false, why: `no physical input for ${Math.round(phys)}s — this wake came from injected input (Universal Control / Sidecar / remote desktop), not from someone at this machine` };
  return { lock: true, why: `woken by physical input ${phys.toFixed(1)}s ago` };
}

module.exports = { shouldOpenAmbient, lockDecision, REMOTE_WAKE_MAX_PHYSICAL_IDLE };
