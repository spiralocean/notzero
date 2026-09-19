// The download count, derived from CDN traffic instead of counted click by click.
//
// The landing page used to count its own button: every click POSTed to a Pages Function that did three KV
// read-modify-writes. That is fine at a few downloads a day and wrong at exactly the moment the number
// matters — KV allows one write per second per key, so a spike turns into 429s, the Function 500s, and the
// counter stalls while the downloads it is failing to count are happening. It also only ever saw the button:
// a direct link to the installer, which is what gets pasted into a thread, counted as nothing.
//
// The CDN already knows. Every installer the site links to is served from dl.getnotzero.com, and zone
// analytics records each fetch whether or not anyone clicked anything. So this reads the last 24 hours of
// those fetches on a timer and folds them into a stored tally. The cost is the same two KV writes every ten
// minutes whether there were three downloads or three million.
//
// What it counts is a complete GET (HTTP 200) of one of the three stable installer URLs. Auto-updates fetch
// VERSIONED files (notzero-0.1.92-…), never these, so an existing install taking a release does not move it.
// It is not deduplicated per browser, as the button was; someone downloading twice is two. HEAD requests and
// resumed ranges (206) are excluded, so a link checker or a download manager's extra connections are not.
//
// Pure functions only — the Worker around them (worker.js) does the I/O. Tested in tally.test.js.

export const INSTALLERS = { "/notzero-mac.dmg": "mac", "/notzero-win.exe": "win", "/notzero-linux.AppImage": "linux" };
const OSES = ["mac", "win", "linux"];

const hourOf = (ms) => new Date(ms).toISOString().slice(0, 13);   // "YYYY-MM-DDTHH", unique across days

// Fold one analytics window into the stored per-hour tally. Returns the next state; never mutates the input.
//
// Idempotent the same way the stats page's machine tally is: an hour is ASSIGNED the count Cloudflare reports
// for it, never added to. The window is 24 hours and this runs every ten minutes, so each hour is read ~144
// times — the current hour growing as it fills, a finished hour repeating its final figure until it ages out.
//
// `since` is the cutover, fixed on the first run to the NEXT full hour. Before it, downloads were counted by
// the button and live in the legacy keys; from it, they are counted here. Starting on an hour boundary is what
// keeps the two from overlapping: taking the current, half-finished hour would count its first half twice.
// The sliver between the first run and that boundary is counted by neither, which is the direction to be
// wrong in — a figure shown as social proof may trail the truth but must never lead it.
export function foldDownloads(state, rows, nowMs) {
  const since = (state && state.since) || hourOf(nowMs + 3600e3);
  const hours = { ...((state && state.hours) || {}) };
  for (const row of rows || []) {
    const os = INSTALLERS[row.dimensions.clientRequestPath];
    const hour = String(row.dimensions.datetimeHour).slice(0, 13);
    if (!os || hour < since) continue;
    hours[hour] = { mac: 0, win: 0, linux: 0, ...hours[hour], [os]: row.count };
  }
  return { since, hours };
}

// What the landing page and the stats page are served: the legacy button count, frozen at the cutover, plus
// everything the CDN has counted since. Same shape /api/downloads has always returned — { count, mac, win,
// linux } and a per-UTC-day map — so neither page has to know the source changed. `source` is there so the
// stats page can describe the number honestly rather than go on saying "once per browser".
export function publicTotals(legacy, state) {
  const out = { count: legacy.count || 0, mac: legacy.mac || 0, win: legacy.win || 0, linux: legacy.linux || 0, days: {}, source: "cdn", since: state.since };
  for (const [day, c] of Object.entries(legacy.days || {})) out.days[day] = { mac: 0, win: 0, linux: 0, other: 0, ...c };
  for (const [hour, c] of Object.entries(state.hours)) {
    const d = (out.days[hour.slice(0, 10)] ||= { mac: 0, win: 0, linux: 0, other: 0 });
    for (const os of OSES) { const n = c[os] || 0; d[os] += n; out[os] += n; out.count += n; }
  }
  return out;
}
