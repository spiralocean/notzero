"use strict";
// Hold a pending update install back while a native modal dialog is on screen.
//
// `update-downloaded` used to call quitAndInstall() on a flat 6s timer regardless of what was displayed. The
// what's-new recap is shown PARENTED to the main window, which on macOS makes it a window-modal sheet, and
// quitting with a sheet attached is the same shape as the 0.1.33→0.1.34 stall: quitAndInstall() closes the
// window first, and anything that stops the window closing leaves Squirrel's ShipIt waiting forever to swap
// the bundle. The app is then wedged — no update, and no way back without a force quit.
//
// So: wait for the dialog to go away, then install. Deferring is safe in a way that proceeding is not. The
// worst case is the update lands when the user dismisses the recap, which is exactly what pressing "Later"
// would have done. There is deliberately NO cap that gives up and installs anyway — a cap would just
// reintroduce the hang on a slow timer, and the app keeps running the old version perfectly well meanwhile.
//
// Split out of main.js so it can be tested: main.js needs a live Electron app, this needs nothing.
function deferWhileBusy({ isBusy, onIdle, run, delayMs = 6000, pollMs = 1000, setTimer = setTimeout }) {
  let released = false, ran = false;
  const busy = () => {
    // A predicate that throws is a bug in the caller, not a dialog. Treat it as "nothing on screen" and get
    // the update installed — the failure we are guarding against is stalling forever, so never stall on this.
    try { return !!isBusy(); } catch (_) { return false; }
  };
  const tick = () => {
    if (released) return;
    if (busy()) { setTimer(tick, pollMs); return; }
    released = true;
    try { if (onIdle) onIdle(); } catch (_) {}
    setTimer(() => {
      if (ran) return;
      ran = true;
      try { run(); } catch (_) {}
    }, delayMs);
  };
  tick();   // synchronous first check, so the common case (no dialog) behaves exactly as the old flat timer did
  return { isPending: () => !ran, isReleased: () => released };
}

module.exports = { deferWhileBusy };
