/**
 * End to end for the GitHub-token fallback (PR #803), through the daemon's PRODUCTION wiring.
 *
 * Unlike `daemon-repos.test.ts`, no `driverFactory` is injected: `startDaemon` builds the real
 * `createClaudeDriverFactory` itself (ReposManager.sessionEnv + createGhAuthPreflight, server.ts), so a regression
 * in that wiring is caught here. What is faked is only the two executables:
 *
 *   - `claude` (claudeBinaryPath): a shell script that records the environment it was spawned with, echoes its
 *     GH_TOKEN to stderr when asked (to prove the redactor), and exits. It does not speak the SDK protocol, so the
 *     session errors out after start; every assertion here is about start-up, which is what #803 changes.
 *   - `gh`: first on PATH. `gh auth status` succeeds only when GH_TOKEN is in its environment (the "gh auth login"
 *     failure otherwise). HOME / XDG / GH_CONFIG_DIR point at an empty temp dir so no real login can leak in.
 *
 * "The agent runs gh" is therefore: execute the fake `gh` with exactly the environment the fake `claude` was
 * spawned with. No network, no real token. The clock is the daemon's injectable `now`, so expiry is deterministic.
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GH_AUTH_NOTICE } from '../../daemon/ghPreflight';
import { TestClient, sleep, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';
import { tempDir } from '../helpers/gitFixtures';

const PUSHED = 'ghp_PUSHEDTOKEN_aaaaaaaaaaaaaaaaaaaa1111';
const FROM_ENV = 'ghp_DAEMONENVTOKEN_bbbbbbbbbbbbbbbbbb2222';

const FAKE_GH = `#!/bin/sh
# Fake gh: only "--version" and "auth status" are modelled. Never prints the token, only whether one is present.
if [ "$1" = "--version" ]; then echo "gh version 0.0.0-fake"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ -n "$GH_TOKEN" ]; then echo "Logged in to github.com (GH_TOKEN present)"; exit 0; fi
  echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2
  exit 1
fi
echo "fake gh: unsupported: $*" >&2
exit 2
`;

const FAKE_CLAUDE = `#!/bin/sh
# Fake claude: record the spawn environment (one file per process), optionally leak the token on stderr, exit.
env > "$FAKE_CLAUDE_OUT/$$.env"
[ -n "$FAKE_CLAUDE_ECHO_TOKEN" ] && echo "boom: token was $GH_TOKEN" >&2
exit 1
`;

let root: string;
let dataDir: string;
let workspace: string;
let outDir: string;
let clock: number;
const cleanups: Array<() => Promise<void>> = [];

function script(path: string, body: string): string {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  root = tempDir('gh-fallback-');
  dataDir = join(root, 'data');
  workspace = join(root, 'ws');
  outDir = join(root, 'claude-env');
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  for (const d of [dataDir, join(workspace, 'proj'), outDir, bin, home]) mkdirSync(d, { recursive: true });
  script(join(bin, 'gh'), FAKE_GH);
  clock = 1_800_000_000_000;

  // Process-global on purpose: the daemon reads process.env for the agent, the doctor probe and the redactor.
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
  vi.stubEnv('GH_CONFIG_DIR', join(home, '.config', 'gh'));
  vi.stubEnv('GH_TOKEN', '');
  vi.stubEnv('GITHUB_TOKEN', '');
  vi.stubEnv('FAKE_CLAUDE_OUT', outDir);
  vi.stubEnv('FAKE_CLAUDE_ECHO_TOKEN', '');
  // The daemon must not pick up a real Claude login either; the fake claude ignores it anyway.
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-fake-not-a-secret');
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function startDaemon(): Promise<{ td: TestDaemon; c: TestClient }> {
  const td = await startTestDaemon({
    dataDir,
    now: () => clock,
    config: { harness: 'claude', workspaces: [workspace], claudeBinaryPath: script(join(root, 'claude'), FAKE_CLAUDE) },
  });
  cleanups.push(() => td.cleanup());
  const c = await TestClient.connect(td.daemon.url, td.adminToken);
  cleanups.push(() => c.close().catch(() => {}));
  return { td, c };
}

const spec = { harness: 'claude', cwd: '', permissionMode: 'default', extraEnvRaw: '' };

/** Open a session and wait until the (fake) claude process has recorded its environment. */
async function openSession(c: TestClient, threadId: string): Promise<Record<string, string>> {
  const before = new Set(readdirSync(outDir));
  const reply = await c.cmd('session.open', { threadId, spec: { ...spec, cwd: join(workspace, 'proj') } });
  expect(reply.type, JSON.stringify(reply)).toBe('ack');
  await c.cmd('attach', { ch: `t:${threadId}`, afterSeq: 0 });
  // The SDK spawns claude when the session starts its first query; poll for the one new env file.
  for (let i = 0; i < 400; i++) {
    const fresh = readdirSync(outDir).filter((f) => !before.has(f));
    if (fresh.length) {
      await sleep(20); // let the script finish writing
      return parseEnv(readFileSync(join(outDir, fresh[0]), 'utf8'));
    }
    await sleep(10);
  }
  throw new Error(`fake claude never spawned for ${threadId}; frames: ${JSON.stringify(c.frames.slice(-5))}`);
}

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** What the agent would get from `gh auth status`, run with exactly the environment the agent was spawned with. */
function agentGh(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'status'], { env: { PATH: env.PATH, HOME: env.HOME, GH_CONFIG_DIR: env.GH_CONFIG_DIR, ...(env.GH_TOKEN ? { GH_TOKEN: env.GH_TOKEN } : {}) } }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number) ?? 1 : 0, out: `${stdout}${stderr}` });
    });
  });
}

