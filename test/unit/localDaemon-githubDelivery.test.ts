/**
 * Local daemon: GitHub connection delivery. The `container` CLI is faked; the same
 * argv is executed against a real daemon CLI in
 * test/integration/local-daemon-github-delivery.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { GithubConnectionError } from '../../src/githubCredentials';
import type { VmCommandResult, VmCommandRunner } from '../../src/containerCli';
import { LocalDaemonGithubDelivery, type LocalDaemonGithubDeps } from '../../src/localDaemon/githubDelivery';
import {
  CLI_TOKEN_FILE,
  CREDS_TOKEN_NAME,
  DATA_MOUNT,
  GITCONFIG_FILE,
  GITHUB_CREDS_TTL_SEC,
  cliTokenCreateArgs,
  cliTokenPresentArgs,
  containerNameFor,
  credsPushArgs,
  credsRemoveArgs,
  gitConfigSetArgs,
} from '../../src/localDaemon/spec';

const VAULT = '/Users/me/Vault';
const NAME = containerNameFor(VAULT);
const TOKEN = 'ghu_' + 'q'.repeat(36);

interface Call { args: string[]; input?: string }

function fixture(over: {
  cliTokenPresent?: boolean;
  containerUp?: boolean;
  pushExits?: number[];
  tokenList?: string;
  enabled?: boolean;
  available?: boolean;
  getToken?: () => Promise<string>;
  getProfile?: () => Promise<{ id: number; login: string; name: string | null }>;
  emailOverride?: string;
} = {}) {
  const calls: Call[] = [];
  const pushExits = [...(over.pushExits ?? [])];
  let cliTokenPresent = over.cliTokenPresent ?? false;
  let now = 1_000_000;
  const run: VmCommandRunner = async (args, opts): Promise<VmCommandResult> => {
    calls.push({ args: [...args], input: opts.input });
    const j = args.join(' ');
    const ok: VmCommandResult = { exitCode: 0, stdout: '', stderr: '' };
    if (over.containerUp === false) return { exitCode: 1, stdout: '', stderr: 'container not found' };
    if (j === cliTokenPresentArgs(NAME).join(' ')) return { ...ok, exitCode: cliTokenPresent ? 0 : 1 };
    if (j === cliTokenCreateArgs(NAME).join(' ')) { cliTokenPresent = true; return { ...ok, stdout: '{"id":"t9","name":"geode-creds","scope":"admin","savedTo":"/x/cli-token"}\n' }; }
    if (args.includes('token') && args.includes('list')) return { ...ok, stdout: over.tokenList ?? '' };
    if (args.includes('token') && args.includes('revoke')) return ok;
    if (args.includes('creds') && args.includes('--stdin')) {
      const exit = pushExits.shift() ?? 0;
      return exit === 0 ? ok : { exitCode: exit, stdout: '', stderr: `connect failed with ${opts.input}` };
    }
    return ok;
  };
  const deps: LocalDaemonGithubDeps = {
    broker: {
      available: over.available ?? true,
      getToken: over.getToken ?? (async () => TOKEN),
      getProfile: over.getProfile ?? (async () => ({ id: 4242, login: 'octo-user', name: "Octo O'User" })),
    },
    isEnabled: () => over.enabled ?? true,
    vaultPath: () => VAULT,
    runner: () => run,
    getEmailOverride: () => over.emailOverride,
    now: () => now,
    setInterval: () => 'timer',
    clearInterval: () => undefined,
  };
  return { delivery: new LocalDaemonGithubDelivery(deps), calls, advance: (ms: number) => { now += ms; } };
}

const argvOf = (calls: Call[]): string => JSON.stringify(calls.map((c) => c.args));
const pushes = (calls: Call[]) => calls.filter((c) => c.args.includes('creds') && c.args.includes('--stdin'));

describe('argv builders', () => {
  it('push JSON on stdin with a TTL, address the in-container daemon, and carry no value', () => {
    const args = credsPushArgs(NAME, 'github', GITHUB_CREDS_TTL_SEC);
    expect(args).toEqual([
      'exec', '-i', '--user', '10001', NAME, 'agent-threads', 'creds', 'push', 'github',
      '--url', 'ws://127.0.0.1:7433', '--data-dir', DATA_MOUNT, '--stdin', '--ttl', '900',
    ]);
    expect(credsRemoveArgs(NAME, 'github')).toEqual([
      'exec', '-i', '--user', '10001', NAME, 'agent-threads', 'creds', 'push', 'github',
      '--url', 'ws://127.0.0.1:7433', '--data-dir', DATA_MOUNT, '--remove',
    ]);
  });

  it('mints a saved admin token without printing it, and tests for it with `test -s`', () => {
    expect(cliTokenCreateArgs(NAME)).toEqual([
      'exec', '--user', '10001', NAME, 'agent-threads', 'token', 'create',
      '--name', CREDS_TOKEN_NAME, '--scope', 'admin', '--save', '--json', '--data-dir', DATA_MOUNT,
    ]);
    expect(cliTokenPresentArgs(NAME)).toEqual(['exec', '--user', '10001', NAME, 'test', '-s', CLI_TOKEN_FILE]);
  });

  it('writes git identity to the daemon user global config file', () => {
    expect(gitConfigSetArgs(NAME, 'user.name', 'A B')).toEqual(['exec', '--user', '10001', NAME, 'git', 'config', '--file', GITCONFIG_FILE, 'user.name', 'A B']);
  });
});

describe('LocalDaemonGithubDelivery', () => {
  it('does nothing without a Geode bridge or with the setting off', async () => {
    for (const over of [{ available: false }, { enabled: false }]) {
      const f = fixture(over);
      expect(await f.delivery.ensureFresh()).toBe('skipped');
      expect(f.calls).toEqual([]);
    }
  });

  it('mints the admin token once, pushes the token over stdin only, and sets the commit identity', async () => {
    const f = fixture();
    expect(await f.delivery.ensureFresh()).toEqual({ ok: true });

    expect(f.calls[0].args).toEqual(cliTokenPresentArgs(NAME));
    expect(f.calls.some((c) => c.args.join(' ') === cliTokenCreateArgs(NAME).join(' '))).toBe(true);
    const [push] = pushes(f.calls);
    expect(push.args).toEqual(credsPushArgs(NAME, 'github', GITHUB_CREDS_TTL_SEC));
    expect(JSON.parse(push.input!)).toEqual({ GH_TOKEN: TOKEN });
    // The secret appears nowhere in argv, only on that one stdin.
    expect(argvOf(f.calls)).not.toContain(TOKEN);
    expect(f.calls.filter((c) => c.input !== undefined)).toHaveLength(1);

    const identity = f.calls.filter((c) => c.args.includes('git')).map((c) => c.args.slice(-2));
    expect(identity).toEqual([['user.name', "Octo O'User"], ['user.email', '4242+octo-user@users.noreply.github.com']]);
  });

  it('honours the commit email override', async () => {
    const f = fixture({ emailOverride: 'me@example.com' });
    await f.delivery.ensureFresh();
    expect(f.calls.filter((c) => c.args.includes('git')).map((c) => c.args.at(-1))).toEqual(["Octo O'User", 'me@example.com']);
  });

  it('is cheap before every send: no container traffic while the last push is under a minute old', async () => {
    const f = fixture();
    await f.delivery.ensureFresh();
    const before = f.calls.length;
    f.advance(30_000);
    await f.delivery.ensureFresh();
    expect(f.calls).toHaveLength(before);

    f.advance(31_000);
    await f.delivery.ensureFresh();
    // A fresh push, but the admin token is cached and the identity is unchanged.
    expect(pushes(f.calls)).toHaveLength(2);
    expect(f.calls.filter((c) => c.args.join(' ') === cliTokenPresentArgs(NAME).join(' '))).toHaveLength(1);
    expect(f.calls.filter((c) => c.args.includes('git'))).toHaveLength(2);
  });

  it('reuses a saved admin token and revokes a stale one of ours before minting a new one', async () => {
    const saved = fixture({ cliTokenPresent: true });
    await saved.delivery.ensureFresh();
    expect(saved.calls.some((c) => c.args.includes('create'))).toBe(false);

    const stale = fixture({ tokenList: '{"id":"old1","name":"geode-creds","scope":"admin"}\n{"id":"x","name":"geode-local","scope":"control"}\n' });
    await stale.delivery.ensureFresh();
    const revokes = stale.calls.filter((c) => c.args.includes('revoke')).map((c) => c.args);
    expect(revokes).toHaveLength(1);
    expect(revokes[0]).toContain('old1');
  });

  it('re-mints the admin token and retries once when a push fails (data volume reset)', async () => {
    const f = fixture({ cliTokenPresent: true, pushExits: [1, 0] });
    expect(await f.delivery.ensureFresh()).toEqual({ ok: true });
    expect(pushes(f.calls)).toHaveLength(2);
  });

  it('reports a failed push without throwing, and never echoes the token', async () => {
    const f = fixture({ cliTokenPresent: true, pushExits: [1, 1] });
    const state = await f.delivery.ensureFresh();
    expect(state).toMatchObject({ ok: false });
    if (!('ok' in state) || state.ok) throw new Error('unreachable');
    expect(state.error.message).toContain('failed (exit 1)');
    expect(state.error.message).not.toContain(TOKEN);
  });

  it('reports a stopped container without throwing', async () => {
    const f = fixture({ containerUp: false });
    const state = await f.delivery.ensureFresh();
    expect(state).toMatchObject({ ok: false });
    expect(pushes(f.calls)).toHaveLength(0);
  });

  it('does not push (or clean up) when the connection has no token', async () => {
    const f = fixture({ getToken: async () => { throw new GithubConnectionError('not_connected', 'GitHub is not connected.'); } });
    expect(await f.delivery.ensureFresh()).toMatchObject({ ok: false });
    expect(f.calls).toEqual([]);
    await f.delivery.stop();
    expect(f.calls).toEqual([]);
  });

  it('stop() removes what was pushed, once', async () => {
    const f = fixture({ cliTokenPresent: true });
    await f.delivery.ensureFresh();
    await f.delivery.stop();
    const removals = f.calls.filter((c) => c.args.join(' ') === credsRemoveArgs(NAME, 'github').join(' '));
    expect(removals).toHaveLength(1);
    await f.delivery.stop();
    expect(f.calls.filter((c) => c.args.join(' ') === credsRemoveArgs(NAME, 'github').join(' '))).toHaveLength(1);
  });

  it('turning the setting off after a push removes the credential', async () => {
    let enabled = true;
    const calls: Call[] = [];
    const delivery = new LocalDaemonGithubDelivery({
      broker: { available: true, getToken: async () => TOKEN, getProfile: async () => ({ id: 1, login: 'o', name: null }) },
      isEnabled: () => enabled,
      vaultPath: () => VAULT,
      runner: () => (async (args, opts) => { calls.push({ args: [...args], input: opts.input }); return { exitCode: 0, stdout: '', stderr: '' }; }) as VmCommandRunner,
      setInterval: () => 't',
      clearInterval: () => undefined,
    });
    await delivery.ensureFresh();
    enabled = false;
    expect(await delivery.ensureFresh()).toBe('skipped');
    expect(calls.some((c) => c.args.join(' ') === credsRemoveArgs(NAME, 'github').join(' '))).toBe(true);
  });
});
