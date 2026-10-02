import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * Per-thread "Run in" (Container / Host / Default) section of the harness menu.
 *
 * States covered: the section for a Claude thread in each selected state, the
 * "Harness: Claude · <mode>" label on the parent menu row, the host <-> container
 * confirm prompt, a Codex thread (section absent) and a 390px mobile viewport.
 *
 * Note: the harness Menu mock (test/harness/obsidian-mock.ts) renders a flat
 * list and drops separators, so this checks content/geometry, not Obsidian's
 * native menu chrome.
 */
const harnessUrl = 'file://' + path.resolve('test/harness/index.html');
const THREAD = 'thread-fix-auth';

type Mode = 'always' | 'never' | undefined;

async function open(page: Page, width: number, height: number): Promise<void> {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  await page.setViewportSize({ width, height });
  await page.goto(harnessUrl);
  await page.waitForSelector('.ct-title-row');
  await page.waitForSelector('.ct-messages');
  await page.waitForTimeout(500);
  await page.evaluate((id) => (window as any).__view.focusThread(id), THREAD);
  await page.waitForTimeout(200);
}

async function setThread(page: Page, patch: { mode?: Mode; harness?: string; sessionId?: string }): Promise<void> {
  await page.evaluate(({ id, patch }) => {
    const t = (window as any).__manager.getThread(id);
    if (patch.mode === undefined) delete t.harnessVmMode; else t.harnessVmMode = patch.mode;
    if (patch.harness) t.agentHarness = patch.harness;
    if (patch.sessionId) t.sessionId = patch.sessionId;
  }, { id: THREAD, patch });
}

/** More menu -> "Harness: ..." row. Returns the text of the more-menu harness row. */
async function openHarnessMenu(page: Page): Promise<string> {
  await page.hover('.ct-floating-panel');
  await page.click('.ct-thread-more-btn');
  await page.waitForSelector('.menu');
  const row = page.locator('.menu .menu-item', { hasText: /^\s*Harness:/ });
  const label = (await row.textContent()) ?? '';
  await row.click();
  await page.waitForSelector('.menu .menu-item:has-text("Run in")');
  return label;
}

/** No menu row may be clipped or run past the viewport. */
async function expectMenuInsideViewport(page: Page): Promise<void> {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const menu = document.querySelector<HTMLElement>('.menu')!;
    const r = menu.getBoundingClientRect();
    if (r.left < 0 || r.right > window.innerWidth + 0.5) out.push(`menu x-range ${r.left}..${r.right} vs ${window.innerWidth}`);
    if (r.top < 0 || r.bottom > window.innerHeight + 0.5) out.push(`menu y-range ${r.top}..${r.bottom} vs ${window.innerHeight}`);
    for (const el of menu.querySelectorAll<HTMLElement>('.menu-item')) {
      if (el.scrollWidth > el.clientWidth + 1) out.push(`row clipped: ${el.textContent}`);
    }
    return out;
  });
  expect(problems, problems.join('; ')).toEqual([]);
}

test.describe('Harness menu: Run in', () => {
  const states: Array<{ name: string; mode: Mode; checked: string; headerLabel: RegExp }> = [
    { name: 'default', mode: undefined, checked: 'Default (follows settings)', headerLabel: /^Harness: Claude$/ },
    { name: 'container', mode: 'always', checked: 'Container', headerLabel: /Harness: Claude · Container$/ },
    { name: 'host', mode: 'never', checked: 'Host (no container)', headerLabel: /Harness: Claude · Host \(no container\)$/ },
  ];

  for (const s of states) {
    test(`claude thread with ${s.name} selected`, async ({ page }) => {
      await open(page, 420, 740);
      await setThread(page, { mode: s.mode });
      const label = await openHarnessMenu(page);
      expect(label.trim()).toMatch(s.headerLabel);
      const items = await page.locator('.menu .menu-item').allTextContents();
      expect(items.map((t) => t.replace(/^✓ /, ''))).toEqual(
        expect.arrayContaining(['Run in', 'Container', 'Host (no container)', 'Default (follows settings)']),
      );
      await expect(page.locator('.menu .menu-item.is-checked', { hasText: s.checked })).toHaveCount(1);
      await expect(page.locator('.menu .menu-item[aria-disabled="true"]', { hasText: 'Run in' })).toHaveCount(1);
      await expectMenuInsideViewport(page);
      await shot(page, `harness-run-in-${s.name}.png`, { fullPage: true });
    });
  }

  test('harness row shows the override in the more menu header label', async ({ page }) => {
    await open(page, 420, 740);
    await setThread(page, { mode: 'always' });
    await page.hover('.ct-floating-panel');
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await expect(page.locator('.menu .menu-item', { hasText: 'Harness: Claude · Container' })).toHaveCount(1);
    await shot(page, 'harness-run-in-header-label.png', { fullPage: true });
  });

  test('flipping container to host with a live session asks for confirmation', async ({ page }) => {
    await open(page, 420, 740);
    await setThread(page, { mode: 'always', sessionId: 'sess-1' });
    await openHarnessMenu(page);
    await page.locator('.menu .menu-item', { hasText: 'Host (no container)' }).click();
    const modal = page.locator('.modal-container');
    await expect(modal).toContainText('Run this thread on the host (no container)?');
    await expect(modal).toContainText('native Claude session resets');
    await shot(page, 'harness-run-in-confirm.png', { fullPage: true });
    await modal.getByRole('button', { name: 'Change' }).click();
    expect(await page.evaluate((id) => (window as any).__manager.getThread(id).harnessVmMode, THREAD)).toBe('never');
  });

  test('declining the confirmation leaves the override unchanged', async ({ page }) => {
    await open(page, 420, 740);
    await setThread(page, { mode: 'always', sessionId: 'sess-1' });
    await openHarnessMenu(page);
    await page.locator('.menu .menu-item', { hasText: 'Host (no container)' }).click();
    await page.locator('.modal-container').getByRole('button', { name: /cancel/i }).click();
    expect(await page.evaluate((id) => (window as any).__manager.getThread(id).harnessVmMode, THREAD)).toBe('always');
  });

  test('default to container does not prompt (same containerized routing)', async ({ page }) => {
    await open(page, 420, 740);
    await setThread(page, { mode: undefined, sessionId: 'sess-1' });
    await openHarnessMenu(page);
    await page.locator('.menu .menu-item', { hasText: /^Container$/ }).click();
    await expect(page.locator('.modal-container')).toHaveCount(0);
    expect(await page.evaluate((id) => (window as any).__manager.getThread(id).harnessVmMode, THREAD)).toBe('always');
  });

  test('codex thread has no Run in section', async ({ page }) => {
    await open(page, 420, 740);
    await setThread(page, { harness: 'codex' });
    await page.hover('.ct-floating-panel');
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await page.locator('.menu .menu-item', { hasText: /^\s*Harness:/ }).click();
    await page.waitForSelector('.menu .menu-item');
    await expect(page.locator('.menu .menu-item', { hasText: 'Run in' })).toHaveCount(0);
    await expect(page.locator('.menu .menu-item', { hasText: 'Container' })).toHaveCount(0);
    await shot(page, 'harness-run-in-codex.png', { fullPage: true });
  });

  test('mobile 390px viewport keeps the section inside the screen', async ({ page }) => {
    await open(page, 390, 844);
    await setThread(page, { mode: 'never' });
    await openHarnessMenu(page);
    await expectMenuInsideViewport(page);
    await shot(page, 'harness-run-in-mobile-390.png', { fullPage: true });
  });
});
