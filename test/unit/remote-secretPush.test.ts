/**
 * Pushing allowlisted secrets to a REMOTE daemon (design: "Secret push to remote daemons"): allowlist filter, wss
 * guard, admin-token naming, the CredsSink contract (local CredsPusher and the remote sink), refresh/revocation and
 * redaction. The daemon side is covered by test/integration/remote-secret-push.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { EnvKindDelivery, type CredsSink } from '../../src/credsDelivery';
import { CredsPusher } from '../../src/localDaemon/credsPusher';
import { adminTokenSecretNameFor, parsePushedSecrets, tokenSecretNameFor } from '../../src/remote/daemonConfig';
import {
  REMOTE_SECRET_TTL_SEC,
  RemoteSecretPush,
  RemoteWsSink,
  assertSecureTransportForPush,
  filterAllowlisted,
  type PushClient,
} from '../../src/remote/secretPush';
import type { RemoteDaemonConfig } from '../../src/types';

const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const ADMIN = 'atd_adminTOKENvalue0123456789';

function daemon(over: Partial<RemoteDaemonConfig> = {}): RemoteDaemonConfig {
  return { id: 'box', name: 'Box', url: 'wss://box.tail1234.ts.net:8443', tokenSecretName: tokenSecretNameFor('box'), pushedSecrets: ['GH_TOKEN'], ...over };
}

describe('filterAllowlisted', () => {
  const env = { GH_TOKEN: SECRET, OTHER: 'x', PATH: '/mac', AWS_PROFILE: 'deploy' };
  it('keeps only forwardable, allowlisted names', () => {
    expect(filterAllowlisted(env, ['GH_TOKEN', 'PATH', 'MISSING'], 'p')).toEqual({ GH_TOKEN: SECRET });
  });
  it('an empty allowlist sends nothing', () => {
    expect(filterAllowlisted(env, [], 'p')).toEqual({});
  });
  it('project-scoped entries only apply to that project', () => {
    expect(filterAllowlisted(env, ['alpha/OTHER'], 'alpha')).toEqual({ OTHER: 'x' });
    expect(filterAllowlisted(env, ['alpha/OTHER'], 'beta')).toEqual({});
    expect(filterAllowlisted(env, ['alpha/OTHER'], undefined)).toEqual({});
    expect(filterAllowlisted(env, ['OTHER'], 'beta')).toEqual({ OTHER: 'x' });
  });
});

describe('parsePushedSecrets', () => {
  it('parses names one per line or comma separated, dedupes, and reports bad entries', () => {
    expect(parsePushedSecrets('GH_TOKEN\nAWS_PROFILE, alpha/KEY\nGH_TOKEN')).toEqual({ ok: true, names: ['GH_TOKEN', 'AWS_PROFILE', 'alpha/KEY'] });
    expect(parsePushedSecrets('')).toEqual({ ok: true, names: [] });
    const bad = parsePushedSecrets('GH_TOKEN\nnot a name\nghp_realvalue=abc');
    expect(bad.ok).toBe(false);
    // The offending text may be a pasted VALUE: it must not be echoed back.
    expect(JSON.stringify(bad)).not.toContain('ghp_realvalue');
  });
});

describe('adminTokenSecretNameFor', () => {
  it('is distinct from the everyday token name, and from another daemon\'s', () => {
    const names = new Set(['x', 'x-admin', 'admin-x'].flatMap((id) => [tokenSecretNameFor(id), adminTokenSecretNameFor(id)]));
    expect(names.size).toBe(6);
  });
});

describe('assertSecureTransportForPush', () => {
  it('allows wss/https and loopback ws', () => {
    for (const u of ['wss://h.example.com', 'https://h.example.com', 'ws://localhost:8080', 'ws://127.0.0.1:1', 'ws://[::1]:9']) {
      expect(() => assertSecureTransportForPush(u)).not.toThrow();
    }
  });
  it('refuses plain ws to anything else, tailnet and bare hosts included', () => {
    for (const u of ['ws://box.example.com', 'ws://100.64.1.2:8080', 'ws://box.tail1.ts.net', 'box:8080', 'http://10.0.0.5']) {
      expect(() => assertSecureTransportForPush(u)).toThrow(/wss/);
    }
  });
});

class FakeClient implements PushClient {
  readonly sent: Array<{ type: string; payload: any; timeoutMs?: number }> = [];
  failWith: Error | null = null;
  disposed = false;
  async command(type: 'creds.push', payload: any, opts?: { timeoutMs?: number }) {
    this.sent.push({ type, payload: structuredClone(payload), timeoutMs: opts?.timeoutMs });
    if (this.failWith) throw this.failWith;
    return {};
  }
  dispose() { this.disposed = true; }
}

describe('CredsSink contract', () => {
  it('both the local CredsPusher and the remote sink implement it', async () => {
    const calls: string[][] = [];
    const local: CredsSink = new CredsPusher({
      vaultPath: () => '/v',
      runner: () => async (args) => { calls.push([...args]); return { exitCode: 0, stdout: '', stderr: '' }; },
    });
    const client = new FakeClient();
    const remote: CredsSink = new RemoteWsSink(client);
    await local.push('sessenv-a', { K: 'v' }, 60);
    await remote.push('sessenv-a', { K: 'v' }, 60);
    await local.remove('sessenv-a');
    await remote.remove('sessenv-a');
    expect(calls.length).toBeGreaterThan(0);
    expect(client.sent.map((s) => s.payload)).toEqual([
      { kind: 'sessenv-a', ttlSec: 60, fields: { K: 'v' } },
      { kind: 'sessenv-a', ttlSec: expect.any(Number), fields: {} },
    ]);
  });

  it('the remote sink refuses kinds other than sessenv-*', async () => {
    const client = new FakeClient();
    await expect(new RemoteWsSink(client).push('github', { GH_TOKEN: SECRET }, 60)).rejects.toThrow(/sessenv/);
    expect(client.sent).toEqual([]);
  });

  it('the remote sink redacts values and the admin token from errors', async () => {
    const client = new FakeClient();
    client.failWith = new Error(`daemon said no: ${SECRET} and ${ADMIN}`);
    const err = await new RemoteWsSink(client, () => [ADMIN]).push('sessenv-a', { GH_TOKEN: SECRET }, 60).catch((e) => e as Error);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain(ADMIN);
    expect(err.message).toContain('sessenv-a');
  });
});

describe('EnvKindDelivery (shared hashing / refresh)', () => {
  function sink() {
    const log: string[] = [];
    const s: CredsSink = { push: async (k, f, t) => { log.push(`push ${k} ${Object.keys(f).join(',')} ${t}`); }, remove: async (k) => { log.push(`remove ${k}`); } };
    return { s, log };
  }
  it('skips identical pushes until the refresh age, repushes on change, removes when empty', async () => {
    const { s, log } = sink();
    let now = 0;
    const d = new EnvKindDelivery(s, { refreshMs: 1000, now: () => now });
    expect(await d.deliver('sessenv-p', { A: '1' }, 60)).toBe(true);
    expect(await d.deliver('sessenv-p', { A: '1' }, 60)).toBe(true);
    expect(log).toEqual(['push sessenv-p A 60']);
    now = 1001;
    await d.deliver('sessenv-p', { A: '1' }, 60);
    await d.deliver('sessenv-p', { A: '2' }, 60);
    expect(log.length).toBe(3);
    expect(await d.deliver('sessenv-p', {}, 60)).toBe(false);
    expect(log[3]).toBe('remove sessenv-p');
  });
});

describe('RemoteSecretPush', () => {
  function fixture(over: { daemons?: RemoteDaemonConfig[]; admin?: string | undefined; env?: Record<string, string> } = {}) {
    const clients: FakeClient[] = [];
    const logs: string[] = [];
    let now = 1_000_000;
    const state = { daemons: over.daemons ?? [daemon()], admin: 'admin' in over ? over.admin : ADMIN, env: over.env ?? { GH_TOKEN: SECRET, OTHER: 'nope', PATH: '/mac' } };
    const push = new RemoteSecretPush({
      daemons: () => state.daemons,
      adminToken: () => state.admin,
      resolveEnv: () => state.env,
      createClient: () => { const c = new FakeClient(); clients.push(c); return c; },
      now: () => now,
      log: (m) => logs.push(m),
    });
    return { push, clients, logs, state, advance: (ms: number) => { now += ms; } };
  }
  const sent = (f: ReturnType<typeof fixture>) => f.clients.flatMap((c) => c.sent);

  it('pushes only allowlisted names as sessenv-<project> with the TTL, and returns just the kind', async () => {
    const f = fixture();
    const r = await f.push.prepare('box', 'Proj-1');
    expect(r).toEqual({ envKind: 'sessenv-proj-1', warnings: [] });
    expect(sent(f)).toHaveLength(1);
    expect(sent(f)[0].type).toBe('creds.push');
    expect(sent(f)[0].payload).toEqual({ kind: 'sessenv-proj-1', ttlSec: REMOTE_SECRET_TTL_SEC, fields: { GH_TOKEN: SECRET } });
    expect(REMOTE_SECRET_TTL_SEC).toBeLessThanOrEqual(3600);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(f.logs.join('\n')).not.toContain(SECRET);
  });

  it('default (empty allowlist) does nothing and never connects', async () => {
    const f = fixture({ daemons: [daemon({ pushedSecrets: [] })] });
    expect(await f.push.prepare('box', 'p')).toEqual({ warnings: [] });
    expect(f.clients).toEqual([]);
    const g = fixture({ daemons: [{ ...daemon(), pushedSecrets: undefined }] });
    expect(await g.push.prepare('box', 'p')).toEqual({ warnings: [] });
  });

  it('no admin token: no push, a clear warning, no throw', async () => {
    const f = fixture({ admin: undefined });
    const r = await f.push.prepare('box', 'p');
    expect(r.envKind).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/admin token/i);
    expect(f.clients).toEqual([]);
  });

  it('refuses plain ws:// to a non-loopback host with a warning, and sends nothing', async () => {
    const f = fixture({ daemons: [daemon({ url: 'ws://box.example.com:8080' })] });
    const r = await f.push.prepare('box', 'p');
    expect(r.envKind).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/wss/);
    expect(f.clients).toEqual([]);
  });

  it('allows ws:// to loopback', async () => {
    const f = fixture({ daemons: [daemon({ url: 'ws://127.0.0.1:9000' })] });
    expect((await f.push.prepare('box', 'p')).envKind).toBe('sessenv-p');
  });

  it('nothing allowlisted is present in the environment: no kind, no push', async () => {
    const f = fixture({ env: { OTHER: 'x' } });
    expect(await f.push.prepare('box', 'p')).toEqual({ warnings: [] });
    expect(sent(f)).toEqual([]);
  });

  it('skips identical re-pushes and refreshes before the TTL runs out', async () => {
    const f = fixture();
    await f.push.prepare('box', 'p');
    await f.push.prepare('box', 'p');
    expect(sent(f)).toHaveLength(1);
    f.advance((REMOTE_SECRET_TTL_SEC * 1000) / 2 + 1);
    await f.push.prepare('box', 'p');
    expect(sent(f)).toHaveLength(2);
  });

  it('a failing push becomes a redacted warning, never a throw, and no envKind', async () => {
    const f = fixture();
    const first = await f.push.prepare('box', 'p');
    expect(first.envKind).toBe('sessenv-p');
    f.state.env = { GH_TOKEN: `${SECRET}x` };
    f.clients[0].failWith = new Error(`boom ${SECRET}x ${ADMIN}`);
    const r = await f.push.prepare('box', 'p');
    expect(r.envKind).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/not delivered|failed/i);
    const everything = JSON.stringify(r) + f.logs.join('\n');
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(ADMIN);
  });

  it('removing a name from the allowlist re-pushes the kind without it; removing the last one deletes the kind', async () => {
    const f = fixture({ daemons: [daemon({ pushedSecrets: ['GH_TOKEN', 'OTHER'] })] });
    await f.push.prepare('box', 'p');
    expect(Object.keys(sent(f)[0].payload.fields).sort()).toEqual(['GH_TOKEN', 'OTHER']);
    f.state.daemons = [daemon({ pushedSecrets: ['GH_TOKEN'] })];
    await f.push.reconcile();
    expect(sent(f)[1].payload).toEqual({ kind: 'sessenv-p', ttlSec: REMOTE_SECRET_TTL_SEC, fields: { GH_TOKEN: SECRET } });
    f.state.daemons = [daemon({ pushedSecrets: [] })];
    await f.push.reconcile();
    expect(sent(f)[2].payload.kind).toBe('sessenv-p');
    expect(sent(f)[2].payload.fields).toEqual({});
  });

  it('a daemon removed from settings has its pushed kinds deleted on reconcile', async () => {
    const f = fixture();
    await f.push.prepare('box', 'p');
    f.state.daemons = [];
    await f.push.reconcile();
    expect(sent(f)[1].payload.fields).toEqual({});
  });

  it('stop() revokes everything pushed and disposes the connections', async () => {
    const f = fixture();
    await f.push.prepare('box', 'a');
    await f.push.prepare('box', 'b');
    await f.push.stop();
    const removals = sent(f).filter((s) => Object.keys(s.payload.fields).length === 0).map((s) => s.payload.kind).sort();
    expect(removals).toEqual(['sessenv-a', 'sessenv-b']);
    expect(f.clients.every((c) => c.disposed)).toBe(true);
  });

  it('stop() never throws when the daemon is unreachable', async () => {
    const f = fixture();
    await f.push.prepare('box', 'a');
    f.clients[0].failWith = new Error('down');
    await expect(f.push.stop()).resolves.toBeUndefined();
  });
});
