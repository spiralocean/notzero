import { test, expect } from "@playwright/test";
import { installMocks } from "./fixtures.mjs";

// expand exactly one section, load with mocks + frozen randomness, return its rendered rect
async function openPanel(page, section) {
  await page.emulateMedia({ reducedMotion: "reduce" }); // freeze rain + ceremonies before app.js reads matchMedia
  await page.addInitScript(() => { Math.random = () => 0.4; }); // pin quote index / shuffles
  await page.addInitScript((s) => localStorage.setItem("bl.expanded", JSON.stringify([s])), section);
  await installMocks(page);
  await page.goto("/");
  await page.waitForFunction((s) => window.__frames && window.__frames[s], section, { timeout: 20000 });
  await page.waitForTimeout(800); // let async hashing (HASH BUILD) + history settle
  const r = await page.evaluate((s) => window.__frames[s], section);
  // include the section header band just above the content for a fuller layout check
  return { x: Math.round(r.x - 8), y: Math.round(r.y - 46), width: Math.round(r.w + 16), height: Math.round(r.h + 54) };
}

for (const section of ["mempool", "closeness", "hashBuild", "network"]) {
  test(`panel: ${section}`, async ({ page }) => {
    const clip = await openPanel(page, section);
    await expect(page).toHaveScreenshot(`panel-${section}.png`, { clip });
  });
}

// Retries for this ONE test. It passes 4/4 single-worker and flakes under 4 parallel workers — canvas/font
// rendering under CPU contention, not a visual regression. It must live inside a describe(): a bare
// test.describe.configure() at file scope would apply to the WHOLE FILE and silently hand retries to the
// regression tests below, which have to fail loudly on the first run. Tracked separately for a proper fix.
test.describe("celebration", () => {
test.describe.configure({ retries: 2 });
test("win celebration (preview)", async ({ page }) => {
  test.setTimeout(90_000); // the screenshot alone budgets 20s for fonts.ready; the 30s default leaves no room under parallel load
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { Math.random = () => 0.4; });
  await installMocks(page);
  await page.goto("/");
  await page.waitForFunction(() => window.__frames, null, { timeout: 20000 });
  await page.waitForTimeout(600);
  await page.mouse.click(1180, 21); // the "▶ preview a win" control (top-right)
  await page.waitForTimeout(600); // reduced-motion pins the celebration card to its settled (static) state
  // The celebration is the first thing to draw text at this size/weight, so the browser loads that face here
  // and fonts.ready re-resolves ~1.5s later — repainting the canvas mid-screenshot and flaking the compare.
  // Wait for fonts to settle, then let the 4fps reduced-motion loop repaint once with the final metrics.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  // center card only — avoids the faint footer/version bleeding through the scrim
  // fonts.ready re-resolves slowly (~1.5s) after the celebration's big text appears, so each retry of the
  // screenshot eats most of the default 5s expect budget — give this one shot room to stabilize
  await expect(page).toHaveScreenshot("celebration.png", { clip: { x: 340, y: 300, width: 600, height: 300 }, timeout: 20000 });
});
});

// Regression: mempool.space going down (wifi drop, laptop waking from sleep) used to replace the ENTIRE
// dashboard with a single error line — including the panels fed by your own node or computed locally.
// The app must stay up, keep its last known values, and report the outage in the corner instead.
test("mempool.space offline: the dashboard stays up", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { Math.random = () => 0.4; });
  await installMocks(page);
  await page.goto("/");
  // Wait for the app to SETTLE, not merely to paint. visibleSections() returns just ["sync","network"] until
  // model.node lands, so sampling at the first painted frame can catch that transient 2-panel state and then
  // compare it against the settled 9 — a race that widens under parallel test load.
  await page.waitForFunction(() => window.__model && window.__model.node && window.__model.tipHeight && window.__drawn > 2, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => ({ drawn: window.__drawn, tip: window.__model.tipHeight }));
  expect(before.drawn).toBeGreaterThan(2); // the settled set, not the syncing-only subset

  // now the host goes away entirely, and force an immediate refetch rather than waiting out the interval
  await page.route("https://mempool.space/**", (r) => r.abort());
  await page.evaluate(() => window.__refresh());
  await page.waitForFunction(() => window.__model.error, null, { timeout: 20000 });
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({ drawn: window.__drawn, tip: window.__model.tipHeight, err: window.__model.error }));
  expect(after.drawn).toBe(before.drawn);   // every panel still painted, not replaced by an error line
  expect(after.tip).toBe(before.tip);         // last known chain data retained, not wiped
  expect(after.err).toContain("mempool.space");
});

