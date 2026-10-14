import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CORE_TSCONFIG,
  ENTRY_FILES,
  computeClosure,
  readCoreFiles,
  renderCoreTsconfig,
  violations,
} from '../../scripts/core-closure.mts';

/**
 * The daemon "core" is the runtime import closure of the entry set below. It
 * must run in plain Node, so no file in it may import `obsidian` or touch DOM
 * globals. Host-specific behavior comes in through src/host/ seams instead.
 * Regenerate the manifest with `npm run core:update` after changing core imports.
 */
const root = resolve(__dirname, '../..');

describe('core boundary', () => {
  const closure = computeClosure(root);
  const core = readCoreFiles(root);

  it('has no violating files outside the (shrinking) allowlist', () => {
    const bad = violations(closure);
    const allowed = core.allowlist.map((a) => a.file);
    expect(bad.filter((f) => !allowed.includes(f)), 'new host-bound files in core closure').toEqual([]);
    // The allowlist may only shrink: an entry that is no longer a violation must be removed.
    expect(allowed.filter((f) => !bad.includes(f)), 'stale allowlist entries').toEqual([]);
  });

  it('reports 0 violating files', () => {
    // Stronger than the allowlist check: this PR's seams leave the allowlist empty.
    expect(violations(closure)).toEqual([]);
  });

  it('matches core-files.json (no drift)', () => {
    expect(core.entries).toEqual(ENTRY_FILES);
    expect(core.files).toEqual(closure.files);
  });

  it('keeps tsconfig.core.json in step with the closure', () => {
    expect(readFileSync(join(root, CORE_TSCONFIG), 'utf8')).toBe(renderCoreTsconfig(closure.files));
  });

  it('includes every daemon entry module', () => {
    for (const entry of ENTRY_FILES) expect(closure.files).toContain(entry);
  });

  it('never reaches a view, modal or plugin entry', () => {
    const hostOnly = closure.files.filter((f) => /(View|Modal|SettingsTab)\.ts$|\/main\.ts$/.test(f));
    expect(hostOnly).toEqual([]);
  });
});

describe('core-closure analysis', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-closure-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, body: string) => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', name), body);
  };

  it('flags runtime obsidian imports and DOM globals but ignores type-only and shadowed ones', () => {
    write('entry.ts', [
      "import type { App } from 'obsidian';",
      "import { Notice, type TFile } from 'obsidian';",
      "import { helper } from './helper';",
      "import { typeOnlyUse } from './typeOnly';",
      'export const n = new Notice(helper());',
      'export type A = App | TFile;',
      'export type T = typeof typeOnlyUse;',
    ].join('\n'));
    write('helper.ts', 'export function helper(): string { const window = { x: 1 }; return String(window.x); }\n');
    write('typeOnly.ts', "import { parseYaml } from 'obsidian';\nexport const typeOnlyUse = parseYaml;\n");
    write('dom.ts', 'export const w = () => window.location.href;\n');
    write('entry2.ts', "import { w } from './dom';\nexport const x = w();\n");

    const c = computeClosure(dir, ['src/entry.ts', 'src/entry2.ts']);
    expect(c.files).toEqual(['src/dom.ts', 'src/entry.ts', 'src/entry2.ts', 'src/helper.ts']);
    // `typeOnly.ts` is only used in a `typeof` type query, so it is elided at runtime.
    expect(violations(c)).toEqual(['src/dom.ts', 'src/entry.ts']);
  });
});
