"use strict";
// Bring the managed node back when it dies on its own.
//
// 2026-08-04, on a real install: bitcoind and the window's renderer were SIGTERMed in the same second — a 16 GB
// machine with 6.7 GB of swap in use, the OS reclaiming memory from the two largest consumers. bitcoind handles
// SIGTERM by shutting down GRACEFULLY, so it exited 0, and node-lifecycle reported "the node stopped
// unexpectedly (code 0)". The app then sat in that error state for four hours with mining stopped.
// retryManagedNode() brings it back in about nine seconds. Nothing ever called it except a button on a screen
// nobody was watching.
//
// Two judgements are baked in, and both are about NOT retrying:
//
//   1. Only a node that had already come up. A node that never started is a setup problem — no disk space, a
//      failed download, a corrupt datadir — and the wizard exists to show it. Retrying that silently buys three
//      more identical failures and hides the one screen that could explain them.
//
//   2. A node that dies shortly after coming up keeps counting against the same budget; only one that stayed up
//      for `stableMs` gets a fresh one. Without that, a machine killing bitcoind every two minutes would restart
//      it forever and the error screen would never appear — which is the failure mode of an unbounded retry,
//      dressed up as a fix.
//
// Split out of main.js so it can be tested: main.js needs a live Electron app, this needs nothing.
function createNodeRecovery({
  retry,
  delays = [5000, 15000, 60000],   // then stop, and leave the error screen up with its manual button
  stableMs = 10 * 60 * 1000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
} = {}) {
  let everReady = false, readyAt = null, attempts = 0, timer = null;

  // Returns what it decided, so the caller (and the tests) can see the reasoning rather than infer it.
  function onState(state, detail, { quitting = false } = {}) {
    if (state === "ready") {
      everReady = true;
      if (readyAt == null) readyAt = now();
      return "ready";
    }
    if (state !== "error") return "ignored";       // downloading / starting / syncing — still on its way up
    if (quitting) return "quitting";               // we asked for this; never fight a shutdown
    if (!everReady) return "never-started";        // see judgement 1
    if (readyAt != null && now() - readyAt > stableMs) attempts = 0;  // stayed up a while → a NEW incident
    readyAt = null;
    if (attempts >= delays.length) {
      log(`node down (${detail}) — auto-retry exhausted, leaving the error screen up`);
      return "exhausted";
    }
    const delay = delays[attempts++];
    log(`node down (${detail}) — auto-retry ${attempts}/${delays.length} in ${Math.round(delay / 1000)}s`);
    if (timer != null) clearTimer(timer);
    timer = setTimer(() => { timer = null; try { retry(); } catch (_) { /* a throwing retry must not kill the app */ } }, delay);
    return "scheduled";
  }

  return {
    onState,
    cancel() { if (timer != null) { clearTimer(timer); timer = null; } },
    pending: () => timer != null,
    attempts: () => attempts,
  };
}

module.exports = { createNodeRecovery };
