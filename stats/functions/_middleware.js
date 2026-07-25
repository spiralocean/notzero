// Serve only from the canonical host, so the numbers have exactly one door.
//
// Cloudflare Access protects Pages PREVIEW deployments (*.notzero-stats.pages.dev) but not the production
// pages.dev hostname, and there is no setting that turns that hostname off — Cloudflare's own guidance is to
// redirect it at your custom domain. Left alone it served the full dashboard, and /api/stats with it, to
// anyone who knew the URL, completely bypassing the Access policy on stats.getnotzero.com.
//
// Doing it here rather than in dashboard configuration means the guarantee ships with the code: it survives
// redeploys, it can't be half-saved in a UI, and it is verifiable with a single curl.
const CANONICAL = "stats.getnotzero.com";
const DEV = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === CANONICAL || DEV.test(url.host)) return context.next();
  // 302 rather than a bare 403: anyone who lands on an old link gets sent to the real one, where Access asks
  // for their email. No content and no data leave this branch.
  url.hostname = CANONICAL;
  url.port = "";
  return Response.redirect(url.toString(), 302);
}
