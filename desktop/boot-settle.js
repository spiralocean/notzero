// ---------------------------------------------------------------------------
// Hold the node (and the engines) back until the machine has finished starting up.
//
// Measured on a real install, 2026-08-14 — Mac mini M1, 16 GB, booted from an external USB4 volume:
// WindowServer/loginwindow at T+29s, Dock/ControlCenter at T+52s, then at T+60s a stampede of a dozen
// menu-bar extras, 1Password at T+154s, and this app at T+240s — where it immediately spawned bitcoind
// with a multi-GB dbcache. An hour later iconservicesagent was still hot and the volume had seen ~48 GB
// read / 51 GB written. The node isn't what makes the menu bar late (it arrives three minutes AFTER the
// stampede); it's what keeps the machine thrashing long past the point it should have gone quiet.
//
// Three judgements are baked in, and two of them are about NOT waiting:
//
//   1. Only a launch we did not ask for. Double-clicking the app means you want it mining; the login item
//      launching us with --hidden during a boot does not. Only the second one waits.
//
//   2. Only a fresh boot. The app relaunches itself after an auto-update, and a relaunch onto a machine
//      that has been up for hours has no stampede to stay out of. Uptime is what tells those apart.
//
//   3. There is ALWAYS a deadline. The whole point is that mining resumes on its own, with nobody at the
//      keyboard — so the ceiling starts everything regardless of what the load is doing. A calm signal can
//      only make that happen SOONER, never later. Nothing here can leave a machine parked forever waiting
//      for a quiet that a busy machine may never reach.
//
// Load average is the calm signal because it costs a syscall — shelling out to sample a machine we are
// trying to keep quiet would be self-defeating. It is a proxy, not a measurement: Darwin counts runnable
// threads, not threads blocked on I/O, so it under-reads pure disk thrash. That is survivable precisely
// because of judgement 3 — a signal that never fires costs the ceiling, not the session.
//
// Pure core (shouldWait/settleCheck) + a thin runner with injected clocks, so all of this is testable
// without Electron, without a node, and without wall-clock waits.
// ---------------------------------------------------------------------------
"use strict";

const FRESH_BOOT_SEC = 15 * 60;      // uptime past this → whatever launched us, it wasn't the boot stampede
const FLOOR_MS = 60 * 1000;          // never start sooner than this on a boot launch, however quiet it looks
const CEILING_MS = 10 * 60 * 1000;   // always start by this, however busy it looks (judgement 3)
const POLL_MS = 15 * 1000;
const CALM_LOAD_PER_CPU = 0.6;       // 1-min load average per core; this machine idles well under it
const CALM_SAMPLES = 3;              // consecutive calm polls — one dip in a stampede isn't "settled"

/**
 * Does this launch wait at all?
 *
 * Returns the reasoning as well as the verdict — the same shape as node-recovery's onState, and for the
 * same reason: this decides whether mining starts in one second or ten minutes, and "it just sat there"
 * is not a debuggable report.
 */
function shouldWait({ bootHidden, uptimeSec } = {}) {
  if (!bootHidden) return { wait: false, why: "launched by hand — nothing to wait for" };
  const up = Number.isFinite(uptimeSec) ? uptimeSec : null;
  if (up != null && up > FRESH_BOOT_SEC)
    return { wait: false, why: `machine has been up ${Math.round(up / 60)}m — not a boot launch` };
  // up === null: we were launched hidden and can't read uptime. Wait — the ceiling bounds the cost of
  // being wrong here, and starting into a stampede is the thing this module exists to avoid.
  return { wait: true, why: up == null ? "launched at login (uptime unknown)" : `launched at login, ${Math.round(up)}s into this boot` };
}

/**
 * One poll: given how long we've waited and how loaded the machine is, start now?
 *
 * loadPerCpu is the 1-min load average divided by core count, or null when the platform can't report it
 * (Windows returns [0,0,0] from os.loadavg()). null is "no signal", NOT "calm" — but it degrades to the
 * floor rather than the ceiling, because holding a Windows machine for ten minutes on the strength of a
 * number that platform never populates would be punishing it for our lack of information.
 *
 * calmStreak is carried by the caller so this stays a pure function of its inputs.
 */
