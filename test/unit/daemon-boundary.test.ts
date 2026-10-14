import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeClosure, readCoreFiles, violations } from '../../scripts/core-closure.mts';

/**
 * daemon/ may use Node APIs (fs, http, ws) but never Obsidian/Electron/DOM,
 * and everything it imports from src/ must already be inside the core boundary.
 * Compiled separately by tsconfig.daemon.json; see "Daemon" in process/architecture.md.
 */
const root = resolve(__dirname, '../..');
const DAEMON_ENTRY = 'daemon/main.ts';
const ALLOWED_PACKAGES = new Set(['ws']);
const NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

describe('daemon boundary', () => {
  const closure = computeClosure(root, [DAEMON_ENTRY]);

  it('has no obsidian, electron or DOM usage anywhere in the daemon closure', () => {
    expect(violations(closure)).toEqual([]);
  });

  it('imports from src/ only files that are in the core closure manifest', () => {
    const core = new Set(readCoreFiles(root).files);
    const outside = closure.files.filter((f) => f.startsWith('src/') && !core.has(f));
    expect(outside, 'daemon pulls host-bound or unchecked src files').toEqual([]);
  });

  it('uses only Node builtins and the allowlisted packages', () => {
    const unexpected = closure.externals.filter((e) => !NODE_BUILTINS.has(e) && !ALLOWED_PACKAGES.has(e));
    expect(unexpected).toEqual([]);
  });

  it('is not imported by anything under src/ (the plugin never bundles daemon code)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /from\s+['"](\.\.?\/)+daemon\//.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(join(root, 'src'));
    expect(offenders).toEqual([]);
  });

  it('keeps the Node-only dependency out of the core closure', () => {
    expect(computeClosure(root).externals).not.toContain('ws');
  });
});
