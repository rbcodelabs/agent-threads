/**
 * DocumentWatchService.test.ts
 *
 * Covers the watch-a-document → alert-the-owning-thread pipeline in
 * src/DocumentWatchService.ts: the per-path coalesce (stage 1, ~150ms) and the
 * per-thread alert bucket (stage 2, ~2000ms), mirroring the shared-timer +
 * pending-Set shape of StatusLineService/GitDiffService and the per-bucket
 * debounce-then-send template of OrchestratorWakeup.
 *
 * Timers are injected (no real delays, no vi.useFakeTimers) so each stage can
 * be advanced independently and deterministically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TFile, type App } from 'obsidian';
import { DocumentWatchService, type DocumentWatchServiceDeps } from '../../src/DocumentWatchService';
import type { Thread, WatchedDocument } from '../../src/types';

// ── Fake vault: enough of Obsidian's Vault surface to drive modify/rename/delete ──

function makeVault() {
  type Listener = (...args: any[]) => void;
  const listeners: Record<'modify' | 'rename' | 'delete', Listener[]> = {
    modify: [],
    rename: [],
    delete: [],
  };
  const files = new Map<string, TFile>();

  return {
    vault: {
      on(name: 'modify' | 'rename' | 'delete', cb: Listener) {
        listeners[name].push(cb);
        return { name, cb };
      },
      offref(ref: { name: 'modify' | 'rename' | 'delete'; cb: Listener }) {
        const arr = listeners[ref.name];
        const idx = arr.indexOf(ref.cb);
        if (idx >= 0) arr.splice(idx, 1);
      },
      getAbstractFileByPath(path: string) {
        return files.get(path) ?? null;
      },
    },
    setFile(path: string, mtime: number, size: number): TFile {
      const f = new TFile(path);
      f.stat = { ctime: 0, mtime, size };
      files.set(path, f);
      return f;
    },
    emitModify(path: string): void {
      const f = files.get(path);
      if (!f) return;
      for (const cb of [...listeners.modify]) cb(f);
    },
    emitRename(oldPath: string, newPath: string): void {
      const f = files.get(oldPath);
      if (!f) return;
      files.delete(oldPath);
      f.path = newPath;
      f.name = newPath.split('/').pop() ?? newPath;
      f.basename = f.name.replace(/\.[^.]+$/, '');
      files.set(newPath, f);
      for (const cb of [...listeners.rename]) cb(f, oldPath);
    },
    emitDelete(path: string): void {
      const f = files.get(path);
      if (!f) return;
      files.delete(path);
      for (const cb of [...listeners.delete]) cb(f);
    },
  };
}

// ── Deterministic manual timer harness (mirrors OrchestratorWakeup's tests) ──

function makeTimers() {
  let idCounter = 0;
  const scheduled = new Map<number, () => void>();
  return {
    setTimeoutFn: (cb: () => void, _ms: number) => {
      const id = ++idCounter;
      scheduled.set(id, cb);
      return id;
    },
    clearTimeoutFn: (id: unknown) => {
      scheduled.delete(id as number);
    },
    /** Fire every timer currently scheduled. Snapshot first: firing one may schedule new ones for the next stage. */
    runPending: () => {
      const entries = [...scheduled.entries()];
      scheduled.clear();
      for (const [, cb] of entries) cb();
    },
    pendingCount: () => scheduled.size,
  };
}

function makeWatch(overrides: Partial<WatchedDocument> = {}): WatchedDocument {
  return {
    id: overrides.id ?? 'watch-1',
    path: overrides.path ?? 'Notes/Doc.md',
    threadId: overrides.threadId ?? 'thread-1',
    enabled: overrides.enabled ?? true,
    createdAt: overrides.createdAt ?? 0,
    lastStamp: overrides.lastStamp,
    lastAlertedAt: overrides.lastAlertedAt,
  };
}

function makeDeps(
  app: App,
  watches: WatchedDocument[],
  overrides: Partial<DocumentWatchServiceDeps> = {},
): { deps: DocumentWatchServiceDeps; sendMessage: ReturnType<typeof vi.fn>; saveWatches: ReturnType<typeof vi.fn>; getState: () => WatchedDocument[] } {
  let state = watches;
  const saveWatches = vi.fn(async (next: WatchedDocument[]) => { state = next; });
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const threads = new Map<string, Thread>();
  for (const w of watches) threads.set(w.threadId, { id: w.threadId } as Thread);
  const deps: DocumentWatchServiceDeps = {
    app,
    getWatches: () => state,
    saveWatches,
    sendMessage,
    getThread: (id: string) => threads.get(id),
    ...overrides,
  };
  return { deps, sendMessage, saveWatches, getState: () => state };
}

describe('DocumentWatchService — no-op resave guard', () => {
  it('does not alert when the stamp is unchanged (resave with no real diff)', () => {
    const { vault, setFile, emitModify } = makeVault();
    const file = setFile('Notes/Doc.md', 1000, 50);
    const watch = makeWatch({ lastStamp: `${file.stat.mtime}:${file.stat.size}` });
    const timers = makeTimers();
    const { deps, sendMessage } = makeDeps({ vault } as unknown as App, [watch], timers);

    const svc = new DocumentWatchService(deps);
    svc.start();
    emitModify('Notes/Doc.md');
    timers.runPending(); // stage 1 coalesce

    expect(sendMessage).not.toHaveBeenCalled();
    expect(timers.pendingCount()).toBe(0); // no alert timer armed
  });
});

