import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * addIcon() wraps custom icon content in `<svg viewBox="0 0 100 100">` (both
 * Obsidian and the Geode host). Registering a raw 24×24 Lucide path fragment
 * therefore draws the glyph at 24% scale in the top-left corner of its box — a
 * ~3px dot. Custom icons also take precedence over built-ins, so registering a
 * built-in Lucide name that way breaks every use of that name (this is how the
 * background-task notice row's check-circle turned into a dot, and how
 * git-branch disappeared before it).
 *
 * The only legitimate custom registrations are the brand marks in
 * harnessBrandIcons.ts, which are pre-scaled to the 100×100 viewBox and
 * covered by harness-brand-icons.test.ts.
 */
const SRC_DIR = path.resolve('src');
const BRAND_ICON_MODULE = 'harnessBrandIcons.ts';
const LUCIDE_ICON_DIR = path.resolve('node_modules/lucide-static/icons');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

interface Registration { file: string; name: string }

function addIconRegistrations(): Registration[] {
  const registrations: Registration[] = [];
  for (const file of sourceFiles(SRC_DIR)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\baddIcon\(\s*(['"`])([^'"`]+)\1/g)) {
      registrations.push({ file: path.relative(SRC_DIR, file), name: match[2] });
    }
  }
  return registrations;
}

describe('custom icon registration', () => {
  it('finds the brand-icon registrations (guards against a broken scanner)', () => {
    const names = addIconRegistrations().map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['claude-spark', 'openai-blossom']));
  });

  it('only registers custom icons from the brand-icon module', () => {
    const outside = addIconRegistrations().filter((r) => r.file !== BRAND_ICON_MODULE);
    expect(outside).toEqual([]);
  });

  it('never shadows a built-in Lucide icon name', () => {
    const shadowed = addIconRegistrations().filter((r) =>
      fs.existsSync(path.join(LUCIDE_ICON_DIR, `${r.name}.svg`)),
    );
    expect(shadowed).toEqual([]);
  });
});
