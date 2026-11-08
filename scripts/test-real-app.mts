// Builds/locates the pinned Geode, then runs the real-app Playwright specs against it. Needs `npm run build` first.
import { spawnSync } from 'node:child_process';
import { ensureGeode } from './geode-harness.mts';

const geode = ensureGeode();
const r = spawnSync('npx', ['playwright', 'test', '-c', 'playwright.real-app.config.ts', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, GEODE_REPO: geode },
});
process.exit(r.status ?? 1);
