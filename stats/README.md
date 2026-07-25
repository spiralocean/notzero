# stats — the private reach dashboard

Downloads and running installs for notzero, at a URL you can open from a phone. Same numbers as
`node scripts/stats.mjs`, but hosted and always current.

It is a Cloudflare Pages project (`notzero-stats`), separate from the public site so nothing here can
leak into `getnotzero.com`. `index.html` ships no credentials — it fetches `/api/stats`, and the
Function does the authenticated work server-side.

Nothing new is collected. Every figure comes from traffic the app and the site already generate.

## Deploy

```
cd stats
npx wrangler pages deploy . --project-name notzero-stats
```

## Configuration — required, once

The Function needs two bindings. Without them `/api/stats` returns a 503 saying so.

**1. `CF_ZONE_ID`** (plain variable) — the getnotzero.com zone id:

```
npx wrangler pages project create notzero-stats     # first time only
npx wrangler pages secret put CF_ZONE_ID --project-name notzero-stats
# paste: 95627a8a0532b6c01731ed136ac3f8b1
```

**2. `CF_ANALYTICS_TOKEN`** (secret) — an API token that may read analytics and nothing else.

Create it at **dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom token**:

| Field | Value |
|---|---|
| Permissions | `Zone` · `Analytics` · `Read` |
| Zone Resources | Include · Specific zone · `getnotzero.com` |

Read-only on one zone — it cannot change DNS, deploy, or touch R2. Then:

```
npx wrangler pages secret put CF_ANALYTICS_TOKEN --project-name notzero-stats
```

## Locking it down

**Do this before treating the URL as private.** A `*.pages.dev` address is unlisted, not protected —
anything that logs or shares the link can read your numbers. The page sends `noindex, nofollow`, which
keeps honest crawlers out and stops nothing else.

**dash.cloudflare.com → Zero Trust → Access → Applications → Add an application → Self-hosted:**

- Application domain: your `notzero-stats.pages.dev` hostname
- Policy: *Allow* · include **Emails** → your address

Cloudflare then emails you a one-time code on each new session. That is the actual gate.

## What the numbers mean

| Figure | Derived from | Caveat |
|---|---|---|
| Downloads | `getnotzero.com/api/downloads` | Landing-page button clicks, deduped per browser. Misses direct CDN links; a download is not an install. |
| Running installs | `CHANGELOG.md` fetches ÷ 48/day | One fetch per install per 30 min. Release hours over-count: updated machines restart and re-poll. Read the median. |
| Platform split | `latest-*.yml` fetches ÷ 12/day | One feed file per platform, so the *ratio* is exact. Also fires once per launch, so the absolute count reads high. |
| Site / demo visits | zone analytics `visits` | Crawler bursts show up as one enormous hour; the page clips and flags those rather than averaging them in. |

Cloudflare caps this dataset at a 24-hour span, which is why there is no week view.
