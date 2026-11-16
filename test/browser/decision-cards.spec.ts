/**
 * Playwright behavioral & geometry tests for inline orchestrator decision cards
 * in Conversation View (`ThreadsView.renderDecisionCards`).
 */
import { test, expect } from '@playwright/test';
import path from 'path';

const harnessUrl = 'file://' + path.resolve('test/harness/index.html');

const SAMPLE_OPTIONS = [
  { label: 'Roll out behind feature flag', description: 'Zero-downtime rollout to staging first.' },
  { label: 'Deploy straight to production', description: 'Faster, skips staging bake window.' },
];

test.describe('Orchestrator decision cards in Conversation View', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-01-15T10:00:00Z'));
  });

  test('renders decision card with source orchestrator title and routes answer only to sourceThreadId', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(200);

    // Normal thread with no decisions has zero .ct-decision-cards wrapper in the DOM.
    await expect(page.locator('.ct-decision-cards')).not.toBeAttached();

    const ids = await page.evaluate((options) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const subjectId = view['activeThreadId'] as string;
      const orch = manager.createThread('Portfolio Orchestrator', '/tmp');
      (window as any).__sendMessageCalls = [];
      manager.sendMessage = async (threadId: string, text: string) => {
        (window as any).__sendMessageCalls.push({ threadId, text });
      };
      const decision = manager.postDecision(subjectId, orch.id, {
        question: 'How should we roll out the auth middleware fix?',
        header: 'Rollout strategy',
        options,
      });
      return { subjectId, orchId: orch.id, decisionId: decision.id };
    }, SAMPLE_OPTIONS);

    await page.waitForSelector('.ct-decision-card');
    await expect(page.locator('.ct-decision-card-label')).toHaveText('Decision for you · Portfolio Orchestrator');
    await expect(page.locator('.ct-decision-card .ct-question-header')).toHaveText('Rollout strategy');
    await expect(page.locator('.ct-decision-card .ct-question-option')).toHaveCount(3); // 2 options + Other
    await expect(page.locator('.ct-decision-card .ct-question-option-other')).toHaveCount(1);

    await page.locator('.ct-decision-card .ct-question-option').first().click();
    await page.locator('.ct-decision-card-submit').click();

    await expect(page.locator('.ct-decision-card')).not.toBeAttached();
    await expect(page.locator('.ct-decision-cards')).not.toBeAttached();

    const state = await page.evaluate(({ subjectId }) => {
      const manager = (window as any).__manager;
      return {
        calls: (window as any).__sendMessageCalls as Array<{ threadId: string; text: string }>,
        pendingDecisions: manager.getThread(subjectId)?.pendingDecisions,
      };
    }, ids);

    expect(state.pendingDecisions).toBeUndefined();
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].threadId).toBe(ids.orchId);
    expect(state.calls[0].threadId).not.toBe(ids.subjectId);
    expect(state.calls[0].text).toContain(ids.decisionId);
    expect(state.calls[0].text).toContain('Roll out behind feature flag');
  });

  test('empty submission does not call answerDecision and keeps the card mounted', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 740 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(200);

    await page.evaluate((options) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const subjectId = view['activeThreadId'] as string;
      const orch = manager.createThread('Portfolio Orchestrator', '/tmp');
      (window as any).__answerCalls = 0;
      const origAnswer = manager.answerDecision.bind(manager);
      manager.answerDecision = async (...args: [string, string, string]) => {
        (window as any).__answerCalls++;
        return origAnswer(...args);
      };
      manager.postDecision(subjectId, orch.id, {
        question: 'How should we roll out the auth middleware fix?',
        header: 'Rollout strategy',
        options,
      });
    }, SAMPLE_OPTIONS);

    await page.waitForSelector('.ct-decision-card');
    await page.locator('.ct-decision-card-submit').click();

    await expect(page.locator('.ct-decision-card')).toBeVisible();
    await expect(page.locator('.ct-decision-card-submit')).toBeEnabled();
    const answerCalls = await page.evaluate(() => (window as any).__answerCalls);
    expect(answerCalls).toBe(0);
  });

  test('patches cards in place and preserves draft across sibling decision post and thread switches', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(200);

    const { subjectId, otherThreadId, orchId } = await page.evaluate((options) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'] as string;
      const otherThread = manager.getThreads().find((t: any) => t.id !== activeId)!;
      const orch = manager.createThread('Portfolio Orchestrator', '/tmp');
      manager.postDecision(activeId, orch.id, {
        question: 'First decision question?',
        header: 'Decision 1',
        options,
      });
      return { subjectId: activeId, otherThreadId: otherThread.id, orchId: orch.id };
    }, SAMPLE_OPTIONS);

    await page.waitForSelector('.ct-decision-card');
    const firstOtherInput = page.locator('.ct-decision-card').first().locator('.ct-question-other-text');
    await firstOtherInput.focus();
    await firstOtherInput.fill('Custom rollout plan at 02:00 UTC');
    await expect(firstOtherInput).toBeFocused();

    // Posting a second decision patches in place without losing text or focus on card 1.
    await page.evaluate(({ sid, oid, options }) => {
      const manager = (window as any).__manager;
      manager.postDecision(sid, oid, {
        question: 'Second decision question?',
        header: 'Decision 2',
        options,
      });
    }, { sid: subjectId, oid: orchId, options: SAMPLE_OPTIONS });

    await expect(page.locator('.ct-decision-card')).toHaveCount(2);
    await expect(firstOtherInput).toHaveValue('Custom rollout plan at 02:00 UTC');
    await expect(firstOtherInput).toBeFocused();

    // Switch to another thread and back — draft in card 1 survives!
    await page.evaluate((id) => (window as any).__view.focusThread(id), otherThreadId);
    await expect(page.locator('.ct-decision-cards')).not.toBeAttached();

    await page.evaluate((id) => (window as any).__view.focusThread(id), subjectId);
    await expect(page.locator('.ct-decision-card')).toHaveCount(2);
    const restoredOtherInput = page.locator('.ct-decision-card').first().locator('.ct-question-other-text');
    await expect(restoredOtherInput).toHaveValue('Custom rollout plan at 02:00 UTC');
    await expect(page.locator('.ct-decision-card').first().locator('.ct-question-option-other input[type="radio"]')).toBeChecked();
  });

  test('sending a manual message in Conversation View kills all pending decision cards', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(200);

    const subjectId = await page.evaluate((options) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'] as string;
      const orch = manager.createThread('Portfolio Orchestrator', '/tmp');
      manager.sendMessage = async () => {};
      manager.postDecision(activeId, orch.id, { question: 'Decision A?', options });
      manager.postDecision(activeId, orch.id, { question: 'Decision B?', options });
      return activeId;
    }, SAMPLE_OPTIONS);

    await expect(page.locator('.ct-decision-card')).toHaveCount(2);

    const composer = page.locator('textarea.ct-input');
    await composer.fill('Taking over manually — ship staging first.');
    await page.locator('.ct-send-btn').click();

    await expect(page.locator('.ct-decision-cards')).not.toBeAttached();
    const pendingDecisions = await page.evaluate((id) => {
      return (window as any).__manager.getThread(id)?.pendingDecisions;
    }, subjectId);
    expect(pendingDecisions).toBeUndefined();
  });

  test('read-only slash command /context does NOT kill pending decision cards', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(200);

    const subjectId = await page.evaluate((options) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'] as string;
      const orch = manager.createThread('Portfolio Orchestrator', '/tmp');
      manager.postDecision(activeId, orch.id, { question: 'Keep pending across /context?', options });
      return activeId;
    }, SAMPLE_OPTIONS);

    await expect(page.locator('.ct-decision-card')).toHaveCount(1);

    const composer = page.locator('textarea.ct-input');
    const sendBtn = page.locator('.ct-send-btn');
    await composer.fill('/context');
    await sendBtn.click();

    await expect(page.locator('.ct-compact-divider').last()).toContainText('No active session');
    await expect(page.locator('.ct-decision-card')).toHaveCount(1);
    const pendingCount = await page.evaluate((id) => {
      return (window as any).__manager.getThread(id)?.pendingDecisions?.length ?? 0;
    }, subjectId);
    expect(pendingCount).toBe(1);

    // Bare /model, bare /goal, and /goal clear also preserve pending decisions;
    // /goal <text> (which dispatches a kickoff turn) dismisses them.
    for (const readOnlyCmd of ['/model', '/goal', '/goal clear']) {
      await composer.fill(readOnlyCmd);
      await sendBtn.click();
      await expect(page.locator('.ct-decision-card')).toHaveCount(1);
    }

    await composer.fill('/goal Ship auth middleware fix safely');
    await sendBtn.click();
    await expect(page.locator('.ct-decision-cards')).not.toBeAttached();
  });

  test('automated incoming messages do NOT kill pending decision cards and keep cards pinned at bottom', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(harnessUrl);
    await page.waitForSelector('.ct-title-row');
    await page.waitForTimeout(200);

    const subjectId = await page.evaluate((options) => {
      const manager = (window as any).__manager;
      const view = (window as any).__view;
      const activeId = view['activeThreadId'] as string;
      const orch = manager.createThread('Portfolio Orchestrator', '/tmp');
      manager.postDecision(activeId, orch.id, { question: 'Survive automated turn?', options });
      return activeId;
    }, SAMPLE_OPTIONS);

    await expect(page.locator('.ct-decision-card')).toHaveCount(1);

    // Simulate an automated turn (e.g. scheduler wakeup or MCP threads_send_message) appending user + assistant messages.
    await page.evaluate((id) => {
      const manager = (window as any).__manager;
      const thread = manager.getThread(id)!;
      const userMsg = {
        id: 'msg-auto-user',
        role: 'user' as const,
        content: '[Scheduled wakeup] Check CI status',
        timestamp: Date.now(),
      };
      thread.messages.push(userMsg);
      manager['emit'](id, { type: 'user_message_added', message: userMsg });
      manager['emit'](id, { type: 'streaming_start' });

      const assistantMsg = {
        id: 'msg-auto-assistant',
        role: 'assistant' as const,
        content: 'CI green on all checks.',
        timestamp: Date.now() + 1000,
      };
      thread.messages.push(assistantMsg);
      manager['emit'](id, { type: 'message', message: assistantMsg });
      manager['emit'](id, { type: 'done' });
    }, subjectId);

    await expect(page.locator('.ct-decision-card')).toHaveCount(1);
    await expect(page.locator('.ct-message').last()).toContainText('CI green on all checks.');

    const ordering = await page.evaluate((id) => {
      const messagesEl = document.querySelector('.ct-messages')!;
      const children = Array.from(messagesEl.children);
      const decisionIdx = children.findIndex((el) => el.classList.contains('ct-decision-cards'));
      const lastMsgIdx = children.reduce((acc, el, i) => (el.classList.contains('ct-message') ? i : acc), -1);
      const pendingLen = (window as any).__manager.getThread(id)?.pendingDecisions?.length ?? 0;
      return { decisionIdx, lastMsgIdx, totalChildren: children.length, pendingLen };
    }, subjectId);

    expect(ordering.pendingLen).toBe(1);
    expect(ordering.decisionIdx).toBeGreaterThan(ordering.lastMsgIdx);
    expect(ordering.decisionIdx).toBe(ordering.totalChildren - 1);
  });

  for (const vp of [
    { label: 'desktop 1280x800', width: 1280, height: 800, mobile: false },
    { label: 'iPhone 14 390x844', width: 390, height: 844, mobile: false },
    { label: 'iPhone SE 375x667 (?mobile=1)', width: 375, height: 667, mobile: true },
  ]) {
    test(`geometry & overflow invariants at ${vp.label}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(vp.mobile ? `${harnessUrl}?mobile=1` : harnessUrl);
      await page.waitForSelector('.ct-title-row');
      await page.waitForTimeout(200);

      await page.evaluate((options) => {
        const manager = (window as any).__manager;
        const view = (window as any).__view;
        const activeId = view['activeThreadId'] as string;
        const orch = manager.createThread('Portfolio Orchestrator With A Very Long Descriptive Name', '/tmp');
        manager.sendMessage = async () => {};
        manager.postDecision(activeId, orch.id, {
          question: 'Should we ship this migration now or wait until after the maintenance window closes?',
          header: 'Database migration window',
          options,
        });
      }, SAMPLE_OPTIONS);

      await page.waitForSelector('.ct-decision-card');
      await page.locator('.ct-decision-card').scrollIntoViewIfNeeded();

      const metrics = await page.evaluate(() => {
        const messages = document.querySelector<HTMLElement>('.ct-messages')!;
        const card = document.querySelector<HTMLElement>('.ct-decision-card')!;
        const submit = document.querySelector<HTMLElement>('.ct-decision-card-submit')!;
        const options = Array.from(card.querySelectorAll<HTMLElement>('.ct-question-option'));
        return {
          messagesOverflow: messages.scrollWidth - messages.clientWidth,
          cardOverflow: card.scrollWidth - card.clientWidth,
          submitHeight: submit.getBoundingClientRect().height,
          optionHeights: options.map((el) => el.getBoundingClientRect().height),
          isMobileRoot: document.querySelector('.ct-root')?.classList.contains('ct-mobile') ?? false,
        };
      });

      expect(metrics.messagesOverflow).toBeLessThanOrEqual(0);
      expect(metrics.cardOverflow).toBeLessThanOrEqual(0);
      if (vp.mobile) {
        expect(metrics.isMobileRoot).toBe(true);
        expect(metrics.submitHeight).toBeGreaterThanOrEqual(44);
        for (const h of metrics.optionHeights) {
          expect(h).toBeGreaterThanOrEqual(44);
        }
      }

      // Options and Send answer button are visible and clickable.
      await expect(page.locator('.ct-decision-card .ct-question-option').first()).toBeVisible();
      await expect(page.locator('.ct-decision-card-submit')).toBeVisible();
      await page.locator('.ct-decision-card .ct-question-option').first().click();
      await page.locator('.ct-decision-card-submit').click();
      await expect(page.locator('.ct-decision-card')).not.toBeAttached();
    });
  }
});
