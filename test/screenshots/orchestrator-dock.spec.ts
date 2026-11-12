import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * K2 OrchestratorDock P2 (dock shell in the Agent Board pill).
 * Served from test/harness/kanban.html; `?orch=` seeds the orchestrator fixture:
 *   first-run (default, no orchestrator), idle, attention, working, error, offline.
 * Screenshots are of the pill only (`.ct-kanban-dispatch`) at both widths; the
 * functional specs below carry no baselines.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');

/**
 * Playwright's default per-pixel colour tolerance (threshold 0.2) is wide enough to hide the orb tint change
 * rgb(224,108,117) -> rgb(157,76,82): the offline-390 baseline was stale yet passed (measured: 3213 differing
 * pixels at threshold 0, 3108 at 0.05, 2993 at 0.1, 0 at 0.2). The dock's whole point is colour state (orb tint,
 * dot, reason text), so its shots use a tight per-pixel threshold.
 */
const DOCK_SHOT = { threshold: 0.05 } as const;

// Same pin as ui.spec.ts: relative labels ("Xd ago") on the board shot otherwise drift with the wall clock
// (the board-in-context baseline failed at the tightened threshold for exactly that reason).
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
});

const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };

type Fixture = 'first-run' | 'idle' | 'attention' | 'working' | 'error' | 'offline';

async function open(page: Page, fixture: Fixture, size: { width: number; height: number }, extra = '') {
  await page.setViewportSize(size);
  const narrow = size.width < 640 ? '&narrow=1&mobile=1' : '';
  await page.goto(`${kanbanUrl}?orch=${fixture}${narrow}${extra}`);
  await page.waitForSelector('.ct-kanban-dispatch .ct-orch-dock');
}

test.describe('orchestrator dock — screenshots', () => {
  const sizes = [
    { label: '1280x800', size: DESKTOP },
    { label: '390x844', size: NARROW },
  ];
  const states: Array<{ fixture: Fixture; name: string }> = [
    { fixture: 'idle', name: 'idle' },
    { fixture: 'attention', name: 'attention' },
    { fixture: 'first-run', name: 'first-run' },
    { fixture: 'error', name: 'error' },
    { fixture: 'offline', name: 'offline' },
  ];
  for (const { label, size } of sizes) {
    for (const { fixture, name } of states) {
      test(`dock pill — ${name} @ ${label}`, async ({ page }) => {
        await open(page, fixture, size);
        await expect(page.locator('.ct-orch-dock')).toHaveAttribute('data-state', fixture === 'first-run' ? 'none' : fixture);
        await shot(page.locator('.ct-kanban-dispatch'), `orchestrator-dock-${name}-${label}.png`, DOCK_SHOT);
      });
    }
  }

  test('board with the idle dock in context @ 1280x800', async ({ page }) => {
    await open(page, 'attention', DESKTOP);
    await shot(page, 'orchestrator-dock-board-1280x800.png', DOCK_SHOT);
  });
});

