// mergeConfig CONCATENATES `include` arrays (running the whole suite), so override via function form.
import { defineConfig } from 'vitest/config';
import base from './vitest.config';
export default defineConfig({ ...base, test: { ...base.test, include: ['test/spikes/**/*.test.ts'] } });
