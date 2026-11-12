/**
 * kanban-permission-buttons.test.ts
 * @vitest-environment jsdom
 *
 * Characterization of the Deny / Allow / Always buttons on a Kanban card with a
 * pending permission. Drives the real KanbanView so the DOM, classes, click
 * wiring and persistence order are pinned before (and after) the buttons move
 * into src/permissionCard.ts.
 */
import '../setup/obsidian-dom';
import { vi, describe, it, expect } from 'vitest';

vi.mock('../../src/ClaudeSession', () => ({ formatToolName: (n: string) => n }));
vi.mock('../../src/DispatchInput', () => ({ DispatchInput: class { mount() {} destroy() {} setValue() {} } }));

import { KanbanView } from '../../src/KanbanView';
import type { Thread } from '../../src/types';

type Pending = { toolName: string; detail: string } | undefined;

function setup(opts: { pending: Pending; remote?: { daemonId: string }; allowAlways?: boolean }) {
  const thread = {
    id: 'p', title: 'Perm thread', cwd: '/repo',
    messages: [{ id: 'm1', role: 'assistant', content: 'hello', createdAt: 0 }],
    createdAt: 0, updatedAt: 0, status: 'waiting', reviewed: true,
  } as unknown as Thread;
  const calls: string[] = [];
  const manager = {
    vaultRoot: '/vault',
    getThreads: () => [thread],
    getThread: () => thread,
    isRunning: () => false,
    hasPendingPermission: () => true,
    hasPendingQuestion: () => false,
    hasPendingPlan: () => false,
    isRunStale: () => false,
    hasActiveBackgroundTasks: () => false,
    getThreadActivity: () => 'Working...',
    getProject: () => undefined,
    getProjects: () => [],
    getPendingPermission: () => opts.pending,
    getPendingQuestionResolver: () => undefined,
    getRemoteScope: () => opts.remote ?? null,
    subscribe: () => () => {},
    resolvePermission: vi.fn((_id: string, allow: boolean) => { calls.push(`resolve:${allow}`); }),
  };
  const settings = {
    kanbanGroupBy: 'status', stackScheduledThreads: false, alwaysAllowedTools: [] as string[],
    hostExecAlwaysAllowedPrefixes: [] as string[], extraEnv: '', kanbanCollapseSide: 'none',
    remoteAlwaysAllowedTools: undefined as Record<string, string[]> | undefined,
  };
  const plugin = {
    manager, settings,
    managedPolicy: opts.allowAlways === false ? { peek: () => ({ hostExec: { allowAlways: false } }) } : undefined,
    hasPendingWakeup: () => false,
    getPendingWakeups: () => [],
    getActiveThreadId: () => null,
    saveSettings: vi.fn(async () => { calls.push('save'); }),
    openThreadInChatView: vi.fn(),
    openThreadWithPrefill: vi.fn(),
  };
  const view = new KanbanView({} as never, plugin as never) as unknown as {
    boardEl: HTMLElement; headerCountEl: HTMLElement; needsYouOnlyBtn: HTMLButtonElement; render: () => void;
  };
  view.boardEl = document.createElement('div');
  view.headerCountEl = document.createElement('div');
  view.needsYouOnlyBtn = document.createElement('button');
  view.render();
  const actions = view.boardEl.querySelector<HTMLElement>('.ct-kanban-perm-actions')!;
  return { actions, manager, plugin, settings, calls, view };
}

const buttons = (actions: HTMLElement) => Array.from(actions.querySelectorAll('button'));
const flush = () => new Promise((r) => setTimeout(r, 0));
const HOST_EXEC = (cmd: string) => ({
  toolName: 'mcp__claude_threads__host_exec',
  detail: `Run host_exec for a remote thread: ${JSON.stringify({ command: cmd })}`,
});

