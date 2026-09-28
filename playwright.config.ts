import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: './test/screenshots',
  // One worker so all screenshot tests share the same GPU context.  Parallel
  // Chromium workers produce consistent-but-diverging subpixel antialiasing
  // (~18 000 pixel delta per run) that defeats the tight maxDiffPixels: 25
  // tolerance below.  Wall-clock cost is negligible — tests average <1 s each.
  workers: 1,
  use: {
    viewport: { width: 420, height: 740 },
    deviceScaleFactor: 2,
    // Pin the browser timezone + locale so message timestamps render the
    // same regardless of the machine's system timezone. The committed
    // baselines were captured in Eastern time — without this pin the suite
    // fails on any machine (or after any travel) outside America/New_York.
    timezoneId: 'America/New_York',
    locale: 'en-US',
  },
  expect: {
    toHaveScreenshot: {
      scale: 'device',
      // Small allowance for sub-pixel anti-aliasing noise. With the clock,
      // timezone, and locale pinned above, renders are fully deterministic
      // on a given machine (verified: two consecutive runs pass at 0), so
      // this stays tight. The previous 200px tolerance silently swallowed an
      // entire added footer icon (~116 differing pixels) — keep this below
      // the footprint of the smallest meaningful UI change.
      maxDiffPixels: 25,
    },
  },
  projects: [{ name: 'chromium' }],
  snapshotDir: './test/screenshots/snapshots',
  // No {platform} segment: baselines are platform-neutral and Linux is the
  // single canonical renderer (CI runs in the official Playwright container;
  // see process/development.md → Screenshot Tests). A Mac render will not
  // match these baselines — that is expected, not a regression.
  snapshotPathTemplate: '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{ext}',
  // Keep the HTML report (with expected/actual/diff images) for CI artifacts
  // without auto-opening a browser on local failures.
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
});
