/**
 * `request_secret` from a thread on a daemon (src/main.ts `requestSecretForThread`). Only the managed local daemon
 * is served: the value is saved to the keychain by the host modal, the session environment is re-pushed over the
 * existing credential channel (`LocalDaemonSessionPrep.refreshEnv`), and the daemon session is restarted so the
 * next turn has it with history preserved. Everything else is refused without opening the modal.
 */
import { describe, expect, it, vi } from 'vitest';
import ClaudeThreadsPlugin from '../../src/main';

interface Setup {
  thread?: Record<string, unknown>;
  daemons?: Array<Record<string, unknown>>;
  stored?: boolean;
  saved?: boolean;
  refresh?: { envKind?: string; warnings: string[] };
  noPrep?: boolean;
  groupOff?: boolean;
}

function make(o: Setup = {}) {
  const plugin = Object.create(ClaudeThreadsPlugin.prototype) as ClaudeThreadsPlugin;
  const requestSecretFromUser = vi.fn(async () => o.saved ?? true);
  const requestSessionRestart = vi.fn();
  const refreshEnv = vi.fn(async () => o.refresh ?? { envKind: 'sessenv-p', warnings: [] });
  const extras = new Map<string, { envKind?: string; pluginPaths?: string[] }>([['t1', { envKind: 'sessenv-old', pluginPaths: ['/skills/a'] }]]);
  const p = plugin as unknown as Record<string, unknown>;
  p.requestSecretFromUser = requestSecretFromUser;
  p.manager = { requestSessionRestart, getThread: () => o.thread };
  p.settings = { remoteDaemons: o.daemons ?? [{ id: 'local', managed: 'local-container' }], secretEnvKeys: ['MY_TOKEN'], localDaemon: { optionalTools: o.groupOff ? [] : ['secrets'] } };
  p.saveSettings = vi.fn();
  p.app = { secretStorage: { getSecret: () => (o.stored ? 'stored-value' : null) } };
  p.localDaemonPrep = o.noPrep ? undefined : { refreshEnv };
  p.localDaemonExtras = extras;
  const call = (force?: boolean) => (plugin as unknown as { requestSecretForThread(t: string, n: string, r: string, f?: boolean): Promise<boolean> })
    .requestSecretForThread('t1', 'MY_TOKEN', 'to call the API', force);
  return { call, requestSecretFromUser, requestSessionRestart, refreshEnv, extras };
}

const onDaemon = { projectId: 'p', remote: { daemonId: 'local' } };

describe('requestSecretForThread on the managed local daemon', () => {
  it('saves, re-pushes the session environment, records the kind and restarts the session, in that order', async () => {
    const order: string[] = [];
    const s = make({ thread: onDaemon });
    s.requestSecretFromUser.mockImplementation(async () => { order.push('modal'); return true; });
    s.refreshEnv.mockImplementation(async () => { order.push('push'); return { envKind: 'sessenv-p', warnings: [] }; });
    s.requestSessionRestart.mockImplementation(() => { order.push('restart'); });
    expect(await s.call()).toBe(true);
    expect(order).toEqual(['modal', 'push', 'restart']);
    expect(s.refreshEnv).toHaveBeenCalledWith('p');
    expect(s.requestSessionRestart).toHaveBeenCalledWith('t1');
    expect(s.extras.get('t1')).toEqual({ envKind: 'sessenv-p', pluginPaths: ['/skills/a'] });
  });

  it('a cancelled modal pushes nothing and restarts nothing', async () => {
    const s = make({ thread: onDaemon, saved: false });
    expect(await s.call()).toBe(false);
    expect(s.refreshEnv).not.toHaveBeenCalled();
    expect(s.requestSessionRestart).not.toHaveBeenCalled();
  });

  it('a secret already in the keychain is delivered without a second modal unless force is set', async () => {
    const s = make({ thread: onDaemon, stored: true });
    expect(await s.call()).toBe(true);
    expect(s.requestSecretFromUser).not.toHaveBeenCalled();
    expect(s.refreshEnv).toHaveBeenCalledOnce();
    expect(s.requestSessionRestart).toHaveBeenCalledOnce();
    await s.call(true);
    expect(s.requestSecretFromUser).toHaveBeenCalledWith('MY_TOKEN', 'to call the API', true);
  });

  it('a failed push still reports the save, keeps the old kind and restarts (the next session start retries the push)', async () => {
    const s = make({ thread: onDaemon, refresh: { warnings: ['session environment: boom'] } });
    expect(await s.call()).toBe(true);
    expect(s.extras.get('t1')?.envKind).toBe('sessenv-old');
    expect(s.requestSessionRestart).toHaveBeenCalledOnce();
  });

  it.each([
    ['a daemon the user added', { thread: onDaemon, daemons: [{ id: 'local' }] }],
    ['an unknown daemon', { thread: onDaemon, daemons: [] }],
    ['a scheduled (headless) thread', { thread: { ...onDaemon, scheduledItemId: 's1' } }],
    ['the secrets group switched off', { thread: onDaemon, groupOff: true }],
    ['no local daemon prep', { thread: onDaemon, noPrep: true }],
  ] as Array<[string, Setup]>)('refuses %s without opening the modal', async (_label, setup) => {
    const s = make(setup);
    expect(await s.call()).toBe(false);
    expect(s.requestSecretFromUser).not.toHaveBeenCalled();
    expect(s.refreshEnv).not.toHaveBeenCalled();
    expect(s.requestSessionRestart).not.toHaveBeenCalled();
  });

  it('a local (non-daemon) thread keeps the old behaviour: modal then restart, no push', async () => {
    const s = make({ thread: { projectId: 'p' } });
    expect(await s.call()).toBe(true);
    expect(s.refreshEnv).not.toHaveBeenCalled();
    expect(s.requestSessionRestart).toHaveBeenCalledWith('t1');
  });
});
