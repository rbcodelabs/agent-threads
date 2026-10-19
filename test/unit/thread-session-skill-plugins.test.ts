/**
 * ThreadSession.start(): skill plugin paths are host paths and are passed to the
 * SDK untouched.
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

const { ThreadSession } = await import('../../src/ThreadSession');

function callbacks(): SessionCallbacks {
  return {
    onToken: () => {}, onToolUse: () => {}, onMessage: () => {}, onRecap: () => {},
    onDone: () => {}, onInterrupted: () => {}, onError: () => {},
    onPermissionRequest: async () => true, onAskUserQuestion: async () => ({}),
    onOpenNewTab: async () => ({ threadId: 't', title: 'T' }),
  };
}

const hostPlugins = [{ type: 'local', path: '/h/a' }, { type: 'local', path: '/h/b' }];

function start(claude: object) {
  return new ThreadSession().start({
    claudePath: '/fake/claude', cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', callbacks: callbacks(), claude,
  } as never);
}

describe('ThreadSession.start() — skill plugin paths', () => {
  beforeEach(() => { queryCalls.length = 0; });

  it('passes host plugin paths to the SDK untouched', async () => {
    await start({ sessionOptions: { plugins: hostPlugins } });
    expect(queryCalls[0].options.plugins).toEqual(hostPlugins);
  });

  it('ignores a leftover legacy claude.vm routing input from older callers', async () => {
    await start({ vm: { mode: 'always', image: 'img' }, sessionOptions: { plugins: hostPlugins } });
    expect(queryCalls[0].options.plugins).toEqual(hostPlugins);
    expect(queryCalls[0].options).not.toHaveProperty('spawnClaudeCodeProcess');
  });
});
