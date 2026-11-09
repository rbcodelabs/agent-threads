/**
 * orchestrator-dock-reduced-motion.test.ts
 *
 * K2 P5 audit: every animation / transition / smooth scroll that touches the OrchestratorDock must honour
 * prefers-reduced-motion. Reads styles.css as text (no browser): each rule that is not already confined to
 * `prefers-reduced-motion: no-preference` and that animates a dock selector needs a `reduce` rule with the same
 * selector that switches it off. The Playwright spec (orchestrator-dock-mobile.spec.ts) checks the computed result.
 * Also pins that pinch-zoom is never disabled by a dock rule.
 *
 * LIMITS (read before trusting a green run): the CSS walker is regex-grade, not a parser; it understands top-level rules and ONE
 * level of @media; only selectors containing a DOCK_SELECTOR class are audited (a motion rule on a generic selector such as
 * `button` that reaches the dock is NOT seen here); `animation` / `transition` shorthands are matched textually. The
 * Playwright spec orchestrator-dock-mobile.spec.ts (computed styles under emulated reduced motion) is the real guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

interface Rule { selectors: string[]; body: string; media: string | null }

/** Minimal CSS walker: top-level rules and one level of @media; @keyframes bodies are skipped. */
function parseRules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const walk = (text: string, media: string | null): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      i = j;
      if (head.startsWith('@keyframes') || head.startsWith('@-webkit-keyframes') || head.startsWith('@font-face')) continue;
      if (head.startsWith('@media')) { walk(body, head.replace(/^@media\s*/, '').trim()); continue; }
      if (head.startsWith('@')) continue;
      rules.push({ selectors: head.split(',').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean), body, media });
    }
  };
  walk(src, null);
  return rules;
}

const css = readFileSync('styles.css', 'utf8');
const rules = parseRules(css);