describe('Kanban card permission buttons', () => {
  it('reads plugin.settings at click time: a settings object reassigned after render is the one mutated', async () => {
    const { actions, plugin, settings, calls } = setup({ pending: { toolName: 'Bash', detail: 'ls' } });
    const replacement = { ...settings, alwaysAllowedTools: [] as string[] };
    (plugin as { settings: unknown }).settings = replacement;
    buttons(actions)[2].click();
    await flush();
    expect(replacement.alwaysAllowedTools).toEqual(['Bash']);
    expect(settings.alwaysAllowedTools).toEqual([]);
    expect(calls).toEqual(['save', 'resolve:true']);
  });

  it('renders Deny, Allow, Always with the existing classes for an ordinary tool', () => {
    const { actions } = setup({ pending: { toolName: 'Bash', detail: 'ls' } });
    expect(buttons(actions).map((b) => [b.textContent, b.className])).toEqual([
      ['Deny', 'ct-permission-btn ct-permission-deny'],
      ['Allow', 'ct-permission-btn ct-permission-allow'],
      ['Always', 'ct-permission-btn ct-permission-always'],
    ]);
  });

  it('Deny and Allow call manager.resolvePermission(threadId, bool) and never persist', async () => {
    const { actions, manager, plugin } = setup({ pending: { toolName: 'Bash', detail: 'ls' } });
    const [deny, allow] = buttons(actions);
    deny.click();
    allow.click();
    await flush();
    expect(manager.resolvePermission.mock.calls).toEqual([['p', false], ['p', true]]);
    expect(plugin.saveSettings).not.toHaveBeenCalled();
  });

  it('stops click propagation so the card does not open the thread', () => {
    const { actions, plugin } = setup({ pending: { toolName: 'Bash', detail: 'ls' } });
    buttons(actions).forEach((b) => b.click());
    expect(plugin.openThreadInChatView).not.toHaveBeenCalled();
  });

  it('Always records a local always-allow, saves, then resolves (in that order)', async () => {
    const { actions, settings, calls } = setup({ pending: { toolName: 'Bash', detail: 'ls' } });
    buttons(actions)[2].click();
    await flush();
    expect(settings.alwaysAllowedTools).toEqual(['Bash']);
    expect(calls).toEqual(['save', 'resolve:true']);
  });

  it('Always on a repeat tool does not save but still resolves', async () => {
    const { actions, settings, calls } = setup({ pending: { toolName: 'Bash', detail: 'ls' } });
    settings.alwaysAllowedTools.push('Bash');
    buttons(actions)[2].click();
    await flush();
    expect(calls).toEqual(['resolve:true']);
  });

  it('Always on a remote thread records into that daemon list only', async () => {
    const { actions, settings, calls } = setup({ pending: { toolName: 'Bash', detail: 'ls' }, remote: { daemonId: 'd1' } });
    buttons(actions)[2].click();
    await flush();
    expect(settings.alwaysAllowedTools).toEqual([]);
    expect(settings.remoteAlwaysAllowedTools).toEqual({ d1: ['Bash'] });
    expect(calls).toEqual(['save', 'resolve:true']);
  });

  it('with no pending info still offers Allow and Always; Always just resolves', async () => {
    const { actions, settings, calls } = setup({ pending: undefined });
    expect(buttons(actions).map((b) => b.textContent)).toEqual(['Deny', 'Allow', 'Always']);
    buttons(actions)[2].click();
    await flush();
    expect(settings.alwaysAllowedTools).toEqual([]);
    expect(calls).toEqual(['resolve:true']);
  });

  it('host_exec: Allow once + Always `prefix`, and no plain Always', async () => {
    const { actions, settings, calls } = setup({ pending: HOST_EXEC('npm test') });
    expect(buttons(actions).map((b) => [b.textContent, b.className])).toEqual([
      ['Deny', 'ct-permission-btn ct-permission-deny'],
      ['Allow once', 'ct-permission-btn ct-permission-allow'],
      ['Always `npm test`', 'ct-permission-btn ct-permission-always'],
    ]);
    buttons(actions)[2].click();
    await flush();
    expect(settings.hostExecAlwaysAllowedPrefixes).toEqual(['npm test']);
    expect(settings.alwaysAllowedTools).toEqual([]);
    expect(calls).toEqual(['save', 'resolve:true']);
  });

  it('host_exec prefix offer is withheld when managed policy disables allowAlways', () => {
    const { actions } = setup({ pending: HOST_EXEC('npm test'), allowAlways: false });
    expect(buttons(actions).map((b) => b.textContent)).toEqual(['Deny', 'Allow once']);
  });

  it('host_exec with an unscopable command offers only Deny / Allow once', () => {
    const { actions } = setup({ pending: HOST_EXEC('rm -rf /tmp/x') });
    expect(buttons(actions).map((b) => b.textContent)).toEqual(['Deny', 'Allow once']);
  });
});
