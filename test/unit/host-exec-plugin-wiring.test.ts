import { Platform } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';
import type { HostExecHooks } from '../../src/hostExec';

type HostExecInternals = {
  manager: { getThread: (threadId: string) => { cwd: string; scheduledItemId?: string } | undefined };
  mcpRegistrationAvailable: boolean;
  hostExecModals: Set<unknown>;
  withHostExec<T>(
    threadId: string,
    servers: Record<string, T>,
    build: (threadId: string, cwd: string, hostExec: HostExecHooks) => Record<string, T>,
  ): Record<string, T>;
};

const originalMobile = Platform.isMobile;
afterEach(() => { Platform.isMobile = originalMobile; });

function fixture(thread: { cwd: string; scheduledItemId?: string } | null = { cwd: '/host/project' }) {
  const plugin = Object.assign(Object.create(ClaudeThreadsPlugin.prototype), {
    app: {},
    manager: { getThread: vi.fn(() => thread ?? undefined) },
    mcpRegistrationAvailable: true,
    hostExecModals: new Set(),
  }) as unknown as HostExecInternals;
  return plugin;
}

describe('ClaudeThreadsPlugin host_exec wiring', () => {
  it('replaces only the canonical built-in server after desktop VM routing succeeds', () => {
    Platform.isMobile = false;
    const plugin = fixture();
    const ordinary = { claude_threads: 'ordinary', oauth: 'overlay' };
    let hooks: HostExecHooks | undefined;
    const build = vi.fn((threadId: string, cwd: string, supplied: HostExecHooks) => {
      hooks = supplied;
      return { claude_threads: 'host-enabled', obsidian: 'legacy' };
    });

    const result = plugin.withHostExec('thread-1', ordinary, build);

    expect(build).toHaveBeenCalledWith('thread-1', '/host/project', expect.any(Object));
    expect(result).toEqual({ claude_threads: 'host-enabled', oauth: 'overlay' });
    expect(hooks?.isInteractive()).toBe(true);
  });

  it.each([
    ['mobile host', true, { cwd: '/host/project' }, { claude_threads: 'ordinary' }],
    ['missing canonical server', false, { cwd: '/host/project' }, { oauth: 'overlay' }],
    ['missing thread', false, null, { claude_threads: 'ordinary' }],
  ] as const)('does not expose host_exec for a %s', (_label, mobile, thread, servers) => {
    Platform.isMobile = mobile;
    const plugin = fixture(thread);
    const build = vi.fn();

    expect(plugin.withHostExec('thread-1', servers, build)).toBe(servers);
    expect(build).not.toHaveBeenCalled();
  });

  it('marks scheduled and unloading hosts non-interactive', () => {
    Platform.isMobile = false;
    for (const [available, thread] of [
      [true, { cwd: '/host/project', scheduledItemId: 'scheduled-1' }],
      [false, { cwd: '/host/project' }],
    ] as const) {
      const plugin = fixture(thread);
      plugin.mcpRegistrationAvailable = available;
      let hooks: HostExecHooks | undefined;
      plugin.withHostExec('thread-1', { claude_threads: 'ordinary' }, (_threadId, _cwd, supplied) => {
        hooks = supplied;
        return { claude_threads: 'host-enabled' };
      });
      expect(hooks?.isInteractive()).toBe(false);
    }
  });
});
