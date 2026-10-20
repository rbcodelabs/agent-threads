import { describe, expect, it, vi } from 'vitest';

vi.mock('@anthropic-ai/claude-agent-sdk/browser', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: (a: any) => Promise<any>) => ({ name, description, inputSchema, handler }),
}));
vi.mock('obsidian', () => ({ normalizePath: (p: string) => p }));

import { createSyncTools, lineDiff } from '../../src/tools/sync';

const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0]!.text);

function setup(conflicts: any[]) {
  const files: Record<string, string> = { 'a.md': 'one\ntwo\n', 'a.sync-conflict-1.md': 'one\nthree\n' };
  const resolveConflict = vi.fn(async () => {});
  const app: any = {
    sync: { listConflicts: async () => conflicts, resolveConflict },
    vault: {
      adapter: {
        exists: async (p: string) => p in files,
        read: async (p: string) => files[p],
        write: async (p: string, c: string) => { files[p] = c; },
      },
    },
  };
  return { tools: createSyncTools({ app }) as Record<string, any>, files, resolveConflict };
}

describe('sync conflict tools', () => {
  it('lineDiff marks local-only and remote-only lines', () => {
    expect(lineDiff('a\nb', 'a\nc')).toBe('  a\n- b\n+ c');
  });

  it('lists conflicts with kind', async () => {
    const { tools } = setup([{ id: '1', path: 'a.md', conflictPath: 'a.sync-conflict-1.md' }, { id: '2', path: 'b.md' }]);
    const out = parse(await tools.sync_list_conflicts.handler({}));
    expect(out.map((c: any) => c.kind)).toEqual(['sibling', 'history']);
  });

  it('inspects a sibling conflict with a diff', async () => {
    const { tools } = setup([{ id: '1', path: 'a.md', conflictPath: 'a.sync-conflict-1.md' }]);
    const out = parse(await tools.sync_inspect_conflict.handler({ id: '1' }));
    expect(out.kind).toBe('sibling');
    expect(out.diff).toContain('- two');
    expect(out.diff).toContain('+ three');
  });

  it('errors on unknown id and when sync is unavailable', async () => {
    const { tools } = setup([]);
    expect((await tools.sync_inspect_conflict.handler({ id: 'x' })).isError).toBe(true);
    const bare = createSyncTools({ app: { vault: { adapter: {} } } as any }) as Record<string, any>;
    expect((await bare.sync_list_conflicts.handler({})).isError).toBe(true);
  });

  it('resolves, writing merged content first as keep-local', async () => {
    const { tools, files, resolveConflict } = setup([{ id: '1', path: 'a.md', conflictPath: 'a.sync-conflict-1.md' }]);
    const out = parse(await tools.sync_resolve_conflict.handler({ id: '1', resolution: 'accept-remote', mergedContent: 'merged' }));
    expect(files['a.md']).toBe('merged');
    expect(resolveConflict).toHaveBeenCalledWith('1', 'keep-local');
    expect(out.resolved).toBe(true);
  });

  it('rejects mergedContent for history conflicts', async () => {
    const { tools, resolveConflict } = setup([{ id: '2', path: 'b.md' }]);
    expect((await tools.sync_resolve_conflict.handler({ id: '2', resolution: 'keep-local', mergedContent: 'x' })).isError).toBe(true);
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  describe('history conflicts', () => {
    const hid = JSON.stringify(['ent', ['r1', 'r2']]);
    function withHistory() {
      const resolveHistoryConflict = vi.fn(async () => {});
      const app: any = {
        sync: {
          listConflicts: async () => [{ id: hid, path: 'h.md', conflictPath: '' }],
          resolveConflict: vi.fn(),
          describeHistoryConflict: async () => ({ comparable: true, heads: [{ recordId: 'r1' }, { recordId: 'r2', deleted: true }] }),
          readHistoryConflictText: async (_e: string, c: any) => (c.kind === 'current' ? 'a\nb' : 'a\nc'),
          resolveHistoryConflict,
        },
        vault: { adapter: {} },
      };
      return { tools: createSyncTools({ app }) as Record<string, any>, resolveHistoryConflict };
    }

    it('inspects with per-version text and diff', async () => {
      const { tools } = withHistory();
      const out = parse(await tools.sync_inspect_conflict.handler({ id: hid }));
      expect(out.kind).toBe('history');
      expect(out.local).toBe('a\nb');
      expect(out.versions[0].diffFromLocal).toContain('+ c');
      expect(out.versions[1].text).toBeNull();
    });

    it('resolves keep-local as current and accept-remote as an explicit version', async () => {
      const { tools, resolveHistoryConflict } = withHistory();
      await tools.sync_resolve_conflict.handler({ id: hid, resolution: 'keep-local' });
      expect(resolveHistoryConflict).toHaveBeenLastCalledWith({ entityId: 'ent', heads: ['r1', 'r2'], choice: { kind: 'current' } });
      await tools.sync_resolve_conflict.handler({ id: hid, resolution: 'accept-remote', recordId: 'r1' });
      expect(resolveHistoryConflict).toHaveBeenLastCalledWith({ entityId: 'ent', heads: ['r1', 'r2'], choice: { kind: 'version', recordId: 'r1' } });
    });

    it('refuses accept-remote without a valid recordId', async () => {
      const { tools, resolveHistoryConflict } = withHistory();
      expect((await tools.sync_resolve_conflict.handler({ id: hid, resolution: 'accept-remote' })).isError).toBe(true);
      expect((await tools.sync_resolve_conflict.handler({ id: hid, resolution: 'accept-remote', recordId: 'zzz' })).isError).toBe(true);
      expect(resolveHistoryConflict).not.toHaveBeenCalled();
    });
  });
});

describe('busy retry', () => {
  const hid = JSON.stringify(['ent', ['r1']]);
  const make = (failures: number, message = 'Sync already running or disconnecting') => {
    let n = 0;
    const resolveHistoryConflict = vi.fn(async () => { if (n++ < failures) throw new Error(message); });
    const app: any = {
      sync: { listConflicts: async () => [{ id: hid, path: 'h.md', conflictPath: '' }], resolveConflict: vi.fn(), resolveHistoryConflict },
      vault: { adapter: {} },
    };
    return { tools: createSyncTools({ app, busyRetry: { attempts: 3, delayMs: 1 } }) as Record<string, any>, resolveHistoryConflict };
  };

  it('retries resolve while sync is busy, then succeeds', async () => {
    const { tools, resolveHistoryConflict } = make(2);
    const out = parse(await tools.sync_resolve_conflict.handler({ id: hid, resolution: 'keep-local' }));
    expect(out.resolved).toBe(true);
    expect(resolveHistoryConflict).toHaveBeenCalledTimes(3);
  });

  it('gives up after the attempt limit and reports the error', async () => {
    const { tools, resolveHistoryConflict } = make(10);
    const res = await tools.sync_resolve_conflict.handler({ id: hid, resolution: 'keep-local' });
    expect(res.isError).toBe(true);
    expect(resolveHistoryConflict).toHaveBeenCalledTimes(3);
  });

  it('does not retry other errors', async () => {
    const { tools, resolveHistoryConflict } = make(10, 'boom');
    expect((await tools.sync_resolve_conflict.handler({ id: hid, resolution: 'keep-local' })).isError).toBe(true);
    expect(resolveHistoryConflict).toHaveBeenCalledTimes(1);
  });
});
