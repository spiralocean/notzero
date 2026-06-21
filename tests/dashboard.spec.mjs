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
  await expect(page).toHaveScreenshot("celebration.png", { clip: { x: 340, y: 300, width: 600, height: 300 } });
});
