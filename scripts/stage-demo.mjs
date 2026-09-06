#!/usr/bin/env node
// Stage the demo dashboard for Cloudflare Pages (project `notzero-demo`) into .demo-build/.
//
//   node scripts/stage-demo.mjs && npx wrangler pages deploy .demo-build --project-name=notzero-demo
//
// Why this exists rather than `wrangler pages deploy web`: that uploads the DIRECTORY, and `web/node.json` is
// gitignored local state written by the running bridge — it carries THIS MACHINE's seed. Deploying web/ directly
// published it, which is how demo.getnotzero.com came to serve a real machine seed alongside a thin
// 533-attempt, 7-bit node state.
//
// Omitting node.json is not the fix either. The odds map and YOUR RECORDS only render inside drawCloseness's
// live branch (`at && at.hash`), so a demo with no payload silently loses the two richest panels on the page —
// verified: no node.json means no odds map, no records, no ticks.
//
// So: ship a SYNTHETIC payload. It reuses the test fixture deliberately — one definition of "a realistic node"
// serves both the tests and the demo, and a change to one is a change to both. Its timestamps are anchored to
// generation time, which is why this runs at deploy rather than living as a committed file that would age.
import { cpSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { NODE_PAYLOAD } from "../tests/fixtures.mjs";

const OUT = ".demo-build";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync("web", OUT, { recursive: true });
rmSync(`${OUT}/node.json`, { force: true }); // whatever the local bridge left behind

// demo: true is what the dashboard branches on (isDemoPayload in app.js). This payload is otherwise a healthy,
// synced, mode "live" node, so without the flag the page reported "LIVE solo mining" with a payout address.
const demo = { ...NODE_PAYLOAD, demo: true, miner: { ...NODE_PAYLOAD.miner, seed: "demo" } };
writeFileSync(`${OUT}/node.json`, JSON.stringify(demo, null, 2) + "\n");

// Guard, not decoration: if the local bridge's payload is on this machine, prove none of it reached the build.
const out = readFileSync(`${OUT}/node.json`, "utf8");
if (existsSync("web/node.json")) {
  const local = JSON.parse(readFileSync("web/node.json", "utf8")).miner || {};
  for (const [field, value] of [["seed", local.seed]]) {
    if (value && out.includes(value)) {
      console.error(`REFUSING TO STAGE: this machine's ${field} (${value}) is present in the demo payload.`);
      process.exit(1);
    }
  }
}
// web/index.html is shared with the desktop app, so its title/description describe the product. The demo
// gets its own: the tab, the search snippet and the social card all say demo and point at the download.
// Each replacement must hit exactly once — if the source markup drifts, fail here rather than ship the old copy.
const HTML = `${OUT}/index.html`;
let html = readFileSync(HTML, "utf8");
const DEMO_TITLE = "₿itcoin Lottery — live demo (nothing here is mining for you)";
const DEMO_DESC = "A demo of the notzero dashboard on the live Bitcoin network — simulated tickets, real blocks. Nothing here is mining for you: get the free, non-custodial app at getnotzero.com for a real ticket.";
for (const [re, to] of [
  [/<title>[^<]*<\/title>/, `<title>${DEMO_TITLE}</title>`],
  [/(<meta name="description" content=")[^"]*(")/, `$1${DEMO_DESC}$2`],
  [/(<meta property="og:title" content=")[^"]*(")/, `$1${DEMO_TITLE}$2`],
  [/(<meta property="og:description" content=")[^"]*(")/, `$1${DEMO_DESC}$2`],
  [/(<meta name="twitter:title" content=")[^"]*(")/, `$1${DEMO_TITLE}$2`],
  [/(<meta name="twitter:description" content=")[^"]*(")/, `$1${DEMO_DESC}$2`],
]) {
  const hits = (html.match(new RegExp(re.source, "g")) || []).length;
  if (hits !== 1) { console.error(`REFUSING TO STAGE: expected exactly one match for ${re}, found ${hits} in web/index.html`); process.exit(1); }
  html = html.replace(re, to);
}
writeFileSync(HTML, html);

const m = JSON.parse(out).miner;
console.log(`staged ${OUT}/ — seed "${m.seed}", payout ${m.payout}, demo flag: ${JSON.parse(out).demo === true}`);
console.log(`  ${m.best_history.length} records (${m.best_history.map((e) => e.zero_bits).join("/")} bits), live attempt present: ${!!m.attempt?.hash}`);
console.log(`  deploy: npx wrangler pages deploy ${OUT} --project-name=notzero-demo`);
