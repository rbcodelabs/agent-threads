import { test, expect } from '@playwright/test';
import path from 'path';
import { anchorFocusedComposerToBottom, shot } from './helpers';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

for (const theme of ['dark', 'light']) {
  test(`agent list selection remains visible with low-contrast ${theme} theme`, async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
    await page.goto('file://' + path.resolve('test/harness/kanban.html') + '?dashboard=1');
    await page.waitForSelector('.ct-agents-row');
    await page.evaluate((theme) => {
      const app = document.querySelector<HTMLElement>('#app')!;
      app.style.width = '320px';
      app.style.height = '700px';
      // Some host themes omit this token; others make it indistinguishable
      // from the normal background. Selection must remain recognizable.
      document.body.style.setProperty('--background-modifier-active-hover', 'transparent');
      if (theme === 'light') {
        document.body.style.setProperty('--background-primary', '#f6f5f0');
        document.body.style.setProperty('--background-secondary', '#eeede8');
        document.body.style.setProperty('--text-normal', '#303030');
        document.body.style.setProperty('--text-muted', '#666');
        document.body.style.setProperty('--interactive-accent', '#b7791f');
      }
      const dashboard = (window as any).__dashboard;
      const ids = [...dashboard.rowEls.keys()];
      dashboard.setActiveRow(ids[1]);
      dashboard.setActiveRow(ids[0]);
    }, theme);
    await expect(page.locator('.ct-agents-row-active')).toHaveCount(1);
    await page.locator('.ct-agents-row-active').hover();
    await shot(page.locator('#app'), `agent-list-selected-${theme}.png`);
  });
}

