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
  appendPermissionButtons(el, 'thread-1', pending, { manager, settings, saveSettings, hostExecAllowAlways: over.allowAlways ?? true });
  return { el, manager, settings, saveSettings, order, btns: Array.from(el.querySelectorAll('button')) };
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

  it('re-exports summarizePermissionDetail', () => {
    expect(typeof summarizePermissionDetail).toBe('function');
    expect(summarizePermissionDetail('plain')).toBe(summarizePermissionDetail('plain'));
  });
});
