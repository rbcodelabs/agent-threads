/**
 * A remote thread carries the harness the user chose, end to end through the real ThreadManager, HarnessFactory,
 * RemoteHarnessSession, DaemonClient and the daemon's server (scripted fake harness): creation, the session spec on
 * the wire and in the daemon's stored recipe, hand-off to another harness, and capability gating with an older daemon.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonRegistry } from '../../src/remote/DaemonRegistry';
import type { RemoteDaemonResolver } from '../../src/remote/DaemonRegistry';
import type { WebSocketFactory } from '../../src/remote/DaemonClient';
import { ThreadManager } from '../../src/ThreadManager';
import { DEFAULT_SETTINGS, type PluginSettings, type RemoteDaemonConfig } from '../../src/types';
import { startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

const wsFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as ReturnType<WebSocketFactory>;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup(settings: Partial<PluginSettings> = {}, daemonOpts: Parameters<typeof startTestDaemon>[0] = {}) {
  const td = await startTestDaemon(daemonOpts);
  cleanups.push(() => td.cleanup());
  const cfg: RemoteDaemonConfig = { id: 'box', name: 'my-server', url: td.daemon.url, tokenSecretName: 'AT_TOKEN' };
  const registry = new DaemonRegistry({ getDaemons: () => [cfg], getToken: () => td.adminToken, createSocket: wsFactory, clientVersion: '0.62.2' });
  cleanups.push(() => registry.disposeAll());
  const manager = new ThreadManager({ ...DEFAULT_SETTINGS, remoteDaemons: [cfg], ...settings });
  manager.remoteDaemons = registry;
  return { td, manager, registry };
}

async function until(pred: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const recipe = (td: TestDaemon, id: string) => JSON.parse(readFileSync(join(td.dataDir, 'sessions', `${id}.json`), 'utf8')) as { spec: Record<string, unknown>; nativeSessionId?: string };

describe('createRemoteThread carries the harness', () => {
  it.each(['claude', 'codex', 'opencode'] as const)('%s', async (harness) => {
    const { td, manager } = await setup({ codexEffort: 'high', defaultModel: 'sonnet' });
    const thread = manager.createRemoteThread('t', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c', agentHarness: harness });
    expect(thread.agentHarness).toBe(harness);
    expect(thread.remote).toMatchObject({ daemonId: 'box', remoteCwd: '/srv/workspaces/x' });
    await manager.sendMessage(thread.id, 'hello');
    await until(() => thread.status === 'waiting' && thread.messages.some((m) => m.role === 'assistant'), 'turn');
    const spec = recipe(td, thread.id).spec;
    expect(spec.harness).toBe(harness);
    // Claude's default model alias means nothing to the others; Codex's configured effort is the one option it takes.
    if (harness === 'claude') expect(spec.model).toBe('sonnet'); else expect(spec.model).toBeUndefined();
    if (harness === 'codex') expect(spec.sessionOptions).toEqual({ effort: 'high' }); else if (harness === 'opencode') expect(spec.sessionOptions).toBeUndefined();
    manager.destroy();
  });

  it('defaults to Claude when no harness is given', async () => {
    const { manager } = await setup();
    expect(manager.createRemoteThread('t', { daemonId: 'box', remoteCwd: '/srv/w', clientId: 'c' }).agentHarness).toBe('claude');
    manager.destroy();
  });

  it('a thread re-attaches (cold resume of the same harness) after the host restarts', async () => {
    const { td, manager } = await setup();
    const thread = manager.createRemoteThread('t', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c', agentHarness: 'codex' });
    await manager.sendMessage(thread.id, 'first');
    await until(() => thread.status === 'waiting' && thread.messages.some((m) => m.role === 'assistant'), 'turn');
    const saved = JSON.parse(JSON.stringify(thread));
    manager.destroy();
    expect(saved.agentHarness).toBe('codex');
    // The recipe on the daemon is what a cold resume starts from.
    expect(recipe(td, thread.id).spec.harness).toBe('codex');
  });
});

describe('capability gating in ThreadManager', () => {
  const resolver = (caps: string[] | undefined): RemoteDaemonResolver => ({
    clientFor: () => undefined, nameOf: () => 'box-name', capabilitiesOf: () => caps,
  });
  const make = (caps: string[] | undefined) => {
    const manager = new ThreadManager({ ...DEFAULT_SETTINGS, remoteDaemons: [] });
    manager.remoteDaemons = resolver(caps);
    return manager;
  };
  const create = (m: ThreadManager, agentHarness: 'claude' | 'codex' | 'opencode') =>
    m.createRemoteThread('t', { daemonId: 'box', remoteCwd: '/srv/w', clientId: 'c', agentHarness });

  it('refuses a harness the daemon does not offer, naming the daemon and what it offers', () => {
    const m = make(['harness.claude', 'harness.codex']);
    expect(create(m, 'codex').agentHarness).toBe('codex');
    expect(() => create(m, 'opencode')).toThrow('box-name is not set up for OpenCode (it offers: Claude, Codex)');
    expect(m.getThreads()).toHaveLength(1); // nothing was created for the refused one
  });

  it('an older daemon (no harness.* capability) runs Claude only', () => {
    const m = make(['host.tools']);
    expect(create(m, 'claude').agentHarness).toBe('claude');
    expect(() => create(m, 'codex')).toThrow('older daemon that only runs Claude');
  });

  it('capabilities not known yet do not block', () => {
    expect(create(make(undefined), 'opencode').agentHarness).toBe('opencode');
  });

  it('a resolver without capability support (older host wiring) does not block', () => {
    const m = new ThreadManager({ ...DEFAULT_SETTINGS, remoteDaemons: [] });
    m.remoteDaemons = { clientFor: () => undefined, nameOf: () => 'x' };
    expect(create(m, 'codex').agentHarness).toBe('codex');
  });

  it('hand-off to another harness is gated the same way', async () => {
    const m = make(['harness.claude']);
    const thread = create(m, 'claude');
    await expect(m.switchHarness(thread.id, 'codex', async () => undefined)).rejects.toThrow('not set up for Codex');
    expect(thread.agentHarness).toBe('claude');
  });
});

describe('hand-off of a remote thread', () => {
  it('switches a remote thread (no longer refused) and records the handoff for the next send', async () => {
    const { td, manager } = await setup();
    const thread = manager.createRemoteThread('t', { daemonId: 'box', remoteCwd: '/srv/workspaces/x', clientId: 'c', agentHarness: 'claude' });
    await manager.sendMessage(thread.id, 'one');
    await until(() => thread.status === 'waiting' && thread.messages.some((m) => m.role === 'assistant'), 'first turn');
    expect(recipe(td, thread.id).spec.harness).toBe('claude');

    await manager.switchHarness(thread.id, 'codex', async () => undefined);
    expect(thread.agentHarness).toBe('codex');
    expect(thread.sessionId).toBeUndefined();
    expect(thread.pendingHarnessHandoff).toBeTruthy();
    expect(thread.remote).toBeTruthy(); // still a remote thread on the same daemon

    await manager.sendMessage(thread.id, 'two');
    await until(() => thread.messages.filter((m) => m.role === 'assistant').length >= 2, 'second turn');
    expect(recipe(td, thread.id).spec.harness).toBe('codex');
    manager.destroy();
  });
});
