/**
 * Local daemon GitHub delivery against a REAL daemon and its REAL CLI.
 *
 * The plugin runs `container exec ... agent-threads <args>`. Here the fake
 * `container` binary strips that prefix and runs the very same `<args>` through
 * the daemon's own `runCli` (in process), with the container paths mapped onto a
 * temp data directory and the in-container URL onto the test daemon. So the
 * argv built by src/localDaemon/spec.ts is proven to be accepted by the CLI, the
 * admin token is minted/saved/picked up, and the credential lands where
 * daemon/repos.ts looks for it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type Io } from '../../daemon/cli';
import { CredStore } from '../../daemon/credStore';
import { ReposManager } from '../../daemon/repos';
import type { VmCommandResult, VmCommandRunner } from '../../src/containerCli';
import { LocalDaemonGithubDelivery } from '../../src/localDaemon/githubDelivery';
import { CLI_TOKEN_FILE, DATA_MOUNT, GITCONFIG_FILE, containerNameFor } from '../../src/localDaemon/spec';
import { startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

const VAULT = '/Users/me/Vault';
const NAME = containerNameFor(VAULT);
const TOKEN = 'ghu_' + 'k'.repeat(36);

let td: TestDaemon;
beforeEach(async () => { td = await startTestDaemon(); });
afterEach(async () => { await td.cleanup(); });

const hostPath = (p: string): string => p.replace(DATA_MOUNT, td.dataDir);

/** `container exec [-i] --user UID NAME <cmd...>` executed against the test daemon. */
function fakeContainer(log: string[][], gitConfig: Record<string, string>): VmCommandRunner {
  return async (args, opts): Promise<VmCommandResult> => {
    log.push([...args]);
    let i = 1; // after "exec"
    const interactive = args[i] === '-i';
    if (interactive) i += 1;
    expect(args[i]).toBe('--user');
    i += 2;
    expect(args[i]).toBe(NAME);
    const cmd = args.slice(i + 1);

    if (cmd[0] === 'test') {
      return { exitCode: existsSync(hostPath(cmd[2])) && readFileSync(hostPath(cmd[2]), 'utf8').trim() ? 0 : 1, stdout: '', stderr: '' };
    }
    if (cmd[0] === 'git') {
      expect(cmd.slice(0, 4)).toEqual(['git', 'config', '--file', GITCONFIG_FILE]);
      gitConfig[cmd[4]] = cmd[5];
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    expect(cmd[0]).toBe('agent-threads');
    const argv = cmd.slice(1).map((a, n, all) => {
      if (all[n - 1] === '--url') return td.daemon.url; // the in-container loopback address
      if (all[n - 1] === '--data-dir') return td.dataDir;
      return a;
    });
    let out = ''; let err = '';
    const io: Io = {
      out: (l) => { out += `${l}\n`; }, err: (l) => { err += `${l}\n`; },
      write: (t) => { out += t; }, writeErr: (t) => { err += t; },
    };
    const code = await runCli(argv, io, {
      env: {}, // no AGENT_THREADS_TOKEN: the CLI must find cli-token in the data dir by itself
      stdinIsTTY: false, cwd: '/tmp', onInterrupt: () => () => {},
      ...(interactive ? { stdin: Readable.from([opts.input ?? '']) as unknown as NodeJS.ReadableStream } : {}),
    });
    return { exitCode: code, stdout: out, stderr: err };
  };
}

function delivery(log: string[][], gitConfig: Record<string, string>, enabled = () => true) {
  return new LocalDaemonGithubDelivery({
    broker: { available: true, getToken: async () => TOKEN, getProfile: async () => ({ id: 77, login: 'octo-user', name: 'Octo' }) },
    isEnabled: enabled,
    vaultPath: () => VAULT,
    runner: () => fakeContainer(log, gitConfig),
    setInterval: () => 'timer',
    clearInterval: () => undefined,
  });
}

describe('local daemon GitHub delivery, real daemon CLI', () => {
  it('mints a saved admin token, pushes GH_TOKEN as the github kind with a 15 minute expiry, and sets git identity', async () => {
    const log: string[][] = [];
    const gitConfig: Record<string, string> = {};
    const d = delivery(log, gitConfig);

    expect(await d.ensureFresh()).toEqual({ ok: true });

    expect(existsSync(join(td.dataDir, 'cli-token'))).toBe(true);
    expect(CLI_TOKEN_FILE).toBe(`${DATA_MOUNT}/cli-token`);
    const record = JSON.parse(readFileSync(join(td.dataDir, 'creds', 'github.json'), 'utf8'));
    expect(record.fields).toEqual({ GH_TOKEN: TOKEN });
    expect(record.expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(record.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(gitConfig).toEqual({ 'user.name': 'Octo', 'user.email': '77+octo-user@users.noreply.github.com' });
    // The secret was never in argv.
    expect(JSON.stringify(log)).not.toContain(TOKEN);
  });

  it('the daemon resolves the pushed credential exactly where repos.ts looks for it', async () => {
    const d = delivery([], {});
    await d.ensureFresh();
    const creds = new CredStore(td.dataDir);
    const repos = new ReposManager({ dataDir: td.dataDir, root: join(td.dataDir, 'workspace'), creds, getRepos: () => [], setRepos: () => undefined });
    // What a session's agent process gets: GH_TOKEN for gh, askpass wiring for git over https.
    expect(repos.sessionEnv()).toMatchObject({ GH_TOKEN: TOKEN, AGENT_THREADS_GIT_PASSWORD: TOKEN, GIT_TERMINAL_PROMPT: '0' });
  });

  it('a second push replaces the first and the admin token is reused', async () => {
    const log: string[][] = [];
    const d = delivery(log, {});
    await d.ensureFresh();
    const tokens = td.daemon.tokens.list().filter((t) => t.name === 'geode-creds');
    expect(tokens).toHaveLength(1);
    expect(log.filter((a) => a.includes('create'))).toHaveLength(1);
  });

  it('stop() deletes the credential from the daemon', async () => {
    const d = delivery([], {});
    await d.ensureFresh();
    expect(existsSync(join(td.dataDir, 'creds', 'github.json'))).toBe(true);
    await d.stop();
    expect(existsSync(join(td.dataDir, 'creds', 'github.json'))).toBe(false);
  });

  it('turning the setting off removes it on the next send', async () => {
    let on = true;
    const d = delivery([], {}, () => on);
    await d.ensureFresh();
    on = false;
    expect(await d.ensureFresh()).toBe('skipped');
    expect(existsSync(join(td.dataDir, 'creds', 'github.json'))).toBe(false);
  });
});
