import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { shot } from './helpers';

/**
 * K2 OrchestratorDock P3 visual baselines (the reply sheet).
 * Non-pixel functional/scroll specs live in `test/browser/orchestrator-dock-sheet.spec.ts`.
 */
const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  await page.route(/^https?:\/\//, (route) => route.abort('blockedbyclient'));
});

const DESKTOP = { width: 1280, height: 800 };
const NARROW = { width: 390, height: 844 };
const DOCK_SHOT = { threshold: 0.05 } as const;
const SIZES = [{ label: '1280x800', size: DESKTOP }, { label: '390x844', size: NARROW }];

async function open(page: Page, orch: string, tx: string, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  const narrow = size.width < 640 ? '&narrow=1&mobile=1' : '';
  await page.goto(`${kanbanUrl}?orch=${orch}&tx=${tx}${narrow}`);
  await page.waitForSelector('.ct-kanban-dispatch .ct-orch-dock');
}
const sheet = (page: Page) => page.locator('.ct-orch-sheet');
const field = (page: Page) => page.locator('.ct-orch-input');
const isNarrow = (size: { width: number }) => size.width < 640;
async function focusComposer(page: Page, size: { width: number }) {
  if (isNarrow(size)) await page.locator('.ct-orch-orb').click(); else await field(page).click();
}

async function setLight(page: Page) {
  await page.evaluate(() => {
    document.body.classList.remove('theme-dark');
    document.body.classList.add('theme-light');
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries({
      '--background-primary': '#ffffff', '--background-secondary': '#f3f4f6', '--background-secondary-alt': '#eceef1',
      '--background-modifier-border': '#d4d7dd', '--background-modifier-hover': 'rgba(0,0,0,0.05)',
      '--text-normal': '#222226', '--text-muted': '#5c5c64', '--text-faint': '#85858e',
    })) root.setProperty(k, v);
  });
}

const STREAM_MARKDOWN = [
  'Here is the plan so far:', '',
  '- first item with a [[thread:k-hiptrip-awaiting|link]]', '- second item with **bold**', '',
  '| Thread | State |', '|---|---|', '| Deploy | waiting |', '| Mobile | question |', '',
  '```', 'npm run deploy -- --env=production',
].join('\n');

test.describe('orchestrator sheet — step 3 states (shared message renderer)', () => {
  for (const theme of ['dark', 'light'] as const) {
    for (const { label, size } of SIZES) {
      test(`rich transcript: tool groups, thumbnails, notice, divider, markdown @ ${theme} ${label}`, async ({ page }) => {
        await open(page, 'idle', 'transcript', size);
        if (theme === 'light') await setLight(page);
        await focusComposer(page, size);
        await expect(sheet(page)).toBeVisible();
        await expect(page.locator('.ct-notice-row[data-role="notice"]')).toBeVisible();
        await expect(page.locator('.ct-tool-group-header').first()).toBeVisible();
        await page.locator('.ct-orch-sheet-log').evaluate(async (el) => {
          await Promise.all(
            Array.from(el.querySelectorAll('img')).map((img) =>
              img.complete
                ? null
                : new Promise<void>((resolve) => {
                    img.addEventListener('load', () => resolve(), { once: true });
                    img.addEventListener('error', () => resolve(), { once: true });
                  }),
            ),
          );
        });
        await expect.poll(() =>
          page.locator('.ct-orch-sheet-scroll').evaluate((el) => {
            el.scrollTop = el.scrollHeight;
            return el.scrollHeight - el.clientHeight - el.scrollTop;
          }),
        ).toBeLessThanOrEqual(1);
        await shot(page, `orchestrator-sheet-transcript-${theme}-${label}.png`, DOCK_SHOT);
      });

      test(`multi-block markdown while streaming (list, table, open code block) @ ${theme} ${label}`, async ({ page }) => {
        await open(page, 'working', 'conversation', size);
        if (theme === 'light') await setLight(page);
        await page.evaluate((text) => (window as any).__orchStream(text, 'Reading 14 threads…'), STREAM_MARKDOWN);
        await focusComposer(page, size);
        await expect(sheet(page)).toBeVisible();
        await expect(page.locator('[data-streaming] table')).toBeVisible();
        await expect(page.locator('[data-streaming] pre')).toBeVisible();
        await shot(page, `orchestrator-sheet-streaming-markdown-${theme}-${label}.png`, DOCK_SHOT);
      });
    }
  }

  for (const { label, size } of SIZES) {
    test(`a long thread shows the last 50 messages and a "Showing last 50 messages" row @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'long', size);
      await focusComposer(page, size);
      await expect(sheet(page)).toBeVisible();
      await expect(page.locator('.ct-orch-sheet-log > [data-role]')).toHaveCount(50);
      await page.locator('.ct-orch-sheet-scroll').evaluate((el) => { el.scrollTop = 0; });
      await expect(page.locator('.ct-orch-older')).toBeVisible();
      await shot(page, `orchestrator-sheet-older-${label}.png`, DOCK_SHOT);
    });
  }
});

test.describe('orchestrator sheet — screenshots', () => {
  for (const { label, size } of SIZES) {
    test(`focused, empty transcript: suggestion chips @ ${label}`, async ({ page }) => {
      await open(page, 'attention', 'empty', size);
      if (isNarrow(size)) await page.locator('.ct-orch-orb').click(); else await field(page).focus();
      await expect(page.locator(isNarrow(size) ? '.ct-orch-sheet .ct-orch-empty button' : '.ct-orch-chips button').first()).toBeVisible();
      await shot(page, `orchestrator-sheet-chips-${label}.png`, DOCK_SHOT);
    });

    test(`streaming reply with activity line and Stop @ ${label}`, async ({ page }) => {
      await open(page, 'working', 'conversation', size);
      await page.evaluate(() => (window as any).__orchStream('Two things are waiting on you:', 'Reading 14 threads · checking pending approvals…'));
      await focusComposer(page, size);
      await expect(sheet(page)).toBeVisible();
      await expect(page.locator('.ct-orch-stop')).toBeVisible();
      await shot(page, `orchestrator-sheet-streaming-${label}.png`, DOCK_SHOT);
    });

    test(`conversation with thread links and a waiting-to-send list @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await page.evaluate(() => (window as any).__orchQueue('ship it after the plan'));
      await focusComposer(page, size);
      await expect(page.locator('.ct-orch-sheet a.internal-link[data-href^="thread:"]').first()).toBeVisible();
      await expect(page.locator('.ct-orch-waiting')).toBeVisible();
      await shot(page, `orchestrator-sheet-conversation-${label}.png`, DOCK_SHOT);
    });

    test(`unread reply: peek above the pill and the dot @ ${label}`, async ({ page }) => {
      await open(page, 'idle', 'conversation', size);
      await page.evaluate(() => (window as any).__orchSay('Deploy approval and 1 mobile question need you.'));
      await expect(page.locator('.ct-orch-peek')).toBeVisible();
      await shot(page, `orchestrator-sheet-unread-${label}.png`, DOCK_SHOT);
    });

    test(`offline with the sheet open: reason + action, input disabled @ ${label}`, async ({ page }) => {
      await open(page, 'offline', 'conversation', size);
      await page.evaluate(() => (window as any).__openSheet());
      await expect(sheet(page)).toBeVisible();
      await expect(page.locator('.ct-orch-reason').first()).toBeVisible();
      await shot(page, `orchestrator-sheet-offline-${label}.png`, DOCK_SHOT);
    });
  }
});
