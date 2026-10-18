/**
 * The managed local daemon's session extras end to end, with everything real except the container itself:
 *
 *   plugin side  LocalDaemonSessionPrep  (environment + keychain secrets, skills, AWS)
 *      -> `container exec ...` (faked: the SAME argv is executed against the real daemon CLI / the real copy script
 *         with /var/lib/agent-threads mapped onto a temp data directory)
 *   daemon side  creds store, session policy, ClaudeSessionDriver -> HarnessSessionOptions (scripted harness)
 *
 * Proves: secrets reach the agent's process through the credential store and never through the spec; skills reach
 * the session as plugin paths; a forged spec cannot name another credential kind or a path outside the skills folder.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, type Io } from '../../daemon/cli';
import { createClaudeDriverFactory, sessionEnvFromCreds } from '../../daemon/claudeDriver';
import { CredStore } from '../../daemon/credStore';
import type { VmCommandResult, VmCommandRunner } from '../../src/containerCli';
import { nodeFs } from '../../src/localDaemon/containerFiles';
import { LocalDaemonSessionPrep } from '../../src/localDaemon/sessionPrep';
import { DATA_MOUNT, containerNameFor, sessionEnvKind } from '../../src/localDaemon/spec';
import { TestClient, sleep, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';
import { ScriptedHarness, scriptedFactory } from '../helpers/scriptedHarness';

const VAULT = '/Users/me/Vault';
const NAME = containerNameFor(VAULT);
const sha1 = (t: string) => createHash('sha1').update(t).digest('hex');

let workspace: string;
let dataDir: string;
let host: string; // the "Mac" side: skills and aws files
let made: ScriptedHarness[];
let td: TestDaemon;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'extras-ws-')));
  mkdirSync(join(workspace, 'proj'));
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'extras-data-')));
  host = realpathSync(mkdtempSync(join(tmpdir(), 'extras-host-')));
  made = [];
  const creds = new CredStore(dataDir);
  td = await startTestDaemon({
    dataDir,
    config: { harness: 'claude', workspaces: [workspace] },
    driverFactory: createClaudeDriverFactory({
      createHarness: scriptedFactory(made),
      env: {},
      creds,
      sessionEnv: (spec) => sessionEnvFromCreds(creds, spec),
    }),
  });
  cleanups.push(() => td.cleanup());
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const d of [workspace, dataDir, host]) rmSync(d, { recursive: true, force: true });
});

const toHost = (p: string): string => p.replace(DATA_MOUNT, dataDir);

/** `container exec ... <cmd>` executed against the real daemon CLI, the real copy script and the temp data dir. */
function fakeContainer(): VmCommandRunner {
  return async (args, opts): Promise<VmCommandResult> => {
    let i = 1;
    const interactive = args[i] === '-i';
    if (interactive) i += 1;
    i += 2; // --user UID
    expect(args[i]).toBe(NAME);
    const cmd = args.slice(i + 1);
    if (cmd[0] === 'test') return { exitCode: existsSync(toHost(cmd[2])) ? 0 : 1, stdout: '', stderr: '' };
    if (cmd[0] === 'sh') {
      const m = /ls -1 '(.*)'/.exec(cmd[2]);
      const dir = toHost(m![1]);
      const r = spawnSync('ls', ['-1', dir], { encoding: 'utf8' });
      return { exitCode: 0, stdout: r.status === 0 ? r.stdout : '', stderr: '' };
    }
    if (cmd[0] === 'rm') { rmSync(toHost(cmd[2]), { recursive: true, force: true }); return { exitCode: 0, stdout: '', stderr: '' }; }
    if (cmd[0] === 'node') {
      const payload = JSON.parse(opts.input ?? '{}');
      payload.dest = toHost(payload.dest);
      const r = spawnSync(process.execPath, ['-e', cmd[2], dataDir], { input: JSON.stringify(payload), encoding: 'utf8' });
      return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    }
    expect(cmd[0]).toBe('agent-threads');
    const argv = cmd.slice(1).map((a, n, all) => (all[n - 1] === '--url' ? td.daemon.url : all[n - 1] === '--data-dir' ? dataDir : a));
    let out = ''; let err = '';
    const io: Io = { out: (l) => { out += `${l}\n`; }, err: (l) => { err += `${l}\n`; }, write: (t) => { out += t; }, writeErr: (t) => { err += t; } };
    const code = await runCli(argv, io, {
      env: {}, stdinIsTTY: false, cwd: '/tmp', onInterrupt: () => () => {},
      ...(interactive ? { stdin: Readable.from([opts.input ?? '']) as unknown as NodeJS.ReadableStream } : {}),
    });
    return { exitCode: code, stdout: out, stderr: err };
  };
}

