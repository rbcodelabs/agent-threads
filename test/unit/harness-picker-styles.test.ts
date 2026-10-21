import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('composer settings popover touch targets', () => {
  it('keeps each popover row and choice at least 44px tall on mobile', () => {
    const css = fs.readFileSync(path.resolve('styles.css'), 'utf8');
    const rule = css.match(/\.ct-root\.ct-mobile \.ct-sp-item\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(rule).toMatch(/min-height:\s*44px/);
  });

  it('no longer ships the bespoke harness menu styles', () => {
    const css = fs.readFileSync(path.resolve('styles.css'), 'utf8');
    expect(css).not.toMatch(/\.ct-harness-menu/);
  });
});