test.describe('Agent Threads UI', () => {
  // Pin Date.now()/new Date() to the fixture epoch (test/harness/fixtures.ts)
  // so relative labels ("5m ago", "Last active …") and same-day timestamp
  // rendering are deterministic — without this, baselines with "Xd ago" text
  // drift every midnight and timestamp prefixes depend on the run date.
  // setFixedTime fakes only the clock; real timers keep running.
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  });

  test('thread rename supports repeated edits, cancellation, and empty names', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${harnessUrl}?document`);
    await page.waitForSelector('.ct-messages');
    const input = page.getByRole('textbox', { name: 'Thread name', exact: true });
    await page.getByRole('button', { name: 'Rename thread', exact: true }).click();
    await expect(input).toHaveValue('Fix auth middleware');
    await shot(page.locator('#app').locator('..'), 'rename-thread.png');
    await input.fill('Cancelled before first edit');
    await input.press('Escape');
    expect(await page.evaluate(() => (window as any).__manager.getThread((window as any).__view.getActiveThreadId()).titleUserSet)).toBeFalsy();
    await page.locator('.view-header-title').dblclick();
    await input.fill('First name');
    const saves = await page.evaluate(() => (window as any).__saveSettingsCalls ?? 0);
    await input.press('Enter');
    await expect(page.locator('.view-header-title')).toHaveText('First name');
    expect(await page.evaluate(() => (window as any).__saveSettingsCalls)).toBe(saves + 1);
    await page.locator('.view-header-title').dblclick();
    await expect(input).toHaveValue('First name');
    await input.fill('Cancelled name');
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(page.locator('.view-header-title')).toHaveText('First name');
    await page.locator('.view-header-title').dblclick();
    await input.fill('   ');
    await input.press('Enter');
    await expect(input).toBeVisible();
    await input.fill('  Second name  ');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.locator('.view-header-title')).toHaveText('Second name');
    await page.evaluate(() => (window as any).__setDocumentPane(false));
    await page.locator('.ct-title-btn').dblclick();
    await expect(input).toHaveValue('Second name');
    await input.fill('Third name');
    await input.press('Enter');
    await page.locator('.ct-title-btn').dblclick();
    await expect(input).toHaveValue('Third name');
    await input.press('Escape');
  });

  test('thread rename fits a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${harnessUrl}?mobile`);
    await page.waitForSelector('.ct-messages');
    await page.locator('.ct-title-btn').click();
    await page.getByRole('button', { name: 'Rename current thread' }).click();
    const input = page.getByRole('textbox', { name: 'Thread name', exact: true });
    await expect(input).toBeVisible();
    const bounds = await input.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await shot(page.locator('.modal-overlay'), 'rename-thread-mobile.png');
    await input.fill('Mobile thread name');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.locator('.ct-title-text').first()).toHaveText('Mobile thread name');
  });

  test('document pane uses the native header and adapts when moved to a sidebar', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${harnessUrl}?document`);
    await page.waitForSelector('.ct-messages');

    await expect(page.locator('.view-header')).toBeVisible();
    await expect(page.locator('.view-header-title')).toHaveText('Fix auth middleware');
    await expect(page.locator('.ct-title-row')).toBeHidden();
    await expect(page.locator('.view-action[aria-label^="Switch thread"]')).toHaveCount(1);
    await expect(page.locator('.view-action[aria-label="New thread"]')).toHaveCount(1);
    await expect(page.locator('.view-action[aria-label="Close thread"]')).toHaveCount(1);
    await expect(page.locator('.view-action[aria-label="Manager notes"]')).toBeHidden();

    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await expect(page.locator('.view-header-title')).toHaveText('HipTrip feature ideas');

    await page.evaluate(() => {
      const view = (window as any).__view;
      const manager = (window as any).__manager;
      manager.getThread(view.getActiveThreadId()).ephemeral = true;
      (window as any).__setThreadRunning('thread-agentic', true);
      view.renderTitleBar();
    });
    await expect(page.locator('.view-action[aria-label="Switch thread — ephemeral thread, background thread running"]')).toBeVisible();

    await page.locator('.view-action[aria-label^="Switch thread"]').click();
    await expect(page.locator('.ct-switcher-panel')).toBeVisible();
    await expect(page.locator('.ct-switcher-rename-btn')).toBeVisible();
    await expect(page.locator('.ct-switcher-panel')).toHaveClass(/ct-switcher-panel-native/);
    await page.locator('.ct-switcher-rename-btn').click();
    const renameInput = page.getByRole('textbox', { name: 'Thread name', exact: true });
    await expect(renameInput).toHaveValue('HipTrip feature ideas');
    await renameInput.fill('HipTrip roadmap workshop');
    await renameInput.press('Enter');
    await expect(page.locator('.view-header-title')).toHaveText('HipTrip roadmap workshop');

    await page.evaluate(() => {
      const view = (window as any).__view;
      const manager = (window as any).__manager;
      manager.getThread(view.getActiveThreadId()).managerNotes = 'Prioritize the native header QA.';
      view.renderThreadInfo();
    });
    await expect(page.locator('.view-action[aria-label="Manager notes"]')).toBeVisible();

    await expect(page.locator('.ct-switcher-panel')).toHaveCount(0);

    await page.locator('#app').evaluate((element) => {
      element.style.width = '1200px';
      element.style.height = '760px';
    });
    await shot(page.locator('#app'), 'document-pane.png');

    await page.evaluate(() => {
      const view = (window as any).__view;
      const manager = (window as any).__manager;
      (window as any).__setThreadRunning('thread-agentic', false);
      for (const thread of manager.getThreads()) {
        if (thread.id !== view.getActiveThreadId()) manager.deleteThread(thread.id);
      }
    });
    await expect(page.locator('.view-action[aria-label="Close thread"]')).toBeHidden();

    await page.evaluate(() => (window as any).__setDocumentPane(false));
    await expect(page.locator('.view-header')).toBeHidden();
    await expect(page.locator('.ct-title-row')).toBeVisible();

    await page.evaluate(() => (window as any).__setDocumentPane(true));
    await expect(page.locator('.view-header')).toBeVisible();
    await expect(page.locator('.ct-title-row')).toBeHidden();
    await expect(page.locator('.view-action[aria-label^="Switch thread"]')).toHaveCount(1);
  });

  test('closing the switcher before deferred outside-listener setup leaves no stale handler', async ({ page }) => {
    await page.goto(`${harnessUrl}?document`);
    await page.waitForSelector('.ct-messages');
    const switchAction = page.locator('.view-action[aria-label="Switch thread"]');
    await switchAction.click();
    await switchAction.click();
    await page.waitForTimeout(20);

    const state = await page.evaluate(() => ({
      panel: (window as any).__view.switcherPanelEl,
      timer: (window as any).__view.switcherOutsideTimer,
      handler: (window as any).__view.switcherOutsideHandler,
    }));
    expect(state).toEqual({ panel: null, timer: null, handler: null });
  });

  test('mobile keeps the custom conversation title even when a host header is visible', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${harnessUrl}?document&mobile`);
    await page.waitForSelector('.ct-messages');

    await expect(page.locator('.view-header')).toBeVisible();
    await expect(page.locator('.ct-title-row')).toBeVisible();
    await expect(page.locator('.view-action[aria-label="Switch thread"]')).toBeHidden();
  });

  test('closed conversation view ignores later workspace layout changes', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => (window as any).__closeView());
    await page.evaluate(() => (window as any).__setDocumentPane(true));
    await page.waitForTimeout(50);

    await expect(page.locator('.ct-title-row')).toBeVisible();
  });

  // Guards the harness icon map on every state this spec renders, not just the
  // one the dedicated test below drives. setIcon() in
  // test/harness/obsidian-mock.ts records any name it cannot resolve on
  // window.__ctMissingIcons and draws a magenta marker, so an unmapped icon
  // fails the run instead of silently baking a placeholder into a baseline the
  // way the old grey-circle fallback did. Checking here rather than in a single
  // test matters: `cloud-off` on the AWS status tag was missing from the map
  // while a main-view-only assertion passed clean.
  test.afterEach(async ({ page }) => {
    const missing = await page
      .evaluate(() => (window as any).__ctMissingIcons as string[] | undefined)
      // The page is already gone when a test closes it itself; nothing to check.
      .catch(() => undefined);
    expect(
      missing ?? [],
      `Harness has no Lucide glyph for: ${(missing ?? []).join(', ')}. ` +
        'If the name is referenced dynamically, add it to EXTRA_ICONS in ' +
        'scripts/gen-harness-icons.mts; otherwise fix the caller in src/.',
    ).toEqual([]);
  });

  test('main view', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the HipTrip thread which shows a markdown table (use API since tabs were removed)
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.waitForTimeout(200);
    await shot(page, 'main-view.png', { fullPage: true });
  });

  // Guards the harness icon map. setIcon() in test/harness/obsidian-mock.ts
  // records any name it cannot resolve on window.__ctMissingIcons and draws a
  // magenta marker, so an unmapped icon fails here instead of silently baking
  // a placeholder into a baseline the way the old grey-circle fallback did.
  test('every icon the UI renders resolves to a real Lucide glyph', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Cycle the fixture threads so the tool cards, task cards and status
    // footers that own most of the icon surface all get rendered at least once.
    const threadIds: string[] = await page.evaluate(
      () => (window as any).__manager.getThreads().map((t: { id: string }) => t.id),
    );
    expect(threadIds.length).toBeGreaterThan(0);
    for (const id of threadIds) {
      await page.evaluate((threadId) => (window as any).__view.focusThread(threadId), id);
      await page.waitForTimeout(100);
    }

    const missing = await page.evaluate(() => (window as any).__ctMissingIcons as string[] | undefined);
    expect(
      missing ?? [],
      `Harness has no Lucide glyph for: ${(missing ?? []).join(', ')}. ` +
        'If the name is referenced dynamically, add it to EXTRA_ICONS in ' +
        'scripts/gen-harness-icons.mts; otherwise fix the caller in src/.',
    ).toEqual([]);
  });

  test('wide conversation pane centers the complete readable timeline', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.locator('#app').evaluate((element) => {
      element.style.width = '1200px';
      element.style.height = '760px';
    });
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-agentic'));

    const layout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector)!;
        const bounds = element.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, width: bounds.width };
      };
      const messages = document.querySelector('.ct-messages')!;
      const composerWrapper = document.querySelector('.ct-panel-wrapper')!;
      const popover = document.createElement('div');
      popover.className = 'ct-agent-popover';
      composerWrapper.appendChild(popover);
      const popoverBounds = popover.getBoundingClientRect();
      popover.remove();
      return {
        messages: rect('.ct-messages'),
        assistant: rect('.ct-message-assistant'),
        user: rect('.ct-message-user'),
        toolCard: rect('.ct-message-assistant .ct-tools'),
        header: rect('.ct-title-row'),
        composerWrapper: rect('.ct-panel-wrapper'),
        composerPanel: rect('.ct-floating-panel'),
        composerPopover: {
          left: popoverBounds.left,
          right: popoverBounds.right,
          width: popoverBounds.width,
        },
        hasOverflow: messages.scrollWidth > messages.clientWidth,
        documentHasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

    expect(layout.assistant.width).toBeLessThanOrEqual(900);
    expect(layout.user.width).toBe(layout.assistant.width);
    expect(layout.assistant.left - layout.messages.left)
      .toBeCloseTo(layout.messages.right - layout.assistant.right, 0);
    expect(layout.toolCard.left).toBeGreaterThanOrEqual(layout.assistant.left);
    expect(layout.toolCard.right).toBeLessThanOrEqual(layout.assistant.right);
    expect(layout.header.width).toBeGreaterThan(layout.assistant.width);
    expect(layout.composerPanel.width).toBeCloseTo(layout.assistant.width, 0);
    expect(layout.composerPanel.left).toBeCloseTo(layout.assistant.left, 0);
    expect(layout.composerPanel.right).toBeCloseTo(layout.assistant.right, 0);
    expect(layout.composerWrapper.left).toBeCloseTo(layout.composerPanel.left, 0);
    expect(layout.composerWrapper.right).toBeCloseTo(layout.composerPanel.right, 0);
    expect(layout.composerPopover.left).toBeCloseTo(layout.composerPanel.left, 0);
    expect(layout.composerPopover.right).toBeCloseTo(layout.composerPanel.right, 0);
    expect(layout.hasOverflow).toBe(false);
    expect(layout.documentHasOverflow).toBe(false);
    await shot(page.locator('#app'), 'conversation-readable-wide.png');
  });

  test('narrow conversation pane keeps the timeline full width without overflow', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto(harnessUrl);
    await page.locator('#app').evaluate((element) => {
      element.style.width = '760px';
      element.style.height = '760px';
    });
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-notice'));

    const layout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const bounds = document.querySelector(selector)!.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, width: bounds.width };
      };
      const messages = document.querySelector('.ct-messages')!;
      const contentWidth = messages.clientWidth
        - parseFloat(getComputedStyle(messages).paddingLeft)
        - parseFloat(getComputedStyle(messages).paddingRight);
      const messageWidths = Array.from(messages.querySelectorAll(':scope > .ct-message'))
        .map((element) => (element as HTMLElement).getBoundingClientRect().width);
      const notice = messages.querySelector('.ct-notice-row')!.getBoundingClientRect();
      const message = messages.querySelector('.ct-message')!.getBoundingClientRect();
      return {
        contentWidth,
        messageWidths,
        noticeInsideTimeline: notice.left >= message.left && notice.right <= message.right,
        noticeIsCentered: Math.abs((notice.left - message.left) - (message.right - notice.right)) < 1,
        messages: rect('.ct-messages'),
        composerWrapper: rect('.ct-panel-wrapper'),
        composerPanel: rect('.ct-floating-panel'),
        hasOverflow: messages.scrollWidth > messages.clientWidth,
        documentHasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

    expect(layout.messageWidths.length).toBeGreaterThan(0);
    for (const width of layout.messageWidths) expect(width).toBeCloseTo(layout.contentWidth, 0);
    expect(layout.noticeInsideTimeline).toBe(true);
    expect(layout.noticeIsCentered).toBe(true);
    expect(layout.composerWrapper.width).toBeCloseTo(layout.messages.width, 0);
    expect(layout.composerPanel.left - layout.composerWrapper.left).toBeCloseTo(10, 0);
    expect(layout.composerWrapper.right - layout.composerPanel.right).toBeCloseTo(10, 0);
    expect(layout.hasOverflow).toBe(false);
    expect(layout.documentHasOverflow).toBe(false);
    await shot(page.locator('#app'), 'conversation-readable-narrow.png');
  });

  test('conversation timeline and composer activate together near the readable-width boundary', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(harnessUrl);
    await page.locator('#app').evaluate((element) => {
      element.style.width = '925px';
      element.style.height = '760px';
    });
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-agentic'));

    const layout = await page.evaluate(() => {
      const rect = (selector: string) => {
        const bounds = document.querySelector(selector)!.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, width: bounds.width };
      };
      const messages = document.querySelector('.ct-messages')!;
      return {
        assistant: rect('.ct-message-assistant'),
        composer: rect('.ct-floating-panel'),
        hasOverflow: messages.scrollWidth > messages.clientWidth,
        documentHasOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

    expect(layout.assistant.width).toBeCloseTo(900, 0);
    expect(layout.composer.width).toBeCloseTo(layout.assistant.width, 0);
    expect(layout.composer.left).toBeCloseTo(layout.assistant.left, 0);
    expect(layout.composer.right).toBeCloseTo(layout.assistant.right, 0);
    expect(layout.hasOverflow).toBe(false);
    expect(layout.documentHasOverflow).toBe(false);
  });

  test('set latest message as goal context menu', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));

    const userMessages = page.locator('.ct-message-user');
    await expect(userMessages).toHaveCount(3);

    // Restored older rows preserve the host/browser menu; only the latest
    // canonical text-bearing user row opens the plugin action.
    await userMessages.first().click({ button: 'right' });
    await expect(page.locator('.menu')).toHaveCount(0);
    await userMessages.last().click({ button: 'right' });
    await expect(page.locator('.menu .menu-item')).toHaveText('Set as goal');
    await shot(page, 'set-as-goal-context-menu.png', { fullPage: true });
  });

  test('set as goal revalidates an open menu and retains the originating thread across save', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));

    const latest = page.locator('.ct-message-user').last();
    await latest.click({ button: 'right' });
    await page.evaluate(() => (window as any).__addLiveUserMessage('thread-fix-auth', 'live-newer', 'Canonical live goal'));
    await page.locator('.menu .menu-item').click();
    await expect.poll(() => page.evaluate(() => (window as any).__goalKickoffs.length)).toBe(0);

    // The live row gets the same menu binding. Delay persistence, switch
    // threads, then release: the action must still target thread-fix-auth.
    await page.locator('.ct-message-user').last().click({ button: 'right' });
    await page.evaluate(() => (window as any).__blockNextSave());
    await page.locator('.menu .menu-item').click();
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.evaluate(() => (window as any).__releaseNextSave());

    await expect.poll(() => page.evaluate(() => (window as any).__goalKickoffs.length)).toBe(1);
    const result = await page.evaluate(() => ({
      kickoff: (window as any).__goalKickoffs[0],
      goal: (window as any).__manager.getThread('thread-fix-auth').goal,
    }));
    expect(result.goal).toBe('Canonical live goal');
    expect(result.kickoff.threadId).toBe('thread-fix-auth');
    expect(result.kickoff.message).toContain('Canonical live goal');
  });

  test('set as goal rolls back when persistence fails and surfaces the error', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await page.evaluate(() => (window as any).__failNextSave('disk full'));

    await page.locator('.ct-message-user').last().click({ button: 'right' });
    await page.locator('.menu .menu-item').click();

    await expect(page.locator('.ct-error')).toContainText('Failed to set goal: disk full');
    const result = await page.evaluate(() => ({
      goal: (window as any).__manager.getThread('thread-fix-auth').goal,
      kickoffs: (window as any).__goalKickoffs.length,
    }));
    expect(result.goal).toBeUndefined();
    expect(result.kickoffs).toBe(0);
  });

  // Seeds a two-agent team on the auth thread and opens it. Everything after this
  // is driven through real DOM (clicking the pill, clicking a row) rather than
  // calling private render methods, so these tests exercise the same path a user
  // does and would catch the pill silently going invisible.
  const seedAgentTeam = () => {
    const view = (window as any).__view;
    const manager = view.manager;
    const threadId = 'thread-fix-auth';
    const store = manager.agentRuns;
    store.observeStart({ threadId, harness: 'claude', nativeAgentId: 'agent-review', description: 'Review authentication flow', role: 'reviewer', model: 'claude-sonnet-4-5' }, Date.now() - 65000);
    store.observeStart({ threadId, harness: 'claude', nativeAgentId: 'agent-tests', parentNativeAgentId: 'agent-review', description: 'Inspect regression tests', role: 'test engineer' }, Date.now() - 35000);
    store.observeActivity(threadId, 'claude', 'agent-review', { kind: 'tool', text: 'Reading auth middleware', toolName: 'Read', timestamp: Date.now() - 4000 });
    store.observeActivity(threadId, 'claude', 'agent-tests', { kind: 'activity', text: 'Running targeted tests', timestamp: Date.now() - 2000 });
    view.focusThread(threadId);
  };

  test('native agent workspace', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(seedAgentTeam);

    // The pill must be visible at rest — no hover — while agents are running.
    const pill = page.locator('.ct-agent-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText('2 agents working');
    // The conversation is still the conversation: no inline agent panel above it.
    await expect(page.locator('.ct-messages .ct-message').first()).toBeVisible();

    await page.click('.ct-agent-pill');
    await page.waitForSelector('.ct-agent-popover');
    await expect(pill).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.ct-agent-popover [role="treeitem"]')).toHaveCount(2);
    await expect(page.locator('.ct-agent-popover [role="treeitem"]').nth(1)).toHaveAttribute('aria-level', '2');
    await shot(page.locator('.ct-agent-popover'), 'native-agent-popover.png');

    // Escape dismisses and returns focus to the pill.
    await page.keyboard.press('Escape');
    await expect(page.locator('.ct-agent-popover')).toHaveCount(0);
    await expect(pill).toHaveAttribute('aria-expanded', 'false');
  });

  test('agent activity view replaces the conversation and the breadcrumb returns', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(seedAgentTeam);

    await page.click('.ct-agent-pill');
    await page.click('.ct-agent-popover [role="treeitem"]:nth-child(2) .ct-agent-row-button');

    // Selecting closes the popover and takes over the message pane.
    await expect(page.locator('.ct-agent-popover')).toHaveCount(0);
    await page.waitForSelector('.ct-agent-view-header');
    await expect(page.locator('.ct-messages .ct-message')).toHaveCount(0);
    await expect(page.locator('.ct-agent-crumb-current')).toHaveText('test engineer');
    await expect(page.locator('.ct-agent-crumbs .ct-agent-crumb')).toHaveCount(3);
    await expect(page.locator('.ct-agent-timeline .ct-agent-event')).toHaveCount(2);
    // The composer stays live; only the placeholder flags where a send will land.
    await expect(page.locator('.ct-input')).toBeEnabled();
    await expect(page.locator('.ct-input')).toHaveAttribute('placeholder', 'Message Claude (main conversation)');
    await shot(page.locator('.ct-main'), 'native-agent-activity-view.png');

    // The breadcrumb goes back to real conversation messages, not an empty pane.
    await page.click('.ct-agent-crumbs button:has-text("Main conversation")');
    await expect(page.locator('.ct-agent-view-header')).toHaveCount(0);
    await expect(page.locator('.ct-messages .ct-message').first()).toBeVisible();
    await expect(page.locator('.ct-input')).toHaveAttribute('placeholder', 'Message Claude');
    // The pill survives the round trip.
    await expect(page.locator('.ct-agent-pill')).toBeVisible();
  });

  test('agent pill disappears and the footer returns to hover-only with no agents', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    // thread-fix-auth is seeded with no agent runs in this test.
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await expect(page.locator('.ct-agent-pill')).toHaveClass(/ct-hidden/);
    // The harness autofocuses the composer, which intentionally pins the
    // hover-only footer open via :focus-within. Move to the actual rest state
    // before asserting that the agent pill no longer pins it independently.
    await page.locator('.ct-input').blur();
    // With the pill hidden the :has() pin stops matching, so the footer collapses.
    await expect.poll(() => page.locator('.ct-input-footer').evaluate(
      (el) => getComputedStyle(el).maxHeight,
    )).toBe('0px');
  });

  for (const viewport of [
    { name: 'iphone-14', width: 390, height: 844 },
    { name: 'iphone-se', width: 375, height: 667 },
  ]) {
    test(`native agent workspace mobile layout (${viewport.width}x${viewport.height})`, async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(harnessUrl + '?mobile=1');
      await page.waitForSelector('.ct-title-row');
      await page.evaluate(seedAgentTeam);
      await page.evaluate(() => {
        // AgentDashboard is not mounted by this harness, so render its real
        // interactive class to verify the shared mobile tap-target contract.
        const dashboardButton = document.createElement('button');
        dashboardButton.className = 'ct-dashboard-agent';
        dashboardButton.textContent = 'Test engineer';
        document.querySelector('.ct-root')!.appendChild(dashboardButton);
      });

      await expect(page.locator('.ct-agent-pill')).toBeVisible();
      await expect(page.locator('.ct-agent-pill')).toHaveCSS('min-height', '44px');
      await page.click('.ct-agent-pill');
      await page.waitForSelector('.ct-agent-popover');

      await expect(page.locator('.ct-agent-row-button').first()).toHaveCSS('min-height', '44px');
      await expect(page.locator('.ct-dashboard-agent')).toHaveCSS('min-height', '44px');
      const hasHorizontalOverflow = await page.locator('.ct-agent-popover').evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      );
      expect(hasHorizontalOverflow).toBe(false);
      await shot(page.locator('.ct-agent-popover'), `native-agent-popover-${viewport.name}.png`);
    });
  }

  test('wikilink rendering in assistant message', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the thread whose assistant message contains [[wikilinks]]
    await page.evaluate(() => (window as any).__view.focusThread('thread-wikilinks'));
    await page.waitForTimeout(200);
    // Wikilinks should render as <a> tags, not as raw [[...]] text
    const rawBrackets = await page.locator('.ct-messages').innerText();
    if (rawBrackets.includes('[[')) {
      throw new Error('[[wikilinks]] were not rendered — raw bracket text found in message');
    }
    await shot(page, 'wikilink-rendering.png', { fullPage: true });
  });

  test('assistant list items keep wrapped text and nested lists indented under host resets', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.addStyleTag({
      content: `
        ol, ul {
          margin: 0;
          padding-inline-start: 0;
          list-style-position: inside;
        }
      `,
    });
    await page.evaluate(() => {
      const thread = (window as any).__manager.getThread('thread-wikilinks');
      thread.messages[1].content = `1. Ordered items keep every wrapped continuation aligned with the first line of text even when the host theme removes its list spacing entirely.
2. A second ordered item confirms the browser is rendering a real ordered list.

- Unordered items keep every wrapped continuation aligned with the first line of text even when the host theme removes its list spacing entirely.
  - Nested items remain visibly indented from their parent list item.`;
      (window as any).__view.focusThread('thread-wikilinks');
    });

    const geometry = await page.locator('.ct-message-assistant .ct-message-content').evaluate((content) => {
      const directTextLineLefts = (item: Element) => {
        const text = Array.from(item.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
        if (!text) throw new Error('Expected list item to contain a direct text node');
        const range = document.createRange();
        range.selectNodeContents(text);
        return Array.from(range.getClientRects()).map((rect) => rect.left);
      };

      const ordered = content.querySelector(':scope > ol > li')!;
      const unordered = content.querySelector(':scope > ul > li')!;
      const nested = unordered.querySelector(':scope > ul > li')!;
      return {
        ordered: directTextLineLefts(ordered),
        unordered: directTextLineLefts(unordered),
        nested: directTextLineLefts(nested),
      };
    });

    expect(geometry.ordered.length).toBeGreaterThan(1);
    expect(geometry.unordered.length).toBeGreaterThan(1);
    expect(geometry.ordered[1]).toBeCloseTo(geometry.ordered[0], 0);
    expect(geometry.unordered[1]).toBeCloseTo(geometry.unordered[0], 0);
    expect(geometry.nested[0] - geometry.unordered[0]).toBeGreaterThan(12);
  });

  test('conversation-first routes ordinary Markdown vault links to the companion and leaves protocols alone', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(async () => {
      const w = window as any;
      w.__setConversationFirst(true);
      await w.__view.focusThread('thread-brainstorm');
      w.__manager.getThread('thread-brainstorm').noteFile = 'Claude/thread.md';
      const host = document.createElement('div');
      host.id = 'standard-markdown-links';
      document.body.appendChild(host);
      await w.__view.renderMarkdown('[Roadmap](../Projects/Roadmap%20Q4.md#Decision) [External](https://example.com)', host);
    });

    await page.locator('#standard-markdown-links a').first().click();
    expect(await page.evaluate(() => (window as any).__contextLinkCalls)).toEqual([
      ['../Projects/Roadmap%20Q4.md#Decision', 'Claude/thread.md'],
    ]);
    await expect(page.locator('#standard-markdown-links a').nth(1)).toHaveAttribute('href', 'https://example.com');
  });

  test('inline visualization card', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-visualize'));

    // The marker must never survive as text in the bubble.
    await page.waitForSelector('.ct-visualize-card');
    const bubbleText = await page.locator('.ct-message-assistant .ct-message-content').innerText();
    if (bubbleText.includes('visualize')) {
      throw new Error('canonical visualize reference leaked into the message as raw text');
    }

    // The frame is the containment boundary: allow-scripts and nothing else.
    const frame = page.locator('.ct-visualize-frame');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');

    // The fragment is wrapped into a real document and actually renders.
    const inner = page.frameLocator('.ct-visualize-frame');
    await expect(inner.locator('#quarterly-revenue h2')).toHaveText('Quarterly revenue');
    await expect(inner.locator('.viz-stat-value').first()).toHaveText('$4.2M');

    // Auto-height. This fragment is shorter than the 320px starting height, so
    // the card must SHRINK to fit it. That direction is the load-bearing
    // assertion: document.documentElement has no explicit height, so its
    // scrollHeight is max(content, viewport) and would latch at whatever height
    // we last set — it can never report a value below the frame. Only a
    // document.body measurement can shrink.
    await expect
      .poll(async () => page.locator('.ct-visualize-body').evaluate((el) => el.clientHeight))
      .toBeLessThan(320);
    await expect
      .poll(async () => page.locator('.ct-visualize-body').evaluate((el) => el.clientHeight))
      .toBeGreaterThanOrEqual(180);
    await page.waitForTimeout(400);
    await shot(page, 'inline-visualization.png', { fullPage: true });
  });

  test('inline visualization follows the host theme, not the OS colour scheme', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');

    // Repaint the host as a light theme and re-render the thread. Inside a
    // sandboxed opaque origin, `color-scheme: light dark` resolves against the
    // OS rather than the app, so the document must instead carry literal
    // resolved values and an explicit data-theme.
    await page.evaluate(async () => {
      document.body.classList.remove('theme-dark');
      document.body.classList.add('theme-light');
      const root = document.documentElement.style;
      root.setProperty('--background-primary', 'rgb(255, 255, 255)');
      root.setProperty('--text-normal', 'rgb(34, 34, 34)');
      await (window as any).__view.focusThread('thread-visualize');
    });
    await page.waitForSelector('.ct-visualize-frame');

    const light = await page.locator('.ct-visualize-frame').getAttribute('srcdoc');
    expect(light).toContain('data-theme="light"');
    expect(light).toContain('--background:rgb(255, 255, 255)');
    expect(light).toContain('--foreground:rgb(34, 34, 34)');
    // No OS-resolved colour anywhere in the generated document.
    expect(light).not.toContain('color-scheme');
    expect(light).not.toContain('light-dark(');

    // Flip back to dark; the card must follow the host, not the OS.
    await page.evaluate(async () => {
      document.body.classList.remove('theme-light');
      document.body.classList.add('theme-dark');
      const root = document.documentElement.style;
      root.setProperty('--background-primary', 'rgb(30, 30, 30)');
      root.setProperty('--text-normal', 'rgb(220, 221, 222)');
      await (window as any).__view.focusThread('thread-fix-auth');
      await (window as any).__view.focusThread('thread-visualize');
    });
    await page.waitForSelector('.ct-visualize-frame');
    await expect
      .poll(async () => page.locator('.ct-visualize-frame').getAttribute('srcdoc'))
      .toContain('data-theme="dark"');
    const dark = await page.locator('.ct-visualize-frame').getAttribute('srcdoc');
    expect(dark).toContain('--background:rgb(30, 30, 30)');
  });

  test('visualization frames do not accumulate across thread switches or in the compressed view', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');

    const focus = (id: string) => page.evaluate((t) => (window as any).__view.focusThread(t), id);

    await focus('thread-visualize');
    await page.waitForSelector('.ct-visualize-frame');
    await expect(page.locator('.ct-visualize-frame')).toHaveCount(1);

    // renderMessages() empties and rebuilds every row on each thread switch.
    // Without a single view-level observer and per-card generation guards, each
    // round trip would leave another live frame behind.
    for (let i = 0; i < 4; i++) {
      await focus('thread-fix-auth');
      await focus('thread-visualize');
    }
    await page.waitForSelector('.ct-visualize-frame');
    await expect(page.locator('.ct-visualize-frame')).toHaveCount(1);
    await expect(page.locator('.ct-visualize-card')).toHaveCount(1);

    // The compressed view renders full content eagerly into a display:none
    // container. A frame must not mount there: it would parse a document, hit
    // the CDN, and report height 0 while invisible.
    await page.evaluate(() => (window as any).__view['toggleCompressView']());
    await page.waitForSelector('.ct-message-compressed');
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-full-content .ct-visualize-card')).toHaveCount(1);
    await expect(page.locator('.ct-visualize-frame')).toHaveCount(0);

    // A still-streaming message renders inert chrome only: mounting a frame per
    // token would rebuild the document on every throttled render pass.
    const streamingFrames = await page.evaluate(async () => {
      const view = (window as any).__view;
      const scratch = document.createElement('div');
      document.querySelector('.ct-messages')!.appendChild(scratch);
      await view['renderMarkdown'](
        'visualize{"path":"/Users/mock/viz/quarterly-revenue.html"}',
        scratch,
        { streaming: true },
      );
      return {
        cards: scratch.querySelectorAll('.ct-visualize-card').length,
        statics: scratch.querySelectorAll('.ct-visualize-card.ct-visualize-static').length,
        frames: scratch.querySelectorAll('iframe').length,
        popouts: scratch.querySelectorAll('.ct-visualize-action').length,
        leaked: scratch.textContent!.includes('visualize'),
      };
    });
    expect(streamingFrames).toEqual({ cards: 1, statics: 1, frames: 0, popouts: 0, leaked: false });

    // Expanding the row makes it visible, so the frame mounts on demand.
    // Dispatched rather than clicked: the hover-only copy button overlaps the
    // expand chevron in the harness and intercepts real pointer events.
    await page.locator('.ct-expand-btn').dispatchEvent('click');
    await page.waitForSelector('.ct-visualize-frame');
    await expect(page.locator('.ct-visualize-frame')).toHaveCount(1);
  });

  test('background task notice row', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the thread with persisted `notice` messages (completed + failed)
    await page.evaluate(() => (window as any).__view.focusThread('thread-notice'));
    await page.waitForSelector('.ct-notice-row');
    await page.waitForTimeout(200);
    await shot(page, 'background-task-notice-row.png', { fullPage: true });
  });

  test('slash command autocomplete', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.click('.ct-input');
    await page.type('.ct-input', '/bra');
    await page.waitForSelector('.ct-skill-dropdown');
    await shot(page, 'slash-commands.png', { fullPage: true });
  });

  for (const viewport of [
    { name: 'narrow', width: 420, height: 740 },
    { name: 'wide', width: 1000, height: 800 },
  ]) test(`design artifact toolbar actions (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => {
      const view = (window as any).__view;
      const thread = view.manager.getThread('thread-fix-auth');
      thread.artifacts = [{
        id: 'design-thread-fix-auth', kind: 'design-static', title: 'Responsive checkout concept',
        root: '/vault/.geode/artifacts/design-thread-fix-auth',
        manifestPath: '/vault/.geode/artifacts/design-thread-fix-auth/artifact.json',
        entryPath: '/vault/.geode/artifacts/design-thread-fix-auth/index.html',
        createdAt: 1, updatedAt: 1,
      }];
      view.syncEditedFiles();
    });
    // Expand through the panel's :focus-within path instead of hovering the
    // panel by coordinates. The latter can land on the focus-files chip after
    // small browser/font layout shifts and capture an incidental hover ring.
    await page.locator('.ct-input').focus();
    await page.waitForSelector('.ct-artifact-card:not(.ct-hidden)');
    await expect(page.getByRole('button', { name: 'Preview design' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Capture design screenshot' })).toHaveAttribute('title', 'Capture design screenshot');
    await expect(page.getByRole('button', { name: 'Reveal design source' })).toHaveAttribute('title', 'Reveal design source');
    await expect(page.locator('.ct-artifact-action-secondary')).toHaveCount(2);
    const layout = await page.locator('.ct-artifact-card').evaluate((toolbar) => ({
      toolbarOverflow: toolbar.scrollWidth > toolbar.clientWidth,
      documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    expect(layout.toolbarOverflow).toBe(false);
    expect(layout.documentOverflow).toBe(false);
    await shot(page, `design-artifact-toolbar-${viewport.name}.png`, { fullPage: true });
  });

  test('agent design entry refreshes controls and reuses the selected thread artifact', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    const entry = await page.evaluate(async () => {
      const first = await (window as any).__enterDesignMode('thread-fix-auth', 'Responsive checkout concept');
      const second = await (window as any).__enterDesignMode('thread-fix-auth', 'Revise checkout');
      return { created: first.created, reused: !second.created, preview: first.preview.status };
    });
    expect(entry).toEqual({ created: true, reused: true, preview: 'opened' });
    await page.locator('.ct-input').focus();
    await expect(page.getByRole('button', { name: 'Preview design' })).toBeVisible();
    await expect(page.locator('.ct-artifact-card')).toContainText('Responsive checkout concept');
    await expect(page.locator('.ct-artifact-card')).toHaveCount(1);
  });

  test('permission card', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Trigger the inline permission card (3-param: threadId, toolName, detail)
    page.evaluate(() => {
      (window as any).__view.manager.permissionHandler(
        'thread-fix-auth',
        'Write file',
        'src/components/TripCard.tsx',
      );
    });
    await page.waitForSelector('.ct-permission-card');
    await shot(page, 'permission-card.png', { fullPage: true });
  });

  test('permission card reappears after switching away and back', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => {
      (window as any).__view.manager.permissionHandler(
        'thread-fix-auth',
        'MCP: github',
        'Allow search_repositories?',
      );
    });
    await page.waitForSelector('.ct-permission-card');

    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await expect(page.locator('.ct-permission-card')).toHaveCount(0);

    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await expect(page.locator('.ct-permission-card')).toBeVisible();
    await expect(page.locator('.ct-permission-card')).toContainText('Allow search_repositories?');
  });

  test('MCP elicitation form card', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      (window as any).__view.renderElicitationFormCard(
        {
          mode: 'form',
          serverName: 'linear',
          message: 'Choose where this issue should be created.',
          requestedSchema: {
            type: 'object',
            properties: {
              project: { type: 'string', title: 'Project', description: 'The Linear project for this issue.' },
              priority: { type: 'string', title: 'Priority', enum: ['Low', 'Medium', 'High'] },
            },
          },
        },
        new AbortController().signal,
        () => {},
      );
    });
    await page.waitForSelector('.ct-elicitation-card');
    await shot(page, 'mcp-elicitation-form-card.png', { fullPage: true });
  });

  test('scheduled wake-up pill and popover', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await page.waitForTimeout(200);
    // Schedule a wake-up 4 minutes past the pinned clock (10:00:00Z) so the
    // countdown renders deterministically as "in 4m".
    await page.evaluate(() => {
      const fireAt = new Date('2026-01-15T10:04:00Z').getTime();
      (window as any).__setWakeup('thread-fix-auth', fireAt, 'check CI status');
    });
    const pill = page.locator('.ct-schedule-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('Resumes in 4m');
    await expect(page.getByText('Looping every 0s')).toHaveCount(0);
    await pill.click();
    await expect(page.locator('.ct-schedule-popover')).toBeVisible();
    await expect(page.locator('.ct-schedule-row')).toHaveCount(1);
    await expect(page.locator('.ct-schedule-row')).toContainText('One-time wakeup');
    await expect(page.locator('.ct-schedule-action')).toHaveText('Cancel');
    await page.clock.setFixedTime(new Date('2026-01-15T10:01:01Z'));
    await page.waitForTimeout(1_100);
    await expect(pill).toContainText('Resumes in 2m');
  });

  test('regression: scheduled pill remains accurate through run_state_settled without a thread switch', async ({ page }) => {
    // Drive the real ThreadManager → ThreadsView event path while a wakeup is
    // pending; the pill remains inspectable both during and after the run.
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await page.waitForTimeout(200);

    await page.evaluate(() => {
      const w = window as any;
      const threadId = 'thread-fix-auth';
      const fireAt = new Date('2026-01-15T10:04:00Z').getTime();
      // The thread is mid-turn (isRunning() true) when the wake-up is registered.
      w.__setThreadRunning(threadId, true);
      w.__setWakeup(threadId, fireAt, 'check CI status');
    });
    // Scheduled activity remains inspectable while the thread is running.
    await expect(page.locator('.ct-schedule-pill')).toBeVisible();

    await page.evaluate(() => (window as any).__setThreadRunning('thread-fix-auth', false));
    await expect(page.locator('.ct-schedule-pill')).toBeVisible();

    await page.evaluate(() => (window as any).__fireRunStateSettled('thread-fix-auth'));
    await expect(page.locator('.ct-schedule-pill')).toContainText('in 4m');
  });

  test('combined scheduled activity has one pill and item-specific controls', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await page.waitForTimeout(200);
    // Seed a loop targeting the active thread — mirrors what /loop 5m ... does.
    await page.evaluate(() => {
      (window as any).__setLoop('thread-fix-auth', 'check the build', 300);
      const fireAt = new Date('2026-01-15T10:04:00Z').getTime();
      (window as any).__setWakeup('thread-fix-auth', fireAt, 'check CI status');
      (window as any).__view.renderThreadInfo();
    });
    const pill = page.locator('.ct-schedule-pill');
    await expect(pill).toHaveCount(1);
    await expect(pill).toContainText('Resumes in 4m · +1');
    await pill.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.ct-schedule-row')).toHaveCount(2);
    await expect(page.locator('.ct-schedule-action')).toHaveText(['Cancel', 'Stop']);
    const stopAction = page.locator('.ct-schedule-action', { hasText: 'Stop' });
    await stopAction.focus();
    await page.waitForTimeout(1_100);
    await expect(stopAction).toBeFocused();
    await shot(page, 'scheduled-activity-combined.png', { fullPage: true });
    await stopAction.click();
    await expect(page.locator('.ct-schedule-row')).toHaveCount(1);
    await expect(page.locator('.ct-schedule-row')).toContainText('One-time wakeup');
    await expect(pill).toContainText('Resumes in 4m');
    await page.keyboard.press('Escape');
    await expect(page.locator('.ct-schedule-popover')).toHaveCount(0);
    await pill.click();
    await page.locator('.ct-messages').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.ct-schedule-popover')).toHaveCount(0);
    await pill.click();
    await page.locator('.ct-schedule-action', { hasText: 'Cancel' }).click();
    await expect(pill).toHaveClass(/ct-hidden/);
    await expect(page.locator('.ct-schedule-popover')).toHaveCount(0);
  });

  test('loop-only activity opens with Space and closes when switching threads', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => {
      (window as any).__setLoop('thread-fix-auth', 'check the build', 300);
      (window as any).__view.focusThread('thread-fix-auth');
    });
    const pill = page.locator('.ct-schedule-pill');
    await expect(pill).toContainText('Every 5m');
    await pill.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.ct-schedule-popover')).toBeVisible();
    await expect(page.locator('.ct-schedule-row-loop')).toContainText('Recurring loop');
    await expect(page.locator('.ct-schedule-action')).toHaveText('Stop');
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await expect(page.locator('.ct-schedule-popover')).toHaveCount(0);
  });

  test('timer tick reconciles a fired wakeup while preserving the remaining loop row', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => {
      (window as any).__setLoop('thread-fix-auth', 'check the build', 300);
      (window as any).__setWakeup('thread-fix-auth', Date.now() + 240_000, 'check CI status');
      (window as any).__view.focusThread('thread-fix-auth');
    });
    const pill = page.locator('.ct-schedule-pill');
    await pill.click();
    const stop = page.locator('.ct-schedule-action', { hasText: 'Stop' });
    await stop.focus();
    await page.evaluate(() => (window as any).__removeWakeupsSilently('thread-fix-auth'));
    await page.waitForTimeout(1_100);

    await expect(page.locator('.ct-schedule-row-wakeup')).toHaveCount(0);
    await expect(page.locator('.ct-schedule-row-loop')).toHaveCount(1);
    await expect(page.locator('.ct-schedule-action')).toHaveText('Stop');
    await expect(page.locator('.ct-schedule-action')).toBeFocused();
    await expect(pill).toContainText('Every 5m');
  });

  test('schedule deletion failure stays visible and reports the error', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => {
      (window as any).__setLoop('thread-fix-auth', 'check the build', 300);
      (window as any).__failNextScheduleDelete('disk full');
      (window as any).__view.focusThread('thread-fix-auth');
    });
    await page.locator('.ct-schedule-pill').click();
    await page.locator('.ct-schedule-action').click();
    await expect(page.locator('.ct-error')).toContainText('Loop stopped in this session, but persistence failed (disk full). It may return after reload.');
    await expect(page.locator('.ct-schedule-popover')).toHaveCount(0);
    await expect(page.locator('.ct-schedule-pill')).toHaveClass(/ct-hidden/);
  });

  for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
    test(`scheduled activity narrow layout (${viewport.width}x${viewport.height})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl + '?mobile=1');
      await page.waitForSelector('.ct-title-row');
      await page.evaluate(() => {
        const fireAt = new Date('2026-01-15T10:04:00Z').getTime();
        (window as any).__setWakeup('thread-fix-auth', fireAt, 'check CI status');
        (window as any).__view.focusThread('thread-fix-auth');
      });
      await page.locator('.ct-schedule-pill').click();
      await expect(page.locator('.ct-schedule-action')).toHaveCSS('min-height', '44px');
      const overflow = await page.locator('.ct-schedule-popover').evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(overflow).toBe(false);
    });
  }

  test('scheduled origin footer pill', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
    await page.waitForTimeout(200);
    // Seed the thread's origin metadata the same way Scheduler.createThread
    // does when a cron item fires and creates a new thread.
    await page.evaluate(() => {
      (window as any).__setScheduledOrigin('thread-fix-auth', 'sched-1', 'Nightly build check');
      (window as any).__setLoop('thread-fix-auth', 'check the build', 300);
      (window as any).__view.renderThreadInfo();
    });
    await page.waitForSelector('.ct-footer-pill');
    await expect(page.locator('.ct-footer-pill')).toContainText('Scheduled: Nightly build check');
    await expect(page.locator('.ct-schedule-pill')).toContainText('Every 5m');
    await shot(page, 'scheduled-origin-pill.png', { fullPage: true });
  });

  test('fork conversation menu item', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Open the more menu
    await page.hover('.ct-floating-panel');
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await shot(page, 'fork-menu.png', { fullPage: true });
  });

  test('composer menu exposes model and permission choices', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.hover('.ct-floating-panel');
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await expect(page.locator('.menu')).toContainText('Model: Default');
    await expect(page.locator('.menu')).toContainText('Permissions: Global default');
    await expect(page.locator('.ct-model-btn')).toHaveCount(0);
    await expect(page.locator('.ct-permission-mode-btn')).toHaveCount(0);
    // Move mouse away so no menu item is in hover state
    await page.mouse.move(0, 0);
    await shot(page, 'model-switcher-menu.png', { fullPage: true });
  });

  test('composer menu changes model and permission using existing selectors', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');

    await page.hover('.ct-floating-panel');
    await page.click('.ct-thread-more-btn');
    await page.getByText('Model: Default').click();
    await page.getByText('Sonnet', { exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__manager.getThread('thread-fix-auth').model)).toBe('sonnet');

    await page.hover('.ct-floating-panel');
    await page.click('.ct-thread-more-btn');
    await expect(page.locator('.menu')).toContainText('Model: Sonnet');
    await page.getByText('Permissions: Global default').click();
    await page.getByText('Plan only (read & propose, no execute)', { exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__manager.getThread('thread-fix-auth').permissionMode)).toBe('plan');
  });

  test('composer menu shows a temporary model escalation', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => (window as any).__view['escalatedTurnModels'].set('thread-fix-auth', 'opus'));
    await page.hover('.ct-floating-panel');
    await page.click('.ct-thread-more-btn');
    await expect(page.locator('.menu')).toContainText('Model: opus (this turn)');
  });

  test('unified context truncates without overlapping footer actions', async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.hover('.ct-floating-panel');
    await page.waitForTimeout(300);
    const bounds = await page.evaluate(() => {
      const context = document.querySelector('.ct-footer-context')!.getBoundingClientRect();
      const actions = document.querySelector('.ct-input-footer-actions')!.getBoundingClientRect();
      return { contextRight: context.right, actionsLeft: actions.left, footerWidth: document.querySelector('.ct-input-footer')!.scrollWidth };
    });
    expect(bounds.contextRight).toBeLessThanOrEqual(bounds.actionsLeft);
    expect(bounds.footerWidth).toBeLessThanOrEqual(280);
  });

  // Modal IS mocked in obsidian-mock.ts and renders .modal-container into document.body on open()
  test('fork conversation modal', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Open the more menu and click Fork
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await page.getByText('Fork conversation').click();
    await page.waitForSelector('.modal-container');
    await shot(page, 'fork-modal-initial.png', { fullPage: true });
  });

  // Modal IS mocked in obsidian-mock.ts and renders .modal-container into document.body on open()
  test('fork conversation modal after generation', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Open fork modal
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await page.getByText('Fork conversation').click();
    await page.waitForSelector('.modal-container');
    // Click generate
    await page.getByText('Generate fork prompt').click();
    // Wait for the textarea to appear (mock resolves instantly)
    await page.waitForSelector('.ct-fork-textarea', { state: 'visible' });
    await page.waitForTimeout(200);
    await shot(page, 'fork-modal-review.png', { fullPage: true });
  });

  test('edited files card with focus button', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    // Thread 1 (Fix auth middleware) has editedFiles seeded — wait for the card
    await page.waitForSelector('.ct-edited-files:not(.ct-hidden)');
    await page.waitForTimeout(500);
    // Hover to reveal the focus button (opacity: 0 normally, 1 on hover)
    await page.hover('.ct-edited-files');
    await page.waitForTimeout(200);
    await shot(page, 'edited-files-focus.png', { fullPage: true });
  });

  // ─── 0.3.0 feature tests ─────────────────────────────────────────────────────

  test('@ file mention autocomplete', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);

    // Patch the vault mock so getMarkdownFiles returns fake file objects.
    // The harness vault mock does not define getMarkdownFiles, so we add it here.
    await page.evaluate(() => {
      const view = (window as any).__view;
      view.app.vault.getMarkdownFiles = () => [
        { path: 'Projects/HipTrip.md', basename: 'HipTrip' },
        { path: 'Daily/2026-05-16.md', basename: '2026-05-16' },
        { path: 'Claude/repo-map.md', basename: 'repo-map' },
      ];
    });

    await page.click('.ct-input');
    await page.type('.ct-input', '@hip');
    await page.waitForSelector('.ct-file-dropdown');
    await shot(page, 'file-mention.png', { fullPage: true });
  });

  test('context recap banner', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);

    // Trigger the banner directly — bypasses the idle-threshold guard that
    // prevents it from showing when the user was "just here".
    // Thread at index 1 is thread-brainstorm; pass its summary or a fallback string.
    await page.evaluate(() => {
      const view = (window as any).__view;
      const thread = view.manager.getThreads()[1];
      view['showSummaryBanner'](
        thread,
        thread.summary || 'Brainstormed social features for HipTrip, explored gamification and collaborative trip planning options.',
      );
    });

    await page.waitForSelector('.ct-summary-banner');
    await shot(page, 'context-recap-banner.png', { fullPage: true });
  });

  test('active thread Project and cwd chrome converges after reassignment and deletion', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));

    const projectId = await page.evaluate(() => {
      const manager = (window as any).__manager;
      const project = manager.createProject('Live Project', 'Projects/Live', undefined, '/Users/mock/projects/live');
      manager.setThreadProject('thread-fix-auth', project.id);
      return project.id;
    });
    await expect(page.locator('.ct-project-indicator')).toHaveCount(0);
    await expect(page.locator('.ct-footer-context-name')).toHaveText('Live Project · hip-trip');
    await expect(page.locator('.ct-footer-context')).toHaveAttribute('aria-label', 'Project: Live Project. Working directory: /Users/mock/projects/hip-trip');

    await page.evaluate((id) => (window as any).__manager.updateProject(id, { name: 'Renamed Live Project' }), projectId);
    await expect(page.locator('.ct-footer-context-name')).toHaveText('Renamed Live Project · hip-trip');

    await page.evaluate((id) => (window as any).__manager.setThreadProject('thread-fix-auth', id, true), projectId);
    await expect(page.locator('.ct-footer-context-name')).toHaveText('Renamed Live Project · live');
    await expect(page.locator('.ct-footer-context')).toHaveAttribute('aria-label', 'Project: Renamed Live Project. Working directory: /Users/mock/projects/live');

    await page.evaluate((id) => (window as any).__manager.deleteProject(id), projectId);
    await expect(page.locator('.ct-footer-context-name')).toHaveText('live');
    await expect(page.locator('.ct-footer-context')).toHaveAttribute('aria-label', 'Working directory: /Users/mock/projects/live');
  });

  test('unified composer context opens project and working-directory details', async ({ page }) => {
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));

    await page.hover('.ct-floating-panel');
    await page.click('.ct-footer-context');
    await expect(page.locator('.menu')).toContainText('Working directory: /Users/mock/projects/hip-trip');
    await expect(page.locator('.menu')).toContainText('Project: No project');
    await expect(page.locator('.menu')).toContainText('Change project…');
  });

  // Agent Dashboard is not instantiated or exposed in the test harness (index.ts only
  // mounts ThreadsView). To un-skip: add AgentDashboard to the harness, expose it as
  // window.__dashboard, and wire up a permissionHandler call against a dashboard thread.
  test.skip('agent dashboard permission buttons — AgentDashboard not mounted in harness; add it to test/harness/index.ts and expose as window.__dashboard to un-skip', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(500);

    // Trigger a permission request on thread 1
    await page.evaluate(() => {
      (window as any).__view.manager.permissionHandler(
        'thread-fix-auth',
        'Write file',
        'src/components/TripCard.tsx',
      );
    });

    // Switch to the Agent Dashboard view
    await page.evaluate(() => {
      (window as any).__dashboard?.onOpen?.();
    });

    await page.waitForSelector('.ct-agents-permission-actions');
    await shot(page, 'dashboard-permission-buttons.png', { fullPage: true });
  });

  // Wake lock status bar is wired up in main.ts (WakeLockService + Obsidian status bar API).
  // Neither the real plugin lifecycle nor addStatusBarItem() is available in the harness.
  // Verify manually in Obsidian: enable Settings > Keep computer awake, start a response,
  // and confirm the "Keeping awake" item appears in the Obsidian status bar.
  test.skip('wake lock status bar — harness does not wire up the real plugin WakeLockService or Obsidian status bar; verify manually in Obsidian by enabling Settings -> Keep computer awake and starting a response', async ({ page }) => {});

  // ─── Compress view ──────────────────────────────────────────────────────────

  test('compress view menu item', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the agentic thread (has consecutive assistant messages)
    await page.evaluate(() => (window as any).__view.focusThread('thread-agentic'));
    await page.waitForTimeout(200);
    // Open the more menu — "Compress view" should be the first item
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    // Move mouse away so no menu item is in hover state
    await page.mouse.move(0, 0);
    await shot(page, 'compress-view-menu.png', { fullPage: true });
  });

  test('compressed messages', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the agentic thread (has consecutive assistant messages for grouping)
    await page.evaluate(() => (window as any).__view.focusThread('thread-agentic'));
    await page.waitForTimeout(200);
    // Toggle compress view via the more menu
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await page.getByText('Compress view').click();
    // Wait for the compressed layout to render (3 consecutive assistant msgs → grouped block)
    await page.waitForSelector('.ct-message-compressed');
    await page.waitForTimeout(200);
    await shot(page, 'compress-view-active.png', { fullPage: true });
  });

  test('compressed message expand', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Switch to the agentic thread
    await page.evaluate(() => (window as any).__view.focusThread('thread-agentic'));
    await page.waitForTimeout(200);
    // Activate compress view
    await page.click('.ct-thread-more-btn');
    await page.waitForSelector('.menu');
    await page.getByText('Compress view').click();
    await page.waitForSelector('.ct-message-compressed');
    await page.waitForTimeout(200);
    // Expand the first (and only) compressed group
    await page.click('.ct-expand-btn');
    await page.waitForSelector('.ct-full-content:not(.ct-hidden)');
    await page.waitForTimeout(200);
    await shot(page, 'compress-view-expanded.png', { fullPage: true });
  });

  test('streaming tool pills above panel', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);

    // Simulate a running thread: create the streaming element and inject tool pills
    // directly so we can test the visual state without needing a live Claude process.
    await page.evaluate(() => {
      const view = (window as any).__view;

      // Create the streaming bubble (private method accessible via bracket notation)
      view['createStreamingEl']();

      // Inject 4 tool pills — same DOM structure the real code produces
      const tools = [
        { name: 'Read',   summary: 'src/middleware/auth.ts' },
        { name: 'Read',   summary: '.env.example' },
        { name: 'Bash',   summary: 'npm test -- --testPathPattern=auth' },
        { name: 'Write',  summary: 'src/middleware/__tests__/auth.test.ts' },
      ];

      for (const tool of [...tools].reverse()) {
        const pill = document.createElement('div');
        pill.className = 'ct-tool-pill ct-tool-active';

        const icon = document.createElement('span');
        icon.className = 'ct-tool-pill-icon';
        icon.textContent = '📄';

        const badge = document.createElement('span');
        badge.className = 'ct-tool-pill-name';
        badge.textContent = tool.name;

        const label = document.createElement('span');
        label.className = 'ct-tool-pill-text';
        label.textContent = tool.summary;

        pill.append(icon, badge, label);
        view['streamingEl'].prepend(pill);
      }

      // Scroll to bottom (triggers the rAF + clearance update)
      view['scrollToBottom']();
    });

    // Wait for rAF + any ResizeObserver callbacks to settle
    await page.waitForTimeout(200);
    await shot(page, 'streaming-tool-pills.png', { fullPage: true });
  });

  test('tool result images rendered inline in assistant message', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Thread 1 is the default; scroll to bottom to see the image message
    await page.evaluate(() => (window as any).__view['scrollToBottom']());
    await page.waitForTimeout(200);
    // The fixture has a message with toolResultImages — verify the img is in the DOM
    const imgCount = await page.locator('.ct-tool-result-images img').count();
    if (imgCount === 0) throw new Error('No .ct-tool-result-images img found — toolResultImages not rendered');
    await shot(page, 'tool-result-images.png', { fullPage: true });
  });

  // ─── Skills Manager ──────────────────────────────────────────────────────

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 375, height: 667 }]) {
  test(`skills manager — create and edit an authored skill ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('file://' + path.resolve('test/harness/skills.html'));
    await page.getByRole('button', { name: 'New skill', exact: true }).click();
    expect((await page.getByRole('button', { name: 'New skill', exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole('textbox', { name: 'Skill identifier' }).fill('meeting-notes');
    await page.getByRole('button', { name: 'Create skill', exact: true }).click();
    await expect(page.locator('.ct-skills-textarea')).toHaveValue(/name: meeting-notes/);
    await expect(page.getByText('Available in new sessions.', { exact: true })).toBeVisible();
    await page.locator('.ct-skills-textarea').fill('---\nname: meeting-notes\ndescription: Summarize meetings\n---\nUpdated instructions');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await shot(page, `skills-manager-local-editor-${viewport.width}.png`, { fullPage: true });
  });
  }

  // Narrow widths collapse the list/detail split into one pane at a time, so a
  // sidebar-sized Skills Manager shows the list, then swaps to the detail view
  // behind a back button. These assert the swap in both directions — a pixel
  // snapshot alone would not catch the list failing to come back.

  test('skills manager — narrow width shows list, not detail', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('file://' + path.resolve('test/harness/skills.html'));
    await page.waitForSelector('.ct-skills-count');

    await expect(page.locator('.ct-skills-list')).toBeVisible();
    await expect(page.locator('.ct-skills-detail')).toBeHidden();
    await expect(page.locator('.ct-skills-divider')).toBeHidden();
    // The list should claim the full width rather than the persisted split width.
    const listWidth = (await page.locator('.ct-skills-list').boundingBox())!.width;
    const bodyWidth = (await page.locator('.ct-skills-body').boundingBox())!.width;
    expect(listWidth).toBeCloseTo(bodyWidth, 0);

    await shot(page, 'skills-manager-narrow-list.png', { fullPage: true });
  });

  test('skills manager — narrow width swaps to detail and back', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('file://' + path.resolve('test/harness/skills.html'));
    await page.waitForSelector('.ct-skills-count');

    await page.locator('.ct-skills-tree-child-name', { hasText: 'release-manager' }).click();

    // Detail takes over the pane; the list is gone until we navigate back.
    await expect(page.locator('.ct-skills-detail')).toBeVisible();
    await expect(page.locator('.ct-skills-list')).toBeHidden();
    const backBtn = page.getByRole('button', { name: 'Back to skill list' });
    await expect(backBtn).toBeVisible();
    // Back button must be a usable tap target on a phone-width pane.
    expect((await backBtn.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await shot(page, 'skills-manager-narrow-detail.png', { fullPage: true });

    await backBtn.click();

    await expect(page.locator('.ct-skills-list')).toBeVisible();
    await expect(page.locator('.ct-skills-detail')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Back to skill list' })).toBeHidden();
  });

  // The detail pane has several distinct sources (installed skill, agent,
  // Browse result, authoring form). Each is a separate branch of the
  // "is something selected" check that drives the narrow-mode swap, so each
  // needs its own proof — one working branch does not imply the others.

  test('skills manager — narrow width swaps for agents and the Browse tab', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('file://' + path.resolve('test/harness/skills.html'));
    await page.waitForSelector('.ct-skills-count');

    // Agent detail (read-only pane, ~/.claude/agents).
    await page.locator('.ct-skills-tree-child-name', { hasText: 'engineer' }).click();
    await expect(page.locator('.ct-skills-list')).toBeHidden();
    await page.getByRole('button', { name: 'Back to skill list' }).click();
    await expect(page.locator('.ct-skills-list')).toBeVisible();

    // Browse tab: list until a result is picked, then the detail pane.
    await page.getByRole('button', { name: 'Browse', exact: true }).click();
    await page.waitForTimeout(300);
    await expect(page.locator('.ct-skills-list')).toBeVisible();
    await expect(page.locator('.ct-skills-detail')).toBeHidden();

    // The harness has no network, so skills.sh returns nothing — seed a result
    // directly rather than letting the assertions below pass vacuously.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (window as any).__skillsView;
      view.browseQuery = 'demo';
      view.isBrowseLoading = false;
      view.browseResults = [{
        slug: 'acme/demo/demo-skill',
        skillId: 'demo-skill',
        name: 'Demo Skill',
        source: 'acme/demo',
        installs: 1234,
        isInstalled: false,
      }];
      view.renderList();
      view.renderDetail();
    });

    const firstCard = page.locator('.ct-skills-card').first();
    await expect(firstCard).toBeVisible();
    await firstCard.click();
    await expect(page.locator('.ct-skills-detail')).toBeVisible();
    await expect(page.locator('.ct-skills-list')).toBeHidden();
    await page.getByRole('button', { name: 'Back to skill list' }).click();
    await expect(page.locator('.ct-skills-list')).toBeVisible();
    await expect(page.locator('.ct-skills-detail')).toBeHidden();
  });

  test('skills manager — narrow width swaps for the New skill form', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('file://' + path.resolve('test/harness/skills.html'));
    await page.waitForSelector('.ct-skills-count');

    await page.getByRole('button', { name: 'New skill', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Skill identifier' })).toBeVisible();
    await expect(page.locator('.ct-skills-list')).toBeHidden();

    // Abandoning the form returns to the list rather than stranding the user.
    await page.getByRole('button', { name: 'Back to skill list' }).click();
    await expect(page.locator('.ct-skills-list')).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Skill identifier' })).toHaveCount(0);
  });

  test('skills manager — back with unsaved edits asks before discarding', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('file://' + path.resolve('test/harness/skills.html'));
    await page.waitForSelector('.ct-skills-count');

    await page.locator('.ct-skills-tree-child-name', { hasText: 'release-manager' }).click();
    await page.locator('.ct-skills-textarea').fill('edited but not saved');
    await page.getByRole('button', { name: 'Back to skill list' }).click();

    // Back is the only exit in narrow mode, so it must not silently drop edits.
    const modal = page.locator('.modal-container');
    await expect(modal).toBeVisible();
    await expect(page.locator('.ct-skills-list')).toBeHidden();

    await modal.getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(page.locator('.ct-skills-list')).toBeVisible();
    await expect(page.locator('.ct-skills-detail')).toBeHidden();
  });

  test('skills manager — wide width keeps both panes and hides back button', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 740 });
    await page.goto('file://' + path.resolve('test/harness/skills.html'));
    await page.waitForSelector('.ct-skills-count');

    await page.locator('.ct-skills-tree-child-name', { hasText: 'release-manager' }).click();
    await page.waitForSelector('.ct-skills-btn-save');

    // Both panes stay on screen, and the back affordance is narrow-mode only.
    await expect(page.locator('.ct-skills-list')).toBeVisible();
    await expect(page.locator('.ct-skills-detail')).toBeVisible();
    await expect(page.locator('.ct-skills-divider')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to skill list' })).toBeHidden();
  });

  test('skills manager — installed tab', async ({ page }) => {
    const skillsUrl = 'file://' + path.resolve('test/harness/skills.html');
    await page.setViewportSize({ width: 1000, height: 740 });
    await page.goto(skillsUrl);
    await page.waitForSelector('.ct-skills-count');
    await page.waitForTimeout(200);
    await shot(page, 'skills-manager-installed.png', { fullPage: true });
  });

  // The two specs above only ever capture the empty detail state, so they
  // would pass without proving anything about the editor. These click into a
  // row and assert what the pane offers — the first coverage that path has had.

  test('skills manager — Claude Code skill detail is read-only', async ({ page }) => {
    const skillsUrl = 'file://' + path.resolve('test/harness/skills.html');
    await page.setViewportSize({ width: 1000, height: 740 });
    await page.goto(skillsUrl);
    await page.waitForSelector('.ct-skills-count');
    // 'brain-dump' lives in the ~/.claude/skills fixture.
    await page.locator('.ct-skills-tree-child-name', { hasText: 'brain-dump' }).click();
    await page.waitForSelector('.ct-skills-callout');

    await expect(page.locator('.ct-skills-btn-save')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Uninstall' })).toHaveCount(0);
    await expect(page.locator('.ct-skills-detail-name-row .ct-skills-badge--readonly')).toHaveCount(1);
    await expect(page.locator('.ct-skills-textarea[readonly]')).toHaveCount(1);

    await shot(page, 'skills-manager-readonly-detail.png', { fullPage: true });
  });

  test('skills manager — vault skill detail is editable', async ({ page }) => {
    const skillsUrl = 'file://' + path.resolve('test/harness/skills.html');
    await page.setViewportSize({ width: 1000, height: 740 });
    await page.goto(skillsUrl);
    await page.waitForSelector('.ct-skills-count');
    // 'release-manager' lives in the vault skills fixture.
    await page.locator('.ct-skills-tree-child-name', { hasText: 'release-manager' }).click();
    await page.waitForSelector('.ct-skills-btn-save');

    await expect(page.getByRole('button', { name: 'Uninstall' })).toHaveCount(1);
    await expect(page.locator('.ct-skills-badge--readonly')).toHaveCount(1); // the Claude Code group header only
    await expect(page.locator('.ct-skills-textarea[readonly]')).toHaveCount(0);

    await shot(page, 'skills-manager-vault-detail.png', { fullPage: true });
  });

  test('skills manager — agent detail is read-only', async ({ page }) => {
    const skillsUrl = 'file://' + path.resolve('test/harness/skills.html');
    await page.setViewportSize({ width: 1000, height: 740 });
    await page.goto(skillsUrl);
    await page.waitForSelector('.ct-skills-count');
    await page.locator('.ct-skills-tree-child-name', { hasText: 'engineer' }).click();
    await page.waitForSelector('.ct-skills-callout');

    await expect(page.locator('.ct-skills-btn-save')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await expect(page.locator('.ct-skills-textarea[readonly]')).toHaveCount(1);
  });

  test('skills manager — browse tab', async ({ page }) => {
    const skillsUrl = 'file://' + path.resolve('test/harness/skills.html');
    await page.setViewportSize({ width: 1000, height: 740 });
    await page.goto(skillsUrl);
    await page.waitForSelector('.ct-skills-tabs');
    await page.getByText('Browse').click();
    await page.waitForTimeout(200);
    await shot(page, 'skills-manager-browse.png', { fullPage: true });
  });

  // ─── Settings tab ────────────────────────────────────────────────────────

  test('settings — desktop section selector preserves the host content width', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('file://' + path.resolve('test/harness/settings.html') + '?host=geode');
    const sections = page.getByLabel('Settings section');
    await expect(sections).toBeVisible();
    await sections.selectOption('projects');
    await expect(page.getByLabel('Geode settings')).toBeVisible();
    await expect(sections.locator('optgroup')).toHaveCount(4);
    await expect(page.locator('.ct-settings-sidebar')).toHaveCount(0);
    const body = await page.locator('.ct-settings-tab-body').boundingBox();
    const shell = await page.locator('.ct-settings-shell').boundingBox();
    expect(body!.width).toBeGreaterThanOrEqual(shell!.width - 1);
    await shot(page, 'settings-geode-projects.png', { fullPage: true });
    await sections.selectOption('secrets');
    await expect(page.getByLabel('Variable name')).toBeVisible();
    await shot(page, 'settings-geode-secrets.png', { fullPage: true });
    await page.setViewportSize({ width: 800, height: 800 });
    await sections.selectOption('projects');
    const list = await page.locator('.ct-manager-list').boundingBox();
    const detail = await page.locator('.ct-manager-detail').boundingBox();
    expect(detail!.y).toBeGreaterThanOrEqual(list!.y + list!.height - 1);
    await expect.poll(() => page.locator('.vertical-tab-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByLabel('Project name').fill('Host-width edit');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__settings.projects[0].name)).toBe('Host-width edit');
    await page.locator('.vertical-tab-content').evaluate(el => { el.scrollTop = 0; });
    await shot(page, 'settings-geode-projects-narrow.png', { fullPage: true });
  });

  test('settings — general tab', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    await page.waitForTimeout(200);

    const createPr = page.locator('.setting-item', { hasText: 'Create PR message' }).locator('textarea');
    const createDraftPr = page.locator('.setting-item', { hasText: 'Create draft PR message' }).locator('textarea');
    await expect(createPr).toHaveValue('/create-pr');
    await expect(createDraftPr).toHaveValue('/create-pr --draft');

    await createPr.fill('Open the finished pull request');
    await createPr.blur();
    await expect.poll(() => page.evaluate(() => (window as any).__settings.createPrMessage)).toBe('Open the finished pull request');
    await expect.poll(() => page.evaluate(() => (window as any).__settings.createDraftPrMessage)).toBe('/create-pr --draft');

    await createDraftPr.fill('Open a draft pull request');
    await createDraftPr.blur();
    await expect.poll(() => page.evaluate(() => (window as any).__settings.createDraftPrMessage)).toBe('Open a draft pull request');

    await createPr.fill('/create-pr');
    await createDraftPr.fill('/create-pr --draft');
    await createDraftPr.blur();
    await shot(page, 'settings-general.png', { fullPage: true });
  });

  test('settings — claude tab', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    // The tab whose id is 'claude' is now labelled "Agent" (harness-agnostic
    // naming since the Codex harness landed); the screenshot keeps the historical
    // settings-claude.png name to match the tab id.
    await page.getByLabel('Settings section').selectOption('claude');
    await page.waitForTimeout(200);
    await shot(page, 'settings-claude.png', { fullPage: true });
  });

  test('settings — switching harness reveals Codex Ultra effort without overwriting Claude effort', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    await page.getByLabel('Settings section').selectOption('claude');

    const harnessSetting = page.locator('.setting-item').filter({ hasText: 'Agent harness' });
    await harnessSetting.locator('select').selectOption('codex');

    await expect(page.locator('.setting-item').filter({ hasText: 'Codex effort level' })).toBeVisible();
    const effortSelect = page.locator('.setting-item').filter({ hasText: 'Codex effort level' }).locator('select');
    await expect(effortSelect.locator('option[value="ultra"]')).toHaveText('Ultra (proactive agents)');
  });

  test('settings — tools tab', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    await page.getByLabel('Settings section').selectOption('tools');
    await page.waitForTimeout(200);
    await shot(page, 'settings-tools.png', { fullPage: true });
  });

  test('settings — Projects use an explicit searchable list-detail draft', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    await page.getByLabel('Settings section').selectOption('projects');
    await expect(page.getByText('/Users/mock/projects/acme-webapp').first()).toBeVisible();
    await expect(page.getByPlaceholder('Search projects')).toBeVisible();
    const override = page.getByLabel('Filesystem working directory');
    await expect(override).toHaveValue('/Users/mock/projects/acme-webapp');
    await shot(page, 'settings-projects.png', { fullPage: true });
    await override.fill('');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Effective cwd: /Users/mock/vault/Work/Acme')).toBeVisible();
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.getByLabel('Project name')).toHaveValue('');
    await page.getByLabel('Project name').fill('Discarded draft');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('Project name')).toHaveValue('Acme Webapp');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      const app = document.getElementById('app');
      const content = app?.querySelector<HTMLElement>('.vertical-tab-content');
      if (app) app.style.height = 'auto';
      if (content) { content.style.flex = 'none'; content.style.overflow = 'visible'; }
    });
    await expect(page.getByLabel('Settings section')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await shot(page, 'settings-projects-narrow.png', { fullPage: true });
  });

  test('settings — Secrets save value and selected-project scope together', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    await page.getByLabel('Settings section').selectOption('secrets');
    await expect(page.getByPlaceholder('Search secrets')).toBeVisible();
    await expect(page.getByLabel('Variable name')).toBeDisabled();
    await page.getByLabel('Replace value').fill('replacement-value');
    await page.getByLabel('Selected projects').check();
    await page.getByLabel('Acme Webapp').check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__settings.secretEnvScopes.STRIPE_SECRET_KEY)).toEqual(['proj-1']);
    await expect.poll(() => page.evaluate(() => (window as any).__getSettingsSecret('STRIPE_SECRET_KEY'))).toBe('replacement-value');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__getSettingsSecret('STRIPE_SECRET_KEY'))).toBe('replacement-value');
    await page.locator('.vertical-tab-content').evaluate(element => { element.scrollTop = 0; });
    await shot(page, 'settings-secrets.png', { fullPage: true });
  });

  test('settings — scheduled work dashboard', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    await page.getByLabel('Settings section').selectOption('scheduled');
    await expect(page.getByRole('heading', { name: 'Next up' })).toHaveCount(0);
    // 5 scheduled-work cards + 2 watched-document cards share the same
    // .ct-scheduled-card markup (see "Watched documents" checks below).
    await expect(page.locator('.ct-scheduled-card')).toHaveCount(7);
    const expectedNames = [
      'Morning inbox triage',
      'Project pulse',
      'Weekly PR sweep',
      'Loop: watch CI',
      'Wakeup: deployment check',
    ];
    for (const name of expectedNames) {
      await expect(page.locator('.ct-scheduled-name', { hasText: name })).toHaveCount(1);
    }
    const initialSections = page.locator('.ct-scheduled-section');
    await expect(initialSections.nth(0).locator('.ct-scheduled-name')).toHaveText(expectedNames.slice(0, 3));
    await expect(initialSections.nth(1).locator('.ct-scheduled-name')).toHaveText(expectedNames.slice(3));
    await expect(page.locator('.ct-scheduled-card').filter({ hasText: 'Loop: watch CI' }))
      .toContainText('Existing thread · Codex · gpt-5.6-codex');
    await expect(page.locator('.ct-scheduled-card').filter({ hasText: 'Wakeup: deployment check' }))
      .toContainText('Target thread missing · falls back to new thread');
    await expect(page.locator('.ct-scheduled-card[open]')).toHaveCount(0);
    await expect(page.getByText('Overdue — catching up', { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Next check').first()).toBeVisible();
    await expect(page.getByText('Thread loops & wakeups')).toBeVisible();
    await expect(page.getByText('Thread Orchestrator heartbeat')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create with Claude' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open last run' })).toHaveCount(0);

    // ── Watched documents ────────────────────────────────────────────────
    await expect(page.getByText('Watched documents')).toBeVisible();
    const watchedSection = page.locator('.ct-scheduled-section').filter({ hasText: 'Watched documents' });
    const liveWatch = watchedSection.locator('.ct-scheduled-card').filter({ hasText: 'Reports/Weekly Report.md' });
    const orphanWatch = watchedSection.locator('.ct-scheduled-card').filter({ hasText: 'Specs/Orphaned Watch.md' });
    await expect(liveWatch).toContainText('Watching');
    await expect(liveWatch).toContainText('Owner: Weekly report review');
    await expect(orphanWatch).toContainText('Owner: Thread no longer exists');
    await expect(orphanWatch).toContainText('Never alerted');
    await expect(watchedSection.locator('.ct-scheduled-card')).toHaveCount(2);

    // The unwatch button's tooltip ("Stop watching this document") becomes its
    // accessible name (aria-label wins over visible text), even though its
    // visible label reads "Unwatch" — mirrors the Delete button's tooltip below.
    await liveWatch.locator(':scope > summary').click();
    await expect(liveWatch.getByRole('button', { name: 'Open owning thread' })).toBeVisible();
    await expect(liveWatch.getByRole('button', { name: 'Stop watching this document' })).toBeVisible();
    await liveWatch.locator(':scope > summary').click(); // collapse again for the baseline screenshot

    await orphanWatch.locator(':scope > summary').click();
    await expect(orphanWatch.getByRole('button', { name: 'Open owning thread' })).toHaveCount(0);
    await expect(orphanWatch.getByRole('button', { name: 'Stop watching this document' })).toBeVisible();
    await orphanWatch.locator(':scope > summary').click(); // collapse again for the baseline screenshot
    await page.evaluate(() => {
      const app = document.getElementById('app');
      const content = app?.querySelector<HTMLElement>('.vertical-tab-content');
      if (app) app.style.height = 'auto';
      if (content) {
        content.style.flex = 'none';
        content.style.overflow = 'visible';
      }
    });
    await page.waitForTimeout(200);
    await shot(page, 'settings-scheduled.png', { fullPage: true });

    const morning = page.locator('.ct-scheduled-card').filter({ hasText: 'Morning inbox triage' });
    await morning.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    await expect(morning).toHaveAttribute('open', '');
    await expect(morning.getByText('Prompt', { exact: true })).toBeVisible();
    await expect(morning.getByText('test -s inbox/pending.txt', { exact: false })).toBeVisible();
    await expect(morning.getByText('Creates a new thread', { exact: false })).toBeVisible();
    await expect(morning.getByRole('button', { name: 'Open last run' })).toBeVisible();
    await morning.locator('.ct-run-history-summary').click();
    await expect(morning.getByText('Fired', { exact: true })).toBeVisible();
    await shot(page, 'settings-scheduled-expanded.png', { fullPage: true });

    await page.setViewportSize({ width: 360, height: 760 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await shot(page, 'settings-scheduled-narrow.png', { fullPage: true });

    await morning.getByRole('button', { name: 'Open last run' }).click();

    await page.getByRole('button', { name: 'Create with Claude' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__scheduledCreateCalls)).toEqual({
      dispatches: [{
        prompt: 'Help me create scheduled work. Ask me what should happen, when it should run, and whether it needs active hours or a deterministic gate. Then use CronCreate once the schedule is clear.',
        title: 'Create scheduled work',
      }],
      openedThreadIds: ['thread-morning', 'thread-created'],
      updatedItemIds: [],
      deletedItemIds: [],
    });

    await morning.getByRole('button', { name: 'Pause' }).click();
    const recurringNames = page.locator('.ct-scheduled-section').filter({ hasText: 'Recurring jobs' }).locator('.ct-scheduled-name');
    await expect(recurringNames).toHaveText(['Project pulse', 'Morning inbox triage', 'Weekly PR sweep']);
    await expect(page.locator('.ct-scheduled-card').filter({ hasText: 'Morning inbox triage' }).getByText('Paused', { exact: true }).first()).toBeVisible();

    const weekly = page.locator('.ct-scheduled-card').filter({ hasText: 'Weekly PR sweep' });
    await weekly.locator(':scope > summary').click();
    await weekly.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.ct-scheduled-card').filter({ hasText: 'Weekly PR sweep' })).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).__scheduledCreateCalls.updatedItemIds)).toEqual(['sched-1']);
    await expect.poll(() => page.evaluate(() => (window as any).__scheduledCreateCalls.deletedItemIds)).toEqual(['sched-2']);

    const liveWatchCard = page.locator('.ct-scheduled-card').filter({ hasText: 'Reports/Weekly Report.md' });
    await liveWatchCard.locator(':scope > summary').click();
    await liveWatchCard.getByRole('button', { name: 'Stop watching this document' }).click();
    await expect(page.locator('.ct-scheduled-card').filter({ hasText: 'Reports/Weekly Report.md' })).toHaveCount(0);
    await expect(page.locator('.ct-scheduled-card').filter({ hasText: 'Specs/Orphaned Watch.md' })).toHaveCount(1);
  });

  test('settings — mcp tab', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    await page.getByLabel('Settings section').selectOption('mcp');
    await page.waitForTimeout(200);
    // Collapse the fixed-height harness shell to the content so the docs
    // screenshot (copied out by posttest:screenshots:update) crops tight
    // instead of trailing a large empty panel below the server list.
    await page.evaluate(() => {
      const app = document.getElementById('app');
      if (app) app.style.height = 'auto';
    });
    await page.waitForTimeout(50);
    await shot(page, 'settings-mcp.png', { fullPage: true });
  });

  test('settings — MCP registration host confirmation', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('file://' + path.resolve('test/harness/settings.html'));
    await page.evaluate(() => (window as any).__openMcpRegistration());
    await expect(page.locator('.ct-mcp-registration')).toBeVisible();
    await shot(page, 'mcp-registration.png');
    await page.getByRole('button', { name: 'Register server', exact: true }).click();
    expect(await page.evaluate(() => (window as any).__mcpRegistrationResult)).toBe(true);
    await page.evaluate(() => (window as any).__openMcpRegistration('http'));
    await expect(page.locator('.ct-mcp-registration')).toContainText('connect to this endpoint');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await page.evaluate(() => (window as any).__mcpRegistrationResult)).toBe(false);
  });

  for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
    test(`MCP registration fits narrow viewport ${viewport.width}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('file://' + path.resolve('test/harness/settings.html'));
      await page.evaluate(() => (window as any).__openMcpRegistration());
      const content = page.locator('.ct-mcp-registration');
      await expect(content).toBeVisible();
      const box = await content.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(await content.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const button = page.getByRole('button', { name: 'Register server', exact: true });
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: test.info().outputPath(`mcp-registration-${viewport.width}.png`) });
      await button.click();
      expect(await page.evaluate(() => (window as any).__mcpRegistrationResult)).toBe(true);
    });
  }
  test('Google Workspace services are opt-in and persisted independently', async ({ page }) => {
    await page.goto('file://' + path.resolve('test/harness/settings.html'));
    await page.getByLabel('Settings section').selectOption('mcp');
    for (const name of ['Google Docs', 'Google Drive', 'Google Sheets', 'Google Slides']) {
      const toggle = page.locator('.setting-item').filter({ has: page.locator('.setting-item-name', { hasText: new RegExp(`^${name}$`) }) }).locator('.checkbox-container');
      await expect(toggle).not.toHaveClass(/is-enabled/);
      await toggle.click();
      await expect(toggle).toHaveClass(/is-enabled/);
    }
    await expect(page.getByText('Google Workspace requires desktop Google Docs Sync with a connected account.', { exact: true })).toBeVisible();
    await page.getByLabel('Settings section').selectOption('general');
    await page.getByLabel('Settings section').selectOption('mcp');
    for (const name of ['Google Docs', 'Google Drive', 'Google Sheets', 'Google Slides']) {
      await expect(page.locator('.setting-item').filter({ has: page.locator('.setting-item-name', { hasText: new RegExp(`^${name}$`) }) }).locator('.checkbox-container')).toHaveClass(/is-enabled/);
    }
  });

  for (const width of [1280, 390, 375]) {
    test(`Google Workspace settings at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('file://' + path.resolve('test/harness/settings.html'));
      await page.getByLabel('Settings section').selectOption('mcp');
      await page.evaluate(() => { document.getElementById('app')!.style.height = 'auto'; });
      await expect(page.getByText('Google Workspace', { exact: true })).toBeVisible();
      await expect(page.locator('.setting-item-name').filter({ hasText: /^Google (Docs|Drive|Sheets|Slides)$/ })).toHaveCount(4);
      await shot(page, `google-workspace-settings-${width}.png`, { fullPage: true });
    });
  }

  test('Google Workspace connected settings update transport selection after save', async ({ page }) => {
    await page.goto('file://' + path.resolve('test/harness/settings.html'));
    await page.evaluate(() => {
      const calls: string[] = [];
      (window as any).__workspaceCalls = calls;
      (window as any).__settingsPlugin.saveSettings = async () => { calls.push('save'); };
      (window as any).__settingsPlugin.googleWorkspaceMcp = {
        status: () => 'Connected through Google Docs Sync. Google validates service access when a thread connects.',
        configure: async (selection: unknown) => { calls.push(JSON.stringify(selection)); },
      };
    });
    await page.getByLabel('Settings section').selectOption('mcp');
    await expect(page.getByText('Connected through Google Docs Sync.', { exact: false })).toBeVisible();
    await page.locator('.setting-item').filter({ has: page.locator('.setting-item-name', { hasText: /^Google Sheets$/ }) }).locator('.checkbox-container').click();
    await expect.poll(() => page.evaluate(() => (window as any).__workspaceCalls)).toEqual(['save', '{"sheets":true}']);
  });
  test('settings — mcp edit server form', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    await page.getByLabel('Settings section').selectOption('mcp');
    await page.waitForTimeout(200);
    // Open the edit modal on the stdio server so the form shows real values,
    // including an ${ENV_VAR} placeholder in the environment field. Targeted by
    // name rather than by position: rows are sorted alphabetically, so `.first()`
    // silently depends on the fixture's naming.
    await page
      .locator('.ct-mcp-servers-list .setting-item')
      .filter({ hasText: 'obsidian_notes' })
      .getByRole('button', { name: 'Edit' })
      .click();
    await page.waitForSelector('.modal-overlay');
    await page.waitForTimeout(200);
    await shot(page, 'settings-mcp-edit.png', { fullPage: true });
  });

  test('settings — add mcp server form offers the OAuth type', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    await page.getByLabel('Settings section').selectOption('mcp');
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: 'Add MCP server' }).click();
    await page.waitForSelector('.modal-overlay');
    await page.getByRole('button', { name: 'OAuth', exact: true }).click();
    await page.waitForTimeout(200);
    // The OAuth arm collects its own field set — no command/args/env or headers.
    await expect(page.getByPlaceholder('https://mcp.vercel.com/')).toBeVisible();
    await expect(page.getByPlaceholder('openid profile email')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    await shot(page, 'settings-mcp-add-oauth.png', { fullPage: true });
  });

  test('settings — OAuth type is offered when adding but not when editing', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    await page.getByLabel('Settings section').selectOption('mcp');
    await page.waitForTimeout(200);

    await page.getByRole('button', { name: 'Add MCP server' }).click();
    await page.waitForSelector('.modal-overlay');
    await expect(page.getByRole('button', { name: 'OAuth', exact: true })).toBeVisible();
    // Dismiss via the form's own Cancel: Escape does not close the modal in the
    // harness, and the lingering overlay intercepts the Edit click below.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForSelector('.modal-overlay', { state: 'detached' });

    // Editing an existing server must NOT offer OAuth: a connected OAuth server
    // is reconnected, not edited in place.
    await page
      .locator('.ct-mcp-servers-list .setting-item')
      .filter({ hasText: 'obsidian_notes' })
      .getByRole('button', { name: 'Edit' })
      .click();
    await page.waitForSelector('.modal-overlay');
    await expect(page.getByRole('button', { name: 'Command (stdio)' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'OAuth', exact: true })).toHaveCount(0);
  });

  for (const width of [390, 375]) {
    test(`settings — three MCP type buttons fit viewport ${width}`, async ({ page }) => {
      const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
      await page.setViewportSize({ width, height: 760 });
      await page.goto(settingsUrl);
      await page.waitForSelector('.ct-settings-shell');
      await page.getByLabel('Settings section').selectOption('mcp');
      await page.waitForTimeout(200);
      await page.getByRole('button', { name: 'Add MCP server' }).click();
      await page.waitForSelector('.modal-overlay');
      await page.waitForTimeout(200);

      // Adding a third type button must not push the row into horizontal
      // overflow on a phone-width modal — the row wraps instead.
      const overflow = await page.locator('.ct-modal-type-row').evaluate(
        (el) => el.scrollWidth - el.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      for (const label of ['Command (stdio)', 'HTTP or SSE', 'OAuth']) {
        await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
      }
    });
  }

  test('settings — oauth mcp servers', async ({ page }) => {
    const settingsUrl = 'file://' + path.resolve('test/harness/settings.html');
    await page.setViewportSize({ width: 860, height: 820 });
    await page.goto(settingsUrl);
    await page.waitForSelector('.ct-settings-shell');
    await page.getByLabel('Settings section').selectOption('mcp');
    await page.waitForTimeout(200);
    // Collapse the fixed-height harness shell to the content, same as the
    // "settings — mcp tab" screenshot above, so this crops tight to the
    // OAuth MCP servers panel instead of trailing empty space below it.
    await page.evaluate(() => {
      const app = document.getElementById('app');
      if (app) app.style.height = 'auto';
    });
    await page.waitForTimeout(50);
    await expect(page.getByText('OAuth MCP servers', { exact: true })).toBeVisible();
    // Both fixture servers' status rows and their Disconnect buttons.
    const figmaRow = page.locator('.ct-oauth-mcp-servers-list .setting-item').filter({ hasText: 'figma' });
    await expect(figmaRow.getByText('Needs re-authorization')).toBeVisible();
    await expect(figmaRow.getByText('Refresh failed: invalid_grant', { exact: false })).toBeVisible();
    await expect(figmaRow.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    const vercelRow = page.locator('.ct-oauth-mcp-servers-list .setting-item').filter({ hasText: 'vercel' });
    await expect(vercelRow.getByText('Connected · expires in 2h 45m', { exact: false })).toBeVisible();
    await expect(vercelRow.getByRole('button', { name: 'Disconnect' })).toBeVisible();
    await shot(page, 'settings-oauth-mcp.png', { fullPage: true });
  });

  test('sub-agent task pill while working', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Thread 1 is the default; scroll to bottom to see the image message
    await page.evaluate(() => (window as any).__view['scrollToBottom']());
    await page.waitForTimeout(200);
    // The fixture has a message with toolResultImages — verify the img is in the DOM
    const imgCount = await page.locator('.ct-tool-result-images img').count();
    if (imgCount === 0) throw new Error('No .ct-tool-result-images img found — toolResultImages not rendered');
    await shot(page, 'tool-result-images.png', { fullPage: true });

    // Simulate the state after an Agent tool call commits: the "Sub-agent working"
    // placeholder is created, then task_started prepends a task pill to it.
    await page.evaluate(() => {
      const view = (window as any).__view;

      // Create the streaming element with the sub-agent label
      view['createStreamingEl']('Sub-agent working');

      // Simulate a task pill (same structure as task_started handler produces)
      const pill = document.createElement('div');
      pill.className = 'ct-tool-pill ct-tool-active ct-task-pill';

      const iconEl = document.createElement('span');
      iconEl.className = 'ct-tool-pill-icon';
      // Use text icon as a stand-in (Obsidian setIcon unavailable in harness)
      iconEl.textContent = '🤖';

      const badge = document.createElement('span');
      badge.className = 'ct-tool-pill-name';
      badge.textContent = 'sub-agent';

      const label = document.createElement('span');
      label.className = 'ct-tool-pill-text';
      label.textContent = 'Implementing the auth middleware · Read (1m12s)';

      pill.append(iconEl, badge, label);
      view['streamingEl'].prepend(pill);
      view['scrollToBottom']();
    });

    await page.waitForTimeout(200);
    await shot(page, 'subagent-task-pill.png', { fullPage: true });
  });

  test('workflow progress block while running', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);

    // Simulate the workflow block DOM that task_started (local_workflow) produces,
    // followed by two sub-agent rows (one running, one done).
    await page.evaluate(() => {
      const view = (window as any).__view;
      view['createStreamingEl']('Sub-agent working');

      const block = document.createElement('div');
      block.className = 'ct-workflow-block';

      // Header
      const header = document.createElement('div');
      header.className = 'ct-workflow-header';
      const iconEl = document.createElement('span');
      iconEl.className = 'ct-workflow-icon';
      iconEl.textContent = '⑂';
      const nameEl = document.createElement('span');
      nameEl.className = 'ct-workflow-name';
      nameEl.textContent = 'review-changes';
      const phaseEl = document.createElement('span');
      phaseEl.className = 'ct-workflow-phase';
      phaseEl.textContent = ' · Review';
      header.append(iconEl, nameEl, phaseEl);

      // Agent list
      const agentList = document.createElement('div');
      agentList.className = 'ct-workflow-agents';

      // Running agent
      const row1 = document.createElement('div');
      row1.className = 'ct-workflow-agent-row ct-workflow-agent-running';
      const dot1 = document.createElement('span');
      dot1.className = 'ct-workflow-agent-dot';
      dot1.textContent = '●';
      const desc1 = document.createElement('span');
      desc1.className = 'ct-workflow-agent-desc';
      desc1.textContent = 'Review for bugs · Bash (4s)';
      row1.append(dot1, desc1);

      // Done agent
      const row2 = document.createElement('div');
      row2.className = 'ct-workflow-agent-row ct-workflow-agent-done';
      const dot2 = document.createElement('span');
      dot2.className = 'ct-workflow-agent-dot';
      dot2.textContent = '✔';
      const desc2 = document.createElement('span');
      desc2.className = 'ct-workflow-agent-desc';
      desc2.textContent = 'No security issues found';
      row2.append(dot2, desc2);

      agentList.append(row1, row2);
      block.append(header, agentList);
      view['streamingEl'].appendChild(block);
      view['scrollToBottom']();
    });

    await page.waitForTimeout(200);
    await shot(page, 'workflow-block-running.png', { fullPage: true });

    // Simulate workflow completion
    await page.evaluate(() => {
      const block = document.querySelector('.ct-workflow-block');
      if (block) {
        block.classList.add('ct-workflow-done');
        const phase = block.querySelector('.ct-workflow-phase');
        if (phase) phase.textContent = ' · Done';
      }
    });
    await page.waitForTimeout(200);
    await shot(page, 'workflow-block-done.png', { fullPage: true });
  });

  test('task list card', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.evaluate(() => (window as any).__view.focusThread('thread-tasks'));
    await page.waitForSelector('.ct-task-card:not(.ct-hidden)');
    // Hover the panel so the task card is expanded (it collapses at rest via CSS)
    await page.hover('.ct-floating-panel');
    await page.waitForTimeout(300); // let expand animation complete
    const header = await page.locator('.ct-task-card-header').innerText();
    if (!header.includes('5 tasks') || !header.includes('4 done, 1 in progress, 0 open')) {
      throw new Error(`Unexpected task card header: ${header}`);
    }
    await expect(page.locator('.ct-task-row-completed')).toHaveCount(4);
    await expect(page.locator('.ct-task-row-in_progress')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => (window as any).__view.getActiveThreadId())).toBe('thread-tasks');
    // Capture the intended bottom after async rendering and composer expansion.
    await anchorFocusedComposerToBottom(page);
    await shot(page, 'task-list-card.png', { fullPage: true });

    // Collapse on header click
    await page.click('.ct-task-card-header');
    await expect(page.locator('.ct-task-row')).toHaveCount(0);
  });

  test('status line — structured tag pills', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.waitForTimeout(150);
    // Drive the footer the same way StatusLineService would: store status tags
    // on the active thread (dev url, branch, PR with url, AWS warn tone).
    await page.evaluate(() => {
      (window as any).__manager.applyStatusTags('thread-brainstorm', [
        { label: 'http://localhost:3001', url: 'http://localhost:3001', kind: 'dev' },
        { label: 'feat/social-nudge', kind: 'branch' },
        { label: 'PR #225', url: 'https://github.com/acme/hip-trip/pull/225', kind: 'pr' },
        { label: 'AWS expired', tone: 'warn', kind: 'aws' },
      ]);
    });
    await page.waitForSelector('.ct-footer-pill-pr');
    // Four pills, in order, with the PR pill rendered.
    await expect(page.locator('.ct-footer-pill')).toHaveCount(4);
    await expect(page.locator('.ct-footer-pill-warn')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => (window as any).__view.getActiveThreadId())).toBe('thread-brainstorm');
    await anchorFocusedComposerToBottom(page);
    await shot(page, 'status-line-tags.png', { fullPage: true });
  });

  test('git diff bar — branch, diff stat, and Create PR split button', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.waitForTimeout(150);
    // Drive the bar the same way GitDiffService would: store git diff info on
    // the active thread (feature branch, base branch, a real diff, GitHub origin).
    await page.evaluate(() => {
      (window as any).__manager.applyGitDiff('thread-brainstorm', {
        isGitRepo: true,
        branch: 'feat/social-nudge',
        baseBranch: 'main',
        insertions: 60,
        deletions: 4,
        ownerRepo: { owner: 'acme', repo: 'hip-trip' },
      });
    });
    await page.waitForSelector('.ct-git-diff-bar:not(.ct-hidden)');
    await expect(page.locator('.ct-git-diff-branch-name')).toHaveText('feat/social-nudge');
    await expect(page.locator('.ct-git-diff-repo')).toHaveText('hip-trip');
    await expect(page.locator('.ct-git-diff-stat-add')).toHaveText('+60');
    await expect(page.locator('.ct-git-diff-stat-del')).toHaveText('-4');
    await expect(page.locator('.ct-git-diff-create-btn')).toHaveText('Create PR');
    await shot(page, 'git-diff-bar.png', { fullPage: true });

    // Open the split-button dropdown: 3 actions.
    await page.click('.ct-git-diff-dropdown-btn');
    await page.waitForSelector('.menu');
    const menuItems = await page.locator('.menu .menu-item').allTextContents();
    expect(menuItems).toEqual(['Create PR', 'Create draft PR', 'Manually create PR']);
    await shot(page, 'git-diff-bar-menu.png', { fullPage: true });
  });

  test('git diff bar — View PR when the thread already has an open PR', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.waitForTimeout(150);
    // Drive both the diff bar and the sticky prUrl the same way GitDiffService
    // and the status-line PR tag would: a real diff, plus an existing open PR.
    await page.evaluate(() => {
      (window as any).__manager.applyGitDiff('thread-brainstorm', {
        isGitRepo: true,
        branch: 'feat/social-nudge',
        baseBranch: 'main',
        insertions: 60,
        deletions: 4,
        ownerRepo: { owner: 'acme', repo: 'hip-trip' },
      });
      (window as any).__manager.applyStatusTags('thread-brainstorm', [
        { label: 'PR #225', url: 'https://github.com/acme/hip-trip/pull/225', kind: 'pr' },
      ]);
    });
    await page.waitForSelector('.ct-git-diff-bar:not(.ct-hidden)');
    // The bar's button carries the PR number itself...
    await expect(page.locator('.ct-git-diff-create-btn')).toHaveText('PR #225');
    // ...so the context footer must NOT also render a PR pill for the same PR.
    // (Regression: the footer previously showed "PR #225" directly above a bar
    // that already said so — either from the script's kind:'pr' tag or, once
    // that tag was removed, from the synthesized sticky-prUrl pill.)
    await expect(page.locator('.ct-footer-pill-pr')).toHaveCount(0);
    await shot(page, 'git-diff-bar-view-pr.png', { fullPage: true });

    // Open the split-button dropdown: View PR is prepended above the other 3 actions.
    await page.click('.ct-git-diff-dropdown-btn');
    await page.waitForSelector('.menu');
    const menuItems = await page.locator('.menu .menu-item').allTextContents();
    expect(menuItems).toEqual(['View PR', 'Create PR', 'Create draft PR', 'Manually create PR']);
  });

  test('context footer keeps the PR pill once the git diff bar hides', async ({ page }) => {
    // The dedupe is conditional, not a blanket removal: when the bar goes away
    // (PR merged → thread back on the base branch) the footer pill is the only
    // remaining surface for the PR, so it has to come back.
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.waitForTimeout(150);

    // Feature branch + open PR → bar visible, footer PR pill suppressed.
    await page.evaluate(() => {
      (window as any).__manager.applyStatusTags('thread-brainstorm', [
        { label: 'PR #225', url: 'https://github.com/acme/hip-trip/pull/225', kind: 'pr' },
      ]);
      (window as any).__manager.applyGitDiff('thread-brainstorm', {
        isGitRepo: true,
        branch: 'feat/social-nudge',
        baseBranch: 'main',
        insertions: 60,
        deletions: 4,
        ownerRepo: { owner: 'acme', repo: 'hip-trip' },
      });
    });
    await page.waitForSelector('.ct-git-diff-bar:not(.ct-hidden)');
    await expect(page.locator('.ct-footer-pill-pr')).toHaveCount(0);

    // PR merged, back on main → bar hides and the footer pill returns.
    await page.evaluate(() => {
      (window as any).__manager.applyGitDiff('thread-brainstorm', {
        isGitRepo: true,
        branch: 'main',
        baseBranch: 'main',
        isBaseBranch: true,
      });
    });
    await expect(page.locator('.ct-git-diff-bar')).toHaveClass(/ct-hidden/);
    await expect(page.locator('.ct-footer-pill-pr')).toHaveCount(1);
    await expect(page.locator('.ct-footer-pill-pr')).toContainText('PR #225');
  });

  test('git diff bar — ignores a stale PR left over from another repo/branch', async ({ page }) => {
    // Reproduces real data.json state: a thread that once worked in the `geode`
    // repo (picking up a sticky prUrl for geode PR #121) was later pointed at
    // the obsidian-claude-threads worktree via set_working_directory. prUrl is
    // never cleared, so the bar used to label THIS branch's button "PR #121"
    // and link to an unrelated closed PR in a different repo.
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.waitForTimeout(150);

    await page.evaluate(() => {
      // Sticky prUrl from the OLD repo...
      (window as any).__manager.applyStatusTags('thread-brainstorm', [
        { label: 'PR #121', url: 'https://github.com/rbcodelabs/geode/pull/121', kind: 'pr' },
      ]);
      // ...then the thread moves to a different repo, and the status-line script
      // (branch-scoped `gh pr view`) finds no PR for the new branch.
      (window as any).__manager.applyStatusTags('thread-brainstorm', []);
      (window as any).__manager.applyGitDiff('thread-brainstorm', {
        isGitRepo: true,
        branch: 'feat/social-nudge',
        baseBranch: 'main',
        insertions: 60,
        deletions: 4,
        ownerRepo: { owner: 'acme', repo: 'hip-trip' },
      });
    });
    await page.waitForSelector('.ct-git-diff-bar:not(.ct-hidden)');

    // The branch genuinely has no PR → offer to create one, never "PR #121".
    await expect(page.locator('.ct-git-diff-create-btn')).toHaveText('Create PR');
    // And the stale cross-repo PR must not leak into the footer either.
    await expect(page.locator('.ct-footer-pill-pr')).toHaveCount(0);
  });

  test('git diff bar — hidden for a non-git thread and for the base branch', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-messages');
    await page.evaluate(() => (window as any).__view.focusThread('thread-brainstorm'));
    await page.waitForTimeout(150);

    // Not a git repo at all — bar stays hidden.
    await page.evaluate(() => {
      (window as any).__manager.applyGitDiff('thread-brainstorm', { isGitRepo: false });
    });
    await page.waitForTimeout(50);
    await expect(page.locator('.ct-git-diff-bar')).toHaveClass(/ct-hidden/);

    // Sitting on the base branch itself — nothing to PR against, bar stays hidden.
    await page.evaluate(() => {
      (window as any).__manager.applyGitDiff('thread-brainstorm', {
        isGitRepo: true,
        branch: 'main',
        baseBranch: 'main',
        isBaseBranch: true,
      });
    });
    await page.waitForTimeout(50);
    await expect(page.locator('.ct-git-diff-bar')).toHaveClass(/ct-hidden/);
  });

  // ── Kanban board ──────────────────────────────────────────────────────────
  // Served from a dedicated harness (test/harness/kanban.html) that mounts
  // KanbanView against kanbanFixtureThreads. The wider 1180px board needs its
  // own viewport, separate from the 420px conversation-view tests above.

  const kanbanUrl = 'file://' + path.resolve('test/harness/kanban.html');

  test('kanban board — group by status', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');
    // Status mode is the default — assert the seven status columns are present.
    // (CSS text-transform uppercases the labels, so compare case-insensitively.)
    const labels = (await page.locator('.ct-kanban-col-label').allInnerTexts()).map(s => s.toUpperCase());
    for (const expected of ['Working', 'Awaiting', 'Waiting', 'New', 'Done', 'Failed', 'Ready']) {
      if (!labels.includes(expected.toUpperCase())) {
        throw new Error(`Status board missing the "${expected}" column. Got: ${labels.join(', ')}`);
      }
    }
    // The seeded waiting-thread card shows the hourglass icon and countdown text.
    // (Scoped to the accent class, not text — "Awaiting" contains "waiting" as
    // a substring so a text filter would match the wrong column.)
    const waitingCol = page.locator('.ct-kanban-col-waiting');
    await expect(waitingCol.locator('.ct-kanban-icon-waiting')).toHaveCount(1);
    await expect(waitingCol).toContainText('Resumes');
    await page.waitForTimeout(200);
    await shot(page, 'kanban-status.png', { fullPage: true });
  });

  test('kanban agent count reflects live activity and patches in place', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');
    await page.evaluate(() => {
      (window as any).__replaceAgentRuns('k-hiptrip-running', ['working', 'completed']);
      (window as any).__replaceAgentRuns('k-hiptrip-done', ['completed']);
    });

    const activeCard = page.locator('.ct-kanban-card').filter({ hasText: 'Add "why this place" provenance layer' });
    const terminalCard = page.locator('.ct-kanban-card').filter({ hasText: 'Fix auth middleware 401s' });
    const activeCount = activeCard.locator('.ct-kanban-agent-count');
    await expect(activeCount).toHaveClass(/ct-agent-count-active/);
    await expect(activeCount).toHaveCSS('color', 'rgb(76, 175, 80)');
    await expect(terminalCard.locator('.ct-kanban-agent-count')).not.toHaveClass(/ct-agent-count-active/);
    await expect(terminalCard.locator('.ct-kanban-agent-count')).toHaveCSS('color', 'rgb(85, 85, 85)');

    await activeCount.evaluate(el => el.setAttribute('data-patch-sentinel', 'same-node'));
    await page.evaluate(() => (window as any).__replaceAgentRuns('k-hiptrip-running', ['completed', 'failed']));
    await expect(activeCard.locator('.ct-kanban-agent-count')).toHaveAttribute('data-patch-sentinel', 'same-node');
    await expect(activeCard.locator('.ct-kanban-agent-count')).not.toHaveClass(/ct-agent-count-active/);

    await page.evaluate(() => (window as any).__replaceAgentRuns('k-hiptrip-running', []));
    await expect(activeCard.locator('.ct-kanban-agent-count')).toHaveCount(0);
    await page.evaluate(() => (window as any).__replaceAgentRuns('k-hiptrip-running', ['waiting']));
    await expect(activeCard.locator('.ct-kanban-agent-count')).toHaveClass(/ct-agent-count-active/);
  });

  test('kanban kickoff harness picker selects without dispatching', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');

    const harnessButton = page.locator('.ct-kanban-dispatch .ct-harness-send-btn');
    await expect(harnessButton).toHaveAttribute('aria-label', /Claude/);
    await harnessButton.click({ button: 'right' });

    const menu = page.locator('.ct-harness-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitemradio', { name: 'Claude' })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemradio', { name: 'Codex' })).toHaveCSS('min-height', '44px');

    await menu.getByRole('menuitemradio', { name: 'Codex' }).click();
    await expect(menu).toHaveCount(0);
    await expect(harnessButton).toHaveAttribute('aria-label', /Codex/);
    expect(await page.evaluate(() => (window as any).__dispatchCalls.length)).toBe(0);

    await harnessButton.click({ button: 'right' });
    const reopenedMenu = page.locator('.ct-harness-menu');
    await expect(reopenedMenu).toBeVisible();
    await shot(reopenedMenu, 'kanban-harness-picker.png');
  });

  test('kanban kickoff Project selector preserves the selected Project in dispatch options', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    const project = page.getByLabel('Dispatch Project');
    await expect(project).toHaveValue('');
    await project.selectOption('proj-hiptrip');
    await page.locator('.ct-kanban-dispatch .ct-agents-dispatch-input').fill('Plan the next HipTrip release');
    await page.locator('.ct-kanban-dispatch .ct-send-btn').click();

    const opts = await page.evaluate(() => (window as any).__dispatchCalls.at(-1)?.[3]);
    expect(opts).toMatchObject({ projectId: 'proj-hiptrip', agentHarness: 'claude' });
    await shot(page.locator('.ct-kanban-dispatch'), 'kanban-project-selector.png');
  });

  test('kanban kickoff Project selector fits a narrow mobile viewport', async ({ page }) => {
    for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 667 }]) {
      await page.setViewportSize(viewport);
      await page.goto(kanbanUrl + '?mobile=1');
      const project = page.getByLabel('Dispatch Project');
      await project.selectOption('proj-threads');
      const controls = [
        project,
        page.locator('.ct-kanban-groupby'),
        page.locator('.ct-agents-search-btn'),
      ];
      for (const control of controls) {
        await expect(control).toBeVisible();
        const box = await control.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
        expect(box?.width).toBeGreaterThanOrEqual(44);
      }
      await expect(page.locator('.ct-agents-count')).toBeVisible();
      if (viewport.width === 390) {
        await expect(page.locator('.ct-kanban-dispatch')).toHaveCSS('width', '358px');
        await shot(page.locator('.ct-kanban-dispatch'), 'kanban-project-selector-mobile.png');
      }
    }
  });

  test('kanban Project selector converges on create, rename, and delete', async ({ page }) => {
    await page.goto(kanbanUrl);
    const project = page.getByLabel('Dispatch Project');
    await project.selectOption('proj-hiptrip');

    await page.evaluate(() => (window as any).__manager.updateProject('proj-hiptrip', { name: 'HipTrip Studio' }));
    await expect(project.locator('option:checked')).toHaveText('HipTrip Studio');
    await expect(project).toHaveValue('proj-hiptrip');

    const createdId = await page.evaluate(() => (window as any).__manager.createProject('New Product', 'Projects/New').id);
    await expect(project.locator(`option[value="${createdId}"]`)).toHaveText('New Product');

    await page.evaluate(() => (window as any).__manager.deleteProject('proj-hiptrip'));
    await expect(project).toHaveValue('');
  });

  test('kanban board — group by folder swimlanes', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');
    await page.evaluate(() => (window as any).__setGroupBy('folder'));
    await page.waitForSelector('.ct-kanban-swimlanes');
    // One lane per app/project, alphabetical (case-insensitive) with Unassigned last.
    const lanes = await page.locator('.ct-kanban-lane-name').allInnerTexts();
    const expected = ['acme-api', 'Agent Threads', 'HipTrip', 'Unassigned'];
    if (JSON.stringify(lanes) !== JSON.stringify(expected)) {
      throw new Error(`Unexpected swimlane order. Expected ${expected.join(', ')} — got ${lanes.join(', ')}`);
    }
    await page.waitForTimeout(200);
    await shot(page, 'kanban-folder-swimlanes.png', { fullPage: true });
  });

  test('kanban board — group by project columns', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');
    await page.evaluate(() => (window as any).__setGroupBy('project'));
    await page.waitForSelector('.ct-kanban-project-col');

    // One vertical column per app/project — same alphabetical (case-insensitive),
    // Unassigned-last ordering as folder swimlanes (both share sortGroupEntries()).
    // (CSS text-transform uppercases .ct-kanban-col-label, same as the status board —
    // compare case-insensitively, same pattern as the "group by status" test above.)
    const columns = (await page.locator('.ct-kanban-project-col .ct-kanban-col-label').allInnerTexts()).map(s => s.toUpperCase());
    const expected = ['acme-api', 'Agent Threads', 'HipTrip', 'Unassigned'].map(s => s.toUpperCase());
    if (JSON.stringify(columns) !== JSON.stringify(expected)) {
      throw new Error(`Unexpected project column order. Expected ${expected.join(', ')} — got ${columns.join(', ')}`);
    }

    // HipTrip: threads are grouped under sidebar-style status SECTIONS, not the
    // status board's 7 columns — there is never a separate Awaiting section
    // anywhere on this board (it always folds into Working; see the
    // "awaiting folds into Working" unit tests in kanban-project-columns.test.ts
    // for the bucketing logic itself — the harness's seeded running/awaiting
    // threads don't actually flip ThreadManager.isRunning() true, so this
    // screenshot test sticks to what's reliably observable: Waiting/New/Reviewed).
    const hiptripCol = page.locator('.ct-kanban-project-col').filter({
      has: page.locator('.ct-kanban-col-label', { hasText: 'HipTrip' }),
    });
    const hiptripSections = (await hiptripCol.locator('.ct-kanban-project-section-name').allInnerTexts()).map(s => s.toUpperCase());
    for (const expectedLabel of ['Waiting', 'New', 'Reviewed']) {
      if (!hiptripSections.includes(expectedLabel.toUpperCase())) {
        throw new Error(`HipTrip column missing the "${expectedLabel}" section. Got: ${hiptripSections.join(', ')}`);
      }
    }
    if (hiptripSections.includes('AWAITING')) {
      throw new Error('Project-columns mode must fold Awaiting into Working, not render a separate Awaiting section');
    }

    // Agent Threads surfaces a non-default section (Failed).
    const threadsCol = page.locator('.ct-kanban-project-col').filter({
      has: page.locator('.ct-kanban-col-label', { hasText: 'Agent Threads' }),
    });
    await expect(threadsCol.locator('.ct-kanban-project-section-name', { hasText: 'Failed' })).toHaveCount(1);

    // New section carries a badge with its thread count.
    const hiptripNewLabel = hiptripCol.locator('.ct-kanban-project-section-label').filter({
      has: page.locator('.ct-kanban-project-section-name', { hasText: 'New' }),
    });
    await expect(hiptripNewLabel.locator('.ct-kanban-badge')).toHaveCount(1);

    await page.waitForTimeout(200);
    await shot(page, 'kanban-project-columns.png', { fullPage: true });
  });

  test('agents list — project-first adaptive rows', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 820 });
    await page.goto(kanbanUrl + '?dashboard=1');
    await page.waitForSelector('.ct-agents-project');
    expect(await page.evaluate(() => (window as any).__dashboard.getDisplayText())).toBe('Agents · 14 threads');
    expect(await page.evaluate(() => (window as any).__dashboard.getIcon())).toBe('list');
    await expect(page.locator('.view-header')).toBeVisible();
    await expect(page.locator('.view-header-title')).toHaveText('Agents · 14 threads');
    await expect(page.locator('.ct-agents-header')).toHaveCount(0);
    await expect(page.locator('.view-actions .view-action')).toHaveCount(2);
    await expect(page.locator('.ct-agents-floating-panel .ct-agents-count')).toHaveCount(0);
    await expect(page.locator('.ct-agents-floating-panel .ct-agents-search-btn')).toHaveCount(0);

    const projects = await page.locator('.ct-agents-project-name').allInnerTexts();
    expect(projects.slice(0, 2)).toEqual(['acme-api', 'Agent Threads']);
    expect(projects.at(-1)).toBe('Unassigned');

    const hiptrip = page.locator('.ct-agents-project').filter({
      has: page.locator('.ct-agents-project-name', { hasText: 'HipTrip' }),
    });
    const sections = (await hiptrip.locator('.ct-agents-group-label > span:first-child').allInnerTexts()).map(label => label.trim().toUpperCase());
    expect(sections).toEqual(expect.arrayContaining(['WORKING', 'WAITING', 'NEW', 'REVIEWED']));
    expect(sections.indexOf('WORKING')).toBeLessThan(sections.indexOf('WAITING'));
    expect(sections.indexOf('WAITING')).toBeLessThan(sections.indexOf('NEW'));

    const normalRow = hiptrip.locator('.ct-agents-row:not(.ct-agents-row-permission):not(.ct-agents-row-waiting)').first();
    await expect(normalRow.locator('.ct-agents-row-summary')).toHaveCount(0);
    await expect(normalRow.locator('.ct-agents-row-primary')).toHaveCount(1);
    await expect(normalRow.locator('.ct-agents-row-secondary')).toHaveCount(1);
    await expect(normalRow.locator('.ct-agents-row-primary .ct-agents-row-title')).toBeVisible();
    await expect(normalRow.locator('.ct-agents-row-primary .ct-agents-row-time')).toBeVisible();
    await expect(normalRow.locator('.ct-agents-row-secondary .ct-agents-row-activity')).toBeVisible();
    await expect(normalRow.locator('.ct-agents-row-secondary .ct-agents-row-cwd')).toBeVisible();

    await page.evaluate(() => (window as any).__replaceAgentRuns('k-hiptrip-done', ['completed']));
    await expect(hiptrip.locator('.ct-dashboard-agent-count')).toHaveCount(2);
    const runningRow = hiptrip.locator('.ct-agents-row').filter({ hasText: 'Add "why this place" provenance layer' });
    await expect(runningRow.locator('.ct-dashboard-agent-count')).toHaveText('7 agents');
    await expect(runningRow.locator('.ct-dashboard-agent-count')).toHaveClass(/ct-agent-count-active/);
    const completedRow = hiptrip.locator('.ct-agents-row').filter({ hasText: 'Fix auth middleware 401s' });
    await expect(completedRow.locator('.ct-dashboard-agent-count')).not.toHaveClass(/ct-agent-count-active/);
    await expect(completedRow.locator('.ct-dashboard-agent-count')).toHaveCSS('color', 'rgb(85, 85, 85)');
    await expect(hiptrip.locator('.ct-dashboard-agent')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__manager.getSelectedAgentRun('k-hiptrip-running'))).toBeUndefined();
    await runningRow.locator('.ct-dashboard-agent-count').click();
    expect(await page.evaluate(() => (window as any).__manager.getSelectedAgentRun('k-hiptrip-running'))).toBeUndefined();
    expect(await page.evaluate(() => (window as any).__openedAgentTeams)).toEqual(['k-hiptrip-running']);

    const permissionRow = page.locator('.ct-agents-row-permission:not(.ct-agents-row-plan):not(.ct-agents-row-question)');
    await expect(permissionRow.locator('.ct-agents-permission-actions')).toBeVisible();
    expect((await permissionRow.boundingBox())?.height).toBeGreaterThan(44);

    const planRow = page.locator('.ct-agents-row-plan');
    await expect(planRow).toContainText('Plan ready — open to review');
    expect((await planRow.boundingBox())?.height).toBeGreaterThan(44);
    const questionRow = page.locator('.ct-agents-row-question');
    await expect(questionRow).toContainText('Question ready — open to answer');
    expect((await questionRow.boundingBox())?.height).toBeGreaterThan(44);

    await shot(page, 'agent-dashboard-project-first.png', { fullPage: true });
  });

  test('agents list — grouping toggles and sibling search panel', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 820 });
    await page.goto(kanbanUrl + '?dashboard=1');
    await page.waitForSelector('.view-header');

    const root = page.locator('.ct-dashboard-root');
    const header = page.locator('.view-header');
    const searchButton = page.getByRole('button', { name: 'Search threads' });
    const headerUpdatesAfterInitialRender = await page.evaluate(() => (window as any).__getHeaderUpdateCalls());
    await page.evaluate(() => (window as any).__dashboard.render());
    expect(await page.evaluate(() => (window as any).__getHeaderUpdateCalls())).toBe(headerUpdatesAfterInitialRender);
    const headerHeight = await header.evaluate(el => el.getBoundingClientRect().height);
    await searchButton.click();
    const searchPanel = page.locator('.ct-agents-search-bar');
    await expect(searchPanel).toBeVisible();
    expect(await root.evaluate(el => Array.from(el.children).map(child => child.className))).toEqual(
      expect.arrayContaining([expect.stringContaining('ct-agents-search-bar')]),
    );
    expect(await header.evaluate(el => el.getBoundingClientRect().height)).toBe(headerHeight);
    const search = page.getByPlaceholder('Search threads…');
    await expect(search).toBeFocused();
    await search.fill('Mobile layout polish');
    await expect(page.locator('.ct-agents-row')).toHaveCount(1);
    await expect(page.locator('.view-header-title')).toHaveText('Agents · 1 thread');
    await page.locator('.search-input-clear-button').click();
    await expect(search).toHaveValue('');
    await expect(page.locator('.view-header-title')).toHaveText('Agents · 14 threads');
    await search.fill('Mobile layout polish');
    await search.press('Escape');
    await expect(searchPanel).toBeHidden();
    await expect(page.locator('.ct-agents-row')).not.toHaveCount(1);
    await searchButton.click();
    await search.fill('Kanban');
    await searchButton.click();
    await expect(searchPanel).toBeHidden();
    await expect(page.locator('.view-header-title')).toHaveText('Agents · 14 threads');

    const groupingButton = page.getByRole('button', { name: 'Group agents' });
    await groupingButton.click();
    const menu = page.locator('.menu');
    const projectItem = menu.getByRole('menuitemcheckbox', { name: 'Project' });
    const statusItem = menu.getByRole('menuitemcheckbox', { name: 'Status' });
    await expect(projectItem).toHaveAttribute('aria-checked', 'true');
    await expect(statusItem).toHaveAttribute('aria-checked', 'true');

    const savesBefore = await page.evaluate(() => (window as any).__getSaveSettingsCalls());
    await statusItem.click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator('.ct-agents-project')).not.toHaveCount(0);
    await expect(page.locator('.ct-agents-project .ct-agents-group-label')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__getAgentsGroupBy())).toBe('project');

    await groupingButton.click();
    const projectOnlyMenu = page.locator('.menu');
    await expect(projectOnlyMenu.getByRole('menuitemcheckbox', { name: 'Project' })).toHaveAttribute('aria-disabled', 'true');
    await projectOnlyMenu.getByRole('menuitemcheckbox', { name: 'Status' }).click();
    await groupingButton.click();
    await page.locator('.menu').getByRole('menuitemcheckbox', { name: 'Project' }).click();
    await groupingButton.click();
    await expect(page.locator('.menu').getByRole('menuitemcheckbox', { name: 'Status' })).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('.ct-agents-project')).toHaveCount(0);
    await expect(page.locator('.ct-agents-status-section')).not.toHaveCount(0);
    await expect(page.locator('.ct-agents-row-project').first()).toBeVisible();
    expect(await page.evaluate(() => (window as any).__getAgentsGroupBy())).toBe('status');
    expect(await page.evaluate(() => (window as any).__getSaveSettingsCalls())).toBe(savesBefore + 3);

    await page.evaluate(async () => {
      const dashboard = (window as any).__dashboard;
      await dashboard.onClose();
      await dashboard.onOpen();
    });
    await expect(page.locator('.view-actions .view-action')).toHaveCount(2);
  });

  test('agents list — themed Project menu selects, checks, and dispatches a Project', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(kanbanUrl + '?dashboard=1');

    const trigger = page.getByRole('button', { name: 'Dispatch Project: No Project' });
    await page.locator('.ct-agents-floating-panel').hover();
    await expect(trigger).toBeVisible();
    await trigger.click();

    let menu = page.locator('.menu');
    await expect(menu.getByRole('menuitemcheckbox', { name: 'No Project' })).toHaveAttribute('aria-checked', 'true');
    await menu.getByRole('menuitemcheckbox', { name: 'HipTrip' }).click();
    await expect(page.getByRole('button', { name: 'Dispatch Project: HipTrip' })).toBeVisible();

    await page.getByPlaceholder('Dispatch a task...').fill('Ship the themed menu');
    await page.getByPlaceholder('Dispatch a task...').press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__dispatchCalls.length)).toBe(1);
    expect(await page.evaluate(() => (window as any).__dispatchCalls[0][3].projectId)).toBe('proj-hiptrip');

    await page.getByRole('button', { name: 'Dispatch Project: HipTrip' }).click();
    menu = page.locator('.menu');
    await expect(menu.getByRole('menuitemcheckbox', { name: 'HipTrip' })).toHaveAttribute('aria-checked', 'true');
    await shot(page, 'agent-dashboard-project-menu.png', { fullPage: true });
  });

  // Non-visual: the archive menu adds no resting-state DOM, so there is nothing
  // to snapshot. This drives the real listener end to end instead — right-click,
  // read the rendered menu, click the item, and confirm the thread is gone.
  test('agents list — right-click archives a thread', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 820 });
    await page.goto(kanbanUrl + '?dashboard=1');
    await page.waitForSelector('.ct-agents-project');

    const before = await page.evaluate(() => (window as any).__manager.getThreads().length);

    await page.locator('.ct-agents-row-idle').first().click({ button: 'right' });
    const menu = page.locator('.menu');
    await expect(menu).toHaveCount(1);
    expect(await menu.locator('.menu-item').allInnerTexts()).toEqual(['Archive thread']);

    await menu.locator('.menu-item').first().click();

    // One idle, non-orchestrator thread archives outright — no dialog.
    await expect(page.locator('.modal-container')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).__archivedThreadIds)).toHaveLength(1);

    const [archivedId] = await page.evaluate(() => (window as any).__archivedThreadIds);
    // deleteThread emits `thread_deleted`, which the dashboard already maps to
    // scheduleRender() — so no re-render call is needed in the menu code itself.
    expect(await page.evaluate((id) => (window as any).__manager.getThread(id), archivedId)).toBeFalsy();
    await expect.poll(() => page.evaluate(() => (window as any).__manager.getThreads().length)).toBe(before - 1);
  });

  test('agents list — right-click a scheduled-job rollup offers a bulk archive', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 820 });
    await page.goto(kanbanUrl + '?dashboard=1');
    await page.waitForSelector('.ct-agents-row-scheduled-stack');

    const rollup = page.locator('.ct-agents-row-scheduled-stack').first();
    await expect(rollup.locator('.ct-agents-stack-count')).toHaveText('×3');
    await rollup.click({ button: 'right' });

    // All three runs of Hourly Triage sit in this one rollup (M === N), so there
    // is no "all M runs of this job" item to offer.
    expect(await page.locator('.menu .menu-item').allInnerTexts()).toEqual(['Archive these 3 runs']);
  });

  test('agents list — long scheduled-job names truncate without hiding row controls', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 844 });
    await page.goto(kanbanUrl + '?dashboard=1');
    await page.waitForSelector('.ct-agents-row-scheduled-stack');
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      for (const thread of manager.getThreads()) {
        if (thread.scheduledItemId === 'sched-hourly-triage') {
          thread.scheduledItemName = 'HipTrip Experiment Watchdog With An Intentionally Long Scheduled Job Name';
        }
      }
      (window as any).__dashboard.render();
    });
    await page.locator('#app').evaluate(host => { host.style.width = '280px'; });

    const list = page.locator('.ct-agents-list');
    const row = page.locator('.ct-agents-row-scheduled-stack').first();
    const title = row.locator('.ct-agents-row-title-text');
    await expect(title).toBeVisible();
    await expect(title).toHaveCSS('white-space', 'nowrap');
    await expect(title).toHaveCSS('text-overflow', 'ellipsis');
    expect(await title.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(row.locator('.ct-agents-stack-count')).toBeVisible();
    await expect(row.locator('.ct-agents-row-time')).toBeVisible();
    await expect(row.locator('.ct-expand-btn')).toBeVisible();
    expect(await list.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);

    await shot(row, 'agent-dashboard-scheduled-row-narrow.png');
    await row.click();
    await expect(page.locator('.ct-agents-stack-body .ct-agents-row')).toHaveCount(3);
  });

  for (const { width, height } of [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 760, height: 844 },
    { width: 1240, height: 844 },
  ]) {
    test(`agents list — two-line rows avoid horizontal overflow at ${width}x${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto(kanbanUrl + '?dashboard=1');
      await page.waitForSelector('.ct-agents-row-primary');

      await expect(page.locator('.ct-agents-row-primary').first()).toBeVisible();
      await expect(page.locator('.ct-agents-row-secondary').first()).toBeVisible();
      expect(await page.locator('.ct-agents-list').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.locator('.ct-agents-row').evaluateAll(rows => rows.every(row => row.scrollWidth <= row.clientWidth))).toBe(true);

      await shot(page, `agents-list-${width}.png`, { fullPage: true });
    });
  }

  test('agents list — responds to pane width inside a wide workspace', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 844 });
    await page.goto(kanbanUrl + '?dashboard=1');
    await page.waitForSelector('.ct-dashboard-root');

    for (const width of [280, 320, 380, 760, 1160]) {
      await page.locator('#app').evaluate((host, paneWidth) => {
        host.style.width = `${paneWidth}px`;
      }, width);

      const list = page.locator('.ct-agents-list');
      await expect(list).toHaveCSS('width', `${width}px`);
      expect(await list.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.locator('.ct-agents-row').evaluateAll(rows => rows.every(row => row.scrollWidth <= row.clientWidth))).toBe(true);
      expect(await page.locator('.view-header').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect(page.locator('.view-actions .view-action')).toHaveCount(2);

      if (width <= 380) {
        await expect(page.locator('.ct-agents-row').first()).toHaveCSS('min-height', '52px');
        await expect(page.locator('.ct-dashboard-agent-count')).toHaveCSS('min-height', '28px');
        await expect(page.locator('.ct-agents-row-cwd').first()).toBeHidden();

        await page.locator('.ct-agents-floating-panel').hover();
        await expect(page.locator('.ct-dispatch-project')).toBeVisible();
        await expect(page.locator('.ct-dispatch-project-label')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Dispatch Project: No Project' })).toBeVisible();
        expect(await page.locator('.ct-agents-panel-meta').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await expect.poll(() => page.locator('.ct-agents-panel-meta').evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true);
        if (width === 320) await shot(page.locator('#app'), 'agent-dashboard-narrow-desktop.png');
      }
    }
  });

  test('agents list — orchestrator badge remains visible beside a truncated title', async ({ page }) => {
    await page.setViewportSize({ width: 1240, height: 844 });
    await page.goto(kanbanUrl + '?dashboard=1');
    await page.evaluate(() => (window as any).__setOrchestrator('k-hiptrip-running'));
    await page.locator('#app').evaluate(host => { host.style.width = '280px'; });
    const row = page.locator('.ct-agents-row').filter({ has: page.locator('.ct-portfolio-orchestrator-badge') });
    const badge = row.locator('.ct-portfolio-orchestrator-badge');
    await expect(badge).toBeVisible();
    const bounds = await row.evaluate((rowEl) => {
      const badgeEl = rowEl.querySelector('.ct-orchestrator-badge')!;
      const rowRect = rowEl.getBoundingClientRect();
      const badgeRect = badgeEl.getBoundingClientRect();
      return { left: badgeRect.left >= rowRect.left, right: badgeRect.right <= rowRect.right };
    });
    expect(bounds).toEqual({ left: true, right: true });
    await expect(row.locator('.ct-agents-row-title-text')).toHaveCSS('text-overflow', 'ellipsis');
  });

  test('agents list — narrow exceptional states remain usable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(kanbanUrl + '?dashboard=1&mobile=1');
    await page.waitForSelector('.ct-agents-row-plan');
    await expect(page.locator('.ct-agents-permission-actions .ct-permission-btn').first()).toHaveCSS('min-height', '44px');
    await expect(page.locator('.ct-dashboard-agent-count')).toHaveCSS('min-height', '44px');
    const projectTrigger = page.getByRole('button', { name: 'Dispatch Project: No Project' });
    await expect(projectTrigger).toBeVisible();
    expect((await projectTrigger.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await page.locator('.ct-agents-panel-meta').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator('.ct-agents-list').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await shot(page, 'agent-dashboard-exceptional-mobile.png', { fullPage: true });
  });

  test('conversation footer responds to narrow pane width inside a wide workspace', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    for (const width of [280, 320, 380]) {
      await page.goto(harnessUrl);
      await page.waitForSelector('.ct-input-footer');
      await page.locator('#app').evaluate((host, paneWidth) => { host.style.width = `${paneWidth}px`; }, width);
      await expect(page.locator('.ct-footer-cwd')).toBeHidden();

      const readFooterLayout = () => page.evaluate(() => {
        const meta = document.querySelector('.ct-input-footer-meta')!.getBoundingClientRect();
        const actions = document.querySelector('.ct-input-footer-actions')!.getBoundingClientRect();
        const footer = document.querySelector('.ct-input-footer')!;
        return {
          overlaps: meta.right > actions.left,
          clips: footer.scrollHeight > footer.clientHeight,
          meta: { left: meta.left, right: meta.right, width: meta.width },
          actions: { left: actions.left, right: actions.right, width: actions.width },
          clientHeight: footer.clientHeight,
          scrollHeight: footer.scrollHeight,
        };
      });

      // Resting: the optional footer remains intentionally collapsed.
      await page.evaluate(() => (window as any).__view.focusThread('thread-fix-auth'));
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.mouse.move(1200, 0);
      await expect.poll(() => page.locator('.ct-input-footer').evaluate(el => getComputedStyle(el).maxHeight)).toBe('0px');
      expect(await page.locator('.ct-input-footer').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);

      // Focused: actions reveal without overlapping or being clipped.
      await page.locator('.ct-input').focus();
      await expect.poll(async () => (await readFooterLayout()).clips).toBe(false);
      let footerLayout = await readFooterLayout();
      expect(footerLayout, `focused footer at ${width}px: ${JSON.stringify(footerLayout)}`).toMatchObject({ overlaps: false, clips: false });

      // Agent-active: the compact 22px pill pins the footer on desktop.
      await page.evaluate(seedAgentTeam);
      await page.locator('.ct-input').blur();
      await expect(page.locator('.ct-agent-pill')).toHaveCSS('min-height', '22px');
      await expect.poll(async () => (await readFooterLayout()).clips).toBe(false);
      footerLayout = await readFooterLayout();
      expect(footerLayout, `agent footer at ${width}px: ${JSON.stringify(footerLayout)}`).toMatchObject({ overlaps: false, clips: false });
      if (width === 320) await shot(page.locator('#app'), 'conversation-footer-narrow-desktop.png');

      // Scheduled activity independently pins the same footer without agents.
      await page.evaluate(() => {
        (window as any).__setWakeup('thread-brainstorm', Date.now() + 240_000, 'check CI status');
        (window as any).__view.focusThread('thread-brainstorm');
      });
      await expect(page.locator('.ct-schedule-pill')).toBeVisible();
      await expect.poll(async () => (await readFooterLayout()).clips).toBe(false);
      footerLayout = await readFooterLayout();
      expect(footerLayout, `scheduled footer at ${width}px: ${JSON.stringify(footerLayout)}`).toMatchObject({ overlaps: false, clips: false });
      expect(await page.locator('.ct-input-footer').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
  });

  test('regression: kanban card moves Working → Waiting automatically on run_state_settled', async ({ page }) => {
    // Same run-state-settling root cause as the scheduled-pill test above, on the dashboard
    // side: KanbanView.handleEvent's isStateChange didn't include
    // wakeup_changed/run_state_settled, so a thread that finished with a
    // pending wake-up stayed bucketed under "Working" until an unrelated
    // event forced a re-render.
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');

    const cardTitle = 'Add "why this place" provenance layer'; // kanbanRunningThreadId's card
    const workingCard = page.locator('.ct-kanban-col', { hasText: 'Working' }).getByText(cardTitle);
    await expect(workingCard).toBeVisible();

    await page.evaluate(() => {
      const w = window as any;
      const threadId = 'k-hiptrip-running'; // kanbanRunningThreadId
      const fireAt = new Date('2026-01-15T10:04:00Z').getTime();
      w.__addWakeup(threadId, fireAt, 'check CI status');
    });
    // Still running (seeded running at harness load) — must stay in Working.
    await expect(workingCard).toBeVisible();

    await page.evaluate(() => (window as any).__setThreadRunning('k-hiptrip-running', false));
    // isRunning() just went false, but no event fired — must NOT move yet.
    await expect(workingCard).toBeVisible();

    await page.evaluate(() => (window as any).__fireRunStateSettled('k-hiptrip-running'));
    // This is the fix under test: the card re-buckets into Waiting from the
    // event alone — no manual render() call, no group-by toggle, no reload.
    const waitingCard = page.locator('.ct-kanban-col-waiting').getByText(cardTitle);
    await expect(waitingCard).toBeVisible({ timeout: 2000 });
    await expect(page.locator('.ct-kanban-col', { hasText: 'Working' }).getByText(cardTitle)).toHaveCount(0);
  });

  test('kanban board — orchestrator badge on matching card', async ({ page }) => {
    // appendOrchestratorBadge only fires when a card's threadId matches
    // settings.orchestratorThreadId — confirm the bot badge appears next to
    // that one card's title and no other card's.
    await page.setViewportSize({ width: 1240, height: 820 });
    await page.goto(kanbanUrl);
    await page.waitForSelector('.ct-kanban-board');

    const cardTitle = 'Add "why this place" provenance layer'; // kanbanRunningThreadId's card
    await expect(page.locator('.ct-orchestrator-badge')).toHaveCount(0);

    await page.evaluate(() => (window as any).__setOrchestrator('k-hiptrip-running'));
    const badgedCard = page.locator('.ct-kanban-card', { hasText: cardTitle });
    await expect(badgedCard.locator('.ct-orchestrator-badge')).toHaveCount(1);
    await expect(page.locator('.ct-orchestrator-badge')).toHaveCount(1);
    await page.waitForTimeout(200);
    await shot(page, 'kanban-orchestrator-badge.png', { fullPage: true });
  });

  // ─── Status area redesign ─────────────────────────────────────────────────

  test('queue rows — stacked removable rows above composer', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Inject 3 queued messages into the active thread via manager internals
    await page.evaluate(() => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const threadId = view['activeThreadId'];
      if (!threadId) throw new Error('No active thread');
      // Set running state so the queue accumulates (not auto-sent)
      manager['isRunningMap'] = manager['isRunningMap'] ?? new Map();
      manager['runningThreads'] = manager['runningThreads'] ?? new Set();
      manager['runningThreads'].add(threadId);
      // Push 3 items into the private queue map
      const queue = [
        { text: 'Quick reply about the deploy status, is it green yet?' },
        { text: 'Need help with the rate limit logs from last night' },
        { text: 'Can you draft an email to Lindsey about the timeline change?' },
      ];
      manager['queuedMessages'].set(threadId, queue);
      // Fire a queued event so the view re-renders
      view['renderQueueRows']();
    });
    await page.waitForSelector('.ct-queue-row');
    await shot(page, 'queue-rows.png', { fullPage: true });
  });

  test('status rail — active-work card with spinner', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Show a "Compacting context…" active-work card in the rail
    await page.evaluate(() => {
      const view = (window as any).__view;
      view['showStatusCard']('active', 'Compacting context…');
    });
    await page.waitForSelector('.ct-status-card-active');
    await shot(page, 'status-rail-active-card.png', { fullPage: true });
  });

  test('thinking spinner — shown before first token', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Trigger the streaming placeholder (thinking spinner) via private method
    await page.evaluate(() => {
      const view = (window as any).__view;
      view['createStreamingEl']();
      view['scrollToBottom']();
    });
    await page.waitForSelector('.ct-thinking-spinner');
    await page.waitForTimeout(200);
    await shot(page, 'thinking-spinner.png', { fullPage: true });
  });

  test('model escalation tip — popover above model button', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const view = (window as any).__view;
      view['showModelEscalationTip']('⚡ Using claude-sonnet-4-5 for this turn');
    });
    await page.waitForSelector('.ct-escalation-tip');
    // Playwright freezes CSS animations at frame 0 (opacity: 0). Override to show
    // the tip at full opacity for the snapshot.
    await page.addStyleTag({ content: '.ct-escalation-tip { animation: none !important; opacity: 1 !important; transform: translateX(-50%) !important; }' });
    await page.waitForTimeout(100);
    await shot(page, 'model-escalation-tip.png', { fullPage: true });
  });

  test('model escalation — menu reflects the temporary model for the whole turn', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Drive the real event path: ThreadManager emits 'escalated' at turn start.
    await page.evaluate(() => {
      const view = (window as any).__view;
      const manager = (window as any).__manager;
      manager['emit'](view['activeThreadId'], { type: 'escalated', model: 'opus' });
    });
    await page.hover('.ct-floating-panel');
    await page.click('.ct-thread-more-btn');
    await expect(page.locator('.menu')).toContainText('Model: opus (this turn)');
    await page.waitForTimeout(100);
    await shot(page, 'model-escalation-turn-button.png', { fullPage: true });
    await page.mouse.click(0, 0);
    // Turn end clears the temporary menu label.
    await page.evaluate(() => {
      const view = (window as any).__view;
      const manager = (window as any).__manager;
      manager['emit'](view['activeThreadId'], { type: 'done' });
    });
    await page.hover('.ct-floating-panel');
    await page.click('.ct-thread-more-btn');
    await expect(page.locator('.menu')).toContainText('Model: Default');
    await expect(page.locator('.menu')).not.toContainText('(this turn)');
  });

  // ─── SDK alignment gap features (Group 4 + 5) ────────────────────────────

  test('plan mode — planning state card', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Trigger the "Planning..." status card the same way the enter_plan_mode event does.
    await page.evaluate(() => {
      const view = (window as any).__view;
      view['createStreamingEl']();
      view['showStatusCard']('active', 'Planning...');
      view['scrollToBottom']();
    });
    await page.waitForSelector('.ct-status-card-active');
    await expect(page.locator('.ct-status-card-active')).toContainText('Planning...');
    await shot(page, 'plan-mode-planning.png', { fullPage: true });
  });

  test('plan mode — approve/reject card', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Render the plan approval card with sample plan text.
    await page.evaluate(() => {
      const view = (window as any).__view;
      view['createStreamingEl']();
      const planText = [
        '## Plan: Fix the auth middleware',
        '',
        '**Step 1:** Read src/middleware/auth.ts to understand the current implementation.',
        '**Step 2:** Identify the JWT_SECRET fallback bug.',
        '**Step 3:** Fix the empty-string fallback — throw on startup instead.',
        '**Step 4:** Add a test covering the missing-secret case.',
        '**Step 5:** Verify tsc and tests pass.',
      ].join('\n');
      // approve/reject are no-ops for the screenshot
      view['renderPlanCard'](planText, () => {}, () => {});
      view['scrollToBottom']();
    });
    await page.waitForSelector('.ct-plan-card');
    // Wait for async markdown rendering to finish
    await page.waitForSelector('.ct-plan-md', { state: 'visible' });
    await page.waitForTimeout(200);
    await expect(page.locator('.ct-plan-card')).toBeVisible();
    await expect(page.locator('.ct-plan-approve')).toBeVisible();
    await expect(page.locator('.ct-plan-edit')).toBeVisible();
    await expect(page.locator('.ct-plan-reject')).toBeVisible();
    // Default view should show rendered markdown, not a textarea
    await expect(page.locator('.ct-plan-md')).toBeVisible();
    await expect(page.locator('.ct-plan-textarea')).not.toBeVisible();
    await shot(page, 'plan-mode-approve-reject.png', { fullPage: true });
  });

  test('proposed reply — inline card', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    // thread-proposed-reply's fixture has thread.proposedReply pre-seeded, so
    // switching to it exercises the real restore path (setActiveThread ->
    // renderProposedReplyCard after renderMessages wipes messagesEl) rather
    // than calling the render method directly.
    await page.evaluate(() => (window as any).__view.focusThread('thread-proposed-reply'));
    await page.waitForSelector('.ct-proposed-reply-card');
    // Wait for async markdown rendering to finish
    await page.waitForSelector('.ct-proposed-reply-md', { state: 'visible' });
    await page.waitForTimeout(200);
    await expect(page.locator('.ct-proposed-reply-card')).toBeVisible();
    await expect(page.locator('.ct-proposed-reply-approve')).toBeVisible();
    await expect(page.locator('.ct-proposed-reply-edit')).toBeVisible();
    await expect(page.locator('.ct-proposed-reply-discard')).toBeVisible();
    await expect(page.locator('.ct-proposed-reply-label')).toHaveText('Proposed reply');
    await expect.poll(() => page.evaluate(() => (window as any).__view.getActiveThreadId())).toBe('thread-proposed-reply');
    await anchorFocusedComposerToBottom(page);
    await shot(page, 'proposed-reply-card.png', { fullPage: true });
  });

  test('context usage panel', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForSelector('.ct-messages');
    await page.waitForTimeout(500);
    // Render the context usage card with a representative usage snapshot.
    await page.evaluate(() => {
      const view = (window as any).__view;
      const fakeUsage = {
        totalTokens: 42850,
        maxTokens: 200000,
        percentage: 21.4,
        categories: [
          { name: 'System prompt', tokens: 3200, color: '#4b9cd3' },
          { name: 'Tools', tokens: 8400, color: '#7cb9e8' },
          { name: 'Messages', tokens: 28050, color: '#97c1e8' },
          { name: 'MCP tools', tokens: 3200, color: '#b0cfe8' },
        ],
        agents: [],
      };
      view['renderContextUsageCard'](fakeUsage);
      view['scrollToBottom']();
    });
    await page.waitForSelector('.ct-context-usage-card');
    await expect(page.locator('.ct-context-usage-card')).toBeVisible();
    await expect(page.locator('.ct-context-usage-title')).toContainText('Context usage');
    await shot(page, 'context-usage-panel.png', { fullPage: true });
  });

  for (const usageViewport of [
    { name: 'desktop', width: 1280, height: 800, golden: 'usage-panel-desktop.png' },
    { name: 'mobile', width: 390, height: 844, golden: 'usage-panel-mobile.png' },
    { name: 'mobile SE', width: 375, height: 667, golden: 'usage-panel-mobile-se.png' },
  ]) {
    test(`usage panel — ${usageViewport.name}`, async ({ page }) => {
      await page.setViewportSize({ width: usageViewport.width, height: usageViewport.height });
      await page.goto(harnessUrl);
      await page.waitForSelector('.ct-messages');
      await page.evaluate(() => {
        const view = (window as any).__view;
        view['renderUsageCard']({
          provider: 'codex', updatedAt: new Date('2026-08-17T14:00:00-04:00').getTime(),
          tokens: { total: 42000, input: 35000, cachedInput: 12000, output: 7000, reasoning: 2000 },
          lastTurnTokens: { total: 2400 },
          quotaWindows: [
            { label: '5 hours', usedPercent: 84, resetsAt: new Date('2026-08-17T15:00:00-04:00').getTime() },
            { label: '7 days', usedPercent: 100, resetsAt: new Date('2026-08-24T14:00:00-04:00').getTime() },
          ],
          accountUsage: {
            lifetimeTokens: 125000, peakDailyTokens: 18000, longestRunningTurnSeconds: 95,
            currentStreakDays: 4, longestStreakDays: 11,
            daily: [{ date: '2026-08-17', tokens: 4200 }, { date: '2026-08-16', tokens: 3800 }],
          },
        });
      });

      const card = page.locator('.ct-usage-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('42,000 thread/session tokens');
      await expect(card.locator('.ct-usage-quota')).toHaveCount(2);
      await expect(card.locator('.ct-usage-bar-warning')).toHaveCount(1);
      await expect(card.locator('.ct-usage-bar-exhausted')).toHaveCount(1);
      await expect(card).toContainText('125,000 lifetime tokens');
      await expect(card).toContainText('4 day current streak');
      await expect(card).toContainText('Aug 17, 2026');
      await expect(card.locator('.ct-usage-account')).toHaveCount(0);
      expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await anchorFocusedComposerToBottom(page);
      await shot(page, usageViewport.golden, { fullPage: true });
    });
  }

});
