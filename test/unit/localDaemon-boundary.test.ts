import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(__dirname, '../..');
const core: string[] = JSON.parse(readFileSync(resolve(root, 'core-files.json'), 'utf8')).files ?? [];

describe('core-closure boundary', () => {
  it('no file under src/localDaemon is part of the daemon core', () => {
    expect(core.length).toBeGreaterThan(10);
    expect(core.filter((f) => f.includes('localDaemon'))).toEqual([]);
  });

  it('no core file imports the local daemon module', () => {
    for (const f of core) {
      const text = readFileSync(resolve(root, f), 'utf8');
      expect(text, f).not.toMatch(/from ['"][^'"]*localDaemon/);
      expect(text, f).not.toMatch(/require\(['"][^'"]*localDaemon/);
    }
  });

  it('local daemon modules import no Node built-in at module scope (the bundle also loads on mobile)', () => {
    const dir = resolve(root, 'src/localDaemon');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text, f).not.toMatch(/^import .* from ['"](node:)?(fs|os|path|child_process|net|http|crypto)(\/promises)?['"]/m);
    }
  });
});
