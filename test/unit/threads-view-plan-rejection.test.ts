/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup/obsidian-dom';
import { ThreadsView } from '../../src/ThreadsView';

const GENERIC_REJECTION = 'I rejected the plan. Please ask what changes I\'d like, or suggest alternative approaches.';

function renderPlan(rejectResult = false) {
  const messagesEl = document.createElement('div');
  document.body.appendChild(messagesEl);
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const approve = vi.fn();
  const reject = vi.fn(() => rejectResult);
  const view = Object.assign(Object.create(ThreadsView.prototype), {
    activeThreadId: 'thread-original',
    messagesEl,
    streamingEl: null,
    manager: { sendMessage },
    renderMarkdown: vi.fn(async (text: string, el: HTMLElement) => { el.setText(text); }),
    scrollToBottom: vi.fn(),
  }) as ThreadsView & Record<string, unknown>;

  const card = (view as any).renderPlanCard('## Proposed plan\n\n1. Keep context visible', approve, reject) as HTMLElement;
  return { view, card, approve, reject, sendMessage };
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('ThreadsView plan rejection reason', () => {
  beforeEach(() => {
    document.body.empty();
  });

  it('opens a focused reason field on first Reject without invoking rejection or removing the plan', () => {
    const { card, reject, sendMessage } = renderPlan();

    click(card.querySelector('.ct-plan-reject')!);

    const textarea = card.querySelector<HTMLTextAreaElement>('.ct-plan-rejection-textarea');
    expect(textarea).not.toBeNull();
    expect(textarea?.labels?.[0]?.textContent).toBe('Why are you rejecting this plan?');
    expect(document.activeElement).toBe(textarea);
    expect(card.querySelector('.ct-plan-md')).not.toBeNull();
    expect(card.isConnected).toBe(true);
    expect(reject).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('cancels rejection entry without invoking rejection and restores the original actions', () => {
    const { card, reject } = renderPlan();
    click(card.querySelector('.ct-plan-reject')!);

    click(card.querySelector('.ct-plan-rejection-cancel')!);

    expect(card.querySelector('.ct-plan-rejection-field')).toBeNull();
    expect(card.querySelector('.ct-plan-reject')).not.toBeNull();
    expect(card.querySelector('.ct-plan-edit')).not.toBeNull();
    expect(card.querySelector('.ct-plan-approve')).not.toBeNull();
    expect(reject).not.toHaveBeenCalled();
  });

  it('Escape cancels while plain Enter inserts a newline', () => {
    const { card, reject } = renderPlan();
    click(card.querySelector('.ct-plan-reject')!);
    const textarea = card.querySelector<HTMLTextAreaElement>('.ct-plan-rejection-textarea')!;

    textarea.value = 'First line';
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(card.querySelector('.ct-plan-rejection-field')).not.toBeNull();
    expect(reject).not.toHaveBeenCalled();

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(card.querySelector('.ct-plan-rejection-field')).toBeNull();
    expect(reject).not.toHaveBeenCalled();
  });

  it('trims explicit feedback, targets the captured thread, and submits only once', () => {
    const { view, card, reject, sendMessage } = renderPlan(true);
    click(card.querySelector('.ct-plan-reject')!);
    const textarea = card.querySelector<HTMLTextAreaElement>('.ct-plan-rejection-textarea')!;
    const submit = card.querySelector('.ct-plan-rejection-submit')!;
    textarea.value = '  Please compare both migration paths.  \n';
    (view as any).activeThreadId = 'thread-selected-later';

    click(submit);
    click(submit);

    expect(reject).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('thread-original', 'Please compare both migration paths.');
    expect(card.isConnected).toBe(false);
  });

  it('sends explicit feedback even when the resolver reports queued feedback', () => {
    const { card, reject, sendMessage } = renderPlan(true);
    click(card.querySelector('.ct-plan-reject')!);
    const textarea = card.querySelector<HTMLTextAreaElement>('.ct-plan-rejection-textarea')!;
    textarea.value = 'Do less work';

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));

    expect(reject).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith('thread-original', 'Do less work');
  });

  it('uses the generic fallback only for an empty reason with no queued feedback', () => {
    const noQueue = renderPlan(false);
    click(noQueue.card.querySelector('.ct-plan-reject')!);
    click(noQueue.card.querySelector('.ct-plan-rejection-submit')!);
    expect(noQueue.sendMessage).toHaveBeenCalledWith('thread-original', GENERIC_REJECTION);

    const queued = renderPlan(true);
    click(queued.card.querySelector('.ct-plan-reject')!);
    queued.card.querySelector<HTMLTextAreaElement>('.ct-plan-rejection-textarea')!.value = '  \n ';
    click(queued.card.querySelector('.ct-plan-rejection-submit')!);
    expect(queued.sendMessage).not.toHaveBeenCalled();
    expect(queued.reject).toHaveBeenCalledOnce();
  });

  it('keeps approve and edit behavior unchanged', () => {
    const edited = renderPlan();
    click(edited.card.querySelector('.ct-plan-edit')!);
    const textarea = edited.card.querySelector<HTMLTextAreaElement>('.ct-plan-textarea')!;
    textarea.value = 'Edited plan';
    click(edited.card.querySelector('.ct-plan-approve')!);
    expect(edited.approve).toHaveBeenCalledWith('Edited plan');
    expect(edited.reject).not.toHaveBeenCalled();

    const untouched = renderPlan();
    click(untouched.card.querySelector('.ct-plan-approve')!);
    expect(untouched.approve).toHaveBeenCalledWith(undefined);
  });

  it('invokes a restored live-session rejection resolver exactly once', () => {
    const messagesEl = document.createElement('div');
    document.body.appendChild(messagesEl);
    const thread = { id: 'thread-live', pendingPlan: 'Live plan' as string | undefined, permissionMode: 'plan' };
    const reject = vi.fn(() => {
      thread.pendingPlan = undefined;
      return false;
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const view = Object.assign(Object.create(ThreadsView.prototype), {
      activeThreadId: 'thread-live',
      messagesEl,
      streamingEl: null,
      manager: {
        getThread: vi.fn(() => thread),
        getPendingPlanResolvers: vi.fn(() => ({ approve: vi.fn(), reject })),
        sendMessage,
      },
      renderMarkdown: vi.fn(async (text: string, el: HTMLElement) => { el.setText(text); }),
      scrollToBottom: vi.fn(),
    }) as ThreadsView & Record<string, unknown>;

    (view as any).restorePendingPlanCard();
    click(messagesEl.querySelector('.ct-plan-reject')!);
    expect(thread.pendingPlan).toBe('Live plan');
    expect(reject).not.toHaveBeenCalled();
    const submit = messagesEl.querySelector('.ct-plan-rejection-submit')!;
    click(submit);
    click(submit);

    expect(reject).toHaveBeenCalledOnce();
    expect(thread.pendingPlan).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('invokes the post-reload rejection resolver exactly once and clears the restored plan', () => {
    const messagesEl = document.createElement('div');
    document.body.appendChild(messagesEl);
    const setThreadPendingPlan = vi.fn();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    const view = Object.assign(Object.create(ThreadsView.prototype), {
      activeThreadId: 'thread-restored',
      messagesEl,
      streamingEl: null,
      plugin: { saveSettings },
      manager: {
        getThread: vi.fn(() => ({ id: 'thread-restored', pendingPlan: 'Restored plan', permissionMode: 'plan' })),
        getPendingPlanResolvers: vi.fn(() => undefined),
        setThreadPendingPlan,
        sendMessage,
      },
      renderMarkdown: vi.fn(async (text: string, el: HTMLElement) => { el.setText(text); }),
      scrollToBottom: vi.fn(),
    }) as ThreadsView & Record<string, unknown>;

    (view as any).restorePendingPlanCard();
    click(messagesEl.querySelector('.ct-plan-reject')!);
    expect(setThreadPendingPlan).not.toHaveBeenCalled();
    messagesEl.querySelector<HTMLTextAreaElement>('.ct-plan-rejection-textarea')!.value = 'Try a smaller change';
    const submit = messagesEl.querySelector('.ct-plan-rejection-submit')!;
    click(submit);
    click(submit);

    expect(setThreadPendingPlan).toHaveBeenCalledOnce();
    expect(setThreadPendingPlan).toHaveBeenCalledWith('thread-restored', undefined);
    expect(saveSettings).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith('thread-restored', 'Try a smaller change');
  });
});
