import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * K2 OrchestratorDock P2 visual baselines (dock shell in the Agent Board pill).
 * Non-pixel functional/geometry specs live in `test/browser/orchestrator-dock.spec.ts`.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
const DOCK_SHOT = { threshold: 0.05 } as const;

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

  test('D2: narrow screenshots of the status row (first-run, offline) @ 390x844', async ({ page }) => {
    await open(page, 'first-run', NARROW);
    await shot(page.locator('.ct-kanban-dispatch'), 'orchestrator-dock-status-first-run-390x844.png', DOCK_SHOT);
    await open(page, 'offline', NARROW);
    await shot(page.locator('.ct-kanban-dispatch'), 'orchestrator-dock-status-offline-390x844.png', DOCK_SHOT);
  });
});
