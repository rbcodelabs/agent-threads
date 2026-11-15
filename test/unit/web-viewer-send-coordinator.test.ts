import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import {
  WEB_VIEWER_NEW_THREAD_ID,
  type WebViewerPageTarget,
} from '../../src/webViewerFeedback/contract';
import {
  createWebViewerFeedbackHandler,
  type HandlerThreadRecord,
  type WebViewerFeedbackHost,
} from '../../src/webViewerFeedback/handler';
import { registerWebViewerFeedback } from '../../src/webViewerFeedback/registerWebViewerFeedback';
import { WebViewerSendCoordinator } from '../../src/webViewerFeedback/sendCoordinator';
import type { ImageAttachment } from '../../src/types';
import { makeValidPngBytes, makeValidRequest, makeValidSelection } from './helpers/webViewerFeedbackFixtures';

const VALID_TARGET: WebViewerPageTarget = {
  url: 'http://localhost:3000/billing/invoices',
  origin: 'http://localhost:3000',
  title: 'Invoices',
};

function createTestHarness(opts?: {
  threads?: HandlerThreadRecord[];
  runningIds?: string[];
  activeViewThreadId?: string | null;
  settingsActiveThreadId?: string;
  projects?: Array<{ id: string; name: string }>;
  shouldRunNewThreadRemotely?: boolean;
}) {
  const threads = new Map<string, HandlerThreadRecord>(
    (opts?.threads ?? []).map((t) => [t.id, t]),
  );
  const running = new Set<string>(opts?.runningIds ?? []);
  const listeners = new Set<(threadId: string, event: { type: string }) => void>();
  const projects = new Map((opts?.projects ?? []).map((p) => [p.id, p]));

  const sendMessage = vi.fn<
    (threadId: string, userText: string, images?: ImageAttachment[]) => Promise<void>
  >(async () => undefined);

  const focusThread = vi.fn(async (id: string) => {
    currentViewThreadId = id;
  });

  let currentViewThreadId: string | null =
    opts?.activeViewThreadId !== undefined ? opts.activeViewThreadId : null;

  const dispatchNewThread = vi.fn<
    (text: string, images?: ImageAttachment[], titleHint?: string) => Promise<string>
  >(async (_text, _images, titleHint) => {
    const id = 'created-thread-99';
    threads.set(id, {
      id,
      title: titleHint ?? 'New Thread',
      cwd: '/tmp/nonexistent-test-cwd',
      createdAt: 5000,
      updatedAt: 5000,
    });
    return id;
  });

  const manager = {
    subscribe(listener: (threadId: string, event: { type: string }) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isRunning(threadId: string) {
      return running.has(threadId);
    },
    getThreads() {
      return [...threads.values()];
    },
    getThread(id: string) {
      return threads.get(id);
    },
    getProject(id: string) {
      return projects.get(id);
    },
    hasPendingPlan() {
      return false;
    },
    sendMessage,
  };

  const host: WebViewerFeedbackHost = {
    settings: {
      activeThreadId: opts?.settingsActiveThreadId,
      escalationKeyword: '/escalate',
      permissionMode: 'default',
      projects: opts?.projects ?? [],
    },
    manager,
    getActiveThreadId: () => currentViewThreadId,
    getEffectiveCwd: () => '/tmp/nonexistent-test-cwd',
    getView: () => ({
      getActiveThreadId: () => currentViewThreadId,
      focusThread,
    }),
    shouldRunNewThreadRemotely: () => Boolean(opts?.shouldRunNewThreadRemotely),
    dispatchNewThread,
  };

  const emit = (threadId: string, event: { type: string }) => {
    for (const listener of listeners) {
      listener(threadId, event);
    }
  };

  return {
    host,
    manager,
    threads,
    running,
    listeners,
    emit,
    sendMessage,
    dispatchNewThread,
    focusThread,
  };
}

describe('WebViewerFeedbackHandler & WebViewerSendCoordinator', () => {
  it('lists open threads active-first then descending recency, excluding background and archived threads and resolving subtitles', async () => {
    const { host, manager } = createTestHarness({
      activeViewThreadId: 't-active',
      runningIds: ['t-recent'],
      projects: [{ id: 'proj-1', name: 'Billing Portal' }],
      threads: [
        {
          id: 't-older',
          title: 'Older thread',
          cwd: '/Users/dev/repos/web-app',
          createdAt: 1000,
          updatedAt: 1500,
        },
        {
          id: 't-active',
          title: 'Currently open thread',
          cwd: '/Users/dev/repos/other',
          projectId: 'proj-1',
          createdAt: 900,
          updatedAt: 1100,
        },
        {
          id: 't-recent',
          title: 'Most recent busy thread',
          cwd: '/Users/dev/repos/design-system/.worktrees/feat-btn',
          permissionMode: 'plan',
          createdAt: 2000,
          updatedAt: 4000,
        },
        {
          id: 't-bg',
          title: 'Background job',
          cwd: '/Users/dev/repos/web-app',
          background: true,
          createdAt: 5000,
          updatedAt: 5000,
        },
        {
          id: 't-archived',
          title: 'Archived thread',
          cwd: '/Users/dev/repos/web-app',
          status: 'archived',
          createdAt: 6000,
          updatedAt: 6000,
        },
      ],
    });

    const coordinator = new WebViewerSendCoordinator(manager);
    const handler = createWebViewerFeedbackHandler(host, coordinator);

    const list = await handler.listThreads(VALID_TARGET, {
      signal: new AbortController().signal,
    });

    expect(list.allowNewThread).toBe(true);
    expect(list.threads.map((t) => t.id)).toEqual(['t-active', 't-recent', 't-older']);
    expect(list.threads[0]).toEqual({
      id: 't-active',
      title: 'Currently open thread',
      subtitle: 'Billing Portal',
      active: true,
      busy: false,
      planMode: false,
    });
    expect(list.threads[1]).toEqual({
      id: 't-recent',
      title: 'Most recent busy thread',
      subtitle: 'design-system',
      active: false,
      busy: true,
      planMode: true,
    });
    expect(list.threads[2]).toEqual({
      id: 't-older',
      title: 'Older thread',
      subtitle: 'web-app',
      active: false,
      busy: false,
      planMode: false,
    });

    coordinator.dispose();
  });

  it('delivers immediately with PNG ImageAttachment when target thread is idle and selects thread in view', async () => {
    const { host, manager, sendMessage, focusThread } = createTestHarness({
      activeViewThreadId: 't-other',
      threads: [
        {
          id: 'thread-123',
          title: 'UI Polish',
          cwd: '/tmp/nonexistent-test-cwd',
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
    });

    const coordinator = new WebViewerSendCoordinator(manager);
    const handler = createWebViewerFeedbackHandler(host, coordinator);

    const pngBytes = makeValidPngBytes(40, 20);
    const req = makeValidRequest({
      threadId: 'thread-123',
      comment: 'Increase horizontal padding to 16px.',
      screenshot: {
        mimeType: 'image/png',
        bytes: pngBytes,
        width: 40,
        height: 20,
        cssRect: { x: 10, y: 10, width: 40, height: 20 },
        devicePixelRatio: 2,
        downscaled: false,
      },
    });

    const res = await handler.submit(req, { signal: new AbortController().signal });
    expect(res).toEqual({
      status: 'accepted',
      delivery: 'sent',
      threadId: 'thread-123',
      message: 'Sent to "UI Polish"',
    });

    expect(focusThread).toHaveBeenCalledWith('thread-123');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [sentThreadId, sentPrompt, sentImages] = sendMessage.mock.calls[0];
    expect(sentThreadId).toBe('thread-123');
    expect(sentPrompt).toContain('Increase horizontal padding to 16px.');
    expect(sentImages).toEqual([
      {
        mediaType: 'image/png',
        base64: Buffer.from(pngBytes).toString('base64'),
        name: `${req.selection.selectionId}.png`,
      },
    ]);

    coordinator.dispose();
  });

  it('queues into 1-slot per running thread, replaces older unsent pick, and flushes on done (including microtask turnInFlight settle)', async () => {
    const { host, manager, running, emit, sendMessage } = createTestHarness({
      runningIds: ['thread-busy'],
      threads: [
        {
          id: 'thread-busy',
          title: 'Busy Agent',
          cwd: '/tmp/nonexistent-test-cwd',
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
    });

    const coordinator = new WebViewerSendCoordinator(manager);
    const handler = createWebViewerFeedbackHandler(host, coordinator);

    // First pick while busy -> queued
    const firstReq = makeValidRequest({
      threadId: 'thread-busy',
      comment: 'First unsent comment that should be replaced',
      selection: makeValidSelection({
        selectionId: 'sel_11111111111111111111111111111111',
      }),
    });
    const firstRes = await handler.submit(firstReq, { signal: new AbortController().signal });
    expect(firstRes).toEqual({
      status: 'accepted',
      delivery: 'queued',
      threadId: 'thread-busy',
      message: 'Thread is busy — queued for next turn',
    });
    expect(sendMessage).not.toHaveBeenCalled();

    // Second pick for same running thread -> replaces first slot!
    const secondReq = makeValidRequest({
      threadId: 'thread-busy',
      comment: 'Second replacement comment that should flush',
      selection: makeValidSelection({
        selectionId: 'sel_22222222222222222222222222222222',
      }),
    });
    const secondRes = await handler.submit(secondReq, { signal: new AbortController().signal });
    expect(secondRes).toEqual({
      status: 'accepted',
      delivery: 'queued',
      threadId: 'thread-busy',
      message: 'Thread is busy — queued for next turn',
    });
    expect(coordinator.pendingCount).toBe(1);

    // Simulate real ThreadSession ordering: `done` emits synchronously right before `_turnInFlight` flips false!
    emit('thread-busy', { type: 'done' });
    running.delete('thread-busy');

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [flushedThreadId, flushedPrompt] = sendMessage.mock.calls[0];
    expect(flushedThreadId).toBe('thread-busy');
    expect(flushedPrompt).toContain('Second replacement comment that should flush');
    expect(flushedPrompt).not.toContain('First unsent comment');
    expect(coordinator.pendingCount).toBe(0);

    coordinator.dispose();
  });

  it('cleans up queued slot on thread_deleted without flushing', async () => {
    const { host, manager, running, threads, emit, sendMessage } = createTestHarness({
      runningIds: ['thread-del'],
      threads: [
        {
          id: 'thread-del',
          title: 'Doomed Thread',
          cwd: '/tmp/nonexistent-test-cwd',
          createdAt: 1000,
        },
      ],
    });

    const coordinator = new WebViewerSendCoordinator(manager);
    const handler = createWebViewerFeedbackHandler(host, coordinator);

    const res = await handler.submit(
      makeValidRequest({ threadId: 'thread-del', comment: 'Queued before delete' }),
      { signal: new AbortController().signal },
    );
    expect(res.status).toBe('accepted');
    expect(coordinator.hasPending('thread-del')).toBe(true);

    threads.delete('thread-del');
    running.delete('thread-del');
    emit('thread-del', { type: 'thread_deleted' });
    emit('thread-del', { type: 'done' });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(coordinator.hasPending('thread-del')).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();

    coordinator.dispose();
  });

  it('creates a new thread on WEB_VIEWER_NEW_THREAD_ID with concise comment-only titleHint and skips fs when remote', async () => {
    const realpathSpy = vi.spyOn(fs.promises, 'realpath');
    const { host, manager, dispatchNewThread } = createTestHarness({
      shouldRunNewThreadRemotely: true,
    });

    const coordinator = new WebViewerSendCoordinator(manager);
    const handler = createWebViewerFeedbackHandler(host, coordinator);

    const req = makeValidRequest({
      threadId: WEB_VIEWER_NEW_THREAD_ID,
      comment: 'Fix header contrast against dark slate background',
      page: {
        url: 'http://localhost:3000/secret-title-check',
        origin: 'http://localhost:3000',
        title: 'UNTRUSTED_PAGE_TITLE_DO_NOT_USE',
      },
    });

    const res = await handler.submit(req, { signal: new AbortController().signal });
    expect(res).toEqual({
      status: 'accepted',
      delivery: 'sent',
      threadId: 'created-thread-99',
      message: 'Sent to new thread',
    });

    expect(realpathSpy).not.toHaveBeenCalled();
    expect(dispatchNewThread).toHaveBeenCalledTimes(1);
    const [prompt, images, titleHint] = dispatchNewThread.mock.calls[0];
    expect(prompt).toContain('Fix header contrast against dark slate background');
    expect(images).toHaveLength(1);
    expect(titleHint).toBe('Fix header contrast against dark slate background');
    expect(titleHint).not.toContain('UNTRUSTED_PAGE_TITLE');

    realpathSpy.mockRestore();
    coordinator.dispose();
  });

  it('deduplicates identical retry submissions via bounded idempotency cache and rejects unavailable threads', async () => {
    const { host, manager, sendMessage } = createTestHarness({
      threads: [
        {
          id: 'thread-123',
          title: 'Open Thread',
          cwd: '/tmp/nonexistent-test-cwd',
          createdAt: 1000,
        },
        {
          id: 'thread-arch',
          title: 'Archived Thread',
          cwd: '/tmp/nonexistent-test-cwd',
          status: 'archived',
          createdAt: 1000,
        },
      ],
    });

    const coordinator = new WebViewerSendCoordinator(manager);
    const handler = createWebViewerFeedbackHandler(host, coordinator);

    const req = makeValidRequest({
      threadId: 'thread-123',
      comment: 'Idempotent comment test',
    });

    const first = await handler.submit(req, { signal: new AbortController().signal });
    const retry = await handler.submit(req, { signal: new AbortController().signal });
    expect(first).toEqual(retry);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // Archived or missing thread returns rejected unavailable
    const archivedRes = await handler.submit(
      makeValidRequest({ threadId: 'thread-arch' }),
      { signal: new AbortController().signal },
    );
    expect(archivedRes).toEqual({
      status: 'rejected',
      reason: 'unavailable',
      message: 'Selected thread is no longer open.',
    });

    coordinator.dispose();
  });

  it('registerWebViewerFeedback no-ops on hosts without Geode API and cleans up on dispose()', () => {
    const { host, listeners } = createTestHarness();

    // Plain Obsidian host without registerWebViewerFeedbackHandler
    expect(registerWebViewerFeedback(host)).toBeNull();
    expect(listeners.size).toBe(0);

    // Geode host with registerWebViewerFeedbackHandler
    const hostDispose = vi.fn();
    const registerSpy = vi.fn(() => ({
      status: 'registered' as const,
      dispose: hostDispose,
    }));

    const disposable = registerWebViewerFeedback({
      ...host,
      app: { webViewerFeedback: { contractVersions: [1] } },
      registerWebViewerFeedbackHandler: registerSpy,
    });

    expect(disposable).not.toBeNull();
    expect(registerSpy).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);

    disposable!.dispose();
    disposable!.dispose(); // idempotent
    expect(hostDispose).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});
