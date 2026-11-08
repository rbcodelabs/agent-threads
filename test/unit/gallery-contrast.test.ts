import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * WCAG contrast for the colour pairs Gallery mode uses (4.5:1 text, 3:1 UI).
 *
 * Robustness: the pairs are declared here by CSS custom-property NAME and are
 * resolved from (a) the Gallery section of styles.css for the `--ct-gallery-*`
 * locals, (b) the dark theme variables in the screenshot harness
 * (test/harness/kanban.html :root), which is what the baselines render, and
 * (c) Obsidian's default light-theme constants below. The test also fails if the
 * Gallery CSS stops referencing a token a pair relies on, or starts referencing
 * a colour variable this table cannot resolve, so the pairs cannot drift away
 * from the stylesheet silently.
 */

const css = fs.readFileSync(path.resolve('styles.css'), 'utf8');
const START = '/* ══ Gallery mode';
const END = '/* ══ end Gallery mode';
const gallery = css.slice(css.indexOf(START), css.indexOf(END));

function parseVars(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  return out;
}

const harnessHtml = fs.readFileSync(path.resolve('test/harness/kanban.html'), 'utf8');
const darkTheme = parseVars(harnessHtml.slice(harnessHtml.indexOf(':root'), harnessHtml.indexOf('*, *::before')));
// Obsidian default light theme (documented defaults; not rendered by the harness).
const lightTheme: Record<string, string> = {
  '--background-primary': '#ffffff',
  '--background-secondary': '#f6f6f6',
  '--background-modifier-border': '#dadada',
  '--text-normal': '#222222',
  '--text-muted': '#5c5c5c',
  '--text-on-accent': '#ffffff',
  '--interactive-accent': '#705dcf',
  '--color-orange': '#ec7500',
};
const locals = parseVars(gallery.slice(0, gallery.indexOf('.ct-gallery-banner')));

function hex(c: string): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) throw new Error(`not a hex colour: ${c}`);
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function luminance(c: string): number {
  const [r, g, b] = hex(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const resolve = (theme: Record<string, string>, token: string): string => {
  const v = locals[token] ?? theme[token];
  if (!v) throw new Error(`unresolved token ${token}`);
  return v;
};

type Pair = { fg: string; bg: string; min: number; what: string; darkOnly?: boolean };
const TEXT = 4.5;
const UI = 3;
const PAIRS: Pair[] = [
  { fg: '--text-normal', bg: '--background-secondary', min: TEXT, what: 'title / kicker / excerpt on card' },
  { fg: '--text-muted', bg: '--background-secondary', min: TEXT, what: 'one-line message and status label on card' },
  { fg: '--text-muted', bg: '--background-primary', min: TEXT, what: 'chip text and placeholder tag' },
  { fg: '--text-normal', bg: '--background-primary', min: TEXT, what: 'chips, command block, placeholder excerpt' },
  { fg: '--text-on-accent', bg: '--interactive-accent', min: TEXT, what: 'Allow button' },
  { fg: '--ct-gallery-scrim-text', bg: '--ct-gallery-scrim', min: TEXT, what: 'badge / time / counter / +N over images' },
  // Non-text UI: focus ring, current-thumb border and nav-button border against what they sit on.
  { fg: '--text-normal', bg: '--background-secondary', min: UI, what: 'focus ring and current-thumb border' },
  { fg: '--ct-gallery-scrim-text', bg: '--ct-gallery-image-well', min: UI, what: 'nav button border on the image well' },
  // Decorative accent only: "Needs you" is always also stated in words (kicker, chip, status label,
  // banner). Obsidian's light-theme orange is ~2.8:1 on the card, so it is asserted for dark only.
  { fg: '--color-orange', bg: '--background-secondary', min: UI, what: 'Needs-you card border and state dot', darkOnly: true },
];

describe('Gallery mode contrast (WCAG 2.x)', () => {
  it('finds the Gallery section and its local colour tokens', () => {
    expect(gallery.length).toBeGreaterThan(1000);
    expect(locals['--ct-gallery-scrim']).toBeDefined();
    expect(locals['--ct-gallery-scrim-text']).toBeDefined();
  });

  it('only references colour variables this test can resolve', () => {
    const used = new Set(Array.from(gallery.matchAll(/var\((--[a-z0-9-]+)/gi)).map((m) => m[1]));
    const colourish = [...used].filter((v) => /^--(text|background|color|interactive|ct-gallery)/.test(v));
    for (const token of colourish) {
      const known = token in locals || token in darkTheme;
      expect(known, `${token} used by Gallery CSS but not resolvable`).toBe(true);
    }
  });

  it('every pair is backed by a token the Gallery CSS actually uses', () => {
    const used = new Set(Array.from(gallery.matchAll(/var\((--[a-z0-9-]+)/gi)).map((m) => m[1]));
    for (const p of PAIRS) {
      expect(used.has(p.fg), `${p.fg} (${p.what})`).toBe(true);
      expect(used.has(p.bg), `${p.bg} (${p.what})`).toBe(true);
    }
  });

  for (const [name, theme] of [['dark (harness)', darkTheme], ['light (Obsidian defaults)', lightTheme]] as const) {
    describe(name, () => {
      for (const p of PAIRS.filter((pair) => !pair.darkOnly || theme === darkTheme)) {
        it(`${p.what}: ${p.fg} on ${p.bg} >= ${p.min}:1`, () => {
          const ratio = contrast(resolve(theme, p.fg), resolve(theme, p.bg));
          expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(p.min);
        });
      }
    });
  }

  it('contrast helper matches known WCAG values', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
  });
});
