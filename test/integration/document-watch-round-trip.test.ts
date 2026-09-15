/**
 * document-watch-round-trip.test.ts
 *
 * End-to-end trace of "watch a document, get alerted when it changes" without
 * a live Obsidian instance: creates a watch through the actual `watch_document`
 * MCP tool handler (src/ObsidianTools.ts), then feeds a real `modify` event
 * with a changed stat through the actual DocumentWatchService, and confirms
 * `sendMessage` fires with the expected `@[[basename]]`-formatted alert.
 *
 * The watch_document tool and DocumentWatchService share one settings array
 * and one fake vault, exactly as main.ts wires them in the real plugin
 * (onWatchDocument delegates to Plugin.watchDocument, which pushes into
 * `settings.watchedDocuments` and calls `documentWatch.primeWatch`).
 */
import { describe, it, expect, vi } from 'vitest';
import { TFile, type App } from 'obsidian';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (
    name: string,
    _description: string,
    _schema: unknown,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult>,
  ) => ({ _toolName: name, _handler: handler }),
  createSdkMcpServer: ({ tools }: { tools: CapturedTool[] }) => ({ tools }),
}));

import { createObsidianMcpServer } from '../../src/ObsidianTools';
import { DocumentWatchService } from '../../src/DocumentWatchService';
import type { Thread, WatchedDocument } from '../../src/types';

interface ToolResult {
  content: [{ type: string; text: string }];
  isError?: boolean;
}

interface CapturedTool {
  _toolName: string;
  _handler: (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;
}

interface CapturedServer {
  tools: CapturedTool[];
}

function getTool(server: CapturedServer, name: string): CapturedTool {
  const t = server.tools.find((tool) => tool._toolName === name);
  if (!t) throw new Error(`Tool "${name}" not found in server`);
  return t;
}

// ── Fake vault shared by the tool and the service, mirroring the real plugin wiring ──

function makeVault() {
  type Listener = (...args: any[]) => void;
  const listeners: Record<'modify' | 'rename' | 'delete', Listener[]> = { modify: [], rename: [], delete: [] };
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
  };
}

function makeTimers() {
  let idCounter = 0;
  const scheduled = new Map<number, () => void>();
  return {
    setTimeoutFn: (cb: () => void, _ms: number) => {
      const id = ++idCounter;
      scheduled.set(id, cb);
      return id;
    },
    clearTimeoutFn: (id: unknown) => { scheduled.delete(id as number); },
    runPending: () => {
      const entries = [...scheduled.entries()];
      scheduled.clear();
      for (const [, cb] of entries) cb();
    },
  };
}

describe('watch_document → modify → alert round trip', () => {
  it('creates a watch via the real tool handler, then alerts the owning thread on a real content change', async () => {
    const { vault, setFile, emitModify } = makeVault();
    setFile('Reports/Weekly.md', 1000, 100);

    let watchedDocuments: WatchedDocument[] = [];
    const threads = new Map<string, Thread>([['thread-1', { id: 'thread-1' } as Thread]]);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const timers = makeTimers();

    const app = { vault } as unknown as App;

    const documentWatch = new DocumentWatchService({
      app,
      getWatches: () => watchedDocuments,
      saveWatches: async (next) => { watchedDocuments = next; },
      sendMessage,
      getThread: (id) => threads.get(id),
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    documentWatch.start();

    // Plugin.watchDocument's real behavior: resolve the file, dedupe by
    // (threadId, path), prime the stamp, persist. threadId is bound via
    // closure exactly as main.ts's mcpServerFactory does for onWatchDocument.
    const threadId = 'thread-1';
    const onWatchDocument = async (path: string) => {
      const abstract = vault.getAbstractFileByPath(path);
      if (!(abstract instanceof TFile)) throw new Error(`File not found: ${path}`);
      const watch: WatchedDocument = {
        id: 'watch-1',
        path: abstract.path,
        threadId,
        enabled: true,
        createdAt: 0,
      };
      documentWatch.primeWatch(watch);
      watchedDocuments = [...watchedDocuments, watch];
      return { id: watch.id, path: watch.path };
    };

    const server = createObsidianMcpServer(app, { onWatchDocument }) as unknown as CapturedServer;
    const watchTool = getTool(server, 'watch_document');

    const toolResult = await watchTool._handler({ path: 'Reports/Weekly.md' });
    const parsed = JSON.parse(toolResult.content[0].text);
    expect(parsed).toEqual({ id: 'watch-1', path: 'Reports/Weekly.md' });
    expect(toolResult.isError).toBeUndefined();

    // Watching itself must not count as a change: primeWatch snapshotted the
    // stamp at creation time, matching the file's current (unchanged) stat.
    expect(watchedDocuments[0].lastStamp).toBe('1000:100');

    // Now simulate a real edit: bump mtime/size and fire the vault's modify event.
    setFile('Reports/Weekly.md', 2000, 140);
    emitModify('Reports/Weekly.md');

    timers.runPending(); // stage 1: coalesce, detects a real stamp change
    expect(sendMessage).not.toHaveBeenCalled(); // stage 2 hasn't fired yet

    timers.runPending(); // stage 2: batched per-thread alert
    await Promise.resolve();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [alertedThreadId, message] = sendMessage.mock.calls[0];
    expect(alertedThreadId).toBe('thread-1');
    expect(message).toContain('@[[Weekly]]');
    expect(message).toMatch(/^📄 Watched document\(s\) changed:/);

    // The watch's stamp reflects the file's final state after the alert.
    expect(watchedDocuments[0].lastStamp).toBe('2000:140');
    expect(watchedDocuments[0].lastAlertedAt).toBeTypeOf('number');
  });
});
