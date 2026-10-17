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
});
