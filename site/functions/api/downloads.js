// Cloudflare Pages Function — a download counter backed by KV (binding: STATS).
//   GET  /api/downloads         → { count, mac, win, linux }   (count = total across all OSes)
//   POST /api/downloads?os=mac  → increment the total + that OS, return the same shape
// The client dedupes per browser (localStorage) so a refresh doesn't keep counting, and only the FIRST
// download per browser is counted — so this is "unique downloaders," attributed to the OS of that click.
// No personal data, no cookies — just integers, in keeping with the no-phone-home posture (opt-in social proof).
// NOTE: KV increments are read-modify-write (not atomic), so concurrent clicks can occasionally lose a
// count. That's fine for approximate social proof — don't treat these as billing-grade totals.
const TOTAL = "downloads";
const OSES = ["mac", "win", "linux"];
const osKey = (os) => "downloads:" + os;
const headers = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" };
const num = (v) => parseInt(v || "0", 10);

async function readAll(kv) {
  const [total, mac, win, linux] = await Promise.all([
    kv.get(TOTAL), kv.get(osKey("mac")), kv.get(osKey("win")), kv.get(osKey("linux")),
  ]);
  return { count: num(total), mac: num(mac), win: num(win), linux: num(linux) };
}

export async function onRequestGet(context) {
  const kv = context.env.STATS;
  if (!kv) return new Response(JSON.stringify({ count: null }), { headers });
  return new Response(JSON.stringify(await readAll(kv)), { headers });
}

export async function onRequestPost(context) {
  const kv = context.env.STATS;
  if (!kv) return new Response(JSON.stringify({ count: null }), { headers });
  // total always increments (also covers older clients that don't send ?os)
  await kv.put(TOTAL, String(num(await kv.get(TOTAL)) + 1));
  // per-OS only for a recognised value, so a bogus ?os can't create arbitrary keys
  const os = new URL(context.request.url).searchParams.get("os");
  if (OSES.includes(os)) { const k = osKey(os); await kv.put(k, String(num(await kv.get(k)) + 1)); }
  return new Response(JSON.stringify(await readAll(kv)), { headers });
}
