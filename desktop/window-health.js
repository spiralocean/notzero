// ---------------------------------------------------------------------------
// Is the main window actually showing anything?
//
// Seen after a reboot: the window opened, the page load neither failed nor finished, and the renderer never
// crashed — so neither did-fail-load nor render-process-gone fired, and the user stared at a black rectangle
// (backgroundColor, nothing painted) until File → Dashboard reloaded it by hand. Mining was fine the whole
// time; the window just never came back from its first load.
//
// The check asks the question the user asks — "is there anything in this window?" — rather than a proxy like
// "does the DOM have elements" (it does: the dashboard's static HTML has them before any script runs, and a
// compositor that never paints them leaves the DOM looking perfectly healthy). So main.js captures a small
// thumbnail of the window and this module looks for any pixel that isn't the empty background.
//
// Pure (bitmaps and clocks are passed in) so the decisions can be tested without Electron.
// ---------------------------------------------------------------------------
"use strict";

// The window's backgroundColor is #05040a — every channel ≤ 10. Anything the page draws (text, the block
// visuals, even a dim border) lifts some pixel well above that; a little headroom absorbs scaling blur.
const BLANK_MAX_CHANNEL = 24;

/**
 * isBlank(bitmap) -> true | false | null
 *
 * bitmap: raw 4-byte-per-pixel buffer from nativeImage.toBitmap() (BGRA or RGBA — only the max colour channel
 * matters, so the order doesn't). Returns null for an empty capture: macOS hands back nothing for a window it
 * isn't compositing (occluded, mid-transition), and "couldn't look" must never be mistaken for "looked, saw
 * nothing" — that would reload a perfectly good window every time it was covered.
 */
function isBlank(bitmap, maxChannel = BLANK_MAX_CHANNEL) {
  if (!bitmap || bitmap.length < 4) return null;
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    if (bitmap[i] > maxChannel || bitmap[i + 1] > maxChannel || bitmap[i + 2] > maxChannel) return false;
  }
  return true;
}

/**
 * createWindowHealth({ now, maxReloads, windowMs }) -> { verdict(probe) }
 *
 * probe: { stuckLoading } — still loading long after it should have finished, or
 *        { captureTimedOut } — the renderer didn't answer a capture at all, or
 *        { blank: true | false | null } — the result of isBlank on a capture.
 *
 * verdict returns "ok" (healthy, or nothing to judge), "reload", or "give-up". Reloads are capped: if
 * reloading isn't fixing it, more reloads won't either, and the caller should say so instead of looping.
 */
function createWindowHealth({ now = Date.now, maxReloads = 3, windowMs = 120000 } = {}) {
  let reloads = [];
  return {
    verdict(probe) {
      const p = probe || {};
      const sick = p.stuckLoading || p.captureTimedOut || p.blank === true;
      if (!sick) { if (p.blank === false) reloads = []; return "ok"; } // only a SEEN healthy window clears the history
      const t = now();
      reloads = reloads.filter((at) => t - at < windowMs);
      if (reloads.length >= maxReloads) return "give-up";
      reloads.push(t);
      return "reload";
    },
  };
}

module.exports = { isBlank, createWindowHealth, BLANK_MAX_CHANNEL };