// Regression: a 429 does NOT reject fetch — it resolves — so without an explicit res.ok check it looked
// identical to "host unreachable" and triggered the FAST retry ladder (5s/10s/20s/30s). That turned the
// normal 30s cadence into ~5s hammering exactly when mempool.space was asking for less. The client must
// back off when the server pushes back, and must keep the 30s interval suppressed while it does.
test("rate-limited: the app backs off instead of hammering", async ({ page }) => {
  test.setTimeout(120_000); // deliberately watches a 12s quiet window; boot + that cannot fit the 30s default
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { Math.random = () => 0.4; });
  await installMocks(page);

  // Rate-limit from the FIRST request, before the page even loads. Deliberately not "boot successfully, then
  // start 429ing": waiting on a full successful cycle (10 intercepted fetches) is slow and starves under
  // parallel load, and being throttled from the outset is a real scenario anyway. node.json is same-origin
  // and still mocked, so the dashboard still has a node and renders its full panel set.
  let hits = 0;
  await page.route("https://mempool.space/**", (r) => {
    hits++;
    r.fulfill({ status: 429, headers: { "Retry-After": "120" }, contentType: "text/plain", body: "Too Many Requests" });
  });
  await page.goto("/");
  await page.waitForFunction(() => (window.__model && window.__model.error || "").includes("rate-limit"), null, { timeout: 30000 });
  const afterFirst = hits;

  // 12s spans several ticks of the OLD 5s retry ladder AND a 30s-interval tick; with backoff we expect ~none
  await page.waitForTimeout(12_000);
  const extra = hits - afterFirst;
  console.log(`   requests during backoff window: ${extra} (the old fast ladder would have made several)`);
  expect(extra).toBeLessThanOrEqual(2);           // essentially quiet, not a retry ladder
  expect(await page.evaluate(() => window.__model.error)).toContain("rate-limit");
  expect(await page.evaluate(() => window.__drawn)).toBeGreaterThan(2); // and the dashboard stays up
});

// Guard the polling budget: slow-moving aggregates (price / 3d-hashrate / difficulty) were moved OFF the 30s
// tip/mempool cycle onto the 300s history timer. This proves it directly — a second refresh() re-fetches the
// mempool group but NOT the aggregates — so a future edit that drops an aggregate back into refresh() is caught.
test("polling budget: refresh() re-fetches the mempool group but not the slow aggregates", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { Math.random = () => 0.4; });
  await installMocks(page);
  const hits = {};
  await page.route("https://mempool.space/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    hits[path] = (hits[path] || 0) + 1;
    r.continue();
  });
  await page.goto("/");
  await page.waitForFunction(() => window.__model && window.__model.chainOkAt > 0, null, { timeout: 20000 });
  // one MORE refresh cycle, on top of boot
  await page.evaluate(() => window.__refresh());
  await page.waitForTimeout(1500);

  const h = (p) => hits[p] || 0;
  console.log("   mempool group /mempool:", h("/api/mempool"), " fees/recommended:", h("/api/v1/fees/recommended"));
  console.log("   aggregates  /v1/prices:", h("/api/v1/prices"), " difficulty:", h("/api/v1/difficulty-adjustment"));

  // /mempool stays on the 30s path here: the fixture node is blocksonly (relay:false), so it has no local
  // count and the collapsed header still needs mempool.space for it — fetched on boot AND the forced refresh.
  expect(h("/api/mempool")).toBeGreaterThanOrEqual(2);
  // fee weather is drawn only in the EXPANDED mempool panel, which this test never opens → visibility-gated off.
  expect(h("/api/v1/fees/recommended")).toBe(0);
  // slow aggregates are on the 300s path (refreshSlow, via loadHistory) → fetched once at boot, NOT by refresh()
  expect(h("/api/v1/prices")).toBe(1);
  expect(h("/api/v1/mining/hashrate/3d")).toBe(1);
  expect(h("/api/v1/difficulty-adjustment")).toBe(1);
  // and the price still actually loaded, so moving it didn't break the header
  expect(await page.evaluate(() => window.__model.price)).toBeGreaterThan(0);
});

