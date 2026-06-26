// Cloudflare Pages Function — the current downloadable version, read from the update feed so the
// landing page always shows what the Download button actually serves (no manual edit per release).
const headers = { "content-type": "application/json", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" };

export async function onRequestGet() {
  try {
    const yml = await (await fetch("https://dl.getnotzero.com/latest-mac.yml", { cf: { cacheTtl: 300 } })).text();
    const m = yml.match(/version:\s*([0-9][\w.\-]*)/);
    return new Response(JSON.stringify({ version: m ? m[1] : null }), { headers });
  } catch (_) {
    return new Response(JSON.stringify({ version: null }), { headers });
  }
}
