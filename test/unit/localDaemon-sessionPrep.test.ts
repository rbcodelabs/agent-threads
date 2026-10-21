/**
 * Preparing the managed daemon for a session: environment + keychain secrets (creds push), skills, AWS.
 * The container CLI is faked; the daemon-side half is covered by test/integration/daemon-session-extras.test.ts.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { VmCommandResult, VmCommandRunner } from '../../src/containerCli';
import type { AwsCopyFs } from '../../src/localDaemon/awsCopy';
import type { FsLike } from '../../src/localDaemon/containerFiles';
import { LocalDaemonSessionPrep, forwardableEnv, type SessionPrepDeps } from '../../src/localDaemon/sessionPrep';
import {
  AWS_HOME_DIR,
  CLAUDE_HOME_DIR,
  SESSION_ENV_TTL_SEC,
  SKILLS_DIR,
  cliTokenPresentArgs,
  containerNameFor,
  credsPushArgs,
  credsRemoveArgs,
  sessionEnvKind,
} from '../../src/localDaemon/spec';

const VAULT = '/Users/me/Vault';
const NAME = containerNameFor(VAULT);
const sha1 = (t: string) => createHash('sha1').update(t).digest('hex');

interface Call { args: string[]; input?: string }

/** A host file tree: path -> content; a path ending with '/' is a directory. */
function treeFs(files: Record<string, string>): FsLike {
  const dirs = new Set<string>();
  for (const p of Object.keys(files)) { let d = p; while ((d = d.slice(0, d.lastIndexOf('/'))) ) dirs.add(d); }
  return {
    realpath: (p) => { if (dirs.has(p) || p in files) return p; throw new Error('ENOENT'); },
    readdir: (p) => {
      const names = new Set<string>();
      for (const f of Object.keys(files)) if (f.startsWith(`${p}/`)) names.add(f.slice(p.length + 1).split('/')[0]);
      return [...names];
    },
    stat: (p) => (dirs.has(p) ? { dir: true, file: false, size: 0, mtimeMs: 0, mode: 0o755 }
      : p in files ? { dir: false, file: true, size: files[p].length, mtimeMs: 1, mode: 0o644 } : null),
    readBase64: (p) => Buffer.from(files[p]).toString('base64'),
  };
}

function fixture(over: {
  env?: Record<string, string>;
  files?: Record<string, string>;
  plugins?: string[];
  awsProfiles?: string[];
  awsFiles?: Record<string, string>;
  existingSkillDirs?: string[];
  copyExit?: number;
  cliTokenPresent?: boolean;
} = {}) {
  const calls: Call[] = [];
  const run: VmCommandRunner = async (args, opts): Promise<VmCommandResult> => {
    calls.push({ args: [...args], input: opts.input });
    const ok: VmCommandResult = { exitCode: 0, stdout: '', stderr: '' };
    if (args.join(' ') === cliTokenPresentArgs(NAME).join(' ')) return { ...ok, exitCode: over.cliTokenPresent === false ? 1 : 0 };
    if (args.some((a) => a.startsWith('ls -1'))) return { ...ok, stdout: (over.existingSkillDirs ?? []).join('\n') };
    if (args.includes('node') && over.copyExit) return { exitCode: over.copyExit, stdout: '', stderr: 'boom' };
    return ok;
  };
  const awsFs: AwsCopyFs = { readFile: (p) => over.awsFiles?.[p] ?? null, sha1Hex: sha1 };
  let now = 1_000_000;
  const logs: string[] = [];
  const deps: SessionPrepDeps = {
    vaultPath: () => VAULT,
    runner: () => run,
    resolveEnv: () => over.env ?? {},
    skillPlugins: () => (over.plugins ?? []).map((path) => ({ type: 'local' as const, path })),
    homeDir: () => '/Users/me',
    awsProfiles: () => over.awsProfiles ?? [],
    fs: treeFs(over.files ?? {}),
    awsFs,
    now: () => now,
    log: (m) => logs.push(m),
  };
  return { prep: new LocalDaemonSessionPrep(deps), calls, logs, advance: (ms: number) => { now += ms; } };
}

const pushes = (calls: Call[]) => calls.filter((c) => c.args.includes('creds') && c.args.includes('--stdin'));
const copies = (calls: Call[]) => calls.filter((c) => c.args.includes('node'));
const argvOf = (calls: Call[]) => JSON.stringify(calls.map((c) => c.args));

