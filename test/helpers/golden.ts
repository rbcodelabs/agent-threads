import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect } from 'vitest';

const ROOT = resolve(__dirname, '../golden');

/** Compare `actual` to test/golden/<name>; `UPDATE_GOLDEN=1` rewrites the file instead. */
export function expectGolden(name: string, actual: string): void {
  const file = join(ROOT, name);
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, actual);
    if (process.env.UPDATE_GOLDEN !== '1') throw new Error(`golden file ${name} did not exist; written. Review and re-run.`);
    return;
  }
  expect(actual).toBe(readFileSync(file, 'utf8'));
}
