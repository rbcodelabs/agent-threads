/**
 * ThreadSession.start(): skill plugin paths are rewritten to guest paths only
 * when the session is VM-routed; host-local sessions keep host paths untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';

const { queryCalls } = vi.hoisted(() => ({ queryCalls: [] as Array<{ options: { plugins?: Array<{ type: string; path: string }> } }> }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: object }) => (queryCalls.push(args as never), {
    [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
    close: () => {},
    interrupt: async () => {},
    supportedModels: async () => [],
    supportedAgents: async () => [],
    getContextUsage: async () => null,
    setPermissionMode: async () => {},
  }),
}));

const resolveClaudeVmRouting = vi.fn();
vi.mock('../../src/harnessVmRouting', async () => {
  const actual = await vi.importActual<typeof import('../../src/harnessVmRouting')>('../../src/harnessVmRouting');
  return { ...actual, resolveClaudeVmRouting };
});

const { ThreadSession } = await import('../../src/ThreadSession');

function callbacks(): SessionCallbacks {
  return {
    onToken: () => {}, onToolUse: () => {}, onMessage: () => {}, onRecap: () => {},
    onDone: () => {}, onInterrupted: () => {}, onError: () => {},
    onPermissionRequest: async () => true, onAskUserQuestion: async () => ({}),
    onOpenNewTab: async () => ({ threadId: 't', title: 'T' }),
  };
}

const plan = {
  mounts: [{ hostPath: '/h/a', guestPath: '/skills/a-1' }],
  pluginGuestPaths: { '/h/a': '/skills/a-1', '/h/b': '/skills/b-2' },
};
const vm = { mode: 'auto', image: 'img', vmManager: {} as never, mountPath: '/work', skillMountPlan: plan };
const hostPlugins = [{ type: 'local', path: '/h/a' }, { type: 'local', path: '/h/b' }];

function start(claude: object) {
  return new ThreadSession().start({
    claudePath: '/fake/claude', cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', callbacks: callbacks(), claude,
  } as never);
}

describe('ThreadSession.start() — skill plugin paths', () => {
  beforeEach(() => { resolveClaudeVmRouting.mockReset(); queryCalls.length = 0; });

  it('rewrites to guest paths and drops unmounted plugins when VM-routed', async () => {
    resolveClaudeVmRouting.mockResolvedValue({
      routed: true,
      routing: { containerName: 'c', containerBinaryPath: '/x/claude', mountedExtra: plan.mounts },
    });
    await start({ vm, sessionOptions: { plugins: hostPlugins } });
    expect(queryCalls[0].options.plugins).toEqual([{ type: 'local', path: '/skills/a-1' }]);
  });

  it('leaves host paths untouched on a host-local fallback', async () => {
    resolveClaudeVmRouting.mockResolvedValue({ routed: false, reason: 'runtime-missing' });
    await start({ vm, sessionOptions: { plugins: hostPlugins } });
    expect(queryCalls[0].options.plugins).toEqual(hostPlugins);
  });

  it('leaves host paths untouched when no VM routing inputs exist at all', async () => {
    await start({ sessionOptions: { plugins: hostPlugins } });
    expect(queryCalls[0].options.plugins).toEqual(hostPlugins);
  });
});
