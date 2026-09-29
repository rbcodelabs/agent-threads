/**
 * ADR-0015 follow-up: does `ThreadSession.start()` actually report its
 * resolved VM-routing decision through `SessionCallbacks.onVmRouting`, and
 * does it wire `pathToClaudeCodeExecutable` to the container path when
 * routed? `resolveClaudeVmRouting()`'s own decision logic already has
 * dedicated tests in harnessVmRouting.test.ts — this only exercises the
 * seam between that decision and the callback the UI reads
 * (`ThreadManager.getClaudeVmRouting`, see harness-vm-routing-threadmanager.test.ts).
 *
 * The Agent SDK's query() is mocked exactly like plan-mode.test.ts's minimal
 * shape — an immediately-empty async iterator, since nothing here needs a
 * real turn to run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionCallbacks } from '../../src/ClaudeSession';

const { queryCalls } = vi.hoisted(() => ({ queryCalls: [] as Array<{ options: { env?: Record<string, string | undefined>; mcpServers?: Record<string, unknown> } }> }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: { env?: Record<string, string | undefined> } }) => (queryCalls.push(args), {
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

function callbacks(overrides: Partial<SessionCallbacks> = {}): SessionCallbacks {
  return {
    onToken: () => {}, onToolUse: () => {}, onMessage: () => {}, onRecap: () => {},
    onDone: () => {}, onInterrupted: () => {}, onError: () => {},
    onPermissionRequest: async () => true, onAskUserQuestion: async () => ({}),
    onOpenNewTab: async () => ({ threadId: 't', title: 'T' }),
    ...overrides,
  };
}

function vmInputs(mode: 'auto' | 'always' | 'never' = 'auto') {
  return {
    mode,
    image: 'claude-threads-harness:1',
    vmManager: {} as never,
    mountPath: '/work',
  };
}

describe('ThreadSession.start() — ADR-0015 onVmRouting reporting', () => {
  beforeEach(() => {
    resolveClaudeVmRouting.mockReset();
    queryCalls.length = 0;
  });

  it('reports the resolved container routing and points pathToClaudeCodeExecutable at the container binary', async () => {
    resolveClaudeVmRouting.mockResolvedValue({
      routed: true,
      routing: { containerName: 'claude-threads-vm-t1', containerBinaryPath: '/home/node/.local/bin/claude' },
    });
    const onVmRouting = vi.fn();
    const session = new ThreadSession();
    await session.start({
      claudePath: '/fake/claude',
      cwd: '/tmp',
      permissionMode: 'default',
      extraEnvRaw: '',
      callbacks: callbacks({ onVmRouting }),
      claude: { vm: vmInputs() },
    } as never);

    expect(onVmRouting).toHaveBeenCalledWith({ containerName: 'claude-threads-vm-t1', containerBinaryPath: '/home/node/.local/bin/claude' });
  });

  it('reports null for a host-local fallback', async () => {
    resolveClaudeVmRouting.mockResolvedValue({ routed: false, reason: 'runtime-missing' });
    const onVmRouting = vi.fn();
    const session = new ThreadSession();
    await session.start({
      claudePath: '/fake/claude',
      cwd: '/tmp',
      permissionMode: 'default',
      extraEnvRaw: '',
      callbacks: callbacks({ onVmRouting }),
      claude: { vm: vmInputs() },
    } as never);

    // The structured reason rides along so the UI can offer sandbox setup.
    expect(onVmRouting).toHaveBeenCalledWith(null, 'runtime-missing');
  });

  it('reports the "never" reason when the configured mode is never', async () => {
    const onVmRouting = vi.fn();
    const session = new ThreadSession();
    await session.start({
      claudePath: '/fake/claude',
      cwd: '/tmp',
      permissionMode: 'default',
      extraEnvRaw: '',
      callbacks: callbacks({ onVmRouting }),
      claude: { vm: vmInputs('never') },
    } as never);

    expect(onVmRouting).toHaveBeenCalledWith(null, 'never');
    expect(resolveClaudeVmRouting).not.toHaveBeenCalled();
  });

  it('reports null when no vm routing inputs are attached at all (harnessVmMode "never")', async () => {
    const onVmRouting = vi.fn();
    const session = new ThreadSession();
    await session.start({
      claudePath: '/fake/claude',
      cwd: '/tmp',
      permissionMode: 'default',
      extraEnvRaw: '',
      callbacks: callbacks({ onVmRouting }),
    } as never);

    expect(onVmRouting).toHaveBeenCalledWith(null);
    expect(resolveClaudeVmRouting).not.toHaveBeenCalled();
  });

  it('uses the host SDK bridge roster only after VM routing succeeds', async () => {
    resolveClaudeVmRouting.mockResolvedValue({
      routed: true,
      routing: { containerName: 'c1', containerBinaryPath: '/home/node/.local/bin/claude' },
    });
    const host = { type: 'http', url: 'http://127.0.0.1:5555' };
    const bridged = { type: 'sdk', name: 'oauth', instance: {} };
    await new ThreadSession().start({
      claudePath: '/fake/claude', cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', callbacks: callbacks(),
      claude: { vm: vmInputs(), mcpServers: { oauth: host }, vmMcpServers: { oauth: bridged } },
    } as never);

    expect(queryCalls[0].options.mcpServers).toEqual({ oauth: bridged });
  });

  it('keeps the ordinary MCP roster when automatic VM routing falls back to the host', async () => {
    resolveClaudeVmRouting.mockResolvedValue({ routed: false, reason: 'runtime-missing' });
    const host = { type: 'http', url: 'http://127.0.0.1:5555' };
    const bridged = { type: 'sdk', name: 'oauth', instance: {} };
    await new ThreadSession().start({
      claudePath: '/fake/claude', cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '', callbacks: callbacks(),
      claude: { vm: vmInputs(), mcpServers: { oauth: host }, vmMcpServers: { oauth: bridged } },
    } as never);

    expect(queryCalls[0].options.mcpServers).toEqual({ oauth: host });
  });

  describe('containerAuthToken (in-container Claude sign-in credential)', () => {
    const TOKEN = 'sk-ant-oat01-container-signin-token';
    const baseOptions = {
      claudePath: '/fake/claude', cwd: '/tmp', permissionMode: 'default', extraEnvRaw: '',
    };

    it('is injected as CLAUDE_CODE_OAUTH_TOKEN into a VM-routed session\'s env, without leaking the host environment', async () => {
      resolveClaudeVmRouting.mockResolvedValue({
        routed: true,
        routing: { containerName: 'c1', containerBinaryPath: '/home/node/.local/bin/claude' },
      });
      await new ThreadSession().start({
        ...baseOptions, callbacks: callbacks(), claude: { vm: vmInputs() }, containerAuthToken: TOKEN,
      } as never);

      const env = queryCalls[0].options.env!;
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
      expect(env.PATH).toBeUndefined(); // still the minimal container env, not a process.env spread
    });

    it('wins over a stale user secret of the same name', async () => {
      resolveClaudeVmRouting.mockResolvedValue({
        routed: true,
        routing: { containerName: 'c1', containerBinaryPath: '/home/node/.local/bin/claude' },
      });
      await new ThreadSession().start({
        ...baseOptions, callbacks: callbacks(), claude: { vm: vmInputs() },
        secretEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'stale-truncated-token' }, containerAuthToken: TOKEN,
      } as never);

      expect(queryCalls[0].options.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    });

    it('is NEVER given to a host-spawned session — an env token would override the host keychain login', async () => {
      resolveClaudeVmRouting.mockResolvedValue({ routed: false });
      await new ThreadSession().start({
        ...baseOptions, callbacks: callbacks(), claude: { vm: vmInputs() }, containerAuthToken: TOKEN,
      } as never);

      expect(queryCalls[0].options.env!.CLAUDE_CODE_OAUTH_TOKEN).not.toBe(TOKEN);
    });

    it('is never given to a session with VM routing disabled either', async () => {
      await new ThreadSession().start({
        ...baseOptions, callbacks: callbacks(), containerAuthToken: TOKEN,
      } as never);

      expect(queryCalls[0].options.env!.CLAUDE_CODE_OAUTH_TOKEN).not.toBe(TOKEN);
    });

    it('adds nothing when there is no token (not signed in yet)', async () => {
      resolveClaudeVmRouting.mockResolvedValue({
        routed: true,
        routing: { containerName: 'c1', containerBinaryPath: '/home/node/.local/bin/claude' },
      });
      await new ThreadSession().start({
        ...baseOptions, callbacks: callbacks(), claude: { vm: vmInputs() },
      } as never);

      expect(queryCalls[0].options.env!.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });
  });
});
