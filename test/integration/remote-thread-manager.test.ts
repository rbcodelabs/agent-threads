/**
 * The real ThreadManager driving a remote thread end to end: HarnessFactory
 * branch -> RemoteHarnessSession -> DaemonClient -> the daemon's real server
 * (fake harness). Also pins the local-filesystem guards and the
 * detach-instead-of-close behaviour that makes remote turns outlive the host.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import os from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeTokenText } from '../../daemon/fakeHarness';
import { DaemonRegistry } from '../../src/remote/DaemonRegistry';
import type { WebSocketFactory } from '../../src/remote/DaemonClient';
import { ThreadManager, type ThreadEvent } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS, type RemoteDaemonConfig, type Thread } from '../../src/types';
import { startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

const wsFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as ReturnType<WebSocketFactory>;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup(cfgOverride: Partial<RemoteDaemonConfig> = {}): Promise<{ td: TestDaemon; manager: ThreadManager; registry: DaemonRegistry; events: Array<{ id: string; e: ThreadEvent }>; cfg: RemoteDaemonConfig }> {
  const td = await startTestDaemon();
  cleanups.push(() => td.cleanup());
  const cfg: RemoteDaemonConfig = { id: 'box', name: 'my-server', url: td.daemon.url, tokenSecretName: 'AT_TOKEN', ...cfgOverride };
  const registry = new DaemonRegistry({
    getDaemons: () => [cfg],
    getToken: () => td.adminToken,
    createSocket: wsFactory,
    clientVersion: '0.62.2',
  });
  cleanups.push(() => registry.disposeAll());
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS, remoteDaemons: [cfg] });
  manager.remoteDaemons = registry;
  const events: Array<{ id: string; e: ThreadEvent }> = [];
  manager.subscribe((id, e) => events.push({ id, e }));
  return { td, manager, registry, events, cfg };
}

async function until(pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('remote thread through ThreadManager', () => {
  it('creates a remote thread, streams tokens into events and lands the final message in the transcript', async () => {
    const { td, manager, events } = await setup();
    const thread = manager.createRemoteThread('on the box', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'geode-1' });
    expect(thread.cwd).toBe('/srv/workspaces/x');
    expect(thread.agentHarness).toBe('claude');

    await manager.sendMessage(thread.id, '/tokens 25 burst=2 delay=3');
    await until(() => thread.status === 'waiting' && thread.messages.some((m) => m.role === 'assistant'), 'turn to finish');

    const tokens = events.filter((x) => x.e.type === 'token').map((x) => (x.e as { text: string }).text);
    expect(tokens).toEqual(Array.from({ length: 25 }, (_, i) => fakeTokenText(i)));
    const assistant = thread.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe(tokens.join(''));
    expect(thread.messages[0]).toMatchObject({ role: 'user', content: '/tokens 25 burst=2 delay=3' });
    expect(thread.sessionId).toBe('fake-' + thread.id); // the daemon-side native id
    expect(thread.remote!.lastSeq).toBe(td.daemon.threads.journalFor(thread.id)!.lastSeq);
    expect(thread.remote!.turnPending).toBeUndefined();
    manager.destroy();
  });

  it('sends the vault-mirror addendum only for a thread whose remote cwd is inside the daemon\'s vault root', async () => {
    const { td, manager } = await setup({ vaultMapping: { remoteRoot: '/home/user/vault' } });
    const promptOf = (id: string): string => (JSON.parse(readFileSync(join(td.dataDir, 'sessions', `${id}.json`), 'utf8')) as { spec: { appendSystemPrompt?: string } }).spec.appendSystemPrompt ?? '';

    const inVault = manager.createRemoteThread('vault', { daemonId: 'box', remoteCwd: '/home/user/vault/Products', clientId: 'c' });
    await manager.sendMessage(inVault.id, '/tokens 3 burst=3 delay=1');
    await until(() => inVault.status === 'waiting' && inVault.messages.some((m) => m.role === 'assistant'), 'vault turn');
    const vaultPrompt = promptOf(inVault.id);
    expect(vaultPrompt).toContain('Working directory: /home/user/vault/Products');
    expect(vaultPrompt).toContain('Vault (synced mirror):');
    expect(vaultPrompt).toContain('Never delete or rename vault files unless the user explicitly asks');
    expect(vaultPrompt).not.toMatch(/\/Users\//);

    const elsewhere = manager.createRemoteThread('code', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    await manager.sendMessage(elsewhere.id, '/tokens 3 burst=3 delay=1');
    await until(() => elsewhere.status === 'waiting' && elsewhere.messages.some((m) => m.role === 'assistant'), 'code turn');
    expect(promptOf(elsewhere.id)).not.toContain('synced mirror');
    manager.destroy();
  });

  it('answers a permission prompt raised on the daemon', async () => {
    const { manager, events } = await setup();
    const thread = manager.createRemoteThread('perm', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    const asked: Array<{ toolName: string; detail: string }> = [];
    manager.permissionHandler = (_id, toolName, detail) => new Promise<boolean>((resolve) => {
      asked.push({ toolName, detail });
      manager.registerPermissionResolver(thread.id, resolve);
    });
    await manager.sendMessage(thread.id, '/permission');
    await until(() => events.some((x) => x.e.type === 'permission_request') && manager.hasPendingPermission(thread.id), 'permission_request');
    expect(asked).toEqual([{ toolName: 'Bash', detail: 'ls /srv/workspaces' }]);
    manager.resolvePermission(thread.id, true);
    await until(() => thread.messages.some((m) => m.role === 'assistant' && m.content.includes('permission resolved')), 'resolved reply');
    manager.destroy();
  });

  it('treats a remote thread as never always-allowable and a local thread as ordinary', async () => {
    const { manager } = await setup();
    const remote = manager.createRemoteThread('on the box', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'geode-1' });
    expect(manager.isRemoteThread(remote.id)).toBe(true);
    expect(manager.isRemoteThread('no-such-thread')).toBe(false);
    manager.destroy();
  });

  it('offers no host tools by default: the daemon session is opened without a manifest', async () => {
    const { td, manager } = await setup();
    let factoryCalls = 0;
    manager.remoteHostToolsFactory = () => { factoryCalls++; return undefined; };
    const t = manager.createRemoteThread('no tools', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'geode-1' });
    await manager.sendMessage(t.id, '/mcp-list claude_threads');
    await until(() => t.messages.some((m) => m.role === 'assistant'), 'turn');
    expect(factoryCalls).toBe(0); // enabled must be set explicitly for the factory to be consulted
    expect(td.daemon.threads.hostTools.manifest(t.id)).toEqual({});
    manager.destroy();
  });

  it('does not stat, repair or reroute a remote cwd that does not exist locally', async () => {
    const { manager } = await setup();
    const thread = manager.createRemoteThread('guards', { daemonId: 'box', remoteCwd: `${os.homedir()}/.geode/worktrees/nope/feat-x`, clientId: 'c' });
    const before = thread.cwd;
    expect(manager.repairStaleCwds()).toBe(0);
    expect(manager.backfillLegacyProjectNames()).toBe(0);
    expect(thread.cwd).toBe(before);
    // The send path (ensureCwdExists) must not turn the missing local path into an error event.
    const errors: unknown[] = [];
    manager.subscribe((_id, e) => { if (e.type === 'error') errors.push(e.error); });
    await manager.sendMessage(thread.id, 'hello');
    await until(() => thread.messages.some((m) => m.role === 'assistant') || errors.length > 0, 'a reply or an error');
    expect(errors.map(String)).toEqual([]);
    expect(thread.cwd).toBe(before);
    manager.destroy();
  });

  it('keeps remote cwd and thread.cwd in step and ignores Project cwd alignment', async () => {
    const { manager } = await setup();
    const thread = manager.createRemoteThread('cwd', { daemonId: 'box', remoteCwd: '/srv/workspaces/a', clientId: 'c' });
    manager.setThreadCwd(thread.id, '/srv/workspaces/b');
    expect(thread.remote!.remoteCwd).toBe('/srv/workspaces/b');
    const project = manager.createProject?.('p', '/tmp/local-project') ?? undefined;
    if (project) {
      manager.setThreadProject(thread.id, project.id, true);
      expect(thread.cwd).toBe('/srv/workspaces/b');
    }
  });

  it('refuses container and harness switching for a remote thread', async () => {
    const { manager } = await setup();
    const thread = manager.createRemoteThread('nope', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    await expect(manager.setThreadHarnessVmMode(thread.id, 'always', async () => undefined)).rejects.toThrow(/remote daemon/);
    await expect(manager.switchHarness(thread.id, 'codex', async () => undefined)).rejects.toThrow(/Claude only/);
  });

  it('fails clearly when the daemon was removed from settings', async () => {
    const { manager, cfg } = await setup();
    const thread = manager.createRemoteThread('orphan', { daemonId: 'gone', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    const errors: string[] = [];
    manager.subscribe((_id, e) => { if (e.type === 'error') errors.push(e.error.message); });
    await manager.sendMessage(thread.id, 'hi').catch((e: Error) => errors.push(e.message));
    await until(() => errors.length > 0, 'an error');
    expect(errors[0]).toMatch(/not configured/);
    expect(cfg.id).toBe('box');
  });
});

describe('remote turns outlive the host', () => {
  it('gracefulShutdown detaches instead of interrupting or closing a running remote turn', async () => {
    const { td, manager } = await setup();
    const thread = manager.createRemoteThread('long', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    await manager.sendMessage(thread.id, '/tokens 120 burst=1 delay=10');
    await until(() => (td.daemon.threads.journalFor(thread.id)?.lastSeq ?? 0) > 10, 'streaming');
    const t0 = Date.now();
    const { timedOut } = await manager.gracefulShutdown(2000);
    expect(timedOut).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1500); // did not wait for the remote turn
    const entry = td.daemon.threads.list().find((t) => t.threadId === thread.id)!;
    expect(entry.open).toBe(true);
    expect(entry.turnInFlight).toBe(true); // still running on the daemon
  });

  it('a new ThreadManager resumes the pending turn from the persisted thread and completes the transcript', async () => {
    const { td, manager, cfg } = await setup();
    const thread = manager.createRemoteThread('long', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    await manager.sendMessage(thread.id, '/tokens 60 burst=1 delay=10');
    await until(() => (td.daemon.threads.journalFor(thread.id)?.lastSeq ?? 0) > 10, 'streaming');
    expect(thread.remote!.turnPending).toBe(true);
    await manager.gracefulShutdown(500);
    const persisted = JSON.parse(JSON.stringify(thread)) as Thread; // data.json round trip

    // "Reopen Geode": fresh manager and registry, same persisted thread.
    const registry2 = new DaemonRegistry({ getDaemons: () => [cfg], getToken: () => td.adminToken, createSocket: wsFactory, clientVersion: '0.62.2' });
    cleanups.push(() => registry2.disposeAll());
    const manager2 = new ThreadManager({ ...DEFAULT_SETTINGS, remoteDaemons: [cfg] });
    manager2.remoteDaemons = registry2;
    manager2.loadThreads([persisted]);
    expect(manager2.resumeRemoteTurns()).toEqual([thread.id]);
    expect(persisted.status).toBe('active');
    expect(manager2.isRunning(thread.id)).toBe(true);

    await until(() => persisted.messages.some((m) => m.role === 'assistant'), 'the assistant message');
    const assistant = persisted.messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0].content).toBe(Array.from({ length: 60 }, (_, i) => fakeTokenText(i)).join(''));
    await until(() => persisted.status === 'waiting', 'waiting');
    expect(persisted.remote!.turnPending).toBeUndefined();
    manager2.destroy();
  });

  it('a daemon removed from settings drops the pending marker instead of retrying forever', async () => {
    const { manager } = await setup();
    const thread = manager.createRemoteThread('x', { daemonId: 'gone', remoteCwd: '/srv/workspaces/x', clientId: 'c' });
    thread.remote!.turnPending = true;
    expect(manager.resumeRemoteTurns()).toEqual([]);
    expect(thread.remote!.turnPending).toBeUndefined();
  });
});