describe('forwardableEnv', () => {
  it('drops this Mac shell\'s own variables, invalid names and empty values; keeps provider and secret variables', () => {
    expect(forwardableEnv({
      PATH: '/opt/homebrew/bin', HOME: '/Users/me', USER: 'me', SHELL: '/bin/zsh', TMPDIR: '/var/x', LANG: 'en_US.UTF-8', LC_ALL: 'x', DYLD_LIBRARY_PATH: '/x', _: '/bin/env',
      AWS_PROFILE: 'deploy', AWS_REGION: 'eu-west-1', CLAUDE_CODE_USE_BEDROCK: '1', LINEAR_API_KEY: 'lin_secret', EMPTY: '', 'bad name': 'x', '1BAD': 'x',
    })).toEqual({ AWS_PROFILE: 'deploy', AWS_REGION: 'eu-west-1', CLAUDE_CODE_USE_BEDROCK: '1', LINEAR_API_KEY: 'lin_secret' });
  });
});

describe('session environment (keychain secrets and Extra environment variables)', () => {
  it('pushes them as a credential kind named by project, over stdin only, and returns just the name', async () => {
    const f = fixture({ env: { LINEAR_API_KEY: 'lin_secret_value', AWS_PROFILE: 'deploy', PATH: '/mac/path' } });
    const extras = await f.prep.prepare('Proj-123');
    expect(extras.envKind).toBe('sessenv-proj-123');
    const [push] = pushes(f.calls);
    expect(push.args).toEqual(credsPushArgs(NAME, 'sessenv-proj-123', SESSION_ENV_TTL_SEC));
    expect(JSON.parse(push.input!)).toEqual({ LINEAR_API_KEY: 'lin_secret_value', AWS_PROFILE: 'deploy' });
    expect(argvOf(f.calls)).not.toContain('lin_secret_value');
    expect(f.logs.join('\n')).not.toContain('lin_secret_value');
    expect(extras.warnings).toEqual([]);
    expect(JSON.stringify(extras)).not.toContain('lin_secret_value');
  });

  it('adds EC2-metadata-off when AWS profiles are exposed, and skips an identical re-push until it is old', async () => {
    const f = fixture({ env: { AWS_PROFILE: 'deploy' }, awsProfiles: ['deploy'] });
    await f.prep.prepare('p');
    expect(JSON.parse(pushes(f.calls)[0].input!)).toEqual({ AWS_PROFILE: 'deploy', AWS_EC2_METADATA_DISABLED: 'true' });
    await f.prep.prepare('p');
    expect(pushes(f.calls)).toHaveLength(1);
    f.advance(7 * 60 * 60_000);
    await f.prep.prepare('p');
    expect(pushes(f.calls)).toHaveLength(2);
  });

  it('a changed secret is pushed again; secrets of different projects go to different kinds', async () => {
    let env: Record<string, string> = { K: 'one' };
    const calls: Call[] = [];
    const run: VmCommandRunner = async (args, opts) => { calls.push({ args: [...args], input: opts.input }); return { exitCode: 0, stdout: '', stderr: '' }; };
    const prep = new LocalDaemonSessionPrep({
      vaultPath: () => VAULT, runner: () => run, resolveEnv: () => env, skillPlugins: () => [], homeDir: () => '/h',
      awsProfiles: () => [], fs: treeFs({}), awsFs: { readFile: () => null, sha1Hex: sha1 },
    });
    await prep.prepare('a');
    env = { K: 'two' };
    await prep.prepare('a');
    await prep.prepare('b');
    const kinds = pushes(calls).map((c) => c.args[c.args.indexOf('push') + 1]);
    expect(kinds).toEqual(['sessenv-a', 'sessenv-a', 'sessenv-b']);
  });

  it('sends nothing (and no envKind) when there is nothing to send, and removes a kind that became empty', async () => {
    let env: Record<string, string> = { K: 'v' };
    const calls: Call[] = [];
    const run: VmCommandRunner = async (args, opts) => { calls.push({ args: [...args], input: opts.input }); return { exitCode: 0, stdout: '', stderr: '' }; };
    const prep = new LocalDaemonSessionPrep({
      vaultPath: () => VAULT, runner: () => run, resolveEnv: () => env, skillPlugins: () => [], homeDir: () => '/h',
      awsProfiles: () => [], fs: treeFs({}), awsFs: { readFile: () => null, sha1Hex: sha1 },
    });
    await prep.prepare('p');
    env = { PATH: '/only/mac' };
    const extras = await prep.prepare('p');
    expect(extras.envKind).toBeUndefined();
    expect(calls.some((c) => c.args.join(' ') === credsRemoveArgs(NAME, 'sessenv-p').join(' '))).toBe(true);
  });

  it('stop() deletes what it pushed', async () => {
    const f = fixture({ env: { K: 'v' } });
    await f.prep.prepare('p');
    await f.prep.stop();
    expect(f.calls.some((c) => c.args.join(' ') === credsRemoveArgs(NAME, 'sessenv-p').join(' '))).toBe(true);
  });

  it('sessionEnvKind produces names the daemon accepts', () => {
    for (const id of [undefined, 'Proj_A', 'x'.repeat(100), '!!!', 'a b/c']) {
      expect(sessionEnvKind(id)).toMatch(/^sessenv-[a-z0-9_-]{1,56}$/);
    }
    expect(sessionEnvKind(undefined)).toBe('sessenv-none');
  });
});

