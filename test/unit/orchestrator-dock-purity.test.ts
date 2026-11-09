/**
 * Boundary guard: the dock model and the shared permission helper must stay
 * host-free (no `obsidian` import), so they stay unit-testable and out of the
 * host-bound closure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = ['src/orchestratorDockModel.ts', 'src/permissionCard.ts', 'src/dockSheetModel.ts'];
const IMPORT_OBSIDIAN = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]obsidian['"]/;

describe.each(FILES)('%s', (file) => {
  const src = readFileSync(join(__dirname, '..', '..', file), 'utf8');
  it('does not import from obsidian', () => {
    expect(IMPORT_OBSIDIAN.test(src)).toBe(false);
  });
});

describe('the guard itself', () => {
  it('detects the import forms it is meant to catch', () => {
    for (const bad of ["import { Notice } from 'obsidian';", 'import "obsidian";', "import type { App } from \"obsidian\"", "const o = require('obsidian')", "await import('obsidian')"]) {
      expect(IMPORT_OBSIDIAN.test(bad)).toBe(true);
    }
    expect(IMPORT_OBSIDIAN.test("import { x } from './obsidianTools';")).toBe(false);
  });
});
