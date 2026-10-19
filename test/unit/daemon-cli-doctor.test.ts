import { describe, expect, it } from 'vitest';
import {
  checkClaude, checkHarnessCli, checkClockSkew, checkCredentials, checkDataDir, checkDisk, checkListen, checkNode, checkTailscale, checkTokens,
  checkWorkspaces, doctorExitCode, formatReport, resolveDoctorTarget, runChecks, summarize, type CheckResult, type CommandResult, type HealthResult, type Probes,
} from '../../daemon/cmd/doctor';
import { sha256Hex } from '../../daemon/tokenStore';

const GIB = 1024 ** 3;

function probes(over: Partial<Probes> & { files?: Record<string, string>; cmds?: Record<string, CommandResult>; stats?: Record<string, { mode: number; uid: number; isDirectory: boolean }> } = {}): Probes {
  const { files = {}, cmds = {}, stats = {}, ...rest } = over;
  const missing: CommandResult = { ok: false, stdout: '', stderr: 'ENOENT' };
  return {
    nodeVersion: 'v22.11.0', platform: 'linux', uid: 1000, env: {}, home: '/home/user', now: () => 1_000_000,
    run: async (cmd, args) => cmds[`${cmd} ${args.join(' ')}`.trim()] ?? cmds[cmd] ?? missing,
    stat: (p) => stats[p] ?? (files[p] !== undefined ? { mode: 0o600, uid: 1000, isDirectory: false } : null),
    readFile: (p) => files[p] ?? null,
    readDir: () => null,
    disk: () => ({ freeBytes: 50 * GIB, totalBytes: 100 * GIB }),
    canWrite: () => true,
    findClaude: () => '/home/user/.local/bin/claude',
    findHarness: (h) => `/home/user/.local/bin/${h}`,
    health: async () => ({ reachable: true, status: 200, body: '{"ok":true,"protocol":1}', serverTime: 1_000_000 }),
    ...rest,
  };
}
const ok = (stdout: string): CommandResult => ({ ok: true, stdout, stderr: '' });