// Visibility-gating: the mempool GROUP (projection, fee weather, live tx feed) is drawn only in the expanded
// MEMPOOL panel. When it's collapsed AND a synced relaying node supplies the pending count, the dashboard makes
// none of those calls; the header shows the node's count. Expanding the panel fetches them on demand.
test("mempool gating: collapsed + node count = no mempool-group calls; expanding fetches them", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { Math.random = () => 0.4; });
  await installMocks(page);
  // a synced node that RELAYS (has a real mempool) with a pending count
  await page.route("**/node.json*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    ts: 1718901234, reachable: true, blocks: 961000, headers: 961000, initialblockdownload: false, pruned: true,
    core_version: "31.1.0", mempool: { count: 55000, bytes: 30e6, rate: 9, relay: true },
  }) }));
  const hits = {};
  await page.route("https://mempool.space/**", (r) => { const p = new URL(r.request().url()).pathname; hits[p] = (hits[p] || 0) + 1; r.continue(); });
  await page.goto("/");
  await page.waitForFunction(() => window.__model && window.__model.node && window.__model.node.mempool, null, { timeout: 20000 });
  await page.waitForTimeout(300);

  // MEMPOOL collapsed by default (fixtures don't expand it). Force a couple refreshes and confirm the group is silent.
  const base = { mp: hits["/api/mempool"] || 0, proj: hits["/api/v1/fees/mempool-blocks"] || 0, fees: hits["/api/v1/fees/recommended"] || 0, recent: hits["/api/mempool/recent"] || 0 };
  await page.evaluate(() => window.__refresh());
  await page.evaluate(() => window.__refresh());
  await page.waitForTimeout(500);
  const collapsed = { mp: (hits["/api/mempool"]||0)-base.mp, proj: (hits["/api/v1/fees/mempool-blocks"]||0)-base.proj, fees: (hits["/api/v1/fees/recommended"]||0)-base.fees, recent: (hits["/api/mempool/recent"]||0)-base.recent };
  console.log("   collapsed, 2 refreshes:", JSON.stringify(collapsed), "(all should be 0)");
  expect(collapsed.mp).toBe(0);
  expect(collapsed.proj).toBe(0);
  expect(collapsed.fees).toBe(0);
  expect(collapsed.recent).toBe(0);
  // the node's count is present for the collapsed header to use — no mempool.space call was made for it
  expect(await page.evaluate(() => window.__model.node.mempool.count)).toBe(55000);

  // now EXPAND the mempool panel → the group must be fetched on demand
  const before = { proj: hits["/api/v1/fees/mempool-blocks"]||0, fees: hits["/api/v1/fees/recommended"]||0 };
  await page.evaluate(() => { window.__expand && window.__expand("mempool"); });
  await page.waitForTimeout(800);
  const projAfter = (hits["/api/v1/fees/mempool-blocks"]||0) - before.proj, feesAfter = (hits["/api/v1/fees/recommended"]||0) - before.fees;
  console.log("   after expanding:", JSON.stringify({ proj: projAfter, fees: feesAfter }), "(should be >= 1)");
  expect(projAfter + feesAfter).toBeGreaterThanOrEqual(1);
});

// A managed node mid-sync is NOT "practice mode" — the app is setting a node up. The footer must show the real
// sync status, not "practice mode · set up a node", and must not stack a second long line on the left (which
// overlapped the SYNC panel's disk readout). Regression for both from the same report.
test("footer: managed node syncing shows sync status, not practice mode", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { Math.random = () => 0.4; });
  await installMocks(page);
  await page.route("**/config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ exists: true, node_mode: "managed", platform: "darwin", app_version: "0.1.60" }) }));
  // managed node up but still syncing, miner still in its default symbolic mode
  await page.route("**/node.json*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    ts: 1718901234, reachable: true, blocks: 900000, headers: 961000, verificationprogress: 0.94,
    initialblockdownload: true, size_on_disk: 9.4e9, pruned: true, miner: { mode: "symbolic" },
  }) }));
  await page.goto("/");
  await page.waitForFunction(() => window.__footerPill != null, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  const pill = await page.evaluate(() => window.__footerPill);
  const left = await page.evaluate(() => window.__footerLeft);
  console.log(`   pill: ${JSON.stringify(pill)}\n   left: ${JSON.stringify(left)}`);
  expect(pill.toLowerCase()).not.toContain("practice mode"); // the bug: it used to say this
  expect(pill.toLowerCase()).toContain("syncing");            // shows the real state instead
  expect(left).toBe("");                                       // left suppressed → no overlap with the disk readout
});

