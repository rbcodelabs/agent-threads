/**
 * Moving a thread between this computer and a daemon ("Run on" in the thread menu), which replaces the removed
 * per-thread sandbox VM's host <-> container switch.
 */
import os from 'os';
import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';

vi.mock('../../src/ThreadSession', () => ({
  ThreadSession: class {
    get turnInFlight(): boolean { return false; }
    async start(): Promise<void> {}
    send(): void {}
    async interrupt(): Promise<void> {}
    async setModel(): Promise<void> {}
    async setPermissionMode(): Promise<void> {}
    async restart(): Promise<void> {}
    close(): void {}
    async getContextUsage(): Promise<null> { return null; }
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function setup(over: Partial<Thread> = {}) {
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS });
  const thread = manager.createThread('T', os.tmpdir());
  thread.messages.push({ id: 'm', role: 'user', content: 'hi', timestamp: 1 }, { id: 'a', role: 'assistant', content: 'yo', timestamp: 2 });
  thread.sessionId = 'native-host-session';
  Object.assign(thread, over);
  return { manager, thread };
}

const toDaemon = { kind: 'daemon' as const, daemonId: 'this-mac-container', remoteCwd: '/vault/Projects/x', clientId: 'c1' };

describe('ThreadManager.moveThreadExecution', () => {
  it('moves a host thread onto a daemon: remote set, cwd mapped, native session dropped, handoff queued', async () => {
    const { manager, thread } = setup();
    const persist = vi.fn(async () => undefined);
    const events: string[] = [];
    manager.subscribe((_id, e) => events.push(e.type));
    await manager.moveThreadExecution(thread.id, toDaemon, persist);
    expect(thread.remote).toMatchObject({ daemonId: 'this-mac-container', remoteCwd: '/vault/Projects/x', ownership: 'client', ownerClientId: 'c1', lastSeq: 0 });
    expect(thread.cwd).toBe('/vault/Projects/x');
    expect(thread.sessionId).toBeUndefined();
    expect(thread.sessionGeneration).toBe(1);
    expect(thread.pendingHarnessHandoff).toMatchObject({ sourceHarness: 'claude', targetHarness: 'claude', threadId: thread.id });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(events).toContain('harness_changed');
    // The conversation itself is untouched.
    expect(thread.messages.map((m) => m.content)).toEqual(['hi', 'yo']);
  });

  it('moves it back to this computer: remote cleared, cwd restored, fresh handoff', async () => {
    const { manager, thread } = setup();
    await manager.moveThreadExecution(thread.id, toDaemon, async () => undefined);
    await manager.moveThreadExecution(thread.id, { kind: 'host', cwd: '/Users/me/Vault/Projects/x' }, async () => undefined);
    expect(thread.remote).toBeUndefined();
    expect(thread.cwd).toBe('/Users/me/Vault/Projects/x');
    expect(thread.sessionGeneration).toBe(2);
    expect(thread.pendingHarnessHandoff).toBeDefined();
  });

  it('is a no-op when it is already there', async () => {
    const { manager, thread } = setup();
    const persist = vi.fn(async () => undefined);
    await manager.moveThreadExecution(thread.id, { kind: 'host', cwd: '/x' }, persist);
    expect(persist).not.toHaveBeenCalled();
    await manager.moveThreadExecution(thread.id, toDaemon, persist);
    await manager.moveThreadExecution(thread.id, toDaemon, persist);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it.each(['codex', 'opencode'] as const)('moves a %s thread too, keeping its harness for the handoff', async (agentHarness) => {
    const { manager, thread } = setup({ agentHarness });
    const events: Array<{ type: string; sourceHarness?: string; targetHarness?: string }> = [];
    manager.subscribe((_id, e) => events.push(e as never));
    await manager.moveThreadExecution(thread.id, toDaemon, async () => undefined);
    expect(thread.agentHarness).toBe(agentHarness);
    expect(thread.remote).toMatchObject({ daemonId: 'this-mac-container', remoteCwd: '/vault/Projects/x' });
    expect(thread.sessionId).toBeUndefined();
    expect(thread.pendingHarnessHandoff).toBeDefined();
    expect(events.find((e) => e.type === 'harness_changed')).toMatchObject({ sourceHarness: agentHarness, targetHarness: agentHarness });
    await manager.moveThreadExecution(thread.id, { kind: 'host', cwd: '/x' }, async () => undefined); // and back
    expect(thread.remote).toBeUndefined();
  });

  it('refuses a daemon known not to offer the thread\'s harness (older daemons run Claude only), leaving the thread untouched', async () => {
    const { manager, thread } = setup({ agentHarness: 'codex' });
    manager.remoteDaemons = { clientFor: () => undefined, nameOf: () => 'This Mac', capabilitiesOf: () => ['host.tools', 'harness.claude'] };
    const persist = vi.fn(async () => undefined);
    await expect(manager.moveThreadExecution(thread.id, toDaemon, persist)).rejects.toThrow('This Mac is not set up for Codex');
    expect(persist).not.toHaveBeenCalled();
    expect(thread.remote).toBeUndefined();
    expect(thread.sessionId).toBe('native-host-session');
    // a Claude thread still moves there
    const claude = setup();
    claude.manager.remoteDaemons = manager.remoteDaemons;
    await claude.manager.moveThreadExecution(claude.thread.id, toDaemon, async () => undefined);
    expect(claude.thread.remote).toBeTruthy();
  });

  it('refuses while a turn is running or messages are queued', async () => {
    const { manager, thread } = setup();
    vi.spyOn(manager, 'isRunning').mockReturnValue(true);
    await expect(manager.moveThreadExecution(thread.id, toDaemon, async () => undefined)).rejects.toThrow(/active turn/);
    expect(thread.remote).toBeUndefined();
  });

  it('rolls everything back when saving fails', async () => {
    const { manager, thread } = setup();
    await expect(manager.moveThreadExecution(thread.id, toDaemon, async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    expect(thread.remote).toBeUndefined();
    expect(thread.cwd).toBe(os.tmpdir());
    expect(thread.sessionId).toBe('native-host-session');
    expect(thread.pendingHarnessHandoff).toBeUndefined();
    expect(thread.sessionGeneration).toBeUndefined();
  });
});

describe('session extras for a thread on the managed daemon', () => {
  it('reach the session options as the credential kind name and plugin paths, and beforeRemoteSend gets the thread id', async () => {
    const { manager, thread } = setup();
    await manager.moveThreadExecution(thread.id, toDaemon, async () => undefined);
    const seen: Array<[string, string]> = [];
    manager.beforeRemoteSend = async (daemonId, threadId) => { seen.push([daemonId, threadId]); };
    manager.remoteSessionExtras = (id) => (id === thread.id ? { envKind: 'sessenv-p1', pluginPaths: ['/var/lib/agent-threads/skills/a-1'] } : undefined);
    const options = (manager as unknown as { buildRemoteSessionOptions(id: string, t: Thread, m: undefined, l: boolean): { claude?: { remoteEnvKind?: string; remotePluginPaths?: string[] } } })
      .buildRemoteSessionOptions(thread.id, thread, undefined, false);
    expect(options.claude).toMatchObject({ remoteEnvKind: 'sessenv-p1', remotePluginPaths: ['/var/lib/agent-threads/skills/a-1'] });
    // No extras: nothing is added.
    manager.remoteSessionExtras = undefined;
    const bare = (manager as unknown as { buildRemoteSessionOptions(id: string, t: Thread, m: undefined, l: boolean): { claude?: Record<string, unknown> } })
      .buildRemoteSessionOptions(thread.id, thread, undefined, false);
    expect(bare.claude).not.toHaveProperty('remoteEnvKind');
    expect(bare.claude).not.toHaveProperty('remotePluginPaths');
    void seen;
  });
});
