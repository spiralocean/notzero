# Deploy — pushing website changes

Two sites, both on **Cloudflare Pages** — **NOT Vercel**. (`site/.vercel/` is a leftover that only
updates an unused `*.vercel.app` URL; deploying there does **not** change the live site.)
Requires `wrangler` to be authenticated (the account already owns the `notzero` + `notzero-demo` Pages
projects). No build step — these are static sites.

## Release workflow — mac first, then Windows + Linux
The desktop app (`web/` + `desktop/`) is one shared source built per platform. **Originate every change
here on the mac, push, then the other boxes pull and build.** This single-origin order is what avoids the
diverge-and-merge mess of parallel edits.

1. **Mac (origin + ship mac):** edit shared source → **bump `desktop/package.json` version once** (shared
   across all three) → **move `CHANGELOG.md` "Unreleased" under the new version** → commit →
   **`git push origin main`** ← load-bearing → `source release.env && scripts/release-mac.sh`. If `web/` or
   `site/` changed, also deploy the website (below). As you make changes between releases, add them to the
   `CHANGELOG.md` **Unreleased** section so nothing is lost when it's time to cut the build.
2. **Windows:** `git pull origin main` → `./scripts/release-win.ps1` (see `WINDOWS-BUILD.md`).
3. **Linux:** `git pull origin main` → `./scripts/release-linux.sh` (see `LINUX-BUILD.md`).

Two rules keep it clean: **(a) push here before the others pull** — the change reaches them only via
GitHub; **(b) the followers only pull + build** — they don't edit source or bump the version. If a
platform needs its own fix, it pushes and the mac pulls; avoid simultaneous edits to the same files. One
bump → all three publish that version, each to its own updater feed (`latest-mac.yml` / `latest.yml` /
`latest-linux.yml`), so no collision even if Windows/Linux ship a version behind.

## Landing page → getnotzero.com  (project `notzero`)
Files live in `site/` (`index.html`, `favicon.svg`, `qrcode.min.js`, and Pages Functions in
`site/functions/`). It has a `site/wrangler.toml` that binds a **KV namespace** for the download counter,
so deploy **from the `site/` directory** (which picks up that config):

```
cd site
npx wrangler pages deploy
```

(Deploying `wrangler pages deploy site --project-name=notzero` from the repo root also publishes the
static files, but may miss the KV binding the counter Function needs — prefer the `cd site` form.)

getnotzero.com auto-updates to the new deployment within seconds.

## Demo dashboard → demo.getnotzero.com  (project `notzero-demo`)
Serves the canvas dashboard from `web/`. No wrangler.toml there, so pass the project name:

```
npx wrangler pages deploy web --project-name=notzero-demo
```

## Verify after deploying
```
# landing — grep for something you just changed:
curl -s https://getnotzero.com | grep -o 'SOME NEW TEXT'
# demo — confirm the JS still parses (catches a broken deploy):
curl -s -o /tmp/a.js https://demo.getnotzero.com/app.js && node --check /tmp/a.js && echo OK
```
Cloudflare serves the HTML fresh (`cf-cache-status: DYNAMIC`), so no purge needed for the sites.

## Related (not websites, but same account)
- **Downloads + snapshots** → Cloudflare **R2** bucket `r2:notzero-dl` (→ `dl.getnotzero.com`), uploaded
  with `rclone`. The `.dmg` + `latest-mac.yml` have a cache rule so a release serves fresh, no purge.
- **macOS releases** → `source release.env && scripts/release-mac.sh` (bump `desktop/package.json` first).

---

[a **spiralocean** project](https://spiralocean.com)
