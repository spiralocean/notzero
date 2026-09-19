# cron — the download count, derived from CDN traffic

A scheduled Cloudflare Worker (`notzero-cron`). Every ten minutes it reads the last 24 hours of installer
fetches from zone analytics, folds them into a stored per-hour tally, and publishes the total the landing
page shows. `tally.js` explains why this replaced the button counter; `worker.js` is the I/O around it.

Nothing new is collected. It reads traffic `dl.getnotzero.com` already serves.

## Deploy

```
cd cron
npx wrangler deploy
```

## Configuration — required, once

**`CF_ANALYTICS_TOKEN`** (secret) — an API token that may read analytics and nothing else. Same recipe as
`stats/README.md` (`Zone` · `Analytics` · `Read`, on `getnotzero.com` only); a Pages secret cannot be read
back, so either paste the same token again or mint a second one:

```
npx wrangler secret put CF_ANALYTICS_TOKEN
```

`CF_ZONE_ID` and the `STATS` KV namespace are in `wrangler.toml`.

## The cutover — order matters

1. **Landing page first** (`cd site && npx wrangler pages deploy`). The new `/api/downloads` behaves exactly
   like the old one until `dl:public` exists, so this step changes nothing on its own.
2. **Then this Worker**, with its secret. Its first run publishes `dl:public` — the button count, unchanged —
   and from that moment the landing page stops writing. It counts CDN fetches from the next full hour on.

The other order double counts: an old landing page keeps incrementing the button keys, which this adds the
CDN's figures on top of.

## Checking it

```
npx wrangler tail notzero-cron                                   # a failed run logs "download tally: …"
npx wrangler kv key get dl:public --namespace-id 57c1ad90f1cd4fea80fb53960de46dbc --remote
```

`npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled"`, runs one pass locally
(against a local KV unless you add `--remote`).

## What the number means

A complete `GET` (HTTP 200) of `/notzero-mac.dmg`, `/notzero-win.exe` or `/notzero-linux.AppImage`. Auto-updates
fetch versioned files and are not counted. Not deduplicated per browser. `HEAD` and resumed ranges (206) are
excluded. At high volume Cloudflare samples this dataset, so the figure becomes an estimate — good to a few
percent, which is what a number shown as "↓ 12,400 downloads so far" needs to be.