describe('skills', () => {
  const files = {
    '/skills/orch/SKILL.md': '# orch',
    '/skills/orch/scripts/go.sh': 'echo',
    '/home-skills/x': '',
    '/Users/me/.claude/skills/mine/SKILL.md': '# mine',
    '/Users/me/.claude/agents/rev.md': '# reviewer',
  };

  it('copies each plugin directory once under a fingerprinted name and returns the guest paths', async () => {
    const f = fixture({ files, plugins: ['/skills/orch', '/skills/orch', '/nonexistent'] });
    const extras = await f.prep.prepare(undefined);
    expect(extras.pluginPaths).toHaveLength(1);
    expect(extras.pluginPaths[0]).toMatch(new RegExp(`^${SKILLS_DIR}/skills-orch-[0-9a-f]{12}$`));
    const copy = copies(f.calls).find((c) => JSON.parse(c.input!).dest === extras.pluginPaths[0])!;
    expect(JSON.parse(copy.input!).files.map((x: { p: string }) => x.p).sort()).toEqual(['SKILL.md', 'scripts/go.sh']);
  });

  it('does not copy again when the directory (same fingerprint) is already in the volume', async () => {
    const first = fixture({ files, plugins: ['/skills/orch'] });
    const { pluginPaths } = await first.prep.prepare(undefined);
    const dirName = pluginPaths[0].split('/').pop()!;
    const again = fixture({ files, plugins: ['/skills/orch'], existingSkillDirs: [dirName] });
    const extras = await again.prep.prepare(undefined);
    expect(extras.pluginPaths).toEqual(pluginPaths);
    expect(copies(again.calls).filter((c) => JSON.parse(c.input!).dest.startsWith(SKILLS_DIR))).toHaveLength(0);
  });

  it('an edited skill gets a new directory name', async () => {
    const a = await fixture({ files, plugins: ['/skills/orch'] }).prep.prepare(undefined);
    const b = await fixture({ files: { ...files, '/skills/orch/SKILL.md': '# orch changed' }, plugins: ['/skills/orch'] }).prep.prepare(undefined);
    expect(a.pluginPaths[0]).not.toBe(b.pluginPaths[0]);
  });

  it('copies ~/.claude/skills and ~/.claude/agents into the daemon user home, once while unchanged', async () => {
    const f = fixture({ files, plugins: [] });
    await f.prep.prepare(undefined);
    const dests = copies(f.calls).map((c) => JSON.parse(c.input!).dest);
    expect(dests).toEqual([`${CLAUDE_HOME_DIR}/skills`, `${CLAUDE_HOME_DIR}/agents`]);
    await f.prep.prepare(undefined);
    expect(copies(f.calls)).toHaveLength(2);
  });
});

