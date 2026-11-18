import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { CodexSession } from '../../src/CodexSession';
import { DEFAULT_SETTINGS } from '../../src/types';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { write: vi.fn() }, kill: vi.fn(),
  })),
}));

describe('Codex computer-use session policy', () => {
  it('defaults to disabled for existing settings without an explicit choice', () => {
    expect(DEFAULT_SETTINGS.codexComputerUseEnabled).toBe(false);
  });

  it.each([undefined, false, true])('applies choice %s to start and resume while preserving mirrored MCP servers', async (computerUseEnabled) => {
    for (const resume of [undefined, 'saved-thread']) {
      const session = new CodexSession('codex');
      const request = vi.spyOn(session as any, 'request').mockImplementation(async () => ({
        thread: { id: 'thread' }, data: [],
      }));
      await session.start({
        cwd: '/workspace', permissionMode: 'bypassPermissions', extraEnvRaw: '', resume,
        callbacks: {} as any,
        codex: {
          approvalPolicy: 'never', sandbox: 'workspace-write', computerUseEnabled,
          mcpServers: {
            example: { type: 'stdio', command: 'example-mcp' },
            node_repl: { type: 'stdio', command: 'legacy-repl' },
          },
        },
      });
      const method = resume ? 'thread/resume' : 'thread/start';
      const config = (request.mock.calls.find(([name]) => name === method)![1] as any).config;
      expect(config.mcp_servers.example).toEqual({ command: 'example-mcp' });
      if (computerUseEnabled) {
        expect(config).not.toHaveProperty('computer_use');
        expect(config).not.toHaveProperty('plugins');
        expect(config.mcp_servers.node_repl).toEqual({ command: 'legacy-repl' });
      } else {
        expect(config.computer_use.default_app_access).toBe('deny');
        expect(config.plugins['unified-computer-use@openai-bundled'].enabled).toBe(false);
        expect(config.plugins['computer-use@openai-bundled'].enabled).toBe(false);
        for (const name of ['node_repl', 'cua_repl', 'computer-use']) {
          // Absent inherited servers require a complete disabled transport.
          expect(config.mcp_servers[name]).toEqual({ command: 'node', enabled: false });
        }
      }
      session.close();
    }
  });

  it('keeps computer use disabled when a failed resume falls back to a fresh thread', async () => {
    const session = new CodexSession('codex');
    const request = vi.spyOn(session as any, 'request').mockImplementation(async (method) => {
      if (method === 'thread/resume') throw new Error('Saved thread unavailable');
      return { thread: { id: 'replacement' }, data: [] };
    });
    await session.start({
      cwd: '/workspace', permissionMode: 'default', extraEnvRaw: '', resume: 'saved-thread',
      callbacks: {} as any,
    });
    const resumeConfig = (request.mock.calls.find(([method]) => method === 'thread/resume')![1] as any).config;
    const startConfig = (request.mock.calls.find(([method]) => method === 'thread/start')![1] as any).config;
    expect(startConfig).toEqual(resumeConfig);
    expect(startConfig.computer_use.default_app_access).toBe('deny');
    expect(startConfig.mcp_servers.node_repl).toEqual({ command: 'node', enabled: false });
    session.close();
  });
});

