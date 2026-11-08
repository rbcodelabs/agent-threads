import { defineConfig } from '@playwright/test';

// Real Geode app (Electron) + this repo's built plugin. See scripts/geode-harness.mts and test/real-app/.
export default defineConfig({
  testDir: './test/real-app',
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
});
