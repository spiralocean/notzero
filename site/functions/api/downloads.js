// Cloudflare Pages Function — download counter backed by KV (binding: STATS).
//   GET  /api/downloads          → { count, mac, win, linux }            (cheap: totals only)
//   GET  /api/downloads?daily=1  → …plus { days: { "YYYY-MM-DD": {mac,win,linux,other} } }
//   POST /api/downloads?os=mac   → increment total + that OS + today's per-day bucket
// Dedupe is client-side (localStorage) so a refresh doesn't recount; only the first download per browser
// counts. No cookies/PII — just integers (opt-in social proof).
// NOTE: KV is read-modify-write (not atomic); concurrent clicks can rarely lose a count. Fine for a
// low-volume social-proof counter — not billing-grade. Per-day tracking begins at deploy, so the summed
// daily buckets can trail the all-time `count` by whatever was downloaded before this shipped.
const TOTAL = "downloads";
const DAILY = "downloads:daily";
const OSES = ["mac", "win", "linux"];
const osKey = (os) => "downloads:" + os;
const headers = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" };
const num = (v) => parseInt(v || "0", 10);
const today = () => new Date().toISOString().slice(0, 10); // UTC day

async function totals(kv) {
  const [t, mac, win, linux] = await Promise.all([kv.get(TOTAL), kv.get(osKey("mac")), kv.get(osKey("win")), kv.get(osKey("linux"))]);
  return { count: num(t), mac: num(mac), win: num(win), linux: num(linux) };
}

export async function onRequestGet(context) {
  const kv = context.env.STATS;
  if (!kv) return new Response(JSON.stringify({ count: null }), { headers });
  const out = await totals(kv);
  if (new URL(context.request.url).searchParams.has("daily")) {
    const raw = await kv.get(DAILY);
    out.days = raw ? JSON.parse(raw) : {};
  }
  return new Response(JSON.stringify(out), { headers });
}

export async function onRequestPost(context) {
  const kv = context.env.STATS;
  if (!kv) return new Response(JSON.stringify({ count: null }), { headers });
  await kv.put(TOTAL, String(num(await kv.get(TOTAL)) + 1));
  const os = new URL(context.request.url).searchParams.get("os");
  const bucket = OSES.includes(os) ? os : "other"; // unknown/old clients → "other"
  if (bucket !== "other") { const k = osKey(bucket); await kv.put(k, String(num(await kv.get(k)) + 1)); }
  // per-day buckets (UTC), split by OS, in a single JSON blob (tiny: ~15 bytes/day)
  const days = JSON.parse((await kv.get(DAILY)) || "{}");
  const d = today();
  days[d] = days[d] || { mac: 0, win: 0, linux: 0, other: 0 };
  days[d][bucket] = (days[d][bucket] || 0) + 1;
  await kv.put(DAILY, JSON.stringify(days));
  return new Response(JSON.stringify(await totals(kv)), { headers });
}