function prep(over: { env?: Record<string, string>; plugins?: string[]; awsProfiles?: string[] } = {}) {
  return new LocalDaemonSessionPrep({
    vaultPath: () => VAULT,
    runner: () => fakeContainer(),
    resolveEnv: () => over.env ?? {},
    skillPlugins: () => (over.plugins ?? []).map((path) => ({ type: 'local' as const, path })),
    homeDir: () => host,
    awsProfiles: () => over.awsProfiles ?? [],
    fs: nodeFs(),
    awsFs: { readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } }, sha1Hex: sha1 },
  });
}

async function client(): Promise<TestClient> {
  const c = await TestClient.connect(td.daemon.url, td.adminToken);
  cleanups.push(() => c.close().catch(() => {}));
  return c;
}
const spec = (over: Record<string, unknown> = {}) => ({ harness: 'claude', cwd: join(workspace, 'proj'), permissionMode: 'default', extraEnvRaw: '', model: 'haiku', ...over });
const harness = async (n = 0): Promise<ScriptedHarness> => {
  for (let i = 0; i < 100 && !made[n]?.options; i++) await sleep(5);
  return made[n];
};

describe('keychain secrets and Extra environment variables', () => {
  it('reach the agent process through the credential store; the spec carries only the kind name', async () => {
    const p = prep({ env: { LINEAR_API_KEY: 'lin_secret_value_123', AWS_PROFILE: 'deploy', PATH: '/mac/path' } });
    const extras = await p.prepare('proj-1');
    expect(extras.envKind).toBe(sessionEnvKind('proj-1'));

    const c = await client();
    const openSpec = spec({ envKind: extras.envKind });
    expect(JSON.stringify(openSpec)).not.toContain('lin_secret_value_123');
    expect((await c.cmd('session.open', { threadId: 't', spec: openSpec })).type).toBe('ack');
    const o = (await harness()).options!;
    expect(o.secretEnv).toMatchObject({ LINEAR_API_KEY: 'lin_secret_value_123', AWS_PROFILE: 'deploy' });
    expect(o.secretEnv).not.toHaveProperty('PATH');

    // At rest: the daemon's own credential store (0600), never config.json or the journal.
    const stored = JSON.parse(readFileSync(join(dataDir, 'creds', `${extras.envKind}.json`), 'utf8'));
    expect(stored.fields.LINEAR_API_KEY).toBe('lin_secret_value_123');
    expect(stored.expiresAt - Date.now()).toBeGreaterThan(23 * 3600_000);
    const journals = spawnSync('grep', ['-rl', 'lin_secret_value_123', dataDir], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    expect(journals.map((f) => f.replace(dataDir, ''))).toEqual([`/creds/${extras.envKind}.json`]);
  });

  it('a spec cannot name another credential kind (github, mcp, ...) as its environment', async () => {
    new CredStore(dataDir).push('github', 0, { GH_TOKEN: 'ghu_should_not_leak' });
    const c = await client();
    // Shape validation refuses it at the door...
    expect(await c.cmd('session.open', { threadId: 'bad', spec: spec({ envKind: 'github' }) })).toMatchObject({ type: 'err' });
    // ...and an envKind that is well formed but unknown simply adds nothing.
    expect((await c.cmd('session.open', { threadId: 'ok', spec: spec({ envKind: 'sessenv-nobody' }) })).type).toBe('ack');
    const o = (await harness()).options!;
    expect(JSON.stringify(o.secretEnv ?? {})).not.toContain('ghu_should_not_leak');
  });

  it('a pushed value is redacted from the daemon\'s logs by the known-secrets provider', async () => {
    await prep({ env: { K: 'sekrit-value-xyz-987654' } }).prepare('p');
    expect(new CredStore(dataDir).secretValues()).toContain('sekrit-value-xyz-987654');
  });
});

describe('skills', () => {
  it('are copied into the data volume and reach the session as plugin paths', async () => {
    mkdirSync(join(host, 'plug/skills/hello'), { recursive: true });
    writeFileSync(join(host, 'plug/skills/hello/SKILL.md'), '# hello skill');
    const p = prep({ plugins: [join(host, 'plug')] });
    const extras = await p.prepare(undefined);
    expect(extras.pluginPaths).toHaveLength(1);
    expect(extras.pluginPaths[0].startsWith(`${DATA_MOUNT}/skills/`)).toBe(true);
    expect(readFileSync(join(toHost(extras.pluginPaths[0]), 'skills/hello/SKILL.md'), 'utf8')).toBe('# hello skill');

    const c = await client();
    const hostPaths = extras.pluginPaths.map(toHost);
    expect((await c.cmd('session.open', { threadId: 't', spec: spec({ pluginPaths: hostPaths }) })).type).toBe('ack');
    const o = (await harness()).options!;
    expect(o.claude?.sessionOptions?.plugins).toEqual(hostPaths.map((path) => ({ type: 'local', path })));
  });

  it('a forged spec cannot load plugins from outside the skills folder', async () => {
    mkdirSync(join(host, 'evil'), { recursive: true });
    const c = await client();
    const inside = join(dataDir, 'skills', 'ok-1');
    mkdirSync(inside, { recursive: true });
    await c.cmd('session.open', { threadId: 't', spec: spec({ pluginPaths: [join(host, 'evil'), join(dataDir, 'skills', '..', 'creds'), `${dataDir}/skills-sibling/x`, inside] }) });
    const o = (await harness()).options!;
    expect(o.claude?.sessionOptions?.plugins).toEqual([{ type: 'local', path: inside }]);
  });

  it('copies ~/.claude/skills into the daemon user home', async () => {
    mkdirSync(join(host, '.claude/skills/mine'), { recursive: true });
    writeFileSync(join(host, '.claude/skills/mine/SKILL.md'), '# mine');
    await prep().prepare(undefined);
    expect(readFileSync(join(dataDir, 'home/.claude/skills/mine/SKILL.md'), 'utf8')).toBe('# mine');
  });
});

describe('AWS', () => {
  it('copies a trimmed config and exactly the SSO session token, and sends the metadata-off variable', async () => {
    mkdirSync(join(host, '.aws/sso/cache'), { recursive: true });
    writeFileSync(join(host, '.aws/config'), '[profile deploy]\nsso_session = corp\nregion = us-east-1\naws_secret_access_key = nope\n\n[sso-session corp]\nsso_start_url = https://c.example/s\nsso_region = us-east-1\n');
    writeFileSync(join(host, '.aws/sso/cache', `${sha1('corp')}.json`), '{"accessToken":"AT"}');
    writeFileSync(join(host, '.aws/sso/cache', `${sha1('another')}.json`), '{"accessToken":"OTHER"}');
    const extras = await prep({ env: { AWS_PROFILE: 'deploy', CLAUDE_CODE_USE_BEDROCK: '1' }, awsProfiles: ['deploy'] }).prepare('p');

    expect(readFileSync(join(dataDir, 'home/.aws/config'), 'utf8')).toContain('[profile deploy]');
    expect(readFileSync(join(dataDir, 'home/.aws/config'), 'utf8')).not.toContain('nope');
    expect(readFileSync(join(dataDir, 'home/.aws/sso/cache', `${sha1('corp')}.json`), 'utf8')).toBe('{"accessToken":"AT"}');
    expect(existsSync(join(dataDir, 'home/.aws/sso/cache', `${sha1('another')}.json`))).toBe(false);

    const c = await client();
    await c.cmd('session.open', { threadId: 't', spec: spec({ envKind: extras.envKind }) });
    const o = (await harness()).options!;
    expect(o.secretEnv).toMatchObject({ AWS_PROFILE: 'deploy', CLAUDE_CODE_USE_BEDROCK: '1', AWS_EC2_METADATA_DISABLED: 'true' });
  });
});