const notices = (c: TestClient, threadId: string) =>
  c.events().filter((f) => f.name === 'onNotification' && f.ch === `t:${threadId}`);

async function settle(): Promise<void> { await sleep(150); }

/** Every file the daemon wrote that holds `needle`; `creds/` is the one place a pushed value legitimately lives. */
function filesContaining(needle: string): string[] {
  const hits: string[] = [];
  const scan = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (p !== join(dataDir, 'creds')) scan(p); }
      else if (readFileSync(p, 'utf8').includes(needle)) hits.push(p);
    }
  };
  scan(dataDir);
  return hits;
}

describe('GitHub token fallback when the pushed credential expires', () => {
  it('uses the pushed token while it is live, with no notice and a working gh', async () => {
    vi.stubEnv('GH_TOKEN', FROM_ENV); // present too: the pushed credential must still win
    const { c } = await startDaemon();
    expect(await c.cmd('creds.push', { kind: 'github', ttlSec: 1, fields: { GH_TOKEN: PUSHED } })).toMatchObject({ type: 'ack' });

    const env = await openSession(c, 'a');

    expect(env.GH_TOKEN).toBe(PUSHED);
    expect(env.AGENT_THREADS_GIT_PASSWORD).toBe(PUSHED);
    expect((await agentGh(env)).code).toBe(0);
    await settle();
    expect(notices(c, 'a')).toHaveLength(0);
  });

  it('(a) falls back to the daemon env GH_TOKEN after the pushed credential expires: no notice, gh succeeds', async () => {
    vi.stubEnv('GH_TOKEN', FROM_ENV);
    const { c } = await startDaemon();
    await c.cmd('creds.push', { kind: 'github', ttlSec: 1, fields: { GH_TOKEN: PUSHED } });
    expect((await openSession(c, 'a')).GH_TOKEN).toBe(PUSHED);

    clock += 5_000; // past the 1s TTL
    const env = await openSession(c, 'b');

    expect(env.GH_TOKEN).toBe(FROM_ENV);
    expect(env.AGENT_THREADS_GIT_PASSWORD).toBe(FROM_ENV);
    expect(env.GH_TOKEN).not.toBe(PUSHED);
    expect(await agentGh(env)).toMatchObject({ code: 0 });
    await settle();
    expect(notices(c, 'b')).toHaveLength(0);
  });

  it('(a) also falls back to GITHUB_TOKEN, handing the agent GH_TOKEN for gh', async () => {
    vi.stubEnv('GITHUB_TOKEN', FROM_ENV);
    const { c } = await startDaemon();
    await c.cmd('creds.push', { kind: 'github', ttlSec: 1, fields: { GH_TOKEN: PUSHED } });
    clock += 5_000;

    const env = await openSession(c, 'b');

    expect(env.GH_TOKEN).toBe(FROM_ENV);
    expect((await agentGh(env)).code).toBe(0);
  });

  it('(b) with no env token, an expired credential yields exactly one high-priority notice and gh fails with "gh auth login"', async () => {
    const { c } = await startDaemon();
    await c.cmd('creds.push', { kind: 'github', ttlSec: 1, fields: { GH_TOKEN: PUSHED } });
    const envA = await openSession(c, 'a');
    expect(envA.GH_TOKEN).toBe(PUSHED);
    await settle();
    expect(notices(c, 'a')).toHaveLength(0); // the live credential suppresses the notice

    clock += 5_000;
    const envB = await openSession(c, 'b');
    await settle();

    expect(envB.GH_TOKEN ?? '').toBe('');
    const gh = await agentGh(envB);
    expect(gh.code).not.toBe(0);
    expect(gh.out).toContain('gh auth login');
    const got = notices(c, 'b');
    expect(got).toHaveLength(1);
    expect(got[0].args).toEqual([GH_AUTH_NOTICE, 'high']);
  });

  it('(b) the notice is once per session, not once per daemon: a second session gets its own, a first never repeats', async () => {
    const { c } = await startDaemon();
    await openSession(c, 'a');
    await openSession(c, 'b');
    await settle();
    expect(notices(c, 'a')).toHaveLength(1);
    expect(notices(c, 'b')).toHaveLength(1);
  });

  it('never writes either token value to the wire, journal, raw logs or audit log', async () => {
    vi.stubEnv('GH_TOKEN', FROM_ENV);
    const { td, c } = await startDaemon();
    await c.cmd('creds.push', { kind: 'github', ttlSec: 1, fields: { GH_TOKEN: PUSHED } });
    await openSession(c, 'a'); // spawned with the pushed token
    clock += 5_000;
    await openSession(c, 'b'); // spawned with the env token
    await settle();

    const wire = JSON.stringify(c.frames);
    expect(wire).not.toContain(PUSHED);
    expect(wire).not.toContain(FROM_ENV);
    await td.cleanup(); // flush the journal before scanning the data dir
    cleanups.length = 0;
    expect(filesContaining(PUSHED)).toEqual([]);
    expect(filesContaining(FROM_ENV)).toEqual([]);
  });

  // BUG (pre-existing, not introduced by #803, but #803 registers the env token with the redactor in good faith):
  // the daemon registers secrets with setKnownSecretsProvider, yet nothing on the event path (onError -> journal ->
  // wire) calls redactSecrets, so an agent process that echoes GH_TOKEN on stderr leaks it verbatim into the
  // journal and to every attached client. Remove `.fails` when error events are redacted.
  it.fails('KNOWN GAP: redacts a token the agent process echoes on stderr before it is journaled or sent', async () => {
    vi.stubEnv('GH_TOKEN', FROM_ENV);
    vi.stubEnv('FAKE_CLAUDE_ECHO_TOKEN', '1'); // fake claude prints "boom: token was $GH_TOKEN" on stderr
    const { c } = await startDaemon();
    await c.cmd('creds.push', { kind: 'github', ttlSec: 1, fields: { GH_TOKEN: PUSHED } });
    await openSession(c, 'a');
    clock += 5_000;
    await openSession(c, 'b');
    await settle();
    const wire = JSON.stringify(c.frames);
    expect(wire).not.toContain(PUSHED);
    expect(wire).not.toContain(FROM_ENV);
  });

  describe('mid-session', () => {
    it('KNOWN GAP (characterization): a token pushed after a session started does not reach that session, only later ones', async () => {
      const { c } = await startDaemon();
      const envA = await openSession(c, 'a'); // no token anywhere yet
      expect(envA.GH_TOKEN ?? '').toBe('');

      await c.cmd('creds.push', { kind: 'github', ttlSec: 0, fields: { GH_TOKEN: PUSHED } });

      // The agent's environment is fixed when its process is spawned; session A keeps failing until it restarts.
      expect((await agentGh(envA)).code).not.toBe(0);
      const envB = await openSession(c, 'b');
      expect(envB.GH_TOKEN).toBe(PUSHED);
      await settle();
      // And A's "auth unavailable" notice is never retracted or followed up by a "fixed now" message.
      expect(notices(c, 'a')).toHaveLength(1);
    });

    it.todo('a GitHub token pushed (or an env token resolved) after session start reaches the running session, or the session is told to restart');
  });
});
