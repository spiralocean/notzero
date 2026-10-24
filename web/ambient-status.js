// The two lines of text the ambient views print over the canvas: what the node is doing, and a recent new best.
// Shared by ambient.html and ambient-rain.html, which used to each carry their own copy of the status line.
//
// A classic script setting window.AmbientStatus, not an ES module: the macOS screen saver (mac-saver/) loads
// those pages over file://, where module scripts are refused. Under file:// neither page polls a node, so
// nothing here runs there — but a failed import would still have broken the page. The strings below use \u
// escapes for · ★ … ’: ambient-rain.html declares no charset, and the first draft rendered "·" as "Â·".
//
// The node line used to treat "verificationprogress under 99.99%" as syncing. A node that has stopped getting
// blocks reports exactly that — its tip ages, and Core's progress estimate drifts down with it — so an Intel
// Mac whose Wi-Fi went dead for 12 hours sat on "SYNCING · 99%" all night. It now reads the tip's age instead,
// the way the dashboard does (web/app.js tipIsStale / tipStuck — the thresholds below mirror those, change
// both): an old tip right after a wake is a catch-up that finishes in minutes; one that STAYS old while we
// watch is a node that isn't hearing from the network.
(function (root) {
  var STALE_TIP_S = 90 * 60;            // web/app.js STALE_TIP_S
  var STUCK_AFTER_MS = 10 * 60 * 1000;  // web/app.js STUCK_AFTER_MS

  function span(sec) {
    if (sec < 5400) return Math.max(1, Math.round(sec / 60)) + ' MIN';
    if (sec < 172800) return Math.round(sec / 3600) + ' H';
    return Math.round(sec / 86400) + ' DAYS';
  }

  // Stateful: it has to remember when it first saw the tip go stale. Returns update(nodeJson, nowMs) →
  // { text, synced }; `synced` is what the canvases use to decide whether blocks are landing for real.
  function createNodeStatus() {
    var staleSeenAt = 0;
    return function update(j, now) {
      var reachable = !!(j && j.reachable);
      var tipAge = j && j.tip_time ? now / 1000 - j.tip_time : 0;
      var stale = reachable && tipAge > STALE_TIP_S;
      if (stale) { if (!staleSeenAt) staleSeenAt = now; } else staleSeenAt = 0;
      if (!reachable) return { text: 'CONNECTING TO YOUR NODE\u2026', synced: false };
      if (j.initialblockdownload || (j.headers || 0) > (j.blocks || 0)) {
        var pct = j.verificationprogress != null ? j.verificationprogress : 1;
        return { text: 'SYNCING \u00b7 ' + Math.floor(pct * 100) + '%', synced: false };
      }
      if (stale) {
        return { text: now - staleSeenAt > STUCK_AFTER_MS
          ? 'NO NEW BLOCKS FOR ' + span(tipAge) + ' \u00b7 CHECK THIS COMPUTER\u2019S INTERNET'
          : 'CATCHING UP \u00b7 FETCHING NEW BLOCKS', synced: false };
      }
      return { text: '', synced: true };
    };
  }

  // A best usually lands while nobody is at the dashboard (one ticket per block, overnight), so the ambient
  // view — what an idle machine actually shows — carries it until the user has seen it: `seenAt` is the `at`
  // of the newest best they dismissed on the dashboard (config best_seen_at, via /config). null means we
  // couldn't learn it (no app server, e.g. the public demo) → show nothing rather than nag forever.
  // Worded like the dashboard toast: leading hex "0"s, the unit people can see in the hash.
  function bestLine(best, seenAt, now) {
    if (seenAt == null || !best || !(best.zero_bits > 0) || !best.at) return '';
    var at = Date.parse(best.at);
    if (!isFinite(at) || best.at === seenAt || Date.parse(seenAt) >= at) return '';
    var zeros = Math.floor(best.zero_bits / 4), ageS = (now - at) / 1000;
    var when = ageS < 3600 ? 'JUST NOW' : ageS < 86400 ? Math.round(ageS / 3600) + ' H AGO'
      : Math.round(ageS / 86400) === 1 ? '1 DAY AGO' : Math.round(ageS / 86400) + ' DAYS AGO';
    return '\u2605 NEW BEST \u00b7 ' + zeros + ' LEADING ZERO' + (zeros === 1 ? '' : 'S') + ' \u00b7 ' + when;
  }

  root.AmbientStatus = { createNodeStatus: createNodeStatus, bestLine: bestLine, STALE_TIP_S: STALE_TIP_S, STUCK_AFTER_MS: STUCK_AFTER_MS };
})(typeof window !== 'undefined' ? window : globalThis);
