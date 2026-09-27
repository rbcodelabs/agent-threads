import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlashCommandRegistry, type SlashCommandContribution, type SlashCommandContext, type SlashCommandHost, type SlashCommandResult } from '../../src/SlashCommandContributions';

const OWNER = { pluginId: 'example.commands' };
const context = (text = '/design brief'): Omit<SlashCommandContext, 'args'> => ({ surface: 'thread', text, threadId: 'thread-a', hasImages: false, hasAttachment: false });
const contribution = (invoke = vi.fn(async (): Promise<SlashCommandResult> => ({ status: 'ok' }))): SlashCommandContribution => ({ name: 'design', thread: { description: 'Design something', invoke } });

afterEach(() => vi.useRealTimers());

describe('slash command contributions', () => {
  it('registers scope-specific discovery and invokes immutable host-captured context', async () => {
    const registry = new SlashCommandRegistry();
    const invoke = vi.fn(async (ctx: Readonly<SlashCommandContext>): Promise<SlashCommandResult> => {
      expect(Object.isFrozen(ctx)).toBe(true);
      return { status: 'ok' };
    });
    expect(registry.register(OWNER, contribution(invoke)).success).toBe(true);
    expect(registry.list('thread')).toEqual([{ name: 'design', description: 'Design something' }]);
    expect(registry.list('dispatch')).toEqual([]);
    expect(await registry.invoke(context('  /DeSiGn first\nsecond  '))).toEqual({ status: 'ok' });
    expect(invoke.mock.calls[0][0]).toMatchObject({ args: 'first\nsecond', threadId: 'thread-a', text: '  /DeSiGn first\nsecond  ' });
  });

  it('matches a whole command, including bare invocation, only in registered scopes', async () => {
    const registry = new SlashCommandRegistry();
    registry.register(OWNER, contribution());
    for (const text of ['/design', ' /DESIGN\nbrief ', '/design\tbrief']) expect(registry.match(text, 'thread')).toBe(true);
    for (const text of ['/designer', '/design-extra', 'hello /design', '/design/brief']) {
      expect(registry.match(text, 'thread')).toBe(false);
      expect(await registry.invoke(context(text))).toBeNull();
    }
    expect(registry.match('/design', 'dispatch')).toBe(false);
  });

  it('rejects invalid owners, names, handlers, and descriptions', () => {
    const registry = new SlashCommandRegistry();
    for (const name of ['', '/design', 'with space', 'a'.repeat(65), 'UPPER', '1name']) {
      expect(registry.register(OWNER, { ...contribution(), name })).toMatchObject({ status: 'invalid' });
    }
    expect(registry.register({ pluginId: ' ' }, contribution())).toMatchObject({ status: 'invalid' });
    expect(registry.register(OWNER, { name: 'design' })).toMatchObject({ status: 'invalid' });
    expect(registry.register(OWNER, { name: 'design', thread: { description: ' ', invoke: async () => ({ status: 'ok' }) } })).toMatchObject({ status: 'invalid' });
    expect(registry.register(OWNER, { name: 'design', thread: { description: 'x', invoke: null } } as unknown as SlashCommandContribution)).toMatchObject({ status: 'invalid' });
  });

  it('checks case-insensitive host reservations live during registration, discovery, and invocation', async () => {
    let reserved = ['/FORK'];
    const registry = new SlashCommandRegistry({ reservedNames: () => reserved });
    expect(registry.register(OWNER, { ...contribution(), name: 'fork' })).toMatchObject({ status: 'conflict' });
    registry.register(OWNER, contribution());
    expect(registry.register(OWNER, contribution())).toMatchObject({ status: 'conflict' });
    reserved = ['DESIGN'];
    expect(registry.list('thread')).toEqual([]);
    expect(registry.match('/design', 'thread')).toBe(false);
    expect(await registry.invoke(context())).toBeNull();
    reserved = [];
    expect(registry.match('/design', 'thread')).toBe(true);
  });

  it('notifies live discovery and keeps replacement registrations safe from old disposers', () => {
    const registry = new SlashCommandRegistry();
    const changed = vi.fn();
    const unsubscribe = registry.subscribe(changed);
    const old = registry.register(OWNER, contribution());
    old.dispose();
    registry.register(OWNER, contribution());
    old.dispose();
    expect(registry.match('/design', 'thread')).toBe(true);
    expect(changed).toHaveBeenCalledTimes(3);
    unsubscribe();
    registry.clear();
    expect(changed).toHaveBeenCalledTimes(3);
    expect(registry.list('thread')).toEqual([]);
  });

  it.each([null, {}, { status: 'other' }, { status: 'ok', message: 42 }])('contains malformed handler result %j', async result => {
    const registry = new SlashCommandRegistry();
    registry.register(OWNER, contribution(vi.fn(async () => result as SlashCommandResult)));
    expect(await registry.invoke(context())).toMatchObject({ status: 'error', message: expect.stringContaining('invalid') });
  });

  it('contains synchronous throws and rejected promises as handled errors', async () => {
    const registry = new SlashCommandRegistry();
    registry.register(OWNER, contribution(vi.fn(() => { throw new Error('failed'); })));
    expect(await registry.invoke(context())).toEqual({ status: 'error', message: 'failed' });
  });

  it('times out and aborts callbacks while rejecting late feedback', async () => {
    vi.useFakeTimers();
    const registry = new SlashCommandRegistry({ timeoutMs: 20 });
    let host!: SlashCommandHost;
    registry.register(OWNER, contribution(vi.fn(async (_ctx, injected) => {
      host = injected;
      return new Promise<SlashCommandResult>(() => {});
    })));
    const report = vi.fn();
    const pending = registry.invoke(context(), report);
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ status: 'error', message: expect.stringContaining('timed out') });
    expect(host.signal.aborted).toBe(true);
    host.report('late');
    expect(report).not.toHaveBeenCalled();
  });

  it.each(['dispose', 'clear'])('%s aborts pending work and revokes its feedback', async action => {
    const registry = new SlashCommandRegistry();
    let host!: SlashCommandHost;
    const registered = registry.register(OWNER, contribution(vi.fn(async (_ctx, injected) => {
      host = injected;
      return new Promise<SlashCommandResult>(() => {});
    })));
    const report = vi.fn();
    const pending = registry.invoke(context(), report);
    await Promise.resolve();
    if (action === 'dispose') registered.dispose(); else registry.clear();
    expect(await pending).toMatchObject({ status: 'error' });
    expect(host.signal.aborted).toBe(true);
    host.report('late');
    expect(report).not.toHaveBeenCalled();
  });

  it('accepts valid argCompletions and exposes them per scope via argCompletionsFor()', () => {
    const registry = new SlashCommandRegistry();
    const argCompletions = [{ name: 'sprint', description: 'Current sprint board' }, { name: 'backlog', description: 'Full backlog board' }];
    const registered = registry.register(OWNER, {
      name: 'board',
      thread: { description: 'Open a board', invoke: vi.fn(async () => ({ status: 'ok' })), argCompletions },
      dispatch: { description: 'Open a board', invoke: vi.fn(async () => ({ status: 'ok' })) },
    });
    expect(registered.success).toBe(true);
    expect(registry.argCompletionsFor('board', 'thread')).toEqual(argCompletions);
    expect(registry.argCompletionsFor('board', 'dispatch')).toBeUndefined();
    expect(registry.argCompletionsFor('unknown-command', 'thread')).toBeUndefined();
  });

  it('leaves absent argCompletions fully backward compatible', () => {
    const registry = new SlashCommandRegistry();
    expect(registry.register(OWNER, contribution()).success).toBe(true);
    expect(registry.argCompletionsFor('design', 'thread')).toBeUndefined();
  });

  it('respects reserved names and scope-existence when looking up argCompletionsFor', () => {
    let reserved: string[] = [];
    const registry = new SlashCommandRegistry({ reservedNames: () => reserved });
    registry.register(OWNER, { name: 'board', thread: { description: 'Open a board', invoke: vi.fn(async () => ({ status: 'ok' })), argCompletions: [{ name: 'sprint', description: 'Current sprint' }] } });
    expect(registry.argCompletionsFor('board', 'thread')).toEqual([{ name: 'sprint', description: 'Current sprint' }]);
    reserved = ['board'];
    expect(registry.argCompletionsFor('board', 'thread')).toBeUndefined();
  });

  it.each([
    { argCompletions: 'not-an-array' },
    { argCompletions: Array.from({ length: 21 }, (_, i) => ({ name: `n${i}`, description: 'd' })) },
    { argCompletions: [{ name: '', description: 'd' }] },
    { argCompletions: [{ name: 'a'.repeat(65), description: 'd' }] },
    { argCompletions: [{ name: 'n', description: '' }] },
    { argCompletions: [{ name: 'n', description: 'd'.repeat(257) }] },
  ])('rejects malformed argCompletions entries %j', (overrides) => {
    const registry = new SlashCommandRegistry();
    const result = registry.register(OWNER, {
      name: 'board',
      thread: { description: 'Open a board', invoke: vi.fn(async () => ({ status: 'ok' })), ...(overrides as object) },
    });
    expect(result).toMatchObject({ status: 'invalid' });
  });

  it('allows async send feedback after success until the registration is revoked', async () => {
    const registry = new SlashCommandRegistry();
    let host!: SlashCommandHost;
    const registered = registry.register(OWNER, contribution(vi.fn(async (_ctx, injected) => {
      host = injected;
      return { status: 'ok' as const };
    })));
    const report = vi.fn();
    await registry.invoke(context(), report);
    host.report('send failed', true);
    expect(report).toHaveBeenCalledWith('send failed', true);
    registered.dispose();
    host.report('stale');
    expect(report).toHaveBeenCalledTimes(1);
  });
});