describe('Codex network policy', () => {
  it('finishes the startup policy before a queued network opt-in', async () => {
    const session = new CodexSession('codex');
    let finishStartup!: () => void;
    const startupPending = new Promise<void>((resolve) => { finishStartup = resolve; });
    const policies: boolean[] = [];
    vi.spyOn(session as any, 'request').mockImplementation(async (method, params) => {
      if (method === 'thread/settings/update') {
        policies.push(params.sandboxPolicy.networkAccess);
        if (policies.length === 1) await startupPending;
      }
      return { thread: { id: 'thread' }, data: [] };
    });
    const starting = session.start({ cwd: '/workspace', permissionMode: 'default', extraEnvRaw: '', callbacks: {} as any, codex: {} });
    for (let i = 0; i < 30 && policies.length === 0; i++) await Promise.resolve();
    expect(policies).toEqual([false]);
    const enabling = session.setNetworkAccessEnabled(true);
    await Promise.resolve();
    expect(policies).toEqual([false]);
    finishStartup();
    await Promise.all([starting, enabling]);
    expect(policies).toEqual([false, true]);
    session.close();
  });

  it('rejects a stale queued policy update after the session closes', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'old-thread';
    internal.options = { cwd: '/workspace', permissionMode: 'default', codex: {}, callbacks: {} };
    let finishFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { finishFirst = resolve; });
    const request = vi.spyOn(internal, 'request').mockImplementation(async () => { await firstPending; return {}; });
    const first = session.setNetworkAccessEnabled(true);
    const stale = session.setNetworkAccessEnabled(false);
    await Promise.resolve();
    session.close();
    internal.codexThreadId = 'replacement-thread';
    internal.options = { cwd: '/workspace', permissionMode: 'default', codex: {}, callbacks: {} };
    finishFirst();
    await expect(first).rejects.toThrow('session changed');
    await expect(stale).rejects.toThrow('session changed');
    expect(request).toHaveBeenCalledTimes(1);
    expect(internal.options.codex.networkAccessEnabled).toBeUndefined();
  });
  it.each([undefined, false, true])('applies explicit choice %s before first turn on start and resume', async (networkAccessEnabled) => {
    for (const resume of [undefined, 'saved-thread']) {
      const session = new CodexSession('codex');
      const request = vi.spyOn(session as any, 'request').mockResolvedValue({ thread: { id: 'thread' }, data: [] });
      await session.start({
        cwd: '/workspace', permissionMode: 'bypassPermissions', extraEnvRaw: '', resume,
        callbacks: {} as any,
        codex: { approvalPolicy: 'never', sandbox: 'workspace-write', networkAccessEnabled },
      });
      const method = resume ? 'thread/resume' : 'thread/start';
      const creationIndex = request.mock.calls.findIndex(([name]) => name === method);
      const policyIndex = request.mock.calls.findIndex(([name]) => name === 'thread/settings/update');
      expect(policyIndex).toBeGreaterThan(creationIndex);
      expect(request.mock.calls[policyIndex][1]).toMatchObject({
        sandboxPolicy: { type: 'workspaceWrite', networkAccess: networkAccessEnabled === true },
      });
      session.close();
    }
  });

  it('keeps read-only sessions network-disabled even when opted in', async () => {
    const session = new CodexSession('codex');
    const request = vi.spyOn(session as any, 'request').mockResolvedValue({ thread: { id: 'thread' }, data: [] });
    await session.start({
      cwd: '/workspace', permissionMode: 'plan', extraEnvRaw: '', callbacks: {} as any,
      codex: { approvalPolicy: 'on-request', sandbox: 'read-only', networkAccessEnabled: true },
    });
    expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    }));
    session.close();
  });

  it('updates a running thread without changing its permission mode', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'thread';
    internal.options = { cwd: '/workspace', permissionMode: 'bypassPermissions', codex: {}, callbacks: {} };
    const request = vi.spyOn(internal, 'request').mockResolvedValue({});
    await session.setNetworkAccessEnabled(true);
    expect(request).toHaveBeenCalledWith('thread/settings/update', expect.objectContaining({
      sandboxPolicy: expect.objectContaining({ type: 'workspaceWrite', networkAccess: true }),
    }));
    expect(internal.options.permissionMode).toBe('bypassPermissions');
    await session.setPermissionMode('acceptEdits');
    expect(request).toHaveBeenLastCalledWith('thread/settings/update', expect.objectContaining({
      sandboxPolicy: expect.objectContaining({ type: 'workspaceWrite', networkAccess: true }),
    }));
    await session.setPermissionMode('plan');
    expect(request).toHaveBeenLastCalledWith('thread/settings/update', expect.objectContaining({
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    }));
  });

  it('serializes network and permission updates so a later Off revokes access', async () => {
    const session = new CodexSession('codex');
    const internal = session as any;
    internal.codexThreadId = 'thread';
    internal.options = { cwd: '/workspace', permissionMode: 'default', codex: {}, callbacks: {} };
    let finishOn!: () => void;
    const onPending = new Promise<void>((resolve) => { finishOn = resolve; });
    const request = vi.spyOn(internal, 'request').mockImplementation(async (_method, params) => {
      if (params.sandboxPolicy?.networkAccess === true) await onPending;
      return {};
    });
    const on = session.setNetworkAccessEnabled(true);
    const mode = session.setPermissionMode('acceptEdits');
    const off = session.setNetworkAccessEnabled(false);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    finishOn();
    await Promise.all([on, mode, off]);
    expect(request.mock.calls.map(([, params]) => params.sandboxPolicy.networkAccess)).toEqual([true, true, false]);
    expect(internal.options.codex.networkAccessEnabled).toBe(false);
    expect(internal.options.permissionMode).toBe('acceptEdits');
  });

  it('closes a new session when Codex rejects the required network policy', async () => {
    const session = new CodexSession('codex');
    vi.spyOn(session as any, 'request').mockImplementation(async (method) => {
      if (method === 'thread/settings/update') throw new Error('policy rejected');
      return { thread: { id: 'thread' }, data: [] };
    });
    await expect(session.start({ cwd: '/workspace', permissionMode: 'default', extraEnvRaw: '', callbacks: {} as any })).rejects.toThrow('policy rejected');
    expect((session as any).closed).toBe(true);
  });
});
