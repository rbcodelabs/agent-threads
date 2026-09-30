/**
 * Geode GitHub connection → threads.
 *
 * Covers: the broker's error mapping, commit identity, token publishing and
 * refresh, host delivery, container delivery through the sandbox VM hooks, and
 * compatibility with credentials the user configured themselves.
 *
 * The generated helper scripts are EXECUTED (sh/bash + real `git credential
 * fill`), not just string-matched — that is the behavior that matters. The
 * `container` CLI is faked; a real container run is covered by the manual smoke
 * in docs/github-integration.md.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  GithubConnectionError,
  GithubCredentialBroker,
  GithubTokenPublisher,
  isValidRepoFullName,
  noreplyEmail,
  redactGithubSecrets,
  resolveCommitIdentity,
  resolveGithubBridge,
  summarizeAccess,
  type GithubAuthBridge,
  type GithubBridgeStatus,
  type GithubIpcResult,
  type TokenSink,
} from '../../src/githubCredentials';
import {
  buildContainerClearTokenCommand,
  buildContainerInstallCommand,
  buildContainerWriteTokenCommand,
  buildGhWrapperScript,
  buildGitHelperScript,
  buildHostGitEnv,
  shellQuote,
  GIT_HELPER_NAME,
} from '../../src/githubCredentialHelper';
import { GithubHostDelivery } from '../../src/githubHostDelivery';
import { createGithubVmHooks } from '../../src/githubVmDelivery';
import {
  SandboxVmManager,
  type VmCommandResult,
  type VmCommandRunner,
} from '../../src/sandboxVm';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TOKEN_1 = 'ghu_' + 'a'.repeat(36);
const TOKEN_2 = 'ghu_' + 'b'.repeat(36);
const PROFILE = { id: 4242, login: 'octo-user', name: 'Octo User' };

const tmpDirs: string[] = [];
function tmp(prefix = 'ct-gh-test-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return fs.realpathSync(d);
}
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

interface FakeBridgeState {
  token: string | null;
  status: GithubBridgeStatus;
  failCode: string;
  failMessage: string;
  getTokenCalls: number;
  installations: Array<{ id: number; account: string; repositories: Array<{ id: number; fullName: string; private: boolean }> }>;
}

function fakeBridge(over: Partial<FakeBridgeState> = {}) {
  const state: FakeBridgeState = {
    token: TOKEN_1,
    status: { state: 'connected', login: PROFILE.login },
    failCode: 'reauth_required',
    failMessage: 'GitHub is not connected.',
    getTokenCalls: 0,
    installations: [{ id: 1, account: 'octo-user', repositories: [{ id: 9, fullName: 'octo-user/sandbox', private: true }] }],
    ...over,
  };
  const bridge: GithubAuthBridge = {
    status: async () => state.status,
    getToken: async (): Promise<GithubIpcResult<string>> => {
      state.getTokenCalls += 1;
      return state.token
        ? { ok: true, value: state.token }
        : { ok: false, code: state.failCode, message: state.failMessage };
    },
    listAccess: async () => (state.token ? { ok: true, value: state.installations } : { ok: false, code: state.failCode, message: state.failMessage }),
    checkRepo: async (repo) => ({
      ok: true,
      value: state.installations.some((i) => i.repositories.some((r) => r.fullName.toLowerCase() === repo.toLowerCase()))
        ? { covered: true, installationId: 1, installUrl: null }
        : { covered: false, installationId: null, installUrl: 'https://github.com/apps/geode-rb-code-labs/installations/new' },
    }),
  };
  return { bridge, state };
}

function brokerFor(state = fakeBridge()) {
  const broker = new GithubCredentialBroker({ bridge: state.bridge, fetchProfile: async () => PROFILE });
  return { broker, ...state };
}

function sh(command: string, opts: { input?: string; env?: Record<string, string>; shell?: string } = {}) {
  const r = spawnSync(opts.shell ?? 'sh', ['-c', command], {
    input: opts.input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...(opts.env ?? {}) },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const CRED_INPUT = 'protocol=https\nhost=github.com\n\n';

// ── Broker: errors ────────────────────────────────────────────────────────────

describe('GithubCredentialBroker — actionable errors', () => {
  it('returns a token when connected', async () => {
    const { broker } = brokerFor();
    await expect(broker.getToken()).resolves.toBe(TOKEN_1);
  });

  it('reports "not connected" (with where to fix it) when Geode has no connection', async () => {
    const { broker } = brokerFor(fakeBridge({ token: null, status: { state: 'disconnected', encryptionAvailable: true } }));
    const err = await broker.getToken().catch((e) => e);
    expect(err).toBeInstanceOf(GithubConnectionError);
    expect(err.code).toBe('not_connected');
    expect(err.message).toContain('Settings → GitHub');
  });

  it('distinguishes a missing OS keychain from a plain disconnect', async () => {
    const { broker } = brokerFor(fakeBridge({ token: null, status: { state: 'disconnected', encryptionAvailable: false } }));
    expect((await broker.getToken().catch((e) => e)).code).toBe('keychain_unavailable');
  });

  it('reports expired/revoked authorization as reauth_required', async () => {
    const { broker } = brokerFor(fakeBridge({
      token: null,
      status: { state: 'reauth_required', message: 'GitHub sign-in expired.' },
    }));
    const err = await broker.getToken().catch((e) => e);
    expect(err.code).toBe('reauth_required');
    expect(err.message).toMatch(/expired or was revoked/);
    expect(err.message).toContain('reconnect');
  });

  it('maps a generic failure to request_failed without leaking a token', async () => {
    const { broker } = brokerFor(fakeBridge({
      token: null, failCode: 'unexpected', failMessage: 'GitHub API failed: HTTP 502',
    }));
    const err = await broker.getToken().catch((e) => e);
    expect(err.code).toBe('request_failed');
    expect(err.message).toContain('HTTP 502');
  });

  it('requireRepo throws repo_not_granted with the App install URL', async () => {
    const { broker } = brokerFor();
    await expect(broker.requireRepo('octo-user/SANDBOX')).resolves.toMatchObject({ covered: true });
    const err = await broker.requireRepo('octo-user/other').catch((e) => e);
    expect(err.code).toBe('repo_not_granted');
    expect(err.installUrl).toBe('https://github.com/apps/geode-rb-code-labs/installations/new');
    expect(err.message).toContain('octo-user/other');
    expect(err.message).toContain('installations/new');
  });

  it('throws "unavailable" everywhere when there is no Geode bridge (Obsidian)', async () => {
    const broker = new GithubCredentialBroker({ bridge: undefined });
    expect(broker.available).toBe(false);
    for (const call of [() => broker.getToken(), () => broker.listAccess(), () => broker.requireRepo('a/b')]) {
      expect((await call().catch((e) => e)).code).toBe('unavailable');
    }
    expect(await broker.status()).toBeNull();
  });

  it('resolveGithubBridge finds the Geode bridge and ignores hosts without it', () => {
    const { bridge } = fakeBridge();
    expect(resolveGithubBridge({ geode: { githubAuth: bridge } })).toBe(bridge);
    expect(resolveGithubBridge({})).toBeUndefined();
    expect(resolveGithubBridge({ geode: {} })).toBeUndefined();
    expect(resolveGithubBridge(undefined)).toBeUndefined();
  });

  it('listAccess summaries and repo-name validation expose names only', async () => {
    const { broker } = brokerFor();
    const summary = summarizeAccess(await broker.listAccess());
    expect(summary).toEqual([{ account: 'octo-user', repositories: ['octo-user/sandbox'] }]);
    expect(JSON.stringify(summary)).not.toContain(TOKEN_1);
    expect(isValidRepoFullName('octo/hello.world')).toBe(true);
    for (const bad of ['octo', 'octo/', '/x', 'a b/c', 'a/b/c', '-x/y', 'a/b;rm']) expect(isValidRepoFullName(bad), bad).toBe(false);
  });
});

// ── Commit identity ───────────────────────────────────────────────────────────

describe('commit identity (separate from authentication)', () => {
  it('uses the GitHub display name and the privacy-preserving noreply address by default', () => {
    expect(resolveCommitIdentity(PROFILE)).toEqual({
      name: 'Octo User',
      email: '4242+octo-user@users.noreply.github.com',
    });
    expect(noreplyEmail(PROFILE)).toBe('4242+octo-user@users.noreply.github.com');
  });

  it('falls back to the login when the profile has no name', () => {
    expect(resolveCommitIdentity({ ...PROFILE, name: null }).name).toBe('octo-user');
    expect(resolveCommitIdentity({ ...PROFILE, name: '  ' }).name).toBe('octo-user');
  });

  it('honours a valid override email and ignores a malformed one', () => {
    expect(resolveCommitIdentity(PROFILE, ' me@example.com ').email).toBe('me@example.com');
    expect(resolveCommitIdentity(PROFILE, 'not an email').email).toBe(noreplyEmail(PROFILE));
    expect(resolveCommitIdentity(PROFILE, '').email).toBe(noreplyEmail(PROFILE));
  });

  it('caches the profile and re-fetches after it is forgotten', async () => {
    const fetchProfile = vi.fn(async () => PROFILE);
    const broker = new GithubCredentialBroker({ bridge: fakeBridge().bridge, fetchProfile });
    expect(broker.cachedProfile()).toBeNull();
    await broker.getProfile();
    await broker.getProfile();
    expect(fetchProfile).toHaveBeenCalledTimes(1);
    expect(broker.cachedProfile()).toEqual(PROFILE);
    broker.forget();
    expect(broker.cachedProfile()).toBeNull();
  });
});

// ── Publisher: refresh + disconnect ───────────────────────────────────────────

describe('GithubTokenPublisher — refresh, expiry and disconnect', () => {
  function harness() {
    const fb = fakeBridge();
    const writes: string[] = [];
    let cleared = 0;
    const sink: TokenSink = {
      write: async (t) => { writes.push(t); },
      clear: async () => { cleared += 1; },
    };
    let tick: (() => void) | null = null;
    const clearIv = vi.fn();
    let now = 1_000_000;
    const publisher = new GithubTokenPublisher({
      broker: new GithubCredentialBroker({ bridge: fb.bridge }),
      sink,
      intervalMs: 240_000,
      now: () => now,
      setInterval: (fn) => { tick = fn; return 'timer'; },
      clearInterval: clearIv,
    });
    return { fb, writes, publisher, clearIv, cleared: () => cleared, tick: () => tick!(), advance: (ms: number) => { now += ms; } };
  }

  it('publishes on start and re-publishes the rotated token on every tick', async () => {
    const h = harness();
    expect(await h.publisher.start()).toEqual({ ok: true });
    expect(h.writes).toEqual([TOKEN_1]);
    h.fb.state.token = TOKEN_2; // Geode refreshed (8h expiry approaching)
    h.tick();
    await vi.waitFor(() => expect(h.writes).toEqual([TOKEN_1, TOKEN_2]));
  });

  it('ensureFresh skips a recent write and refreshes a stale one', async () => {
    const h = harness();
    await h.publisher.start();
    await h.publisher.ensureFresh(60_000);
    expect(h.fb.state.getTokenCalls).toBe(1);
    h.advance(61_000);
    h.fb.state.token = TOKEN_2;
    await h.publisher.ensureFresh(60_000);
    expect(h.writes.at(-1)).toBe(TOKEN_2);
  });

  it('deletes the published token when the connection is disconnected, and recovers on reconnect', async () => {
    const h = harness();
    await h.publisher.start();
    h.fb.state.token = null;
    h.fb.state.status = { state: 'disconnected', encryptionAvailable: true };
    const state = await h.publisher.refresh();
    expect(state.ok).toBe(false);
    expect(h.cleared()).toBe(1);
    expect(h.publisher.error?.code).toBe('not_connected');

    h.fb.state.token = TOKEN_2;
    h.fb.state.status = { state: 'connected', login: 'octo-user' };
    expect((await h.publisher.refresh()).ok).toBe(true);
    expect(h.publisher.error).toBeNull();
    expect(h.writes.at(-1)).toBe(TOKEN_2);
  });

  it('clears the token when authorization expires (reauth_required)', async () => {
    const h = harness();
    await h.publisher.start();
    h.fb.state.token = null;
    h.fb.state.status = { state: 'reauth_required', message: 'expired' };
    await h.publisher.refresh();
    expect(h.publisher.error?.code).toBe('reauth_required');
    expect(h.cleared()).toBe(1);
  });

  it('a sink failure is reported as an actionable error, not thrown', async () => {
    const fb = fakeBridge();
    const publisher = new GithubTokenPublisher({
      broker: new GithubCredentialBroker({ bridge: fb.bridge }),
      sink: { write: async () => { throw new Error('disk full'); }, clear: async () => undefined },
      setInterval: () => 't',
      clearInterval: () => undefined,
    });
    const state = await publisher.start();
    expect(state).toMatchObject({ ok: false });
    expect(publisher.error?.message).toContain('disk full');
  });

  it('stop() cancels the timer and deletes the token', async () => {
    const h = harness();
    await h.publisher.start();
    await h.publisher.stop();
    expect(h.clearIv).toHaveBeenCalledWith('timer');
    expect(h.cleared()).toBe(1);
  });

  it('is single-flight: concurrent refreshes make one bridge call', async () => {
    const h = harness();
    await Promise.all([h.publisher.refresh(), h.publisher.refresh(), h.publisher.refresh()]);
    expect(h.fb.state.getTokenCalls).toBe(1);
  });
});

// ── Redaction ─────────────────────────────────────────────────────────────────

describe('redactGithubSecrets', () => {
  it('masks GitHub token shapes and known secrets', () => {
    const out = redactGithubSecrets(`a ${TOKEN_1} b ghp_${'x'.repeat(30)} c github_pat_${'y'.repeat(30)} d custom-secret-value`, ['custom-secret-value']);
    expect(out).not.toContain(TOKEN_1);
    expect(out).not.toContain('ghp_x');
    expect(out).not.toContain('github_pat_y');
    expect(out).not.toContain('custom-secret-value');
    expect(out.match(/\[REDACTED\]/g)).toHaveLength(4);
  });

  it('leaves ordinary output alone', () => {
    expect(redactGithubSecrets('On branch main\nnothing to commit')).toBe('On branch main\nnothing to commit');
  });
});

// ── Helper scripts: executed for real ─────────────────────────────────────────

describe('git credential helper script', () => {
  function setup() {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'bin'));
    const helper = path.join(dir, GIT_HELPER_NAME);
    fs.writeFileSync(helper, buildGitHelperScript(dir), { mode: 0o700 });
    return { dir, helper, run: (input: string, verb = 'get') => sh(`${shellQuote(helper)} ${verb}`, { input }) };
  }

  it('serves x-access-token + the file contents for https github.com', () => {
    const { dir, run } = setup();
    fs.writeFileSync(path.join(dir, 'token'), TOKEN_1);
    const r = run(CRED_INPUT);
    expect(r.stdout).toBe(`username=x-access-token\npassword=${TOKEN_1}\n`);
    expect(r.status).toBe(0);
  });

  it('stays silent for other hosts, protocols and verbs (never leaks the token elsewhere)', () => {
    const { dir, run } = setup();
    fs.writeFileSync(path.join(dir, 'token'), TOKEN_1);
    expect(run('protocol=https\nhost=example.com\n\n').stdout).toBe('');
    expect(run('protocol=https\nhost=evil.github.com.attacker.io\n\n').stdout).toBe('');
    expect(run('protocol=http\nhost=github.com\n\n').stdout).toBe('');
    expect(run(CRED_INPUT, 'store').stdout).toBe('');
    expect(run(CRED_INPUT, 'erase').stdout).toBe('');
  });

  it('prints an actionable hint on stderr (and no credential) when no token is published', () => {
    const { run } = setup();
    const r = run(CRED_INPUT);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Connect GitHub in Geode');
  });
});

describe('gh wrapper script', () => {
  function setup(respectExistingAuth: boolean, opts: { loggedIn?: boolean } = {}) {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'gh'), buildGhWrapperScript(dir, respectExistingAuth), { mode: 0o700 });
    // A fake "real" gh that reports the token it was given.
    const real = tmp('ct-real-gh-');
    fs.writeFileSync(path.join(real, 'gh'), `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then ${opts.loggedIn ? 'echo existing-login-token; exit 0' : 'exit 1'}; fi
echo "GH_TOKEN=\${GH_TOKEN:-<unset>} ARGS=$*"
`, { mode: 0o755 });
    const run = (env: Record<string, string> = {}, args = 'pr list') =>
      sh(`gh ${args}`, { env: { PATH: `${path.join(dir, 'bin')}:${real}:${process.env.PATH}`, ...env } });
    return { dir, run };
  }

  it('runs the real gh with GH_TOKEN from the file, without touching the shell environment', () => {
    const { dir, run } = setup(false);
    fs.writeFileSync(path.join(dir, 'token'), TOKEN_1);
    expect(run().stdout.trim()).toBe(`GH_TOKEN=${TOKEN_1} ARGS=pr list`);
  });

  it('does not loop on itself and passes arguments through', () => {
    const { dir, run } = setup(false);
    fs.writeFileSync(path.join(dir, 'token'), TOKEN_1);
    expect(run({}, "api 'repos/x/y'").stdout).toContain("ARGS=api repos/x/y");
  });

  it('runs plain gh when no token is published', () => {
    const { run } = setup(false);
    expect(run().stdout.trim()).toBe('GH_TOKEN=<unset> ARGS=pr list');
  });

  it.each(['GH_TOKEN', 'GITHUB_TOKEN'])('yields to a user-provided %s', (name) => {
    const { dir, run } = setup(true);
    fs.writeFileSync(path.join(dir, 'token'), TOKEN_1);
    const out = run({ [name]: 'user-pat' }).stdout;
    expect(out).not.toContain(TOKEN_1);
    expect(out).toContain(name === 'GH_TOKEN' ? 'GH_TOKEN=user-pat' : 'GH_TOKEN=<unset>');
  });

  it('host mode yields to an existing `gh auth login`; container mode does not need to', () => {
    const host = setup(true, { loggedIn: true });
    fs.writeFileSync(path.join(host.dir, 'token'), TOKEN_1);
    expect(host.run().stdout.trim()).toBe('GH_TOKEN=<unset> ARGS=pr list'); // user's login wins

    const hostNoLogin = setup(true, { loggedIn: false });
    fs.writeFileSync(path.join(hostNoLogin.dir, 'token'), TOKEN_1);
    expect(hostNoLogin.run().stdout).toContain(`GH_TOKEN=${TOKEN_1}`);
  });
});

// ── Container install / write / clear commands: executed under bash ───────────

describe('container credential commands', () => {
  function env(home: string) {
    return { HOME: home };
  }

  it('installs helper, wrapper, git config and PATH; tokens flow only through stdin', () => {
    const home = tmp('ct-home-');
    const rt = path.join(tmp(), 'rt');
    const install = buildContainerInstallCommand({ dirCandidates: [rt], identity: { name: "Octo O'User", email: '4242+octo-user@users.noreply.github.com' } });
    expect(install).not.toContain(TOKEN_1);

    const r = sh(install, { shell: 'bash', env: env(home) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe(rt); // reports the resolved dir

    expect(fs.statSync(rt).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(rt, GIT_HELPER_NAME)).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(rt, GIT_HELPER_NAME), 'utf8')).not.toContain('__CT_DIR__');
    expect(fs.readFileSync(path.join(rt, 'bin', 'gh'), 'utf8')).toContain(`'${rt}/token'`);

    const gitconfig = fs.readFileSync(path.join(home, '.gitconfig'), 'utf8');
    expect(gitconfig).toContain(`helper = ${rt}/${GIT_HELPER_NAME}`);
    expect(gitconfig).toContain('name = Octo O\'User');
    expect(gitconfig).toContain('email = 4242+octo-user@users.noreply.github.com');
    expect(fs.readFileSync(path.join(home, '.profile'), 'utf8')).toContain(`export PATH="${rt}/bin:$PATH"`);

    // Write via stdin → 0600 file; then git itself resolves the credential through the helper.
    const write = sh(buildContainerWriteTokenCommand([rt]), { shell: 'bash', input: TOKEN_1, env: env(home) });
    expect(write.status, write.stderr).toBe(0);
    expect(fs.readFileSync(path.join(rt, 'token'), 'utf8')).toBe(TOKEN_1);
    expect(fs.statSync(path.join(rt, 'token')).mode & 0o777).toBe(0o600);
    const fill = sh('git credential fill', { input: CRED_INPUT, env: env(home) });
    expect(fill.stdout).toContain('username=x-access-token');
    expect(fill.stdout).toContain(`password=${TOKEN_1}`);

    // Refresh replaces atomically; clear deletes.
    sh(buildContainerWriteTokenCommand([rt]), { shell: 'bash', input: TOKEN_2, env: env(home) });
    expect(fs.readFileSync(path.join(rt, 'token'), 'utf8')).toBe(TOKEN_2);
    expect(fs.existsSync(path.join(rt, 'token.tmp'))).toBe(false);
    sh(buildContainerClearTokenCommand([rt]), { shell: 'bash', env: env(home) });
    expect(fs.existsSync(path.join(rt, 'token'))).toBe(false);
    expect(sh('git credential fill', { input: CRED_INPUT, env: env(home) }).stdout).not.toContain('password=');
  });

  it('is idempotent and never clobbers an identity the container already has', () => {
    const home = tmp('ct-home-');
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Preset\n\temail = preset@example.com\n');
    fs.writeFileSync(path.join(home, '.profile'), 'export KEEP=1\n');
    const rt = path.join(tmp(), 'rt');
    const cmd = buildContainerInstallCommand({ dirCandidates: [rt], identity: { name: 'Octo', email: 'x@y.z' } });
    for (let i = 0; i < 2; i++) expect(sh(cmd, { shell: 'bash', env: env(home) }).status).toBe(0);

    const gitconfig = fs.readFileSync(path.join(home, '.gitconfig'), 'utf8');
    expect(gitconfig).toContain('name = Preset');
    expect(gitconfig).not.toContain('Octo');
    expect(gitconfig.match(/helper = /g)).toHaveLength(1); // not duplicated
    const profile = fs.readFileSync(path.join(home, '.profile'), 'utf8');
    expect(profile).toContain('export KEEP=1');
    expect(profile.match(/>>> claude-threads github/g)).toHaveLength(1);
  });

  it('falls back through candidate dirs and fails clearly when none is writable', () => {
    const home = tmp('ct-home-');
    const good = path.join(tmp(), 'rt');
    const r = sh(buildContainerInstallCommand({ dirCandidates: ['/proc/definitely/not/writable', good] }), { shell: 'bash', env: env(home) });
    expect(r.stdout.trim()).toBe(good);
    const bad = sh(buildContainerInstallCommand({ dirCandidates: ['/proc/definitely/not/writable'] }), { shell: 'bash', env: env(home) });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('no writable runtime dir');
  });

  it('a login shell finds the wrapper ahead of the real gh', () => {
    const home = tmp('ct-home-');
    const rt = path.join(tmp(), 'rt');
    const real = tmp('ct-real-gh-');
    fs.writeFileSync(path.join(real, 'gh'), '#!/bin/sh\necho "GH_TOKEN=${GH_TOKEN:-<unset>}"\n', { mode: 0o755 });
    // macOS path_helper reorders PATH for login shells, so put the fake gh on PATH from the profile itself.
    fs.writeFileSync(path.join(home, '.profile'), `export PATH="${real}:$PATH"\n`);
    sh(buildContainerInstallCommand({ dirCandidates: [rt] }), { shell: 'bash', env: env(home) });
    fs.writeFileSync(path.join(rt, 'token'), TOKEN_1);
    const r = spawnSync('bash', ['-lc', 'gh x; echo "shell:${GH_TOKEN:-<unset>}"'], {
      encoding: 'utf8',
      env: { HOME: home, PATH: `${real}:${process.env.PATH}` },
    });
    expect(r.stdout).toContain(`GH_TOKEN=${TOKEN_1}`);
    expect(r.stdout).toContain('shell:<unset>'); // token is not in the long-lived shell env
  });
});

// ── Host delivery ─────────────────────────────────────────────────────────────

describe('host env construction', () => {
  it('appends after existing GIT_CONFIG entries and prefixes PATH', () => {
    const env = buildHostGitEnv({
      dir: '/rt',
      baseEnv: { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a', PATH: '/usr/bin' },
      identity: { name: 'N', email: 'e@x.y' },
    });
    expect(env.GIT_CONFIG_COUNT).toBe('5');
    expect(env.GIT_CONFIG_KEY_2).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_2).toBe(`/rt/${GIT_HELPER_NAME}`);
    expect(env.GIT_CONFIG_KEY_3).toBe('user.name');
    expect(env.GIT_CONFIG_KEY_4).toBe('user.email');
    expect(env.PATH).toBe('/rt/bin:/usr/bin');
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined(); // existing entries untouched
  });

  it('adds only the identity fields provided', () => {
    const env = buildHostGitEnv({ dir: '/rt', baseEnv: {}, identity: { email: 'e@x.y' } });
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(Object.values(env)).not.toContain('user.name');
  });
});

describe('GithubHostDelivery', () => {
  function delivery(over: { enabled?: boolean; gitConfig?: Record<string, string> } = {}) {
    const fb = fakeBridge();
    const broker = new GithubCredentialBroker({ bridge: fb.bridge, fetchProfile: async () => PROFILE });
    let tick: (() => void) | null = null;
    const base = tmp('ct-host-');
    let enabled = over.enabled ?? true;
    const d = new GithubHostDelivery({
      broker,
      isEnabled: () => enabled,
      tmpdir: () => base,
      gitConfigGet: (_cwd, key) => over.gitConfig?.[key],
      setInterval: (fn) => { tick = fn; return 't'; },
      clearInterval: () => undefined,
    });
    return { d, fb, base, tick: () => tick!(), setEnabled: (v: boolean) => { enabled = v; } };
  }

  it('publishes a 0600 token in a 0700 dir and resolves env without the token in it', async () => {
    const { d } = delivery();
    expect((await d.start())).toEqual({ ok: true });
    const dir = d.runtimeDir!;
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'token')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, 'token'), 'utf8')).toBe(TOKEN_1);

    const env = d.resolveEnv('/repo', { PATH: '/usr/bin' });
    expect(Object.values(env).join('\n')).not.toContain(TOKEN_1);
    expect(env.GIT_CONFIG_VALUE_0).toBe(`${dir}/${GIT_HELPER_NAME}`);
    expect(env.PATH.startsWith(`${dir}/bin:`)).toBe(true);
    // Identity: noreply by default, from the prefetched profile.
    expect(Object.values(env)).toContain('Octo User');
    expect(Object.values(env)).toContain('4242+octo-user@users.noreply.github.com');
  });

  it('git itself resolves the connection token through the env config', async () => {
    const { d } = delivery();
    await d.start();
    const home = tmp('ct-home-');
    const env = d.resolveEnv('/repo', { PATH: process.env.PATH });
    const fill = sh('git credential fill', { input: CRED_INPUT, env: { HOME: home, ...env } });
    expect(fill.stdout).toContain(`password=${TOKEN_1}`);
  });

  it('never overrides identity the repo already configures (each field independently)', async () => {
    const both = delivery({ gitConfig: { 'user.name': 'Me', 'user.email': 'me@x.y' } });
    await both.d.start();
    const e1 = both.d.resolveEnv('/repo', {});
    expect(Object.values(e1)).not.toContain('user.name');
    expect(Object.values(e1)).not.toContain('user.email');

    const nameOnly = delivery({ gitConfig: { 'user.name': 'Me' } });
    await nameOnly.d.start();
    const e2 = nameOnly.d.resolveEnv('/repo', {});
    expect(Object.values(e2)).not.toContain('user.name');
    expect(Object.values(e2)).toContain('user.email');
  });

  it('adds the helper AFTER existing credential helpers so manual credentials keep working', async () => {
    const { d } = delivery();
    await d.start();
    const home = tmp('ct-home-');
    // The user's own helper, configured through the same env mechanism (worst case for ordering).
    const user = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_0: '!printf "username=me\\npassword=my-own-pat\\n" #' };
    const env = d.resolveEnv('/repo', { ...user, PATH: process.env.PATH });
    const fill = sh('git credential fill', { input: CRED_INPUT, env: { HOME: home, ...user, ...env } });
    expect(fill.stdout).toContain('password=my-own-pat');
    expect(fill.stdout).not.toContain(TOKEN_1);
  });

  it('removes the token on disconnect (next refresh) and recovers after reconnect', async () => {
    const { d, fb, tick } = delivery();
    await d.start();
    const tokenFile = path.join(d.runtimeDir!, 'token');
    fb.state.token = null;
    fb.state.status = { state: 'disconnected', encryptionAvailable: true };
    tick();
    await vi.waitFor(() => expect(fs.existsSync(tokenFile)).toBe(false));
    expect(d.error?.code).toBe('not_connected');
    // Helper now hints instead of failing silently.
    const home = tmp('ct-home-');
    const fill = sh('git credential fill', { input: CRED_INPUT, env: { HOME: home, ...d.resolveEnv('/repo', { PATH: process.env.PATH }) } });
    expect(fill.stderr).toContain('Connect GitHub in Geode');

    fb.state.token = TOKEN_2;
    fb.state.status = { state: 'connected', login: 'octo-user' };
    tick();
    await vi.waitFor(() => expect(fs.readFileSync(tokenFile, 'utf8')).toBe(TOKEN_2));
  });

  it('stop() deletes the whole runtime dir; disabled or unstarted delivery adds nothing', async () => {
    const off = delivery({ enabled: false });
    expect(await off.d.start()).toBeNull();
    expect(off.d.resolveEnv('/repo', {})).toEqual({});

    const { d, setEnabled } = delivery();
    await d.start();
    const dir = d.runtimeDir!;
    setEnabled(false);
    expect(d.resolveEnv('/repo', {})).toEqual({}); // setting applies to the next session
    setEnabled(true);
    await d.stop();
    expect(fs.existsSync(dir)).toBe(false);
    expect(d.resolveEnv('/repo', {})).toEqual({});
  });

  it('is inert without a Geode bridge (Obsidian): no dir, no env', async () => {
    const d = new GithubHostDelivery({
      broker: new GithubCredentialBroker({ bridge: undefined }),
      isEnabled: () => true,
    });
    expect(await d.start()).toBeNull();
    expect(d.running).toBe(false);
    expect(d.resolveEnv('/repo', { PATH: '/x' })).toEqual({});
  });
});

// ── Container delivery through the sandbox VM ─────────────────────────────────

describe('sandbox VM GitHub delivery', () => {
  type Call = { args: string[]; input?: string };

  function vm(over: { enabled?: boolean; bridge?: ReturnType<typeof fakeBridge>; execExit?: Record<string, number> } = {}) {
    const fb = over.bridge ?? fakeBridge();
    const broker = new GithubCredentialBroker({ bridge: fb.bridge, fetchProfile: async () => PROFILE });
    const calls: Call[] = [];
    const run: VmCommandRunner = async (args, opts): Promise<VmCommandResult> => {
      calls.push({ args: [...args], input: opts.input });
      const joined = args.join(' ');
      if (args[0] === 'inspect') return { exitCode: 1, stdout: '', stderr: 'not found' };
      let exitCode = 0;
      for (const [needle, code] of Object.entries(over.execExit ?? {})) if (joined.includes(needle)) exitCode = code;
      return { exitCode, stdout: '', stderr: '' };
    };
    let tick: (() => void) | null = null;
    let enabled = over.enabled ?? true;
    const hooks = createGithubVmHooks({
      broker,
      isEnabled: () => enabled,
      now: () => 0,
      setInterval: (fn) => { tick = fn; return 'vm-timer'; },
      clearInterval: () => undefined,
    });
    const manager = new SandboxVmManager({ containerName: () => 'claude-threads-vm-t1', run, hooks });
    return { manager, calls, fb, tick: () => tick!(), setEnabled: (v: boolean) => { enabled = v; } };
  }
  const bash = (c: Call) => c.args.at(-1) ?? '';
  const enterArgs = { image: 'img:2', mountPath: '/host/wt', network: 'default' as const };

  it('enter installs helper/config with commit identity and publishes the token over stdin only', async () => {
    const { manager, calls } = vm();
    const res = await manager.enter(enterArgs);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.notes?.join('\n')).toContain('GitHub connected as octo-user');

    const installs = calls.filter((c) => bash(c).includes('git-credential-claude-threads') && bash(c).includes('umask 077'));
    expect(installs.length).toBeGreaterThan(0);
    expect(bash(installs[0]!)).toContain('4242+octo-user@users.noreply.github.com');
    expect(bash(installs[0]!)).toContain('Octo User');

    const writes = calls.filter((c) => c.input !== undefined);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.input).toBe(TOKEN_1);
    expect(writes[0]!.args).toContain('--interactive'); // stdin attached
    // The token never appears in any argv, anywhere.
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(TOKEN_1);
    // …and nothing is written under /work.
    expect(JSON.stringify(calls.map((c) => c.args))).not.toMatch(/\/work\/(token|\.gh)/);
  });

  it('the run command does not carry credentials (no --env, no token)', async () => {
    const { manager, calls } = vm();
    await manager.enter(enterArgs);
    const run = calls.find((c) => c.args[0] === 'run')!;
    expect(run.args.join(' ')).not.toMatch(/--env|GH_TOKEN|GITHUB_TOKEN|ghu_/);
  });

  it('refreshes the rotated token before a command and again on the timer (long-running threads)', async () => {
    const { manager, calls, fb, tick } = vm();
    await manager.enter(enterArgs);
    fb.state.token = TOKEN_2;
    tick(); // background refresh while a long command runs
    await vi.waitFor(() => expect(calls.filter((c) => c.input === TOKEN_2)).toHaveLength(1));
    fb.state.token = 'ghu_' + 'c'.repeat(36);
    // Fake clock is frozen at 0, so use the tick path; ensureFresh's fast path is covered in the publisher tests.
    tick();
    await vi.waitFor(() => expect(calls.filter((c) => c.input?.startsWith('ghu_c'))).toHaveLength(1));
    const exec = await manager.execCommand({ command: 'git push', timeoutSeconds: 30 });
    expect(exec.success).toBe(true);
  });

  it('when disconnected: enter still succeeds, a note explains how to fix it, and the token file is deleted', async () => {
    const fb = fakeBridge();
    const { manager, calls } = vm({ bridge: fb });
    await manager.enter(enterArgs);
    fb.state.token = null;
    fb.state.status = { state: 'disconnected', encryptionAvailable: true };
    const before = calls.length;
    const first = await manager.execCommand({ command: 'git fetch', timeoutSeconds: 30 });
    const second = await manager.execCommand({ command: 'git fetch', timeoutSeconds: 30 });
    expect(first.success && first.notes?.join('\n')).toContain('Settings → GitHub');
    expect(second.success && second.notes).toBeUndefined(); // reported once, not on every command
    const cleared = calls.slice(before).filter((c) => bash(c).includes('rm -f'));
    expect(cleared.length).toBeGreaterThan(0);
    expect(first.success && first.exitCode).toBe(0); // the command itself still ran
  });

  it('enter on a not-connected account gives an actionable note instead of failing the VM', async () => {
    const { manager } = vm({ bridge: fakeBridge({ token: null, status: { state: 'reauth_required', message: 'x' } }) });
    const res = await manager.enter(enterArgs);
    expect(res.success).toBe(true);
    expect(res.success && res.notes?.join('\n')).toMatch(/expired or was revoked/);
  });

  it('warns (git still works) when the image has no gh', async () => {
    const { manager } = vm({ execExit: { 'command -v gh': 1 } });
    const res = await manager.enter(enterArgs);
    expect(res.success && res.notes?.join('\n')).toContain('claude-threads-coding:1');
  });

  it('exit deletes the token before the container is stopped and removed', async () => {
    const { manager, calls } = vm();
    await manager.enter(enterArgs);
    await manager.exit();
    const order = calls.map((c) => (bash(c).includes('rm -f') ? 'clear' : c.args[0]));
    const clearIdx = order.lastIndexOf('clear');
    expect(clearIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeLessThan(order.indexOf('stop'));
    expect(clearIdx).toBeLessThan(order.indexOf('rm'));
  });

  it('adopts a container after a reload: re-installs, re-publishes, then runs the command', async () => {
    const { calls, fb } = vm();
    const broker = new GithubCredentialBroker({ bridge: fb.bridge, fetchProfile: async () => PROFILE });
    const run: VmCommandRunner = async (args, opts) => {
      calls.push({ args: [...args], input: opts.input });
      const joined = args.join(' ');
      if (args[0] === 'inspect') return { exitCode: 0, stdout: '', stderr: '' };
      if (joined.includes('[ -x')) return { exitCode: 1, stdout: '', stderr: '' }; // helper missing → install
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const manager = new SandboxVmManager({
      containerName: () => 'claude-threads-vm-t1',
      run,
      hooks: createGithubVmHooks({ broker, isEnabled: () => true, setInterval: () => 't', clearInterval: () => undefined }),
    });
    const res = await manager.execCommand({ command: 'gh pr list', timeoutSeconds: 30 });
    expect(res.success).toBe(true);
    expect(calls.some((c) => bash(c).includes('umask 077') && bash(c).includes('git config --global'))).toBe(true);
    expect(calls.filter((c) => c.input === TOKEN_1)).toHaveLength(1);
  });

  it('is fully inert when disabled or on a host without the connection (existing behavior preserved)', async () => {
    const off = vm({ enabled: false });
    const res = await off.manager.enter(enterArgs);
    expect(res.success && res.notes).toBeUndefined();
    expect(off.calls.every((c) => c.input === undefined && !bash(c).includes('claude-threads-github'))).toBe(true);

    const noBridge = new GithubCredentialBroker({ bridge: undefined });
    const calls: string[] = [];
    const manager = new SandboxVmManager({
      containerName: () => 'claude-threads-vm-t2',
      run: async (args) => { calls.push(args.join(' ')); return args[0] === 'inspect' ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }; },
      hooks: createGithubVmHooks({ broker: noBridge, isEnabled: () => true }),
    });
    const r = await manager.enter(enterArgs);
    expect(r.success && r.notes).toBeUndefined();
    expect(calls.join('\n')).not.toContain('claude-threads-github');
  });

  it('a manager built with no hooks behaves exactly as before', async () => {
    const calls: string[] = [];
    const manager = new SandboxVmManager({
      containerName: () => 'claude-threads-vm-t3',
      run: async (args) => { calls.push(args.join(' ')); return args[0] === 'inspect' ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: 'ok', stderr: '' }; },
    });
    const r = await manager.enter(enterArgs);
    expect(r.success && r.notes).toBeUndefined();
    const e = await manager.execCommand({ command: 'echo hi', timeoutSeconds: 5 });
    expect(e.success && e.notes).toBeUndefined();
  });
});
