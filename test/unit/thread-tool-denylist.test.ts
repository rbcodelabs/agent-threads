/**
 * Per-thread tool denylist (`Thread.disallowedTools`).
 *
 * Live QA: a prompt-level "no shell" rule in the Chief of Staff pack was not
 * reliable — the model still called Bash as a scratchpad. So the plugin
 * enforces it: the home thread is created with `disallowedTools: ['Bash']`,
 * scheduled items created FROM a restricted thread inherit the list (keyed by
 * the creating thread id, never by name), and the threads they spawn inherit
 * it too. Restriction-only: every merge is a union, nothing can remove an
 * entry, and absent means "no change".
 */
import { describe, expect, it, vi } from 'vitest';
import os from 'os';
import ClaudeThreadsPlugin from '../../src/main';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS, type ScheduledItem, type Thread } from '../../src/types';
import { isShellDenied, mergeDisallowedTools, withCreatorToolRestrictions } from '../../src/toolRestrictions';
import { openCodePermissionConfig } from '../../src/OpenCodeSession';
import { CodexSession } from '../../src/CodexSession';
import { mergePersistedSettings } from '../../src/productIdentity';

describe('pure helpers', () => {
  it('mergeDisallowedTools is a de-duplicated union that ignores absent lists', () => {
    expect(mergeDisallowedTools(['CronCreate', 'Bash'], undefined, ['Bash', 'WebFetch'])).toEqual(['CronCreate', 'Bash', 'WebFetch']);
    expect(mergeDisallowedTools(undefined, [])).toEqual([]);
  });

  it('isShellDenied is true only when Bash is in the list', () => {
    expect(isShellDenied(['Bash'])).toBe(true);
    expect(isShellDenied(['Write'])).toBe(false);
    expect(isShellDenied(undefined)).toBe(false);
  });

  it('withCreatorToolRestrictions copies the creator list and records the creator id; unrestricted creators change nothing', () => {
    const params = { name: 'Chief of Staff — morning brief', prompt: 'p' };
    expect(withCreatorToolRestrictions(params, { id: 'home', disallowedTools: ['Bash'] }))
      .toEqual({ ...params, disallowedTools: ['Bash'], createdByThreadId: 'home' });
    expect(withCreatorToolRestrictions(params, { id: 'plain' })).toEqual(params);
    expect(withCreatorToolRestrictions(params, undefined)).toEqual(params);
  });

  it('can only add: an item that already restricts keeps its entries', () => {
    const params = { name: 'x', prompt: 'p', disallowedTools: ['WebFetch'] };
    expect(withCreatorToolRestrictions(params, { id: 'home', disallowedTools: ['Bash'] }).disallowedTools).toEqual(['WebFetch', 'Bash']);
  });
});

describe('session options', () => {
  function build(thread: Thread, settings = { ...DEFAULT_SETTINGS }) {
    const manager = new ThreadManager(settings);
    manager.loadThreads([thread]);
    return (manager as unknown as { buildThreadSessionOptions: (id: string, t: Thread) => Record<string, any> }).buildThreadSessionOptions(thread.id, thread);
  }
  const base = (extra: Partial<Thread> = {}): Thread => ({ id: 't', title: 'T', cwd: os.tmpdir(), messages: [], createdAt: 1, updatedAt: 1, status: 'waiting', ...extra });

  it('the home thread session disallows Bash on top of the global list (Claude SDK disallowedTools)', () => {
    const options = build(base({ disallowedTools: ['Bash'] }));
    expect(options.claude.disallowedTools).toEqual([...DEFAULT_SETTINGS.disallowedTools, 'Bash']);
  });

  it('a normal thread is unaffected', () => {
    const options = build(base());
    expect(options.claude.disallowedTools).toEqual(DEFAULT_SETTINGS.disallowedTools);
    expect(options.disallowedTools ?? []).toEqual([]);
  });

  it('passes the thread list to every harness via the shared contract', () => {
    expect(build(base({ disallowedTools: ['Bash'] })).disallowedTools).toEqual(['Bash']);
  });

  it('absent in persisted data means no change', () => {
    const merged = mergePersistedSettings(DEFAULT_SETTINGS, { threads: [base()] });
    expect(merged.threads[0]!.disallowedTools).toBeUndefined();
  });
});

describe('OpenCode', () => {
  it('denies bash natively in the launch permission config when Bash is disallowed', () => {
    expect(openCodePermissionConfig(['Bash']).bash).toBe('deny');
    expect(openCodePermissionConfig().bash).toBeUndefined();
    expect(openCodePermissionConfig([]).bash).toBeUndefined();
  });
});

