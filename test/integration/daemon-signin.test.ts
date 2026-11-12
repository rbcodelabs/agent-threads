/**
 * `auth.signin.*` over a real daemon socket: admin-only, one flow at a time, the token reaches only the starting
 * connection, a disconnect kills the flow, and the token is in no audit record. The child process is scripted.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SigninManager } from '../../daemon/signin';
import { AUTH_SIGNIN_CAPABILITY } from '../../src/protocol';
import { TestClient, sleep, startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

const TOKEN = 'sk-ant-oat01-INTEGRATIONSECRET_abc-123';
const cleanups: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scriptedSigninDaemon() {
  const audited: Array<Record<string, unknown>> = [];
  const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { write: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> }> = [];
  const signin = new SigninManager({
    spawn: () => {
      const child = new EventEmitter() as (typeof children)[number];
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: vi.fn() };
      child.kill = vi.fn(() => { child.emit('close', null, 'SIGTERM'); return true; });
      children.push(child);
      return child as never;
    },
    env: {},
    claudeBinary: () => '/usr/bin/claude',
    ptyTool: () => ({ kind: 'expect', path: '/usr/bin/expect' }),
    reap: () => {},
    audit: (r) => { audited.push(r); },
    idleMsBeforeCodePrompt: 20,
  });
  return { children, signin, audited };
}

async function boot() {
  const s = scriptedSigninDaemon();
  // The manager's own audit goes through the daemon's audit log: build it against the daemon's after start.
  const dataDir = mkdtempSync(join(tmpdir(), 'signin-data-'));
  dirs.push(dataDir);
  const td = await startTestDaemon({ signin: s.signin, dataDir });
  cleanups.push(() => td.cleanup());
  return { ...s, td };
}
async function connect(td: TestDaemon, token = td.adminToken) {
  const c = await TestClient.connect(td.daemon.url, token);
  cleanups.push(() => c.close().catch(() => {}));
  return c;
}

describe('auth.signin over the wire', () => {
  it('advertises the capability only when a sign-in provider exists', async () => {
    const { td } = await boot();
    const plain = await startTestDaemon({});
    cleanups.push(() => plain.cleanup());
    const a = await TestClient.open(td.daemon.url);
    const wa = await a.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token: td.adminToken });
    expect(wa.capabilities).toContain(AUTH_SIGNIN_CAPABILITY);
    await a.close();
    const b = await TestClient.open(plain.daemon.url);
    const wb = await b.cmd('hello', { protocol: 1, client: 'cli', clientVersion: 't', token: plain.adminToken });
    expect(wb.capabilities).not.toContain(AUTH_SIGNIN_CAPABILITY);
    expect(await (await connect(plain)).cmd('auth.signin.start')).toMatchObject({ type: 'err', code: 'unknown_command' });
    await b.close();
  });

  it('refuses control and read tokens with forbidden', async () => {
    const { td, children } = await boot();
    for (const scope of ['control', 'read'] as const) {
      const c = await connect(td, td.daemon.tokens.create(`t-${scope}`, scope).token);
      expect(await c.cmd('auth.signin.start')).toMatchObject({ type: 'err', code: 'forbidden' });
    }
    expect(children).toHaveLength(0);
  });

  it('runs a flow: ack with flowId, then url/prompt events, code, and the token only to the starter', async () => {
    const { td, children, audited } = await boot();
    const owner = await connect(td);
    const bystander = await connect(td);
    const started = await owner.cmd('auth.signin.start');
    expect(started).toMatchObject({ type: 'ack', result: { flowId: expect.any(String) } });
    const flowId = (started.result as { flowId: string }).flowId;
    // The ack is queued ahead of every event.
    const ackAt = owner.frames.findIndex((f) => f.cmdId === started.cmdId);
    const firstEventAt = owner.frames.findIndex((f) => f.type === 'auth.signin.event');
    if (firstEventAt !== -1) expect(ackAt).toBeLessThan(firstEventAt);

    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].stdout.emit('data', Buffer.from('Visit https://claude.ai/oauth/authorize?state=1\n'));
    await owner.waitFor((f) => f.type === 'auth.signin.event' && f.kind === 'url');
    await owner.waitFor((f) => f.type === 'auth.signin.event' && f.kind === 'prompt');

    // A second flow is refused while this one runs; another connection cannot answer it.
    expect(await bystander.cmd('auth.signin.start')).toMatchObject({ type: 'err', code: 'conflict' });
    expect(await bystander.cmd('auth.signin.code', { flowId, code: 'nope' })).toMatchObject({ type: 'err', code: 'forbidden' });

    expect(await owner.cmd('auth.signin.code', { flowId, code: 'abc#def' })).toMatchObject({ type: 'ack' });
    await sleep(400);
    children[0].stdout.emit('data', Buffer.from(`${TOKEN}\n`));
    const tokenFrame = await owner.waitFor((f) => f.type === 'auth.signin.event' && f.kind === 'token', 5000, 'token event');
    expect(tokenFrame).toMatchObject({ flowId, token: TOKEN });
    expect(bystander.frames.some((f) => JSON.stringify(f).includes('sk-ant'))).toBe(false);

    await td.cleanup();
    expect(readFileSync(join(td.dataDir, 'audit.ndjson'), 'utf8')).not.toContain('sk-ant');
    expect(JSON.stringify(audited)).not.toContain('sk-ant');
    expect(audited.map((a) => a.event)).toEqual(['signin_start', 'signin']);
  });

  it('a dropped connection kills the setup-token process and frees the slot', async () => {
    const { td, children } = await boot();
    const owner = await connect(td);
    await owner.cmd('auth.signin.start');
    await vi.waitFor(() => expect(children).toHaveLength(1));
    owner.kill();
    await vi.waitFor(() => expect(children[0].kill).toHaveBeenCalled());
    const next = await connect(td);
    expect(await next.cmd('auth.signin.start')).toMatchObject({ type: 'ack' });
  });

  it('cancel kills the process and the starter is told', async () => {
    const { td, children } = await boot();
    const owner = await connect(td);
    await owner.cmd('auth.signin.start');
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(await owner.cmd('auth.signin.cancel')).toMatchObject({ type: 'ack' });
    await owner.waitFor((f) => f.type === 'auth.signin.event' && f.kind === 'error' && f.message === 'Sign-in cancelled.');
    expect(children[0].kill).toHaveBeenCalled();
  });
});