describe('DocumentWatchService — real content change', () => {
  it('alerts the owning thread with an @[[basename]] mention', async () => {
    const { vault, setFile, emitModify } = makeVault();
    setFile('Notes/Doc.md', 1000, 50);
    const watch = makeWatch({ lastStamp: '999:40' }); // stale stamp → real change
    const timers = makeTimers();
    const { deps, sendMessage, saveWatches } = makeDeps({ vault } as unknown as App, [watch], timers);

    const svc = new DocumentWatchService(deps);
    svc.start();
    emitModify('Notes/Doc.md');
    timers.runPending(); // stage 1: detects change, arms alert timer
    timers.runPending(); // stage 2: sends batched alert
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [threadId, message] = sendMessage.mock.calls[0];
    expect(threadId).toBe('thread-1');
    expect(message).toContain('@[[Doc]]');
    expect(message).toMatch(/^📄 Watched document\(s\) changed:/);
    expect(message).toContain('(If you just made this edit yourself, no action needed.)');

    expect(saveWatches).toHaveBeenCalled();
    const saved = saveWatches.mock.calls.at(-1)![0] as WatchedDocument[];
    expect(saved[0].lastStamp).toBe('1000:50');
    expect(saved[0].lastAlertedAt).toBeTypeOf('number');
  });
});

describe('DocumentWatchService — burst batching', () => {
  it('batches two files changing in one burst into ONE message, not two', async () => {
    const { vault, setFile, emitModify } = makeVault();
    setFile('Notes/One.md', 1000, 10);
    setFile('Notes/Two.md', 2000, 20);
    const watchOne = makeWatch({ id: 'w1', path: 'Notes/One.md', lastStamp: '0:0' });
    const watchTwo = makeWatch({ id: 'w2', path: 'Notes/Two.md', lastStamp: '0:0' });
    const timers = makeTimers();
    const { deps, sendMessage } = makeDeps({ vault } as unknown as App, [watchOne, watchTwo], timers);

    const svc = new DocumentWatchService(deps);
    svc.start();
    emitModify('Notes/One.md');
    emitModify('Notes/Two.md');
    timers.runPending(); // stage 1 coalesce (single timer covers the burst)
    timers.runPending(); // stage 2 alert
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, message] = sendMessage.mock.calls[0];
    expect(message).toContain('@[[One]]');
    expect(message).toContain('@[[Two]]');
  });
});

describe('DocumentWatchService — rename', () => {
  it('updates the watch path without alerting', () => {
    const { vault, setFile, emitRename } = makeVault();
    setFile('Notes/Old.md', 1000, 10);
    const watch = makeWatch({ path: 'Notes/Old.md', lastStamp: '1000:10' });
    const timers = makeTimers();
    const { deps, sendMessage, saveWatches, getState } = makeDeps({ vault } as unknown as App, [watch], timers);

    const svc = new DocumentWatchService(deps);
    svc.start();
    emitRename('Notes/Old.md', 'Notes/New.md');

    expect(sendMessage).not.toHaveBeenCalled();
    expect(saveWatches).toHaveBeenCalled();
    expect(getState()[0].path).toBe('Notes/New.md');
  });
});

describe('DocumentWatchService — delete', () => {
  it('sends one final alert per owning thread, then removes the watch', async () => {
    const { vault, setFile, emitDelete } = makeVault();
    setFile('Notes/Gone.md', 1000, 10);
    const watch = makeWatch({ path: 'Notes/Gone.md', lastStamp: '1000:10' });
    const timers = makeTimers();
    const { deps, sendMessage, saveWatches, getState } = makeDeps({ vault } as unknown as App, [watch], timers);

    const svc = new DocumentWatchService(deps);
    svc.start();
    emitDelete('Notes/Gone.md');
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [threadId, message] = sendMessage.mock.calls[0];
    expect(threadId).toBe('thread-1');
    expect(message).toContain('🗑️');
    expect(message).toContain('Notes/Gone.md');

    expect(saveWatches).toHaveBeenCalled();
    expect(getState()).toHaveLength(0);
  });
});

describe('DocumentWatchService — dead owning thread', () => {
  it('drops the alert and prunes the watch when the owning thread no longer exists', async () => {
    const { vault, setFile, emitModify } = makeVault();
    setFile('Notes/Orphan.md', 1000, 50);
    const watch = makeWatch({ path: 'Notes/Orphan.md', threadId: 'gone-thread', lastStamp: '0:0' });
    const timers = makeTimers();
    const { deps, sendMessage, saveWatches, getState } = makeDeps({ vault } as unknown as App, [watch], {
      ...timers,
      getThread: () => undefined, // thread archived/deleted
    });

    const svc = new DocumentWatchService(deps);
    svc.start();
    emitModify('Notes/Orphan.md');
    timers.runPending(); // stage 1
    timers.runPending(); // stage 2 — finds thread missing
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(saveWatches).toHaveBeenCalled();
    expect(getState().find(w => w.threadId === 'gone-thread')).toBeUndefined();
  });
});

describe('DocumentWatchService — primeWatch', () => {
  it('snapshots the current stamp so watching itself never counts as a change', () => {
    const { vault, setFile } = makeVault();
    setFile('Notes/Fresh.md', 5000, 123);
    const watch = makeWatch({ path: 'Notes/Fresh.md', lastStamp: undefined });
    const timers = makeTimers();
    const { deps } = makeDeps({ vault } as unknown as App, [watch], timers);

    const svc = new DocumentWatchService(deps);
    svc.primeWatch(watch);

    expect(watch.lastStamp).toBe('5000:123');
  });
});
