import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  artifactIdForThread,
  buildDesignManifest,
  designArtifactRoot,
  designKickoffMessage,
  designTitle,
  dispatchDesignThread,
  ensureDesignArtifact,
  type DesignArtifactFs,
} from '../harness/design-plugin/designArtifact';
import type { Thread } from '../../src/types';

describe('design artifact contract', () => {
  it('derives a portable stable artifact id and root from the thread', () => {
    expect(artifactIdForThread('ABC:thread/unsafe')).toBe('design-abc-thread-unsafe');
    expect(designArtifactRoot('/vault', 'ABC')).toBe(path.join('/vault', '.geode', 'artifacts', 'design-abc'));
  });

  it('builds the exact static, networkless v1 manifest', () => {
    expect(buildDesignManifest('thread-1', 'Checkout concept')).toEqual({
      schemaVersion: 1,
      id: 'design-thread-1',
      title: 'Checkout concept',
      entry: 'index.html',
      runtime: 'static',
      createdByThreadId: 'thread-1',
      viewport: { preset: 'desktop', width: 1440, height: 900 },
      permissions: { network: 'none', clipboard: false },
    });
  });

  it('bounds the title to the shared manifest limit', () => {
    expect(designTitle(`# ${'x'.repeat(140)}`).length).toBeLessThanOrEqual(120);
    expect(designTitle('')).toBe('Design artifact');
  });

  it('creates one zero-install scaffold and persists thread metadata', async () => {
    const writes = new Map<string, string>();
    const fileFs: DesignArtifactFs = {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (target, data) => { writes.set(target, data); }),
    };
    const thread = { id: 'thread-1', artifacts: undefined };
    const artifact = await ensureDesignArtifact(thread, '/vault', 'Checkout concept', 123, fileFs);

    expect(artifact.root).toBe(path.join('/vault', '.geode', 'artifacts', 'design-thread-1'));
    expect(thread.artifacts).toEqual([artifact]);
    expect([...writes.keys()].map((target) => path.basename(target)).sort()).toEqual(['app.js', 'artifact.json', 'index.html', 'styles.css']);
    const scaffold = writes.get(path.join(artifact.root, 'index.html')) ?? '';
    expect(scaffold).toContain('<script src="app.js"></script>');
    expect(scaffold).toContain('Preparing your design');
    expect(scaffold).not.toContain('Checkout concept');
    expect(writes.get(path.join(artifact.root, 'artifact.json'))).toContain('"network": "none"');
  });

  it('reuses the canonical artifact without rewriting accepted source', async () => {
    const existing = {
      id: 'design-thread-1', kind: 'design-static' as const, title: 'Existing', root: '/artifact',
      manifestPath: '/artifact/artifact.json', entryPath: '/artifact/index.html', createdAt: 10, updatedAt: 10,
    };
    const thread = { id: 'thread-1', artifacts: [existing] };
    const fileFs = { mkdir: vi.fn(), writeFile: vi.fn() } as unknown as DesignArtifactFs;
    expect(await ensureDesignArtifact(thread, '/vault', 'Revision', 20, fileFs)).toBe(existing);
    expect(existing.updatedAt).toBe(20);
    expect(fileFs.writeFile).not.toHaveBeenCalled();
  });

  it('builds harness-neutral instructions with the artifact constraints', () => {
    const message = designKickoffMessage({
      id: 'design-t', kind: 'design-static', title: 'T', root: '/artifact', manifestPath: '/artifact/artifact.json',
      entryPath: '/artifact/index.html', createdAt: 1, updatedAt: 1,
    }, 'Make a dashboard');
    expect(message).toContain('/artifact');
    expect(message).toContain('Make a dashboard');
    expect(message).toContain('Do not install packages');
    expect(message).toContain('Inline JavaScript is blocked');
    expect(message).toContain('requirements and context, not literal page copy');
    expect(message).toContain('Replace the preparation scaffold promptly');
    expect(message).toContain('information architecture');
    expect(message).toContain('realistic content');
    expect(message).toContain('distinctive visual direction');
    expect(message).toContain('desktop and mobile');
    expect(message).not.toContain('Claude Code');
  });
});