const DOCK_SELECTOR = /\.ct-orch-|\.ct-kanban-dispatch|ct-kanban-card-linked|\.ct-kanban-clearing/;
const MOTION_DECL = /(^|[;\s])(animation(-name|-duration)?|transition(-property|-duration)?)\s*:(?!\s*(none|0s)\b)[^;]+|scroll-behavior\s*:\s*smooth/;
const NEUTRALISES = /(animation(-name)?\s*:\s*none|transition(-property)?\s*:\s*none|transition-duration\s*:\s*0s|transition\s*:\s*none|scroll-behavior\s*:\s*auto)/;
/** [ids, classes/attributes/pseudo-classes, elements], compared as a single number (enough for the audit). */
function specificity(selector: string): number {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  const classes = (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const elements = (selector.replace(/[.#:[][^\s>+~.#:[]*/g, ' ').match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return ids * 10000 + classes * 100 + elements;
}
const isReduce = (m: string | null): boolean => !!m && /prefers-reduced-motion:\s*reduce/.test(m);
const isNoPref = (m: string | null): boolean => !!m && /prefers-reduced-motion:\s*no-preference/.test(m);

describe('reduced-motion audit of the dock stylesheet rules', () => {
  const animated = rules.flatMap((r) => r.selectors.filter((s) => DOCK_SELECTOR.test(s)).map((s) => ({ selector: s, rule: r })))
    .filter(({ rule }) => MOTION_DECL.test(rule.body) && !isReduce(rule.media) && !isNoPref(rule.media));

  it('finds the dock animations it is meant to audit (the audit is not vacuous)', () => {
    const names = animated.map((a) => a.selector).join('\n');
    expect(names).toContain('.ct-orch-orb-spinning .ct-orch-orb-ring');
    expect(names).toContain('.ct-orch-activity-spin');
    expect(names).toContain('.ct-orch-bubble-streaming::after');
    expect(names).toContain('.ct-kanban-dispatch .ct-orch-peek');
    expect(names).toContain('.ct-kanban-dispatch');
  });

  it.each(animated.map((a) => [a.selector, a] as const))('%s has a prefers-reduced-motion: reduce override', (selector) => {
    const covered = rules.some((r) => isReduce(r.media) && r.selectors.includes(selector) && NEUTRALISES.test(r.body));
    expect(covered, `${selector} animates but no "@media (prefers-reduced-motion: reduce)" rule with this selector turns it off`).toBe(true);
  });

  it.each(animated.map((a) => [a.selector, a] as const))('%s: its reduce override comes AFTER the base rule in source order', (selector) => {
    const baseAt = Math.max(...rules.map((r, i) => (!isReduce(r.media) && !isNoPref(r.media) && r.selectors.includes(selector) && MOTION_DECL.test(r.body) ? i : -1)));
    const reduceAt = rules.map((r, i) => (isReduce(r.media) && r.selectors.includes(selector) && NEUTRALISES.test(r.body) ? i : -1)).filter((i) => i >= 0);
    expect(reduceAt.length).toBeGreaterThan(0);
    expect(Math.min(...reduceAt), `${selector}: a reduce rule before its base rule loses the cascade`).toBeGreaterThan(baseAt);
    // (The override is matched by the SAME selector text, so its specificity equals the base rule's by construction.)
  });

  it('specificity() orders ids > classes > elements', () => {
    expect(specificity('#a')).toBeGreaterThan(specificity('.a.b.c'));
    expect(specificity('.a .b')).toBeGreaterThan(specificity('.a'));
    expect(specificity('.a')).toBeGreaterThan(specificity('div span'));
  });

  it('a base rule that is already unconditionally `animation: none` is not treated as animated (no redundant override needed)', () => {
    expect(animated.map((a) => a.selector)).not.toContain('.ct-orch-orb-alert .ct-orch-orb-ring');
    const reduceOverrides = rules.filter((r) => isReduce(r.media) && r.selectors.includes('.ct-orch-orb-alert .ct-orch-orb-ring'));
    expect(reduceOverrides).toEqual([]);
  });

  it('D4: the highlighted board card has its own reduce override for the board-wide card transition', () => {
    const cardTransition = rules.some((r) => r.selectors.includes('.ct-kanban-card') && /transition\s*:/.test(r.body) && !isReduce(r.media));
    expect(cardTransition, 'precondition: the board card transitions border/shadow').toBe(true);
    const override = rules.some((r) => isReduce(r.media) && r.selectors.some((x) => x.includes('ct-kanban-card-linked')) && NEUTRALISES.test(r.body));
    expect(override).toBe(true);
  });

  it('no dock rule animates anything on state classes only for no-preference without a base rule leaking motion', () => {
    // The card flash is the one rule that exists ONLY under no-preference: it must not also appear outside it.
    const flashOutside = rules.filter((r) => !isNoPref(r.media) && r.selectors.some((s) => s.includes('ct-kanban-card-linked-flash')) && /animation/.test(r.body));
    expect(flashOutside).toEqual([]);
  });

  it('no dock rule uses smooth scrolling in CSS, and none disables pinch-zoom', () => {
    const dockRules = rules.filter((r) => r.selectors.some((s) => DOCK_SELECTOR.test(s)));
    for (const r of dockRules) {
      expect(r.body, r.selectors.join(', ')).not.toMatch(/scroll-behavior\s*:\s*smooth/);
      expect(r.body, r.selectors.join(', ')).not.toMatch(/touch-action\s*:\s*none/);
      expect(r.body, r.selectors.join(', ')).not.toMatch(/user-scalable/);
    }
  });
});

describe('reduced-motion audit of the dock sources', () => {
  const files = readdirSync('src').filter((f) => /^(orchestratorDock.*|dock.*|KanbanView)\.ts$/.test(f));

  it('every programmatic smooth scroll is gated by the reduced-motion flag', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(`src/${f}`, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/behavior\s*:\s*['"]smooth['"]|['"]smooth['"]\s*:/.test(line) && !/behavior:\s*reduced/.test(line)) return;
        const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        if (!/reduced|smooth\b.*&&|smooth &&/.test(window) && !/\bsmooth\b\s*&&/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the host/dock code that animates scroll reads prefers-reduced-motion', () => {
    const kanban = readFileSync('src/KanbanView.ts', 'utf8');
    expect(kanban).toMatch(/prefers-reduced-motion:\s*reduce/);
    const dom = readFileSync('src/dockCardScrollDom.ts', 'utf8');
    expect(dom).toMatch(/reduced/);
  });

  it('the transcript scroller never opts into smooth scrolling in code', () => {
    const sheet = readFileSync('src/orchestratorDockSheet.ts', 'utf8');
    expect(sheet).not.toMatch(/behavior\s*:\s*['"]smooth['"]/);
    expect(sheet).not.toMatch(/scrollIntoView|scrollTo\(/);
  });
});
