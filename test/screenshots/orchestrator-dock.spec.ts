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
        await shot(page.locator('.ct-kanban-dispatch'), `orchestrator-dock-${name}-${label}.png`);
      });
    }
  }

  test('board with the idle dock in context @ 1280x800', async ({ page }) => {
    await open(page, 'attention', DESKTOP);
    await shot(page, 'orchestrator-dock-board-1280x800.png');
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

  test('first run: dashed "No portfolio orchestrator yet" + Set up… creates it, then focuses the field', async ({ page }) => {
    await open(page, 'first-run', DESKTOP);
    await expect(page.locator('.ct-orch-reason')).toHaveText('No portfolio orchestrator yet');
    await expect(page.locator('.ct-orch-input')).toHaveCount(0);
    await page.getByRole('button', { name: 'Set up…' }).click();
    await expect(page.locator('.ct-orch-input')).toBeFocused();
    expect(await page.evaluate(() => (window as any).__ensureOrchestratorCalls)).toEqual([false]);
    expect(await page.evaluate(() => (window as any).__openedThreadIds.length)).toBe(0);
  });

  test('Enter hands the message to the orchestrator and opens its thread (interim, P3 adds the sheet)', async ({ page }) => {
    await open(page, 'idle', DESKTOP);
    const input = page.locator('.ct-orch-input');
    await input.click();
    await input.fill('What needs me?');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__openedThreadIds.length)).toBe(1);
    const sent = await page.evaluate(() => (window as any).__sentMessages);
    expect(sent).toEqual([expect.objectContaining({ text: 'What needs me?' })]);
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

  test('narrow: tapping the orb opens the orchestrator thread (interim)', async ({ page }) => {
    await open(page, 'idle', NARROW);
    await page.locator('.ct-orch-orb').click();
    await expect.poll(() => page.evaluate(() => (window as any).__openedThreadIds.length)).toBe(1);
  });
});
