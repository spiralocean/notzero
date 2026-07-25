#!/usr/bin/env node
// How many people downloaded notzero, and how many are still running it.
//
//   node scripts/stats.mjs            # last 24h
//   node scripts/stats.mjs --hours 72
//   node scripts/stats.mjs --json
//
// Two independent sources, neither of which needs the Cloudflare dashboard:
//
//   DOWNLOADS — getnotzero.com/api/downloads, the KV counter behind the landing page's download button
//     (site/functions/api/downloads.js). Public, no auth. Counts BUTTON CLICKS, deduped per browser via
//     localStorage — so it misses anyone who took a direct CDN link or a GitHub asset, and it can't tell
//     you whether a download was ever installed.
//
//   INSTALLS — Cloudflare zone analytics for dl.getnotzero.com. A running app polls the CDN on fixed
//     cadences, so request counts divide back out into a headcount. No telemetry and nothing new to
//     collect: this is traffic the app already generates to check for updates and verify release proofs.
//
// Auth: CLOUDFLARE_API_TOKEN if set, otherwise the OAuth token `wrangler login` already stored — so if you
// can deploy the site, you can run this. Downloads still print if the Cloudflare half can't authenticate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const HOURS = Number(args[args.indexOf("--hours") + 1]) > 0 && args.includes("--hours") ? Number(args[args.indexOf("--hours") + 1]) : 24;
const JSON_OUT = args.includes("--json");

// The app's polling cadences (desktop/main.js). Requests ÷ per-install-per-day = installs.
const FEED_PER_DAY = 24 / 2;   // autoUpdater checks the feed every 2h …plus once per launch, so this over-counts
const CHANGELOG_PER_DAY = 48;  // refreshUpdateHistory fetches CHANGELOG.md every 30 min — one per install, exactly
const HOST = "dl.getnotzero.com";
const API = "https://api.cloudflare.com/client/v4";

// ---- auth: env token, else whatever `wrangler login` left behind ----
function wranglerToken() {
  const cfg = path.join(os.homedir(), process.platform === "darwin" ? "Library/Preferences/.wrangler" : ".config/.wrangler", "config/default.toml");
  let text; try { text = fs.readFileSync(cfg, "utf8"); } catch (_) { return null; }
  const tok = /^oauth_token\s*=\s*"([^"]+)"/m.exec(text);
  const exp = /^expiration_time\s*=\s*"([^"]+)"/m.exec(text);
  if (!tok) return null;
  if (exp && new Date(exp[1]).getTime() < Date.now()) return { token: tok[1], stale: true };
  return { token: tok[1], stale: false };
}

async function cf(token, body) {
  const r = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error(j.errors.map((e) => e.message).join("; "));
  return j.data;
}