describe('doctor checks', () => {
  it('node: fails below 22', () => {
    expect(checkNode(probes({ nodeVersion: 'v20.5.0' })).status).toBe('fail');
    expect(checkNode(probes({ nodeVersion: 'v22.0.0' })).status).toBe('pass');
    expect(checkNode(probes({ nodeVersion: 'weird' })).status).toBe('warn');
  });

  it('claude: fail with an install hint when missing, warn when --version fails, pass otherwise', async () => {
    const missing = await checkClaude(probes({ findClaude: () => null }));
    expect(missing).toMatchObject({ status: 'fail' });
    expect(missing.fix).toMatch(/claude\.ai\/install\.sh/);
    expect((await checkClaude(probes())).status).toBe('warn');
    expect(await checkClaude(probes({ cmds: { '/home/user/.local/bin/claude --version': ok('2.1.0 (Claude Code)\n') } }))).toMatchObject({ status: 'pass', detail: expect.stringContaining('2.1.0') });
  });

  it('codex / opencode: a missing CLI is a warning with an install hint, never a failure', async () => {
    for (const h of ['codex', 'opencode'] as const) {
      const missing = await checkHarnessCli(probes({ findHarness: () => null }), h);
      expect(missing).toMatchObject({ id: h, status: 'warn' });
      expect(missing.fix).toMatch(new RegExp(`${h}.*(npm i -g|installed)`));
      expect(missing.fix).toContain(`--${h}-binary`);
      expect((await checkHarnessCli(probes({ findHarness: () => null }), h, '/x/nope')).detail).toMatch(/is not an executable/);
      expect((await checkHarnessCli(probes(), h)).status).toBe('warn'); // present, --version fails
      expect(await checkHarnessCli(probes({ cmds: { [`/home/user/.local/bin/${h} --version`]: ok('1.2.3\n') } }), h)).toMatchObject({ status: 'pass', detail: expect.stringContaining('1.2.3') });
    }
  });

  it('runChecks only checks the harnesses in the allowed set', async () => {
    const target = (harnesses?: Array<'claude' | 'codex' | 'opencode'>) => ({ dataDir: '/d', listen: '127.0.0.1', port: 7433, baseUrl: 'http://127.0.0.1:7433', workspaces: ['/srv/w'], credentialFiles: [], ...(harnesses ? { harnesses } : {}) });
    const ids = async (h?: Array<'claude' | 'codex' | 'opencode'>) => (await runChecks(probes(), target(h))).map((r) => r.id).filter((id) => ['claude', 'codex', 'opencode'].includes(id));
    expect(await ids()).toEqual(['claude', 'codex', 'opencode']);
    expect(await ids(['codex'])).toEqual(['codex']);
    expect(await ids(['claude', 'opencode'])).toEqual(['claude', 'opencode']);
  });

  it('resolveDoctorTarget reads the harness set and binary paths like serve does', () => {
    const t = (env: NodeJS.ProcessEnv, files: Record<string, string> = {}) => resolveDoctorTarget({ dataDir: '/d' }, probes({ env, files }));
    expect(t({}).harnesses).toEqual(['claude', 'codex', 'opencode']);
    expect(t({ AGENT_THREADS_HARNESS: 'codex' }).harnesses).toEqual(['codex']);
    expect(t({ AGENT_THREADS_HARNESSES: 'opencode,claude' }).harnesses).toEqual(['opencode', 'claude']);
    expect(t({}, { '/d/config.json': JSON.stringify({ harnesses: ['codex'], codexBinaryPath: '/opt/codex' }) })).toMatchObject({ harnesses: ['codex'], codexBinaryPath: '/opt/codex' });
    expect(t({ AGENT_THREADS_OPENCODE_BINARY: '/o/oc' }).opencodeBinaryPath).toBe('/o/oc');
  });

  it('disk: warns under 5 GiB and fails under 500 MiB', () => {
    const at = (free: number) => checkDisk(probes({ disk: () => ({ freeBytes: free, totalBytes: 500 * GIB }) }), [{ label: 'data', path: '/d' }])[0].status;
    expect(at(100 * GIB)).toBe('pass');
    expect(at(2 * GIB)).toBe('warn');
    expect(at(100 * 1024 ** 2)).toBe('fail');
    expect(checkDisk(probes({ disk: () => null }), [{ label: 'x', path: '/nope' }])[0].status).toBe('skip');
  });

  it('clock: compares against the daemon Date header with a second of slack', () => {
    const h = (serverTime: number): HealthResult => ({ reachable: true, status: 200, serverTime });
    expect(checkClockSkew(probes(), h(1_000_000 + 900), null).status).toBe('pass');
    expect(checkClockSkew(probes(), h(1_000_000 + 30_000), null).status).toBe('warn');
    expect(checkClockSkew(probes(), h(1_000_000 - 300_000), null).status).toBe('fail');
    expect(checkClockSkew(probes(), null, false).status).toBe('warn');
    expect(checkClockSkew(probes(), null, true).status).toBe('pass');
    expect(checkClockSkew(probes(), null, null).status).toBe('skip');
  });

  it('credentials: finds env, systemd credential, env file, or an existing login; never prints a value', () => {
    expect(checkCredentials(probes({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sekret' } }), []).detail).not.toContain('sekret');
    expect(checkCredentials(probes({ env: { CREDENTIALS_DIRECTORY: '/c' }, files: { '/c/claude-token': 'tok\n' } }), []).status).toBe('pass');
    const viaFile = checkCredentials(probes({ files: { '/etc/agent-threads/env': '# c\nCLAUDE_CODE_OAUTH_TOKEN=abc123\n' } }), ['/etc/agent-threads/env']);
    expect(viaFile).toMatchObject({ status: 'pass' });
    expect(viaFile.detail).not.toContain('abc123');
    expect(checkCredentials(probes({ files: { '/etc/agent-threads/env': '#CLAUDE_CODE_OAUTH_TOKEN=\n' } }), ['/etc/agent-threads/env']).status).toBe('fail');
    expect(checkCredentials(probes({ stats: { '/home/user/.claude/.credentials.json': { mode: 0o600, uid: 1000, isDirectory: false } } }), []).status).toBe('pass');
    expect(checkCredentials(probes(), []).status).toBe('fail');
    expect(checkCredentials(probes({ platform: 'darwin' }), []).status).toBe('warn');
    // .claude.json alone (CLI installed, never signed in) is not a credential.
    expect(checkCredentials(probes({ stats: { '/home/user/.claude.json': { mode: 0o600, uid: 1000, isDirectory: false } } }), []).status).toBe('fail');
  });

  it('listen: warns on wildcard and non-loopback, passes loopback; reports whether the daemon answers', async () => {
    const t = (listen: string) => ({ dataDir: '/d', listen, port: 7433, baseUrl: 'http://127.0.0.1:7433', workspaces: [], credentialFiles: [] });
    expect((await checkListen(probes(), t('0.0.0.0'))).listen.status).toBe('warn');
    expect((await checkListen(probes(), t('100.64.0.5'))).listen.status).toBe('warn');
    const loop = await checkListen(probes(), t('127.0.0.1'));
    expect(loop.listen.status).toBe('pass');
    expect(loop.running.status).toBe('pass');
    expect((await checkListen(probes({ health: async () => ({ reachable: false, error: 'ECONNREFUSED' }) }), t('127.0.0.1'))).running.status).toBe('warn');
    expect((await checkListen(probes({ health: async () => ({ reachable: true, status: 404, body: 'nope' }) }), t('127.0.0.1'))).running.status).toBe('fail');
  });

  it('data dir: permissions decide pass / warn / fail', () => {
    const dir = (mode: number, uid = 1000) => checkDataDir(probes({ stats: { '/d': { mode, uid, isDirectory: true } } }), '/d')[0];
    expect(dir(0o700).status).toBe('pass');
    expect(dir(0o750).status).toBe('warn');
    expect(dir(0o770).status).toBe('fail');
    expect(dir(0o700, 0).status).toBe('warn');
    expect(checkDataDir(probes(), '/d')[0].status).toBe('warn');
    const loose = checkDataDir(probes({ stats: { '/d': { mode: 0o700, uid: 1000, isDirectory: true }, '/d/tokens.json': { mode: 0o644, uid: 1000, isDirectory: false } } }), '/d');
    expect(loose.find((r) => r.id === 'perm-tokens.json')?.status).toBe('fail');
  });

  it('tokens: missing, damaged, none active, and a stale local CLI token', () => {
    const rec = (token: string, revoked = false) => ({ id: 'x', name: 'n', sha256: sha256Hex(token), scopes: ['control'], createdAt: 1, lastUsedAt: null, revokedAt: revoked ? 5 : null });
    expect(checkTokens(probes(), '/d')[0].status).toBe('warn');
    expect(checkTokens(probes({ files: { '/d/tokens.json': '{not json' } }), '/d')[0].status).toBe('fail');
    expect(checkTokens(probes({ files: { '/d/tokens.json': JSON.stringify([rec('a', true)]) } }), '/d')[0].status).toBe('warn');
    const good = checkTokens(probes({ files: { '/d/tokens.json': JSON.stringify([rec('a')]), '/d/cli-token': 'a\n' } }), '/d');
    expect(good.map((r) => r.status)).toEqual(['pass', 'pass']);
    const stale = checkTokens(probes({ files: { '/d/tokens.json': JSON.stringify([rec('a')]), '/d/cli-token': 'zzz\n' } }), '/d');
    expect(stale[1]).toMatchObject({ id: 'cli-token', status: 'warn' });
  });

  it('workspaces: none, missing, unwritable', () => {
    expect(checkWorkspaces(probes(), []).status).toBe('warn');
    expect(checkWorkspaces(probes(), ['/srv/w']).status).toBe('warn');
    const here = { '/srv/w': { mode: 0o755, uid: 1000, isDirectory: true } };
    expect(checkWorkspaces(probes({ stats: here }), ['/srv/w']).status).toBe('pass');
    expect(checkWorkspaces(probes({ stats: here, canWrite: () => false }), ['/srv/w']).status).toBe('warn');
  });

  it('tailscale: skip when absent, warn when down or not serving, pass when serving', async () => {
    expect((await checkTailscale(probes(), 7433)).status).toBe('skip');
    const up = ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail1234.ts.net.' } }));
    expect((await checkTailscale(probes({ cmds: { 'tailscale status --json': ok('{"BackendState":"Stopped"}') } }), 7433)).status).toBe('warn');
    const idle = await checkTailscale(probes({ cmds: { 'tailscale status --json': up, 'tailscale serve status': ok('No serve config') } }), 7433);
    expect(idle).toMatchObject({ status: 'warn' });
    expect(idle.fix).toContain('box.tail1234.ts.net');
    const serving = await checkTailscale(probes({ cmds: { 'tailscale status --json': up, 'tailscale serve status': ok('https://box.tail1234.ts.net:8443 (tailnet only)\n|-- / proxy http://127.0.0.1:7433\n') } }), 7433);
    expect(serving.status).toBe('pass');
  });
});

describe('doctor summary and exit code', () => {
  const r = (status: CheckResult['status']): CheckResult => ({ id: status, status, title: status, detail: 'd', ...(status === 'fail' || status === 'warn' ? { fix: 'do this' } : {}) });
  it('exits 1 only on a failure, or on a warning with --strict; skips never count', () => {
    expect(doctorExitCode([r('pass'), r('skip')], false)).toBe(0);
    expect(doctorExitCode([r('pass'), r('warn')], false)).toBe(0);
    expect(doctorExitCode([r('pass'), r('warn')], true)).toBe(1);
    expect(doctorExitCode([r('pass'), r('fail')], false)).toBe(1);
    expect(summarize([r('pass'), r('warn'), r('fail'), r('skip')])).toEqual({ pass: 1, warn: 1, fail: 1, skip: 1 });
  });
  it('prints a fix line under warnings and failures only', () => {
    const out = formatReport([r('pass'), r('warn'), r('fail')], '1.2.3');
    expect(out[0]).toBe('agent-threads doctor 1.2.3');
    expect(out.filter((l) => l.includes('fix: do this'))).toHaveLength(2);
    expect(out.at(-1)).toBe('1 passed, 1 warning, 1 failed');
  });
});

describe('doctor target and full run', () => {
  it('resolves flags > env > config.json > defaults without creating anything', () => {
    const p = probes({ env: { AGENT_THREADS_PORT: '9000' }, files: { '/d/config.json': '{"listen":"100.64.0.5","port":8000,"workspaces":["~/w"]}' }, stats: { '/d': { mode: 0o700, uid: 1000, isDirectory: true } } });
    const t = resolveDoctorTarget({ dataDir: '/d' }, p);
    expect(t).toMatchObject({ dataDir: '/d', port: 9000, listen: '100.64.0.5', baseUrl: 'http://100.64.0.5:9000', workspaces: ['/home/user/w'] });
    expect(resolveDoctorTarget({ dataDir: '/d', url: 'wss://box.ts.net:8443/v1/ws' }, p).baseUrl).toBe('https://box.ts.net:8443');
    expect(resolveDoctorTarget({ dataDir: '/nowhere', listen: '0.0.0.0' }, probes()).baseUrl).toBe('http://127.0.0.1:7433');
  });
  it('a healthy fabricated machine has no failures', async () => {
    const stats = { '/d': { mode: 0o700, uid: 1000, isDirectory: true }, '/srv/w': { mode: 0o755, uid: 1000, isDirectory: true } };
    const cmds = { git: ok('git version 2.43.0'), rg: ok('ripgrep 14.1'), gh: ok('gh version 2.40'), 'gh auth status': ok('Logged in'), '/home/user/.local/bin/claude': ok('2.1.0'), timedatectl: ok('yes\n') };
    const results = await runChecks(probes({ stats, cmds, env: { ANTHROPIC_API_KEY: 'x' }, files: { '/d/tokens.json': JSON.stringify([{ id: 'a', sha256: 'b'.repeat(64), scopes: ['control'], revokedAt: null }]) } }), { dataDir: '/d', listen: '127.0.0.1', port: 7433, baseUrl: 'http://127.0.0.1:7433', workspaces: ['/srv/w'], credentialFiles: [] });
    expect(results.filter((r) => r.status === 'fail')).toEqual([]);
    expect(doctorExitCode(results, false)).toBe(0);
  });
});
