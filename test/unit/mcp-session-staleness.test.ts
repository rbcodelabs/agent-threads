/**
 * A long-lived session keeps the `mcpServers` it was built with. The Google /
 * OAuth proxies use random ports and in-memory capability secrets, so after a
 * proxy (re)start those URLs/secrets are dead. ThreadManager must (1) rebuild
 * every live session on request and (2) detect staleness on each send, via SDK
 * `mcpServerStatus()` (preferred) or by comparing the proxy-owned config.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import { DEFAULT_SETTINGS, type Thread } from '../../src/types';

type FakeSession = {
  id: number; closed: boolean; turnInFlight: boolean;
  status?: Array<{ name: string; status: string }>;
  hostChanged?: boolean;
};
const fake = vi.hoisted(() => ({ sessions: [] as FakeSession[] }));

vi.mock('../../src/HarnessFactory', () => ({
  createHarnessSession: () => {
    const s: FakeSession & Record<string, unknown> = {
      id: fake.sessions.length, closed: false, turnInFlight: false, cwd: undefined,
      start: async () => {}, send: () => {}, prepareForSend: async () => {},
      setModel: async () => {}, setPermissionMode: async () => {},
      close() { s.closed = true; }, interrupt: async () => {}, getContextUsage: async () => null,
      getUsageSnapshot: async () => null,
      mcpServerStatus: async () => s.status ?? [],
      hostServersChanged: async () => s.hostChanged === true,
    };
    fake.sessions.push(s);
    return s;
  },
}));

const { ThreadManager } = await import('../../src/ThreadManager');

function thread(id: string): Thread {
  return { id, title: id, cwd: os.tmpdir(), sessionGeneration: 1, messages: [], createdAt: 1, updatedAt: 1, status: 'waiting' };
}
function setup(servers: () => Record<string, unknown>) {
  const manager = new ThreadManager(DEFAULT_SETTINGS);
  manager.loadThreads([thread('t1'), thread('t2')]);
  manager.proxyMcpServersForThread = () => servers();
  return manager;
}

beforeEach(() => { fake.sessions.length = 0; });

describe('ThreadManager.requestAllSessionsRestart', () => {
  it('rebuilds every live session at its next turn, not mid-turn', async () => {
    const manager = setup(() => ({}));
    await manager.sendMessage('t1', 'a');
    await manager.sendMessage('t2', 'a');
    expect(manager.requestAllSessionsRestart()).toBe(2);

    fake.sessions[0].turnInFlight = true; // t1 mid-turn: must not be closed
    await manager.sendMessage('t1', 'b');
    expect(fake.sessions[0].closed).toBe(false);

    await manager.sendMessage('t2', 'b');
    expect(fake.sessions[1].closed).toBe(true);
    expect(fake.sessions).toHaveLength(3);
  });
});

describe('ThreadManager stale MCP detection on send', () => {
  it('rebuilds when the proxy-owned config changed since the session was built (config comparison)', async () => {
    let origin = 'http://127.0.0.1:1111';
    const manager = setup(() => ({ 'google-docs': { type: 'http', url: `${origin}/docs`, headers: { Authorization: 'Bearer a' } } }));
    await manager.sendMessage('t1', 'a');
    await manager.sendMessage('t1', 'b'); // unchanged -> reuse
    expect(fake.sessions).toHaveLength(1);

    origin = 'http://127.0.0.1:2222';
    await manager.sendMessage('t1', 'c');
    expect(fake.sessions[0].closed).toBe(true);
    expect(fake.sessions).toHaveLength(2);
    await manager.sendMessage('t1', 'd'); // new baseline recorded
    expect(fake.sessions).toHaveLength(2);
  });

  it('rebuilds when the SDK reports a proxy-owned server as failed (SDK status)', async () => {
    const manager = setup(() => ({ 'google-docs': { type: 'http', url: 'http://127.0.0.1:1/docs' } }));
    await manager.sendMessage('t1', 'a');
    fake.sessions[0].status = [{ name: 'google-docs', status: 'failed' }, { name: 'other', status: 'connected' }];
    await manager.sendMessage('t1', 'b');
    expect(fake.sessions[0].closed).toBe(true);
    expect(fake.sessions).toHaveLength(2);
  });

  it('ignores failures of servers the proxies do not own', async () => {
    const manager = setup(() => ({ 'google-docs': { type: 'http', url: 'http://127.0.0.1:1/docs' } }));
    await manager.sendMessage('t1', 'a');
    fake.sessions[0].status = [{ name: 'compass', status: 'failed' }];
    await manager.sendMessage('t1', 'b');
    expect(fake.sessions).toHaveLength(1);
  });

  it('does not loop-rebuild every turn for a server that stays failed under unchanged config', async () => {
    const manager = setup(() => ({ 'google-docs': { type: 'http', url: 'http://127.0.0.1:1/docs' } }));
    await manager.sendMessage('t1', 'a');
    fake.sessions[0].status = [{ name: 'google-docs', status: 'failed' }];
    await manager.sendMessage('t1', 'b'); // rebuild #1
    fake.sessions[1].status = [{ name: 'google-docs', status: 'failed' }];
    await manager.sendMessage('t1', 'c');
    expect(fake.sessions).toHaveLength(2);
  });

  it('never closes a session mid-turn', async () => {
    let url = 'http://127.0.0.1:1/docs';
    const manager = setup(() => ({ 'google-docs': { type: 'http', url } }));
    await manager.sendMessage('t1', 'a');
    url = 'http://127.0.0.1:2/docs';
    fake.sessions[0].turnInFlight = true;
    await manager.sendMessage('t1', 'b');
    expect(fake.sessions[0].closed).toBe(false);
  });

  it('is a no-op when no proxy hook is installed', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([thread('t1')]);
    await manager.sendMessage('t1', 'a');
    await manager.sendMessage('t1', 'b');
    expect(fake.sessions).toHaveLength(1);
  });
});

describe('ThreadManager stale host-tool servers on a remote thread', () => {
  const remoteThread = (): Thread => ({
    ...thread('r1'),
    remote: { daemonId: 'd1', ownership: 'client', remoteCwd: '/srv/x', lastSeq: 0, ownerClientId: 'c' },
  } as Thread);

  it('rebuilds at the next turn when a tool server joined the host manifest', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([remoteThread()]);
    await manager.sendMessage('r1', 'a');
    await manager.sendMessage('r1', 'b'); // nothing new -> reuse
    expect(fake.sessions).toHaveLength(1);

    fake.sessions[0].hostChanged = true; // e.g. vercel was switched on for this daemon
    await manager.sendMessage('r1', 'c');
    expect(fake.sessions[0].closed).toBe(true);
    expect(fake.sessions).toHaveLength(2);
  });

  it('does not rebuild a remote session mid-turn', async () => {
    const manager = new ThreadManager(DEFAULT_SETTINGS);
    manager.loadThreads([remoteThread()]);
    await manager.sendMessage('r1', 'a');
    fake.sessions[0].hostChanged = true;
    fake.sessions[0].turnInFlight = true;
    await manager.sendMessage('r1', 'b');
    expect(fake.sessions[0].closed).toBe(false);
  });
});
