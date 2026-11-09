/**
 * permission-card.test.ts
 * @vitest-environment jsdom
 *
 * Contract of the shared permission-button helper used by the Kanban card
 * (and later the OrchestratorDock).
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect } from 'vitest';
import { appendPermissionButtons, summarizePermissionDetail } from '../../src/permissionCard';

function setup(pending: { toolName: string; detail: string } | undefined, over: { remote?: { daemonId: string }; allowAlways?: boolean } = {}) {
  const order: string[] = [];
  const manager = {
    resolvePermission: vi.fn((_id: string, allow: boolean) => { order.push(`resolve:${allow}`); }),
    getRemoteScope: vi.fn(() => over.remote ?? null),
  };
  const settings = { alwaysAllowedTools: [] as string[], hostExecAlwaysAllowedPrefixes: [] as string[] } as {
    alwaysAllowedTools: string[]; hostExecAlwaysAllowedPrefixes: string[]; remoteAlwaysAllowedTools?: Record<string, string[]>;
  };
  const saveSettings = vi.fn(async () => { order.push('save'); });
  const el = document.createElement('div');
  let current = settings;
  appendPermissionButtons(el, 'thread-1', pending, { manager, getSettings: () => current, saveSettings, hostExecAllowAlways: over.allowAlways ?? true });
  return { el, manager, settings, saveSettings, order, replaceSettings: (next: typeof settings) => { current = next; }, btns: Array.from(el.querySelectorAll('button')) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('appendPermissionButtons', () => {
  it('appends into the given container and returns nothing', () => {
    const { el, btns } = setup({ toolName: 'Edit', detail: '{}' });
    expect(el.children).toHaveLength(btns.length);
    expect(btns.map((b) => b.textContent)).toEqual(['Deny', 'Allow', 'Always']);
  });

  it('calls manager.resolvePermission(threadId, allow) exactly', async () => {
    const { btns, manager } = setup({ toolName: 'Edit', detail: '{}' });
    btns[0].click(); btns[1].click();
    await flush();
    expect(manager.resolvePermission.mock.calls).toEqual([['thread-1', false], ['thread-1', true]]);
  });

  it('stops propagation of every click', () => {
    const { el, btns } = setup({ toolName: 'Edit', detail: '{}' });
    const outer = vi.fn();
    const wrap = document.createElement('div');
    wrap.appendChild(el);
    wrap.addEventListener('click', outer);
    btns.forEach((b) => b.click());
    expect(outer).not.toHaveBeenCalled();
  });

  it('Always uses the thread remote scope, persists, then resolves', async () => {
    const { btns, manager, settings, order } = setup({ toolName: 'Edit', detail: '{}' }, { remote: { daemonId: 'd9' } });
    btns[2].click();
    await flush();
    expect(manager.getRemoteScope).toHaveBeenCalledWith('thread-1');
    expect(settings.remoteAlwaysAllowedTools).toEqual({ d9: ['Edit'] });
    expect(order).toEqual(['save', 'resolve:true']);
  });

  it('host_exec: Allow once and Always `prefix` (no bare Always); prefix persisted via settings', async () => {
    const detail = `Run host_exec for a remote thread: ${JSON.stringify({ command: 'git status' })}`;
    const { btns, settings, order } = setup({ toolName: 'mcp__claude_threads__host_exec', detail });
    expect(btns.map((b) => b.textContent)).toEqual(['Deny', 'Allow once', 'Always `git status`']);
    btns[2].click();
    await flush();
    expect(settings.hostExecAlwaysAllowedPrefixes).toEqual(['git status']);
    expect(order).toEqual(['save', 'resolve:true']);
  });

  it('hostExecAllowAlways=false withholds the prefix offer', () => {
    const detail = `Run host_exec for a remote thread: ${JSON.stringify({ command: 'git status' })}`;
    const { btns } = setup({ toolName: 'mcp__claude_threads__host_exec', detail }, { allowAlways: false });
    expect(btns.map((b) => b.textContent)).toEqual(['Deny', 'Allow once']);
  });

  it('reads settings lazily at click time (a replaced settings object is the one mutated)', async () => {
    const { btns, settings, replaceSettings, saveSettings } = setup({ toolName: 'Edit', detail: '{}' });
    const next = { alwaysAllowedTools: [] as string[], hostExecAlwaysAllowedPrefixes: [] as string[] };
    replaceSettings(next);
    btns[2].click();
    await flush();
    expect(next.alwaysAllowedTools).toEqual(['Edit']);
    expect(settings.alwaysAllowedTools).toEqual([]);
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it('re-exports summarizePermissionDetail', () => {
    expect(typeof summarizePermissionDetail).toBe('function');
    expect(summarizePermissionDetail('plain')).toBe(summarizePermissionDetail('plain'));
  });
});

// ── optional guard (the tray turns it on; the board does not) ────────────────────────────────────────────────────────

describe('appendPermissionButtons with a guard', () => {
  type Info = { toolName: string; detail: string; promptId?: number } | undefined;
  function guarded(initial: Info) {
    const state: { pending: Info; onSave?: () => Promise<void> | void } = { pending: initial };
    const order: string[] = [];
    const manager = {
      resolvePermission: vi.fn((_id: string, allow: boolean) => { order.push(`resolve:${allow}`); }),
      getRemoteScope: vi.fn(() => null),
    };
    const settings = { alwaysAllowedTools: [] as string[], hostExecAlwaysAllowedPrefixes: [] as string[] };
    const saveSettings = vi.fn(async () => { order.push('save'); await state.onSave?.(); });
    const onStale = vi.fn();
    const setBusy = vi.fn();
    const el = document.createElement('div');
    const snapshot = initial;
    appendPermissionButtons(el, 't1', snapshot, {
      manager, getSettings: () => settings, saveSettings, hostExecAllowAlways: true,
      guard: { getPending: () => state.pending, onStale, setBusy },
    });
    return Object.assign(state, { el, manager, settings, saveSettings, order, onStale, setBusy, btns: Array.from(el.querySelectorAll('button')) });
  }

  it('unchanged: a guarded click resolves once and marks the card busy first', () => {
    const g = guarded({ toolName: 'Edit', detail: '{}', promptId: 1 });
    g.btns[1].click();
    expect(g.manager.resolvePermission.mock.calls).toEqual([['t1', true]]);
    expect(g.setBusy).toHaveBeenCalledWith(true);
    expect(g.onStale).not.toHaveBeenCalled();
  });

  it('a different prompt id, a different tool or detail, or nothing pending is stale: no resolve, onStale', () => {
    for (const now of [
      { toolName: 'Edit', detail: '{}', promptId: 2 },
      { toolName: 'Write', detail: '{}', promptId: 1 },
      { toolName: 'Edit', detail: '{"x":1}', promptId: 1 },
      undefined,
    ] as Info[]) {
      const g = guarded({ toolName: 'Edit', detail: '{}', promptId: 1 });
      g.pending = now;
      g.btns[0].click(); g.btns[1].click(); g.btns[2].click();
      expect(g.manager.resolvePermission).not.toHaveBeenCalled();
      expect(g.onStale).toHaveBeenCalled();
      expect(g.saveSettings).not.toHaveBeenCalled();
      expect(g.settings.alwaysAllowedTools).toEqual([]);
    }
  });

  it('Always: re-checks AFTER the save await and resolves nothing if the queue advanced', async () => {
    const g = guarded({ toolName: 'Edit', detail: '{}', promptId: 1 });
    g.onSave = () => { g.pending = { toolName: 'Bash', detail: 'rm -rf /', promptId: 2 }; };
    g.btns[2].click();
    await flush();
    expect(g.manager.resolvePermission).not.toHaveBeenCalled();
    expect(g.onStale).toHaveBeenCalled();
    expect(g.settings.alwaysAllowedTools).toEqual(['Edit']);
  });

  it('Always `prefix`: same re-check after the await', async () => {
    const detail = `Run host_exec for a remote thread: ${JSON.stringify({ command: 'git status' })}`;
    const g = guarded({ toolName: 'mcp__claude_threads__host_exec', detail, promptId: 1 });
    g.onSave = () => { g.pending = { toolName: 'mcp__claude_threads__host_exec', detail, promptId: 2 }; }; // identical text, NEW prompt
    g.btns[2].click();
    await flush();
    expect(g.manager.resolvePermission).not.toHaveBeenCalled();
  });

  it('without a guard nothing changes (the board keeps its behaviour)', async () => {
    const { btns, manager } = setup({ toolName: 'Edit', detail: '{}' });
    btns[1].click();
    expect(manager.resolvePermission).toHaveBeenCalledWith('thread-1', true);
  });
});
