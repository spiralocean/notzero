// Cloudflare Pages Function — the download count (KV binding: STATS).
//   GET  /api/downloads          → { count, mac, win, linux }            (cheap: totals only)
//   GET  /api/downloads?daily=1  → …plus { days: { "YYYY-MM-DD": {mac,win,linux,other} } }
//   POST /api/downloads?os=mac   → the button counter, until the CDN tally takes over (see below)
//
// The count is derived from CDN traffic by a scheduled Worker (cron/), which publishes it under `dl:public`.
// Serving it is one KV read, whatever the traffic; nothing here writes once that key exists.
//
// Before that — and on any deployment where the Worker has never run — this is still the original button
// counter: dedupe is client-side (localStorage), so only the first download per browser counts, and the
// increment is a KV read-modify-write (not atomic; concurrent clicks can lose a count, and KV refuses more
// than one write a second per key, which is why it was replaced). `dl:public` existing is the whole switch:
// the Worker's first run freezes these keys as the pre-cutover total and counts from the next hour on, so the
// two never count the same download. No cookies/PII either way — just integers (opt-in social proof).
const PUBLIC = "dl:public";
const TOTAL = "downloads";
const DAILY = "downloads:daily";
const OSES = ["mac", "win", "linux"];
const osKey = (os) => "downloads:" + os;
const cors = { "content-type": "application/json", "access-control-allow-origin": "*" };
const headers = { ...cors, "cache-control": "no-store" };
const num = (v) => parseInt(v || "0", 10);
const today = () => new Date().toISOString().slice(0, 10); // UTC day

async function totals(kv) {
  const [t, mac, win, linux] = await Promise.all([kv.get(TOTAL), kv.get(osKey("mac")), kv.get(osKey("win")), kv.get(osKey("linux"))]);
  return { count: num(t), mac: num(mac), win: num(win), linux: num(linux) };
}

export async function onRequestGet(context) {
  const kv = context.env.STATS;
  if (!kv) return new Response(JSON.stringify({ count: null }), { headers });
  const daily = new URL(context.request.url).searchParams.has("daily");
  const pub = await kv.get(PUBLIC);
  if (pub) {
    const { days, ...out } = JSON.parse(pub);
    // The tally moves every ten minutes at most, so a browser may keep this for one.
    return new Response(JSON.stringify(daily ? { ...out, days } : out), { headers: { ...cors, "cache-control": "public, max-age=60" } });
  }
  const out = await totals(kv);
  if (daily) {
    const raw = await kv.get(DAILY);
    out.days = raw ? JSON.parse(raw) : {};
  }
  return new Response(JSON.stringify(out), { headers });
}

export async function onRequestPost(context) {
  const kv = context.env.STATS;
  if (!kv) return new Response(JSON.stringify({ count: null }), { headers });
  // Once the CDN tally is live the click is already counted where it lands, so the beacon has nothing to do.
  if (await kv.get(PUBLIC)) return new Response(null, { status: 204, headers: cors });
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
