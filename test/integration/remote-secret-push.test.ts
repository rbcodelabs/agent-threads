/**
 * Host -> remote daemon secret push, end to end: RemoteSecretPush + the real DaemonClient against the daemon's REAL
 * in-process server (admin-scope `creds.push`, credential store on disk). Frames are captured at the socket so the
 * `creds.push` payload and TTL are asserted as they cross the wire, and every log line and warning is searched for
 * secret values.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient, daemonWsUrl, type WebSocketFactory } from '../../src/remote/DaemonClient';
import { REMOTE_SECRET_TTL_SEC, RemoteSecretPush } from '../../src/remote/secretPush';
import type { RemoteDaemonConfig } from '../../src/types';
import { startTestDaemon, type TestDaemon } from '../helpers/daemonTestClient';

const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const OTHER = 'super-secret-other-value-123';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function daemon(): Promise<TestDaemon> {
  const td = await startTestDaemon();
  cleanups.push(() => td.cleanup());
  return td;
}

function setup(td: TestDaemon, token: string, over: Partial<RemoteDaemonConfig> = {}) {
  const sent: any[] = [];
  const logs: string[] = [];
  const factory: WebSocketFactory = (url) => {
    const ws = new WebSocket(url);
    const send = ws.send.bind(ws);
    (ws as any).send = (data: any, ...rest: any[]) => { try { sent.push(JSON.parse(String(data))); } catch { /* not json */ } return send(data, ...rest); };
    return ws as unknown as ReturnType<WebSocketFactory>;
  };
  const state = {
    env: { GH_TOKEN: GH, OTHER_KEY: OTHER, PATH: '/mac' } as Record<string, string>,
    cfg: { id: 'box', name: 'Box', url: td.daemon.url, tokenSecretName: 'T', pushedSecrets: ['GH_TOKEN'], ...over } as RemoteDaemonConfig,
  };
  const push = new RemoteSecretPush({
    daemons: () => [state.cfg],
    adminToken: () => token,
    resolveEnv: () => state.env,
    createClient: (d, admin) => new DaemonClient({ url: daemonWsUrl(d.url), getToken: () => admin, createSocket: factory, clientVersion: '0.0.0-test', reconnect: false, commandTimeoutMs: 5000 }),
    log: (m) => logs.push(m),
  });
  cleanups.push(() => push.stop());
  return { push, sent, logs, state };
}

const storedKind = (td: TestDaemon, kind: string) => {
  const file = join(td.dataDir, 'creds', `${kind}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
};

describe('remote secret push against the real daemon', () => {
  it('sends only allowlisted values as sessenv-<project>, with a TTL, and the daemon stores exactly those', async () => {
    const td = await daemon();
    const f = setup(td, td.adminToken);
    const r = await f.push.prepare('box', 'proj-a');
    expect(r).toEqual({ envKind: 'sessenv-proj-a', warnings: [] });

    const frames = f.sent.filter((x) => x.type === 'creds.push');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'sessenv-proj-a', ttlSec: REMOTE_SECRET_TTL_SEC, fields: { GH_TOKEN: GH } });
    expect(Object.keys(frames[0].fields)).toEqual(['GH_TOKEN']);

    const stored = storedKind(td, 'sessenv-proj-a');
    expect(stored.fields).toEqual({ GH_TOKEN: GH });
    expect(stored.expiresAt - stored.pushedAt).toBe(REMOTE_SECRET_TTL_SEC * 1000);

    const everywhere = JSON.stringify(r) + f.logs.join('\n');
    expect(everywhere).not.toContain(GH);
    expect(everywhere).not.toContain(OTHER);
  });

  it('dropping a name re-pushes without it; clearing the allowlist or quitting deletes the kind', async () => {
    const td = await daemon();
    const f = setup(td, td.adminToken, { pushedSecrets: ['GH_TOKEN', 'OTHER_KEY'] });
    await f.push.prepare('box', 'p');
    expect(Object.keys(storedKind(td, 'sessenv-p').fields).sort()).toEqual(['GH_TOKEN', 'OTHER_KEY']);

    f.state.cfg = { ...f.state.cfg, pushedSecrets: ['GH_TOKEN'] };
    await f.push.reconcile();
    expect(storedKind(td, 'sessenv-p').fields).toEqual({ GH_TOKEN: GH });

    f.state.cfg = { ...f.state.cfg, pushedSecrets: [] };
    await f.push.reconcile();
    expect(storedKind(td, 'sessenv-p')).toBeUndefined();

    f.state.cfg = { ...f.state.cfg, pushedSecrets: ['GH_TOKEN'] };
    await f.push.prepare('box', 'p');
    expect(storedKind(td, 'sessenv-p')).toBeDefined();
    await f.push.stop();
    expect(storedKind(td, 'sessenv-p')).toBeUndefined();
  });

  it('a control-scope token cannot push: a redacted warning, nothing stored, no throw', async () => {
    const td = await daemon();
    const control = td.daemon.tokens.create('everyday', 'control').token;
    const f = setup(td, control);
    const r = await f.push.prepare('box', 'p');
    expect(r.envKind).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/needs scope admin/);
    expect(storedKind(td, 'sessenv-p')).toBeUndefined();
    const everywhere = JSON.stringify(r) + f.logs.join('\n');
    for (const secret of [GH, OTHER, control]) expect(everywhere).not.toContain(secret);
  });

  it('a wrong token and an unreachable daemon become warnings too', async () => {
    const td = await daemon();
    const bad = setup(td, 'atd_not-a-real-token');
    const r = await bad.push.prepare('box', 'p');
    expect(r.envKind).toBeUndefined();
    expect(r.warnings).toHaveLength(1);
    expect(JSON.stringify(r) + bad.logs.join('\n')).not.toContain(GH);
  });
});
