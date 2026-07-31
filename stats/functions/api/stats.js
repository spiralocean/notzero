// Cloudflare Pages Function — everything the stats page plots, assembled server-side.
//
//   GET /api/stats?hours=24  → { window, downloads, dl[], sites[], releases{}, totals }
//
// Server-side because the Cloudflare analytics API needs a token, and a token in client-side JS is a
// published token. The page itself ships no credentials — it just fetches this.
//
// Bindings (see stats/README.md):
//   CF_ANALYTICS_TOKEN  secret — an API token with Zone → Analytics:Read on getnotzero.com
//   CF_ZONE_ID          var    — the getnotzero.com zone id
//
// Nothing here collects anything new. It reads traffic the app and the site already generate.
const GQL = "https://api.cloudflare.com/client/v4/graphql";
const DL_HOST = "dl.getnotzero.com";
const SITE_HOST = "getnotzero.com";
const DEMO_HOST = "demo.getnotzero.com";

// The app's polling cadences (desktop/main.js). Requests ÷ per-install-per-day = a headcount.
const CHANGELOG_PER_DAY = 48; // refreshUpdateHistory: one CHANGELOG.md fetch per install per 30 min
const FEED_PER_DAY = 12;      // autoUpdater: one feed fetch per install per 2h (plus one per launch)

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const iso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");

async function gql(token, query) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data;
}

// Release timestamps for the chart markers, taken from when the release workflow RAN — not from the tagged
// commit's date. Those differ by however long the commit sat before it was tagged: v0.1.61 was committed
// 16:30Z and released 22:20Z, so commit dates would have parked the marker six hours off the traffic it is
// meant to explain. One request, public repo, no credentials; if GitHub is unreachable or rate-limits us the
// page renders without markers rather than failing.
async function releases(hours) {
  try {
    const r = await fetch("https://api.github.com/repos/spiralocean/notzero/actions/workflows/release.yml/runs?event=push&per_page=10", {
      headers: { "user-agent": "notzero-stats", accept: "application/vnd.github+json" },
    });
    if (!r.ok) return {};
    const runs = (await r.json()).workflow_runs || [];
    const cutoff = Date.now() - hours * 3600e3;
    const out = {};
    for (const run of runs) {
      if (!/^v\d/.test(run.head_branch || "")) continue;      // tag-triggered runs only
      const when = Date.parse(run.created_at || "");
      if (!when || when < cutoff) continue;
      out[new Date(when).toISOString().slice(11, 13)] = run.head_branch.replace(/^v/, "");
    }
    return out;
  } catch (_) { return {}; }
}

// Fold this window's versioned installer fetches into a stored per-(version, hour) tally and return cumulative
// totals. Idempotent: an hour already recorded is ASSIGNED the same count, never added to, so reloading the page
// cannot inflate the numbers. Falls back to the window-only figures whenever KV is unavailable, so the page
// degrades to its previous behaviour rather than breaking.
const MACH_KEY = "mach:byhour";
const MACH_KEEP_DAYS = 120;
async function mergeMachineTally(kv, perVersion, dlRows) {
  const windowOnly = () => Object.values(perVersion).sort((a, b) => cmpVer(b.version, a.version));
  if (!kv) return windowOnly();
  const before = (await kv.get(MACH_KEY)) || "{}";
  const stored = JSON.parse(before);          // { version: { "YYYY-MM-DDTHH": {mac,win,linux} } }
  for (const row of dlRows) {
    const m = /^\/notzero-(\d+\.\d+\.\d+)-(mac|win|linux)/.exec(row.dimensions.clientRequestPath);
    if (!m || row.dimensions.clientRequestPath.endsWith(".blockmap")) continue;
    const hour = row.dimensions.datetimeHour.slice(0, 13);   // full YYYY-MM-DDTHH, unique across days
    const byHour = (stored[m[1]] ||= {});
    (byHour[hour] ||= { mac: 0, win: 0, linux: 0 })[m[2]] = row.count;
  }
  const cutoff = Date.now() - MACH_KEEP_DAYS * 86400e3, out = [];
  for (const [version, byHour] of Object.entries(stored)) {
    const v = { version, mac: 0, win: 0, linux: 0, total: 0 };
    for (const [hour, c] of Object.entries(byHour)) {
      if (Date.parse(hour + ":00:00Z") < cutoff) { delete byHour[hour]; continue; }
      v.mac += c.mac || 0; v.win += c.win || 0; v.linux += c.linux || 0;
    }
    v.total = v.mac + v.win + v.linux;
    if (v.total) out.push(v);
  }
  const next = JSON.stringify(stored);
  if (next !== before) await kv.put(MACH_KEY, next);          // only write when the window actually added something
  return out.length ? out.sort((a, b) => cmpVer(b.version, a.version)) : windowOnly();
}

