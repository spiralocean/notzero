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

const demo = { ...NODE_PAYLOAD, miner: { ...NODE_PAYLOAD.miner, seed: "demo" } };
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
const m = JSON.parse(out).miner;
console.log(`staged ${OUT}/ — seed "${m.seed}", payout ${m.payout}`);
console.log(`  ${m.best_history.length} records (${m.best_history.map((e) => e.zero_bits).join("/")} bits), live attempt present: ${!!m.attempt?.hash}`);
console.log(`  deploy: npx wrangler pages deploy ${OUT} --project-name=notzero-demo`);
