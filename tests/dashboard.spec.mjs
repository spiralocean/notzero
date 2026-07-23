import { test, expect } from "@playwright/test";
import { installMocks } from "./fixtures.mjs";

// expand exactly one section, load with mocks + frozen randomness, return its rendered rect
async function openPanel(page, section) {
  await page.emulateMedia({ reducedMotion: "reduce" }); // freeze rain + ceremonies before app.js reads matchMedia
  await page.addInitScript(() => { Math.random = () => 0.4; }); // pin quote index / shuffles
  await page.addInitScript((s) => localStorage.setItem("bl.expanded", JSON.stringify([s])), section);
  await installMocks(page);
  await page.goto("/");
  await page.waitForFunction((s) => window.__frames && window.__frames[s], section, { timeout: 8000 });
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

test("win celebration (preview)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { Math.random = () => 0.4; });
  await installMocks(page);
  await page.goto("/");
  await page.waitForFunction(() => window.__frames, null, { timeout: 8000 });
  await page.waitForTimeout(600);
  await page.mouse.click(1180, 21); // the "▶ preview a win" control (top-right)
  await page.waitForTimeout(600); // reduced-motion pins the celebration card to its settled (static) state
  // center card only — avoids the faint footer/version bleeding through the scrim
  // fonts.ready re-resolves slowly (~1.5s) after the celebration's big text appears, so each retry of the
  // screenshot eats most of the default 5s expect budget — give this one shot room to stabilize
  await expect(page).toHaveScreenshot("celebration.png", { clip: { x: 340, y: 300, width: 600, height: 300 }, timeout: 20000 });
});

// Regression: mempool.space going down (wifi drop, laptop waking from sleep) used to replace the ENTIRE
// dashboard with a single error line — including the panels fed by your own node or computed locally.
// The app must stay up, keep its last known values, and report the outage in the corner instead.
test("mempool.space offline: the dashboard stays up", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => { Math.random = () => 0.4; });
  await installMocks(page);
  await page.goto("/");
  // Wait for the app to SETTLE, not merely to paint. visibleSections() returns just ["sync","network"] until
  // model.node lands, so sampling at the first painted frame can catch that transient 2-panel state and then
  // compare it against the settled 9 — a race that widens under parallel test load.
  await page.waitForFunction(() => window.__model && window.__model.node && window.__model.tipHeight && window.__drawn > 2, null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => ({ drawn: window.__drawn, tip: window.__model.tipHeight }));
  expect(before.drawn).toBeGreaterThan(2); // the settled set, not the syncing-only subset

  // now the host goes away entirely, and force an immediate refetch rather than waiting out the interval
  await page.route("https://mempool.space/**", (r) => r.abort());
  await page.evaluate(() => window.__refresh());
  await page.waitForFunction(() => window.__model.error, null, { timeout: 8000 });
  await page.waitForTimeout(300);

  const after = await page.evaluate(() => ({ drawn: window.__drawn, tip: window.__model.tipHeight, err: window.__model.error }));
  expect(after.drawn).toBe(before.drawn);   // every panel still painted, not replaced by an error line
  expect(after.tip).toBe(before.tip);         // last known chain data retained, not wiped
  expect(after.err).toContain("mempool.space");
});