describe('Codex', () => {
  function codex(disallowedTools?: string[]) {
    const session = new CodexSession('codex');
    const internal = session as any;
    const onPermissionRequest = vi.fn().mockResolvedValue(true);
    internal.options = { permissionMode: 'default', disallowedTools, callbacks: { onPermissionRequest, onError: vi.fn() } };
    const respond = vi.spyOn(internal, 'respond').mockImplementation(() => {});
    return { internal, respond, onPermissionRequest };
  }

  it('declines a shell command approval without asking when Bash is disallowed', async () => {
    const { internal, respond, onPermissionRequest } = codex(['Bash']);
    internal.handle({ id: 7, method: 'item/commandExecution/requestApproval', params: { command: 'ls .geode' } });
    await vi.waitFor(() => expect(respond).toHaveBeenCalledWith(7, { decision: 'decline' }));
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });

  it('still asks for file-change approvals, and for commands on unrestricted threads', async () => {
    const restricted = codex(['Bash']);
    restricted.internal.handle({ id: 8, method: 'item/fileChange/requestApproval', params: { reason: 'edit' } });
    await vi.waitFor(() => expect(restricted.onPermissionRequest).toHaveBeenCalled());

    const normal = codex();
    normal.internal.handle({ id: 9, method: 'item/commandExecution/requestApproval', params: { command: 'ls' } });
    await vi.waitFor(() => expect(normal.respond).toHaveBeenCalledWith(9, { decision: 'accept' }));
  });
});

describe('plugin wiring: home thread → scheduled item → spawned thread', () => {
  function makePlugin() {
    const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin & Record<string, any>;
    plugin.settings = { ...DEFAULT_SETTINGS, defaultCwd: '/tmp', threads: [], scheduledItems: [] };
    plugin.manager = new ThreadManager(plugin.settings);
    const items: ScheduledItem[] = [];
    plugin.scheduler = {
      createItem: vi.fn(async (params: Omit<ScheduledItem, 'id'>) => {
        const item = { ...params, id: `item-${items.length + 1}` } as ScheduledItem;
        items.push(item);
        plugin.settings.scheduledItems = [...items];
        return item;
      }),
    } as never;
    return { plugin, items };
  }
  const cron = { name: 'Chief of Staff — morning brief', prompt: 'brief', schedule: { type: 'daily' as const, timeOfDay: '08:00' }, enabled: true };

  it('a cron item created from the home thread inherits Bash, keyed by the creating thread id', async () => {
    const { plugin } = makePlugin();
    const home = plugin.manager.createThread('Chief of Staff', '/tmp');
    home.disallowedTools = ['Bash'];
    const item = await plugin.createCronItemFromThread(home.id, cron);
    expect(item.disallowedTools).toEqual(['Bash']);
    expect(item.createdByThreadId).toBe(home.id);
  });

  it('the threads that item spawns get the same denylist', async () => {
    const { plugin } = makePlugin();
    const home = plugin.manager.createThread('Chief of Staff', '/tmp');
    home.disallowedTools = ['Bash'];
    const item = await plugin.createCronItemFromThread(home.id, cron);
    const spawned = plugin.createScheduledThread('Chief of Staff — morning brief', '/tmp', undefined, item.id);
    expect(spawned.disallowedTools).toEqual(['Bash']);
    expect(spawned.scheduledItemId).toBe(item.id);
  });

  it('a name that merely looks like Chief of Staff grants or restricts nothing: only the creator matters', async () => {
    const { plugin } = makePlugin();
    const plain = plugin.manager.createThread('Some work', '/tmp');
    const item = await plugin.createCronItemFromThread(plain.id, cron);
    expect(item.disallowedTools).toBeUndefined();
    const spawned = plugin.createScheduledThread('x', '/tmp', undefined, item.id);
    expect(spawned.disallowedTools).toBeUndefined();
  });

  it('threads created by a restricted thread (threads_create) inherit its denylist', () => {
    const { plugin } = makePlugin();
    const home = plugin.manager.createThread('Chief of Staff', '/tmp');
    home.disallowedTools = ['Bash'];
    const child = plugin.createThreadFromAgent(home.id, 'Sub-task', '/tmp');
    expect(child.disallowedTools).toEqual(['Bash']);
    const other = plugin.createThreadFromAgent(plugin.manager.createThread('Plain', '/tmp').id, 'Sub-task', '/tmp');
    expect(other.disallowedTools).toBeUndefined();
  });
});
