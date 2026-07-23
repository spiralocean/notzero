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

  // mempool group is on the 30s path → hit on BOTH boot and the forced refresh
  expect(h("/api/mempool")).toBeGreaterThanOrEqual(2);
  expect(h("/api/v1/fees/recommended")).toBeGreaterThanOrEqual(2);
  // slow aggregates are on the 300s path (refreshSlow, via loadHistory) → fetched once at boot, NOT by refresh()
  expect(h("/api/v1/prices")).toBe(1);
  expect(h("/api/v1/mining/hashrate/3d")).toBe(1);
  expect(h("/api/v1/difficulty-adjustment")).toBe(1);
  // and the price still actually loaded, so moving it didn't break the header
  expect(await page.evaluate(() => window.__model.price)).toBeGreaterThan(0);
});