async function zoneId(token) {
  const r = await fetch(`${API}/zones?name=getnotzero.com`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await r.json();
  if (!j.success || !j.result?.length) throw new Error("couldn't resolve the getnotzero.com zone (token needs Zone:Read)");
  return j.result[0].id;
}

const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

async function traffic(token) {
  const zone = await zoneId(token);
  const now = new Date(), since = new Date(now - HOURS * 3600 * 1000);
  const q = `query { viewer { zones(filter: {zoneTag: "${zone}"}) {
    httpRequestsAdaptiveGroups(limit: 500, filter: {datetime_geq: "${iso(since)}", datetime_lt: "${iso(now)}", clientRequestHTTPHost: "${HOST}"}, orderBy: [count_DESC]) {
      count dimensions { clientRequestPath }
    } } } }`;
  const rows = (await cf(token, { query: q })).viewer.zones[0]?.httpRequestsAdaptiveGroups || [];
  const by = (pred) => rows.filter((r) => pred(r.dimensions.clientRequestPath));
  const sum = (rs) => rs.reduce((n, r) => n + r.count, 0);
  const isArtifact = (p) => /\.(dmg|exe|AppImage|zip)$/.test(p) && !p.endsWith(".blockmap");
  const feed = { mac: sum(by((p) => p === "/latest-mac.yml")), win: sum(by((p) => p === "/latest.yml")), linux: sum(by((p) => p === "/latest-linux.yml")) };
  return {
    hours: HOURS,
    total: sum(rows),
    feed,
    changelog: sum(by((p) => p === "/CHANGELOG.md")),
    proofPolling: sum(by((p) => p.includes("/SHA256SUMS") || p === "/CHANGELOG.md")),
    artifacts: by((p) => isArtifact(p)).map((r) => ({ path: r.dimensions.clientRequestPath, count: r.count })),
  };
}

// requests over the window → installs, normalising the window back to a day
const installsFrom = (count, perDay, hours) => (count / (perDay * (hours / 24)));

async function downloads() {
  const r = await fetch("https://getnotzero.com/api/downloads?daily=1");
  if (!r.ok) throw new Error(`downloads endpoint returned HTTP ${r.status}`);
  return r.json();
}

const n1 = (x) => (Math.round(x * 10) / 10).toFixed(1);

(async () => {
  const out = {};
  try { out.downloads = await downloads(); } catch (e) { out.downloadsError = e.message; }

  const auth = process.env.CLOUDFLARE_API_TOKEN ? { token: process.env.CLOUDFLARE_API_TOKEN, stale: false } : wranglerToken();
  if (!auth) out.trafficError = "no CLOUDFLARE_API_TOKEN, and no wrangler login found — run `npx wrangler login`";
  else { try { out.traffic = await traffic(auth.token); } catch (e) { out.trafficError = auth.stale ? `${e.message} (the wrangler token looks expired — run \`npx wrangler login\`)` : e.message; } }

  if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); return; }

  console.log("\nnotzero — downloads & installs\n" + "=".repeat(46));
  if (out.downloads) {
    const d = out.downloads;
    console.log(`\nDOWNLOADS (all time, landing-page button)`);
    console.log(`  ${d.count} total   mac ${d.mac}  win ${d.win}  linux ${d.linux}`);
    const days = Object.entries(d.days || {}).sort().slice(-7);
    if (days.length) {
      console.log(`  recent days:`);
      for (const [day, b] of days) console.log(`    ${day}  mac ${b.mac}  win ${b.win}  linux ${b.linux}  other ${b.other}`);
    }
    if (d.count > (d.mac + d.win + d.linux)) console.log(`  (${d.count - (d.mac + d.win + d.linux)} predate per-OS tracking)`);
  } else console.log(`\nDOWNLOADS — unavailable: ${out.downloadsError}`);

  if (out.traffic) {
    const t = out.traffic;
    const feedTotal = t.feed.mac + t.feed.win + t.feed.linux;
    console.log(`\nINSTALLS (last ${t.hours}h of dl.getnotzero.com traffic)`);
    console.log(`  from CHANGELOG.md polling  ~${n1(installsFrom(t.changelog, CHANGELOG_PER_DAY, t.hours))} running continuously`);
    console.log(`    ${t.changelog} requests ÷ ${CHANGELOG_PER_DAY}/day — one per install per 30 min, the tightest estimate`);
    console.log(`  from update-feed checks    ~${n1(installsFrom(feedTotal, FEED_PER_DAY, t.hours))} seen`);
    console.log(`    mac ${t.feed.mac}  win ${t.feed.win}  linux ${t.feed.linux}  (÷ ${FEED_PER_DAY}/day; also fires once per launch, so restarts inflate it)`);
    console.log(`      → mac ~${n1(installsFrom(t.feed.mac, FEED_PER_DAY, t.hours))}   win ~${n1(installsFrom(t.feed.win, FEED_PER_DAY, t.hours))}   linux ~${n1(installsFrom(t.feed.linux, FEED_PER_DAY, t.hours))}`);
    if (t.artifacts.length) {
      console.log(`\nINSTALLER FETCHES (last ${t.hours}h)`);
      for (const a of t.artifacts) console.log(`  ${String(a.count).padStart(4)}  ${a.path}`);
    }
    console.log(`\nCDN LOAD (last ${t.hours}h)`);
    console.log(`  ${t.total} requests total; ${t.proofPolling} (${Math.round((t.proofPolling / t.total) * 100)}%) is proof/changelog polling`);
  } else console.log(`\nINSTALLS — unavailable: ${out.trafficError}`);
  console.log("");
})();
