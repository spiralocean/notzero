// Cloudflare Worker, cron-triggered — keeps the public download count current. See tally.js for the why.
//
// Bindings (see cron/README.md):
//   STATS               KV      — the namespace the landing page and the stats page already share
//   CF_ANALYTICS_TOKEN  secret  — Zone → Analytics:Read on getnotzero.com (the same kind the stats page uses)
//   CF_ZONE_ID          var     — the getnotzero.com zone id
//
// No fetch handler: nothing calls this, it only wakes on its schedule. The landing page reads what it writes.
import { INSTALLERS, foldDownloads, publicTotals } from "./tally.js";

const GQL = "https://api.cloudflare.com/client/v4/graphql";
const DL_HOST = "dl.getnotzero.com";
const STATE_KEY = "dl:byhour";     // { since, hours: { "YYYY-MM-DDTHH": {mac,win,linux} } } — ~45 bytes an hour, ~400 KB a year
const PUBLIC_KEY = "dl:public";    // what /api/downloads serves; its existence is also what retires the button counter

const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
const num = (v) => parseInt(v || "0", 10);

async function installerFetches(env, now) {
  // Cloudflare caps the adaptive dataset at a 1-day span. A full GET only: see tally.js for what that excludes.
  const q = `query { viewer { zones(filter: {zoneTag: "${env.CF_ZONE_ID}"}) {
    dl: httpRequestsAdaptiveGroups(limit: 500, filter: {datetime_geq: "${iso(now - 24 * 3600e3)}", datetime_lt: "${iso(now)}", clientRequestHTTPHost: "${DL_HOST}", clientRequestPath_in: ${JSON.stringify(Object.keys(INSTALLERS))}, clientRequestHTTPMethodName: "GET", edgeResponseStatus: 200}, orderBy: [datetimeHour_ASC]) {
      count dimensions { datetimeHour clientRequestPath } }
  } } }`;
  const r = await fetch(GQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query: q }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!r.ok) throw new Error(`Cloudflare's Analytics API returned HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data.viewer.zones[0]?.dl || [];
}

// The button counter's keys (site/functions/api/downloads.js). Read every run rather than snapshotted once:
// they stop moving the moment PUBLIC_KEY exists, so this is the frozen pre-cutover total without a copy of it
// that could disagree with the original.
async function legacyTotals(kv) {
  const [count, mac, win, linux, days] = await Promise.all(
    ["downloads", "downloads:mac", "downloads:win", "downloads:linux", "downloads:daily"].map((k) => kv.get(k)));
  return { count: num(count), mac: num(mac), win: num(win), linux: num(linux), days: days ? JSON.parse(days) : {} };
}

export async function run(env, now = Date.now()) {
  if (!env.STATS || !env.CF_ANALYTICS_TOKEN || !env.CF_ZONE_ID) throw new Error("missing STATS, CF_ANALYTICS_TOKEN or CF_ZONE_ID — see cron/README.md");
  const kv = env.STATS;
  // A failed analytics read throws before anything is written: the last good figures stay up, and the 24h
  // window means the next run that succeeds picks up every hour this one missed.
  const rows = await installerFetches(env, now);
  const before = await kv.get(STATE_KEY);
  const state = foldDownloads(before ? JSON.parse(before) : null, rows, now);
  const next = JSON.stringify(state);
  if (next !== before) await kv.put(STATE_KEY, next);

  // Written only when a number moved, so a quiet night costs no KV writes at all.
  const pub = JSON.stringify(publicTotals(await legacyTotals(kv), state));
  if (pub !== (await kv.get(PUBLIC_KEY))) await kv.put(PUBLIC_KEY, pub);
  return JSON.parse(pub);
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env).catch((e) => console.error("download tally:", e.message || e)));
  },
};
