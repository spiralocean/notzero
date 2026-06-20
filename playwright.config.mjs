import { defineConfig } from "@playwright/test";

// Snapshot regression tests for the canvas dashboard. Determinism comes from: reduced-motion (freezes
// the rain + ceremonies + the global frame counter), fully-mocked data (tests/fixtures.mjs), and
// clipping to exact panel rects (window.__frames) so the rotating header quote / footer version never
// enter a baseline. Baselines are OS-specific; regenerate with `npm run test:update`.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: {
    baseURL: "http://localhost:8799",
    reducedMotion: "reduce",
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
  },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.015 } },
  webServer: {
    command: "python3 -m http.server 8799 --directory web",
    url: "http://localhost:8799",
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
});
