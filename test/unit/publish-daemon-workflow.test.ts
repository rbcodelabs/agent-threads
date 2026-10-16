import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const text = readFileSync(resolve(__dirname, '../../.github/workflows/publish-daemon-image.yml'), 'utf8');

describe('publish-daemon-image workflow', () => {
  it('cannot publish from an arbitrary branch, even on manual dispatch', () => {
    expect(text).toMatch(/^\s+if: github\.ref_type == 'tag' \|\| github\.ref == 'refs\/heads\/main'$/m);
    expect(text).toContain('refs/tags/v${version}');
  });
  it('pins every third-party action by commit SHA', () => {
    const uses = [...text.matchAll(/^\s+uses:\s*(\S+)/gm)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(4);
    for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/);
  });
  it('keeps the immutable-tag check', () => {
    expect(text).toContain('Published tags are immutable');
  });
});