// And once synced, the left footer returns (payout) — suppression is only during the sync.
test("footer: managed node synced shows the payout again", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { Math.random = () => 0.4; });
  await installMocks(page);
  await page.route("**/config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ exists: true, node_mode: "managed", platform: "darwin", app_version: "0.1.60" }) }));
  await page.route("**/node.json*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    ts: 1718901234, reachable: true, blocks: 961000, headers: 961000, verificationprogress: 0.99999,
    initialblockdownload: false, size_on_disk: 9.4e9, pruned: true,
    miner: { mode: "live", attempt: { attempted_at: new Date().toISOString() } },
    payout: { masked: "bc1qxs…fph2fn", is_default: false, valid: true, status: "ok" },
  }) }));
  await page.goto("/");
  await page.waitForFunction(() => window.__footerLeft != null && window.__footerLeft !== "", null, { timeout: 20000 });
  const left = await page.evaluate(() => window.__footerLeft);
  console.log(`   synced left: ${JSON.stringify(left)}`);
  expect(left).toContain("payout");
});

// A synced local node already knows the tip, delivered same-origin in node.json — so the dashboard must render
// the tip from THERE and skip the mempool.space /blocks/tip/hash + /block/{id} round-trip. Two fewer public-API
// calls per cycle for the common (node-running) user, and a faster tip (the 3s node poll vs the 30s external).
test("node tip: a synced node's tip_block replaces the mempool.space tip fetch", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { Math.random = () => 0.4; });
  await installMocks(page);
  // count tip fetches specifically
  let tipHashHits = 0, blockHits = 0;
  await page.route("**/api/blocks/tip/hash", (r) => { tipHashHits++; r.fulfill({ status: 200, contentType: "text/plain", body: "deadbeef" }); });
  await page.route("**/api/block/*", (r) => { blockHits++; r.continue(); });
  // give the node a tip_block (mempool.space's field shape, as the bridge publishes it)
  await page.route("**/node.json*", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    ts: 1718901234, reachable: true, blocks: 961000, headers: 961000, verificationprogress: 0.99999,
    initialblockdownload: false, size_on_disk: 9.8e9, pruned: true, core_version: "31.1.0",
    tip_block: { id: "0000000000000000000147034958af1652b2b91bba607beacc5e72a56f0fb5ee", height: 961000, version: 671088640,
      previousblockhash: "00000000000000000000164c0521899c2ace28639352efb1e6f7faa1f1ab0d6fd",
      merkle_root: "f576d43263ff8056c3cfa68d456e059d02d48d09413ead2e58ef020ffd0c3dc0",
      timestamp: 1718901000, bits: 386089497, nonce: 12345, tx_count: 4001, difficulty: 1.26e14 },
  }) }));
  await page.goto("/");
  // the boot refresh() legitimately runs before node.json arrives, so mempool.space is the only source then.
  // Wait for the node (with its tip) to be loaded, then measure only fetches AFTER that point.
  await page.waitForFunction(() => window.__model && window.__model.node && window.__model.node.tip_block, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  const tipBase = tipHashHits, blockBase = blockHits;
  await page.evaluate(() => window.__refresh());
  await page.waitForFunction(() => window.__model.tipHeight === 961000, null, { timeout: 20000 });
  await page.evaluate(() => window.__refresh()); // and a second cycle, to be sure it stays off mempool.space
  await page.waitForTimeout(500);

  const tipAfter = tipHashHits - tipBase, blockAfter = blockHits - blockBase;
  console.log(`   tip-hash fetches after node loaded: ${tipAfter}  block: ${blockAfter}  (both should be 0)`);
  expect(tipAfter).toBe(0);                                       // no /blocks/tip/hash once the node tip is available
  expect(blockAfter).toBe(0);                                     // no /block/{id}
  expect(await page.evaluate(() => window.__model.block.height)).toBe(961000); // tip really came from the node
  expect(await page.evaluate(() => window.__model.ticket && window.__model.ticket.height)).toBe(961000); // ticket built on it
});

// Mirror: the public demo (and a still-syncing node) has no usable local tip, so it MUST still fetch from
// mempool.space. Proves the substitution is conditional, not a blanket removal.
test("node tip: no node (demo) still fetches the tip from mempool.space", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { Math.random = () => 0.4; });
  await installMocks(page);
  let tipHashHits = 0;
  await page.route("**/api/blocks/tip/hash", (r) => { tipHashHits++; r.continue(); });
  await page.route("**/node.json*", (r) => r.fulfill({ status: 404, contentType: "text/plain", body: "no node" }));
  await page.goto("/");
  await page.waitForFunction(() => window.__model && window.__model.chainOkAt > 0, null, { timeout: 20000 });
  console.log(`   tip-hash fetches with no node: ${tipHashHits} (should be >= 1)`);
  expect(tipHashHits).toBeGreaterThanOrEqual(1);
});