describe('AWS', () => {
  const home = '/Users/me';
  const config = '[profile deploy]\nsso_session = corp\nregion = us-east-1\n\n[sso-session corp]\nsso_start_url = https://c.example/s\nsso_region = us-east-1\n';
  const awsFiles = { [`${home}/.aws/config`]: config, [`${home}/.aws/sso/cache/${sha1('corp')}.json`]: '{"accessToken":"AT"}' };

  it('copies a trimmed config and the session token into the daemon user home', async () => {
    const f = fixture({ awsProfiles: ['deploy'], awsFiles });
    await f.prep.prepare(undefined);
    const aws = copies(f.calls).find((c) => JSON.parse(c.input!).dest === AWS_HOME_DIR)!;
    const body = JSON.parse(aws.input!);
    expect(body.clean).toBe(true);
    expect(body.files.map((x: { p: string }) => x.p).sort()).toEqual(['config', `sso/cache/${sha1('corp')}.json`]);
    expect(argvOf(f.calls)).not.toContain(Buffer.from('{"accessToken":"AT"}').toString('base64'));
  });

  it('re-copies after the refresh interval or when the token changed, and not otherwise', async () => {
    const f = fixture({ awsProfiles: ['deploy'], awsFiles });
    await f.prep.prepare(undefined);
    await f.prep.prepare(undefined);
    expect(copies(f.calls).filter((c) => JSON.parse(c.input!).dest === AWS_HOME_DIR)).toHaveLength(1);
    f.advance(6 * 60_000);
    await f.prep.prepare(undefined);
    expect(copies(f.calls).filter((c) => JSON.parse(c.input!).dest === AWS_HOME_DIR)).toHaveLength(2);
  });

  it('removes the copied files when the profiles are no longer exposed', async () => {
    let profiles = ['deploy'];
    const f = fixture({ awsFiles });
    // Same fixture but with a mutable profile list.
    const calls: Call[] = [];
    const run: VmCommandRunner = async (args, opts) => { calls.push({ args: [...args], input: opts.input }); return { exitCode: 0, stdout: '', stderr: '' }; };
    const prep = new LocalDaemonSessionPrep({
      vaultPath: () => VAULT, runner: () => run, resolveEnv: () => ({}), skillPlugins: () => [], homeDir: () => home,
      awsProfiles: () => profiles, fs: treeFs({}), awsFs: { readFile: (p) => awsFiles[p as keyof typeof awsFiles] ?? null, sha1Hex: sha1 },
    });
    void f;
    await prep.prepare(undefined);
    profiles = [];
    await prep.prepare(undefined);
    expect(calls.some((c) => c.args.join(' ') === ['exec', '--user', '10001', NAME, 'rm', '-rf', AWS_HOME_DIR].join(' '))).toBe(true);
  });

  it('does nothing without exposed profiles', async () => {
    const f = fixture({ awsProfiles: [], awsFiles });
    await f.prep.prepare(undefined);
    expect(copies(f.calls).some((c) => JSON.parse(c.input!).dest === AWS_HOME_DIR)).toBe(false);
  });
});

describe('failure handling', () => {
  it('never throws: a failing part is reported as a warning and the others still run', async () => {
    const f = fixture({ env: { K: 'v' }, files: { '/s/p/SKILL.md': '#' }, plugins: ['/s/p'], copyExit: 2 });
    const extras = await f.prep.prepare('p');
    expect(extras.envKind).toBe('sessenv-p');
    expect(extras.pluginPaths).toEqual([]);
    expect(extras.warnings.join('\n')).toContain('skills');
    expect(f.logs.join('\n')).toContain('skills not delivered');
  });

  it('does nothing when there is no vault (so no local daemon)', async () => {
    const prep = new LocalDaemonSessionPrep({
      vaultPath: () => null, runner: () => { throw new Error('must not run'); }, resolveEnv: () => ({ K: 'v' }),
      skillPlugins: () => [], homeDir: () => '/h', awsProfiles: () => [], fs: treeFs({}), awsFs: { readFile: () => null, sha1Hex: sha1 },
    });
    expect(await prep.prepare('p')).toEqual({ pluginPaths: [], warnings: [] });
  });

  it('a fresh data volume (no saved admin token) clears the caches so everything is delivered again', async () => {
    const f = fixture({ env: { K: 'v' }, cliTokenPresent: false });
    await f.prep.prepare('p');
    // Mint-token path ran: list + create; the push still happened.
    expect(pushes(f.calls)).toHaveLength(1);
  });
});

describe('a data volume that is reset while the app stays open', () => {
  it('has everything delivered again on the next session (the in-memory caches are dropped)', async () => {
    const over = { env: { K: 'v' }, files: { '/s/p/SKILL.md': '#' }, plugins: ['/s/p'], awsProfiles: [] as string[], cliTokenPresent: true, existingSkillDirs: [] as string[] };
    const f = fixture(over);
    await f.prep.prepare(undefined);
    const firstPushes = pushes(f.calls).length;
    const firstCopies = copies(f.calls).length;
    expect(firstPushes).toBe(1);
    // Unchanged volume: nothing is sent twice.
    await f.prep.prepare(undefined);
    expect(pushes(f.calls)).toHaveLength(firstPushes);
    // Reset: the saved admin token (and with it everything else) is gone.
    over.cliTokenPresent = false;
    await f.prep.prepare(undefined);
    expect(pushes(f.calls).length).toBeGreaterThan(firstPushes);
    expect(copies(f.calls).length).toBeGreaterThan(firstCopies);
  });
});