export async function onRequestGet({ request, env }) {
  const token = env.CF_ANALYTICS_TOKEN, zone = env.CF_ZONE_ID;
  if (!token || !zone) return json({ error: "This deployment is missing CF_ANALYTICS_TOKEN or CF_ZONE_ID — see stats/README.md." }, 503);

  const url = new URL(request.url);
  // Cloudflare caps the adaptive dataset at a 1-day span, so 24h is both the default and the ceiling.
  const hours = Math.min(24, Math.max(1, Number(url.searchParams.get("hours")) || 24));
  const now = Date.now(), since = now - hours * 3600e3;

  const out = { window: { since: iso(since), until: iso(now), hours } };

  // downloads — public endpoint, no auth, and its own failure shouldn't take the page down
  try {
    const r = await fetch(`https://${SITE_HOST}/api/downloads?daily=1`, { cf: { cacheTtl: 60 } });
    if (r.ok) out.downloads = await r.json();
  } catch (_) { /* leave undefined; the page shows a dash */ }

  try {
    const q = `query { viewer { zones(filter: {zoneTag: "${zone}"}) {
      dl: httpRequestsAdaptiveGroups(limit: 5000, filter: {datetime_geq: "${iso(since)}", datetime_lt: "${iso(now)}", clientRequestHTTPHost: "${DL_HOST}"}, orderBy: [datetimeHour_ASC]) {
        count dimensions { datetimeHour clientRequestPath } }
      sites: httpRequestsAdaptiveGroups(limit: 2000, filter: {datetime_geq: "${iso(since)}", datetime_lt: "${iso(now)}", clientRequestHTTPHost_in: ["${SITE_HOST}","${DEMO_HOST}"]}, orderBy: [datetimeHour_ASC]) {
        count sum { visits } dimensions { datetimeHour clientRequestHTTPHost } }
    } } }`;
    const z = (await gql(token, q)).viewer.zones[0] || { dl: [], sites: [] };

    const hourKey = (s) => s.slice(11, 13);
    const hoursSeen = [];
    const seen = new Set();
    const bucket = {};
    const touch = (h) => {
      if (!seen.has(h)) { seen.add(h); hoursSeen.push(h); }
      return (bucket[h] ||= { hour: h, changelog: 0, proofs: 0, artifacts: 0, mac: 0, win: 0, linux: 0, siteReq: 0, siteVisits: 0, demoReq: 0, demoVisits: 0 });
    };

    for (const row of z.dl) {
      const b = touch(hourKey(row.dimensions.datetimeHour)), p = row.dimensions.clientRequestPath, n = row.count;
      if (p === "/CHANGELOG.md") b.changelog += n;
      else if (p === "/latest-mac.yml") b.mac += n;
      else if (p === "/latest.yml") b.win += n;
      else if (p === "/latest-linux.yml") b.linux += n;
      else if (/\.(dmg|exe|AppImage|zip)$/.test(p)) b.artifacts += n;
      else if (p.includes("SHA256SUMS")) b.proofs += n;
    }

    // Machines, counted properly. Every other figure on this page divides request volume by a polling
    // cadence, which yields an AVERAGE of how many are awake — a machine that's asleep contributes nothing.
    // An installer is different: each machine fetches it exactly once when it takes a release, so counting
    // versioned artifact fetches counts computers, with no cadence assumption and nothing inflated by restarts.
    const perVersion = {};
    for (const row of z.dl) {
      const m = /^\/notzero-(\d+\.\d+\.\d+)-(mac|win|linux)/.exec(row.dimensions.clientRequestPath);
      if (!m || row.dimensions.clientRequestPath.endsWith(".blockmap")) continue; // blockmaps are extra fetches by the same machine
      const v = (perVersion[m[1]] ||= { version: m[1], mac: 0, win: 0, linux: 0, total: 0 });
      v[m[2]] += row.count; v.total += row.count;
    }
      // PERSIST the per-version tally. Cloudflare caps this dataset at a 24h span, so a release older than a
      // day has no installer fetches left in the window and its bar emptied — the chart forgot how many
      // machines had taken it, which is the one number the page exists to answer. Stored per (version, hour)
      // so re-reading an hour we already have overwrites it with the same value instead of double counting,
      // which keeps it correct however often the page is loaded.
      const machines = await mergeMachineTally(env.STATS, perVersion, z.dl)
        .catch(() => Object.values(perVersion).sort((a, b) => cmpVer(b.version, a.version)));
    for (const row of z.sites) {
      const b = touch(hourKey(row.dimensions.datetimeHour));
      const isDemo = row.dimensions.clientRequestHTTPHost === DEMO_HOST;
      b[isDemo ? "demoReq" : "siteReq"] += row.count;
      b[isDemo ? "demoVisits" : "siteVisits"] += row.sum.visits;
    }

    // chronological, and drop leading/trailing hours with no app polling at all (partial buckets)
    const rows = hoursSeen.map((h) => bucket[h]);
    while (rows.length && rows[0].changelog === 0) rows.shift();
    while (rows.length && rows[rows.length - 1].changelog === 0) rows.pop();
    for (const b of rows) b.installs = Math.round((b.changelog / 2) * 10) / 10;

    const sum = (k) => rows.reduce((n, b) => n + b[k], 0);
    out.rows = rows;
    out.machines = machines;
    out.totals = {
      // A FLOOR on the fleet, not a total: the busiest single release in the window. Summing across releases
      // would count one machine several times; taking only the newest would read as a collapse in the minutes
      // after a cut, before everyone has updated. A machine that stayed off through every release in the
      // window is invisible here — which is why this is "at least", and why it can only ever be an undercount.
      machinesSeen: machines.reduce((n, v) => Math.max(n, v.total), 0),
      requests: sum("changelog") + sum("proofs") + sum("artifacts") + sum("mac") + sum("win") + sum("linux"),
      polling: sum("changelog") + sum("proofs"),
      artifacts: sum("artifacts"),
      feed: { mac: sum("mac"), win: sum("win"), linux: sum("linux") },
      siteVisits: sum("siteVisits"),
      demoVisits: sum("demoVisits"),
      // the quiet-hour floor is the honest headcount: release hours double-count restarts
      installsSteady: rows.length ? median(rows.map((b) => b.installs)) : 0,
      perDay: { changelog: CHANGELOG_PER_DAY, feed: FEED_PER_DAY },
    };
    out.releases = await releases(hours);
  } catch (e) {
    out.trafficError = String(e.message || e);
  }

  return json(out);
}

// newest-first semantic version compare
function cmpVer(a, b) {
  const A = a.split(".").map(Number), B = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
  return 0;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
}