describe('new-thread design dispatch', () => {
  it('persists the native artifact before sending, then focuses the thread and opens its preview', async () => {
    const events: string[] = [];
    const writes = new Map<string, string>();
    let sentMessage = '';
    const thread = {
      id: 'thread-1',
      title: 'placeholder',
      cwd: '/vault',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      status: 'waiting' as const,
      agentHarness: 'codex' as const,
    };
    const fileFs: DesignArtifactFs = {
      mkdir: vi.fn(async () => { events.push('scaffold'); }),
      writeFile: vi.fn(async (target, data) => { writes.set(target, data); }),
    };

    const threadId = await dispatchDesignThread(
      'Responsive settings card',
      'codex',
      '/vault',
      {
        createThread: (title, harness) => {
          events.push('create');
          thread.title = title;
          thread.agentHarness = harness;
          return thread as Thread;
        },
        deleteThread: vi.fn(),
        getActiveThreadId: () => 'thread-existing',
        restoreActiveThread: vi.fn(async () => undefined),
        saveSettings: async () => { events.push('save'); },
        sendMessage: async (_threadId, message) => { events.push('send'); sentMessage = message; },
        openThread: async () => { events.push('open-thread'); },
        openPreview: async () => { events.push('open-preview'); },
        onSendError: vi.fn(),
      },
      fileFs,
    );

    expect(threadId).toBe('thread-1');
    expect(thread.title).toBe('Responsive settings card');
    expect(thread.artifacts).toHaveLength(1);
    expect([...writes.keys()].map((target) => path.basename(target)).sort()).toEqual([
      'app.js', 'artifact.json', 'index.html', 'styles.css',
    ]);
    expect(sentMessage).toContain('You are working in Agent Threads Design mode.');
    expect(sentMessage).toContain('Responsive settings card');
    expect(sentMessage).not.toContain('/design Responsive settings card');
    expect(events).toEqual(['create', 'scaffold', 'save', 'open-thread', 'open-preview', 'send']);
  });

  it.each([
    ['thread focus', 'openThread'],
    ['artifact preview', 'openPreview'],
  ] as const)('does not start the turn when %s fails', async (_label, failingStep) => {
    const thread = {
      id: 'thread-failed-navigation', title: 'placeholder', cwd: '/vault', messages: [],
      createdAt: 1, updatedAt: 1, status: 'waiting' as const, agentHarness: 'claude' as const,
    };
    const previousThreadId = 'thread-existing';
    const liveThreadIds = new Set([previousThreadId, thread.id]);
    let activeThreadId: string | null = previousThreadId;
    const sendMessage = vi.fn(async () => undefined);
    const deleteThread = vi.fn((threadId: string) => { liveThreadIds.delete(threadId); });
    const rm = vi.fn(async () => undefined);
    const navigationError = new Error(`${failingStep} failed`);
    const deps = {
      createThread: () => thread as Thread,
      deleteThread,
      getActiveThreadId: () => activeThreadId,
      restoreActiveThread: vi.fn(async (preferredId: string | null) => {
        activeThreadId = preferredId && liveThreadIds.has(preferredId)
          ? preferredId
          : [...liveThreadIds][0] ?? null;
      }),
      saveSettings: vi.fn(async () => undefined),
      sendMessage,
      openThread: vi.fn(async () => {
        activeThreadId = thread.id;
        if (failingStep === 'openThread') throw navigationError;
      }),
      openPreview: vi.fn(async () => {
        if (failingStep === 'openPreview') throw navigationError;
      }),
      onSendError: vi.fn(),
    };
    const fileFs: DesignArtifactFs = {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      rm,
    };

    await expect(dispatchDesignThread('Retry-safe design', 'claude', '/vault', deps, fileFs))
      .rejects.toBe(navigationError);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(deleteThread).toHaveBeenCalledWith(thread.id);
    expect(deps.restoreActiveThread).toHaveBeenCalledWith(previousThreadId);
    expect(activeThreadId).toBe(previousThreadId);
    expect(liveThreadIds.has(activeThreadId!)).toBe(true);
    expect(deps.saveSettings).toHaveBeenCalledTimes(2);
    expect(rm).toHaveBeenCalledWith(designArtifactRoot('/vault', thread.id), { recursive: true, force: true });
  });

  it('clears the provisional selection safely when navigation fails without a prior thread', async () => {
    const thread = {
      id: 'only-provisional-thread', title: 'placeholder', cwd: '/vault', messages: [],
      createdAt: 1, updatedAt: 1, status: 'waiting' as const, agentHarness: 'claude' as const,
    };
    const liveThreadIds = new Set([thread.id]);
    let activeThreadId: string | null = null;
    const deps = {
      createThread: () => thread as Thread,
      deleteThread: vi.fn((threadId: string) => { liveThreadIds.delete(threadId); }),
      getActiveThreadId: () => activeThreadId,
      restoreActiveThread: vi.fn(async (preferredId: string | null) => {
        activeThreadId = preferredId && liveThreadIds.has(preferredId)
          ? preferredId
          : [...liveThreadIds][0] ?? null;
      }),
      saveSettings: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
      openThread: vi.fn(async () => { activeThreadId = thread.id; }),
      openPreview: vi.fn(async () => { throw new Error('preview failed'); }),
      onSendError: vi.fn(),
    };

    await expect(dispatchDesignThread(
      'First design', 'claude', '/vault', deps,
      { mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
    )).rejects.toThrow('preview failed');

    expect(deps.restoreActiveThread).toHaveBeenCalledWith(null);
    expect(activeThreadId).toBeNull();
    expect(liveThreadIds).toHaveLength(0);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });
});
