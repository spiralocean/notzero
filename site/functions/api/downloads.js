// Cloudflare Pages Function — a simple download counter backed by KV (binding: STATS).
//   GET  /api/downloads  → { count }
//   POST /api/downloads  → increment, return { count }
// The client dedupes per browser (localStorage) so a refresh doesn't keep counting. No personal data,
// no cookies — just an integer, in keeping with the no-phone-home posture (this is opt-in social proof).
const KEY = "downloads";
const headers = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" };

export async function onRequestGet(context) {
  const kv = context.env.STATS;
  if (!kv) return new Response(JSON.stringify({ count: null }), { headers });
  const n = parseInt((await kv.get(KEY)) || "0", 10);
  return new Response(JSON.stringify({ count: n }), { headers });
}

export async function onRequestPost(context) {
  const kv = context.env.STATS;
  if (!kv) return new Response(JSON.stringify({ count: null }), { headers });
  const n = parseInt((await kv.get(KEY)) || "0", 10) + 1;
  await kv.put(KEY, String(n));
  return new Response(JSON.stringify({ count: n }), { headers });
}