function settleCheck({
  waitedMs, loadPerCpu, calmStreak = 0,
  floorMs = FLOOR_MS, ceilingMs = CEILING_MS,
  calmLoad = CALM_LOAD_PER_CPU, calmSamples = CALM_SAMPLES,
} = {}) {
  const known = typeof loadPerCpu === "number" && Number.isFinite(loadPerCpu);
  const streak = known ? (loadPerCpu < calmLoad ? calmStreak + 1 : 0) : 0;
  const secs = Math.round(waitedMs / 1000);
  const out = (start, why) => ({ start, calmStreak: streak, why });

  // Ceiling first, unconditionally: no later branch may ever outrank the deadline.
  if (waitedMs >= ceilingMs) return out(true, `waited ${secs}s — starting regardless of load`);
  if (waitedMs < floorMs) return out(false, `letting your computer finish starting up (${secs}s)`);
  if (!known) return out(true, `waited ${secs}s — no load signal on this platform`);
  if (streak >= calmSamples) return out(true, `load settled (${loadPerCpu.toFixed(2)} per core) after ${secs}s`);
  return out(false, `waiting for your computer to settle — still busy (${loadPerCpu.toFixed(2)} per core)`);
}

// Default calm probe: 1-min load average per core, or null if this platform doesn't report one.
function defaultLoadPerCpu() {
  try {
    const os = require("os");
    const avg = os.loadavg();
    const cores = (os.cpus() || []).length;
    if (!Array.isArray(avg) || !cores) return null;
    const one = avg[0];
    // <= 0 is Windows' unpopulated [0,0,0]. A real Unix load average is never exactly zero, and treating a
    // hypothetical one as "no signal" costs the floor — the same thing "perfectly calm" would have cost.
    if (!Number.isFinite(one) || one <= 0) return null;
    return one / cores;
  } catch (_) { return null; }
}

/**
 * Runner. `schedule(fn, launch)` either runs fn immediately or polls until it should.
 *
 * Everything time-related is injected, so the tests drive it with a fake clock and no real waiting.
 */
function createBootSettle({
  loadPerCpu = defaultLoadPerCpu,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  pollMs = POLL_MS,
  floorMs = FLOOR_MS,
  ceilingMs = CEILING_MS,
  onStatus = () => {},
  log = () => {},
} = {}) {
  let pending = null, t0 = null, timer = null, streak = 0;

  function clear() { if (timer != null) { clearTimer(timer); timer = null; } }

  function fire(why) {
    if (!pending) return "already-started";
    const fn = pending; pending = null;
    clear();
    log(`starting now — ${why}`);
    try { fn(); } catch (e) { log(`start threw: ${(e && e.message) || e}`); } // a throwing start must not strand the app
    return "started";
  }

  function tick() {
    timer = null;
    if (!pending) return;
    const v = settleCheck({ waitedMs: now() - t0, loadPerCpu: loadPerCpu(), calmStreak: streak, floorMs, ceilingMs });
    streak = v.calmStreak;
    if (v.start) return fire(v.why);
    onStatus(v.why);
    timer = setTimer(tick, pollMs);
  }

  return {
    /** Run `fn` now, or once the machine has settled. Returns what it decided. */
    schedule(fn, launch = {}) {
      if (pending) return "already-scheduled";
      pending = fn;
      const d = shouldWait(launch);
      if (!d.wait) { fire(d.why); return "immediate"; }
      t0 = now(); streak = 0;
      log(`holding the node back — ${d.why}`);
      onStatus("letting your computer finish starting up (0s)");
      timer = setTimer(tick, pollMs);
      return "waiting";
    },
    /** Skip the rest of the wait — e.g. the user opened the window, so they want it mining. */
    startNow(why = "asked to start now") { return fire(why); },
    /** Drop the pending start without running it — quitting must never spawn a node into a shutdown. */
    cancel() { const had = !!pending; pending = null; clear(); return had; },
    waiting: () => pending != null,
  };
}

module.exports = {
  createBootSettle, shouldWait, settleCheck, defaultLoadPerCpu,
  FRESH_BOOT_SEC, FLOOR_MS, CEILING_MS, POLL_MS, CALM_LOAD_PER_CPU, CALM_SAMPLES,
};