test.describe('orchestrator dock — functional (no baselines)', () => {
  test('the Ask field is the FIRST element of the pill meta row; New thread, group-by and search remain', async ({ page }) => {
    await open(page, 'idle', DESKTOP);
    const meta = page.locator('.ct-kanban-dispatch .ct-agents-panel-meta');
    await expect(meta.locator('> *').first()).toHaveClass(/ct-orch-dock/);
    await expect(page.getByRole('button', { name: 'New thread' })).toBeVisible();
    await expect(page.locator('.ct-kanban-groupby')).toBeVisible();
    await expect(page.locator('.ct-agents-search-btn')).toBeVisible();
  });

  test('the pill is 640px wide on a wide board and no taller than before at rest', async ({ page }) => {
    await open(page, 'idle', DESKTOP);
    const box = await page.locator('.ct-kanban-dispatch').boundingBox();
    expect(Math.round(box!.width)).toBe(640);
    expect(box!.height).toBeLessThan(60);
  });

  test('the dot tooltip carries the running / total / needs-you text', async ({ page }) => {
    await open(page, 'attention', DESKTOP);
    const dot = page.getByTestId('orchestrator-dot');
    await expect(dot).toHaveAttribute('title', /^\d+ running · \d+ total · \d+ needs? you$/);
    await expect(dot).toHaveClass(/ct-orch-dot-attention/);
  });

  test('working: the orb ring spins while a thread runs', async ({ page }) => {
    await open(page, 'working', DESKTOP);
    await expect(page.locator('.ct-orch-orb')).toHaveClass(/ct-orch-orb-spinning/);
  });

  test('first run: dashed "No orchestrator yet" + Set up… creates it, then focuses the field', async ({ page }) => {
    await open(page, 'first-run', DESKTOP);
    await expect(page.locator('.ct-orch-reason')).toHaveText('No orchestrator yet');
    await expect(page.locator('.ct-orch-input')).toHaveCount(0);
    await page.getByRole('button', { name: 'Set up…' }).click();
    await expect(page.locator('.ct-orch-input')).toBeFocused();
    expect(await page.evaluate(() => (window as any).__ensureOrchestratorCalls)).toEqual([false]);
    expect(await page.evaluate(() => (window as any).__openedThreadIds.length)).toBe(0);
  });

  test('Enter sends to the orchestrator and opens the reply sheet, not the thread (P3)', async ({ page }) => {
    await open(page, 'idle', DESKTOP);
    const input = page.locator('.ct-orch-input');
    await input.click();
    await input.fill('What needs me?');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ct-orch-sheet')).toBeVisible();
    const sent = await page.evaluate(() => (window as any).__sentMessages);
    expect(sent).toEqual([expect.objectContaining({ text: 'What needs me?' })]);
    expect(await page.evaluate(() => (window as any).__openedThreadIds.length)).toBe(0);
  });

  test('Shift+Enter inserts a newline and sends nothing', async ({ page }) => {
    await open(page, 'idle', DESKTOP);
    const input = page.locator('.ct-orch-input');
    await input.click();
    await page.keyboard.type('line one');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line two');
    await expect(input).toHaveValue('line one\nline two');
    expect(await page.evaluate(() => (window as any).__sentMessages.length)).toBe(0);
  });

  test('error and offline: the field is replaced by the reason', async ({ page }) => {
    await open(page, 'error', DESKTOP);
    await expect(page.locator('.ct-orch-reason')).toContainText('Orchestrator errored');
    await expect(page.locator('.ct-orch-input')).toHaveCount(0);
    await open(page, 'offline', DESKTOP);
    await expect(page.locator('.ct-orch-reason')).toHaveText('Orchestrator stopped — daemon disconnected');
    await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  });

  test('narrow: under 640px the pill collapses to orb + New thread; wide restores the field', async ({ page }) => {
    await open(page, 'idle', NARROW);
    await expect(page.locator('.ct-orch-dock')).toHaveAttribute('data-mode', 'orb');
    await expect(page.locator('.ct-orch-input')).toBeHidden();
    await expect(page.locator('.ct-orch-orb')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New thread' })).toBeVisible();
    const orb = await page.locator('.ct-orch-orb').boundingBox();
    expect(orb!.width).toBeGreaterThanOrEqual(44);
    expect(orb!.height).toBeGreaterThanOrEqual(44);
    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.locator('.ct-orch-dock')).toHaveAttribute('data-mode', 'pill');
    await expect(page.locator('.ct-orch-input')).toBeVisible();
  });

  for (const width of [320, 375, 390]) {
    test(`narrow @ ${width}px: the pill meta row stays on ONE line and inside the pill`, async ({ page }) => {
      await open(page, 'idle', { width, height: 844 });
      const rects = await page.evaluate(() => {
        const pill = document.querySelector('.ct-kanban-dispatch')!.getBoundingClientRect();
        const kids = [...document.querySelectorAll('.ct-kanban-dispatch .ct-agents-panel-meta button, .ct-kanban-dispatch .ct-orch-dot')]
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => el.getBoundingClientRect());
        return { left: pill.left, right: pill.right, kids: kids.map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })) };
      });
      const tops = rects.kids.map((r) => Math.round((r.top + r.bottom) / 2));
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(10);
      for (const r of rects.kids) { expect(r.left).toBeGreaterThanOrEqual(rects.left - 1); expect(r.right).toBeLessThanOrEqual(rects.right + 1); }
    });
  }

  test('D1: a long error/offline reason is fully visible in the 640px pill (wraps, never ellipsised) and the board still clears the pill', async ({ page }) => {
    for (const fixture of ['offline', 'error'] as const) {
      await open(page, fixture, DESKTOP);
      const reason = page.locator('.ct-orch-reason');
      const m = await reason.evaluate((el) => ({ over: el.scrollWidth > el.clientWidth + 1, clipped: getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth }));
      expect(m.over, fixture).toBe(false);
      await expect(reason).toHaveAttribute('title', /.+/);
      const pill = await page.locator('.ct-kanban-dispatch').boundingBox();
      const pad = await page.locator('.ct-kanban-board').first().evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
      expect(pad, fixture).toBeGreaterThanOrEqual(pill!.height + 36);
    }
  });

  for (const width of [390, 320]) {
    for (const fixture of ['first-run', 'error', 'offline'] as const) {
      test(`D2: narrow @ ${width}px ${fixture}: a full-width status row above the orb row with a 44px action`, async ({ page }) => {
        await open(page, fixture, { width, height: 844 });
        const row = page.locator('.ct-orch-status');
        await expect(row).toBeVisible();
        const pill = await page.locator('.ct-kanban-dispatch').boundingBox();
        const rowBox = await row.boundingBox();
        const orb = await page.locator('.ct-orch-orb').boundingBox();
        expect(rowBox!.y + rowBox!.height).toBeLessThanOrEqual(orb!.y + 1);
        expect(rowBox!.width).toBeGreaterThan(pill!.width - 24);
        const action = await row.locator('.ct-orch-action').boundingBox();
        expect(action!.height).toBeGreaterThanOrEqual(44);
        await expect(page.locator('.ct-orch-orb')).toHaveClass(/ct-orch-orb-alert/);
        await expect(page.locator('.ct-orch-orb')).not.toHaveClass(/ct-orch-orb-spinning/);
      });
    }
    test(`D2: narrow @ ${width}px idle keeps only the compact orb + New row`, async ({ page }) => {
      await open(page, 'idle', { width, height: 844 });
      await expect(page.locator('.ct-orch-status')).toBeHidden();
    });
  }

  test('D2: narrow screenshots of the status row (first-run, offline) @ 390x844', async ({ page }) => {
    await open(page, 'first-run', NARROW);
    await shot(page.locator('.ct-kanban-dispatch'), 'orchestrator-dock-status-first-run-390x844.png', DOCK_SHOT);
    await open(page, 'offline', NARROW);
    await shot(page.locator('.ct-kanban-dispatch'), 'orchestrator-dock-status-offline-390x844.png', DOCK_SHOT);
  });

  for (const width of [320, 375, 390]) {
    test(`D3: no overflow in the pill at ${width}px (meta row and every button inside the pill)`, async ({ page }) => {
      for (const fixture of ['idle', 'offline'] as const) {
        await open(page, fixture, { width, height: 844 });
        const r = await page.evaluate(() => {
          const pill = document.querySelector('.ct-kanban-dispatch') as HTMLElement;
          const meta = pill.querySelector('.ct-agents-panel-meta') as HTMLElement;
          const pr = pill.getBoundingClientRect();
          const out = [...pill.querySelectorAll('button')].filter((b) => (b as HTMLElement).offsetParent).map((b) => b.getBoundingClientRect().right - pr.right);
          return { metaOverflow: meta.scrollWidth - meta.clientWidth, maxRightOver: Math.max(...out) };
        });
        expect(r.metaOverflow, `${fixture} meta`).toBeLessThanOrEqual(0);
        expect(r.maxRightOver, `${fixture} buttons`).toBeLessThanOrEqual(0);
      }
    });
  }

  test('D6: a long draft never half-clips a line (max height is a whole number of lines plus padding)', async ({ page }) => {
    await open(page, 'idle', DESKTOP);
    const input = page.locator('.ct-orch-input');
    await input.fill(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'));
    await input.evaluate((el) => el.dispatchEvent(new Event('input')));
    const m = await input.evaluate((el) => { const cs = getComputedStyle(el); return { h: el.clientHeight, lh: parseFloat(cs.lineHeight), pad: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) }; });
    expect((m.h - m.pad) % m.lh).toBe(0);
  });

  test('D7: the placeholder uses --text-muted (readable on the dark pill)', async ({ page }) => {
    await open(page, 'idle', DESKTOP);
    const same = await page.evaluate(() => {
      const input = document.querySelector('.ct-orch-input') as HTMLElement;
      const probe = document.createElement('span');
      probe.style.color = 'var(--text-muted)';
      document.body.appendChild(probe);
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(input, '::placeholder').color === expected;
    });
    expect(same).toBe(true);
  });

  async function tabTo(page: Page, selector: string) {
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)) return;
    }
    throw new Error(`Tab never reached ${selector}`);
  }

  test('a11y: keyboard focus on the orb (orb mode) and on Set up… (pill) shows a visible outline', async ({ page }) => {
    await open(page, 'idle', NARROW);
    await tabTo(page, '.ct-orch-orb');
    let o = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement!); return { style: cs.outlineStyle, width: cs.outlineWidth }; });
    expect(o.style).not.toBe('none');
    expect(parseFloat(o.width)).toBeGreaterThanOrEqual(2);
    await open(page, 'first-run', DESKTOP);
    await tabTo(page, '.ct-orch-action');
    o = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement!); return { style: cs.outlineStyle, width: cs.outlineWidth }; });
    expect(o.style).not.toBe('none');
    expect(parseFloat(o.width)).toBeGreaterThanOrEqual(2);
  });

  test('a11y: in pill mode the orb is not a tab stop', async ({ page }) => {
    await open(page, 'idle', DESKTOP);
    await expect(page.locator('.ct-orch-orb')).toHaveAttribute('tabindex', '-1');
  });

  test('prefers-reduced-motion: the spinning ring has no animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, 'working', DESKTOP);
    await expect(page.locator('.ct-orch-orb')).toHaveClass(/ct-orch-orb-spinning/);
    expect(await page.locator('.ct-orch-orb-ring').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page, 'working', DESKTOP);
    expect(await page.locator('.ct-orch-orb-ring').evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none');
  });

  for (const fixture of ['error', 'offline'] as const) {
    test(`board bottom padding clears the pill at 320px (${fixture}, long reason)`, async ({ page }) => {
      await open(page, fixture, { width: 320, height: 844 });
      const pill = await page.locator('.ct-kanban-dispatch').boundingBox();
      const pad = await page.locator('.ct-kanban-board').first().evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
      expect(pad).toBeGreaterThanOrEqual(pill!.height + 36);
    });
  }

  test('N1: at 640x800 a 160-char error wraps and the board still clears the (taller) pill', async ({ page }) => {
    await open(page, 'error', { width: 640, height: 800 }, '&errlong=1');
    const pill = await page.locator('.ct-kanban-dispatch').boundingBox();
    const pad = await page.locator('.ct-kanban-board').first().evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    expect(pill!.height).toBeGreaterThan(62);
    expect(pad).toBeGreaterThanOrEqual(pill!.height + 36);
  });

  test('N1: at 320 a long error in the status row clears too', async ({ page }) => {
    await open(page, 'error', { width: 320, height: 844 }, '&errlong=1');
    const pill = await page.locator('.ct-kanban-dispatch').boundingBox();
    const pad = await page.locator('.ct-kanban-board').first().evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
    expect(pad).toBeGreaterThanOrEqual(pill!.height + 36);
  });

  test('N4: first run at 640 shows the whole label (no ellipsis)', async ({ page }) => {
    await open(page, 'first-run', { width: 640, height: 800 });
    const r = await page.locator('.ct-orch-reason').evaluate((el) => ({ over: el.scrollWidth > el.clientWidth + 1, text: el.textContent }));
    expect(r.text).toBe('No orchestrator yet');
    expect(r.over).toBe(false);
  });

  for (const size of [{ width: 1280, height: 800, extra: '' }, { width: 700, height: 800, extra: '&mobile=1' }]) {
    test(`D6: a full 4-line draft shows exactly 4 whole lines, no padding sliver (${size.width}px)`, async ({ page }) => {
      await open(page, 'idle', size, size.extra);
      const input = page.locator('.ct-orch-input');
      await input.fill(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'));
      await input.evaluate((el) => el.dispatchEvent(new Event('input')));
      const m = await input.evaluate((el) => { const cs = getComputedStyle(el); return { h: el.clientHeight, lh: parseFloat(cs.lineHeight), pt: parseFloat(cs.paddingTop), pb: parseFloat(cs.paddingBottom) }; });
      // Scrolled content shows through padding, so a clean clip needs ZERO vertical padding on the scroller.
      expect(m.pt).toBe(0);
      expect(m.pb).toBe(0);
      expect(m.h).toBe(m.lh * 4);
    });
  }

  test('N2: the glyph on the tinted orb has >= 3:1 contrast on both the error and the first-run tint', async ({ page }) => {
    const ratio = async (fixture: Fixture) => {
      await open(page, fixture, NARROW);
      return page.evaluate(() => {
        const parse = (c: string): number[] => {
          const nums = (c.match(/-?[\d.]+/g) ?? []).map(Number);
          return c.startsWith('color(') ? nums.slice(-3).map((n) => n * 255) : nums.slice(0, 3);
        };
        const lum = ([r, g, b]: number[]) => { const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const core = document.querySelector('.ct-orch-orb-core') as HTMLElement;
        const bg = parse(getComputedStyle(core).backgroundColor);
        const fg = parse(getComputedStyle(core).color);
        const [hi, lo] = [lum(bg), lum(fg)].sort((a, b) => b - a);
        return (hi + 0.05) / (lo + 0.05);
      });
    };
    expect(await ratio('error')).toBeGreaterThanOrEqual(3);
    expect(await ratio('first-run')).toBeGreaterThanOrEqual(3);
  });

  test('narrow: tapping the orb opens the bottom sheet (P3), not the thread', async ({ page }) => {
    await open(page, 'idle', NARROW);
    await page.locator('.ct-orch-orb').click();
    await expect(page.locator('.ct-orch-sheet')).toBeVisible();
    expect(await page.evaluate(() => (window as any).__openedThreadIds.length)).toBe(0);
  });
});
