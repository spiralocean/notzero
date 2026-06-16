// Headless probe for the browser dashboard — lets the dev (and Claude) read live
// canvas state without eyeballs on the screen.
//
//   node scripts/probe.mjs            # dump window.__sync JSON + screenshot to /tmp
//   node scripts/probe.mjs --watch    # sample window.__sync every 1s for ~8s (see it move)
//   node scripts/probe.mjs --section closeness   # screenshot a different expanded section
//
// Writes:  /tmp/sync-state.json   (latest live state object)
//          /tmp/dashboard.png     (full page screenshot)
//
// Requires the dev server on :8787 and (for node data) scripts/node_bridge.py running.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const URL = process.env.PROBE_URL || "http://localhost:8787/";
const watch = process.argv.includes("--watch");
const sIdx = process.argv.indexOf("--section");
const section = sIdx > -1 ? process.argv[sIdx + 1] : "sync";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "networkidle" });

// make sure the section we care about is expanded (state persists in localStorage)
await page.evaluate((s) => {
  const set = new Set(JSON.parse(localStorage.getItem("bl.expanded") || "[]"));
  set.add(s);
  localStorage.setItem("bl.expanded", JSON.stringify([...set]));
}, section);
await page.reload({ waitUntil: "networkidle" });

const read = () => page.evaluate(() => window.__sync || null);

// give the feeds (mempool + ./node.json) a moment to land
await page.waitForTimeout(2500);

if (watch) {
  for (let i = 0; i < 8; i++) {
    const s = await read();
    console.log(`t+${i}s`, JSON.stringify(s));
    await page.waitForTimeout(1000);
  }
}

const state = await read();
writeFileSync("/tmp/sync-state.json", JSON.stringify(state, null, 2));
await page.screenshot({ path: "/tmp/dashboard.png", fullPage: false });

console.log("\n=== window.__sync ===");
console.log(JSON.stringify(state, null, 2));
if (errors.length) console.log("\n=== page errors ===\n" + errors.join("\n"));
console.log("\nwrote /tmp/sync-state.json and /tmp/dashboard.png");

await browser.close();
