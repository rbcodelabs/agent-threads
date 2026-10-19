import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { partitionExternalMcpServers } from '../../src/remote/mcpPartition';
import {
  McpSyncEngine, NeedsAdminError, evaluateServer, mcpSyncKind, normalizeDaemonMcpSync, scrubSecrets, wireTransport,
  type EvalContext, type McpSyncTransport,
} from '../../src/remote/mcpSync';
import { DaemonCommandError } from '../../src/remote/DaemonClient';
import { sha256Hex } from '../../src/remote/sha256';
import type { RemoteDaemonConfig } from '../../src/types';

const CTX: EvalContext = { secretKeys: ['DOCS_TOKEN', 'TOOL_KEY', 'PROJ_KEY', 'OTHER_KEY'], secretScopes: { PROJ_KEY: ['proj-a'], OTHER_KEY: ['proj-b'] }, oauthNames: new Set(['linear']) };
const HTTP = { type: 'http', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } };
const STDIO = { type: 'stdio', command: 'tool-server', args: ['--key', '${TOOL_KEY}'], env: { API_KEY: '${TOOL_KEY}' } };

describe('sha256Hex', () => {
  it.each(['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'héllo wörld ✓', 'x'.repeat(1000)])('matches node:crypto for %j', (text) => {
    expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'));
  });
});

describe('mcpSyncKind', () => {
  it('uses a shared kind or the project\'s, in the shape the daemon accepts', () => {
    expect(mcpSyncKind(undefined)).toBe('mcpsync-global');
    expect(mcpSyncKind('Proj_A 1')).toBe('mcpsync-p-proj_a-1');
    expect(mcpSyncKind('x'.repeat(100))).toMatch(/^mcpsync-p-[a-z0-9_-]{1,40}$/);
    expect(mcpSyncKind('x'.repeat(100)).length).toBeLessThanOrEqual(64);
  });
});

describe('evaluateServer', () => {
  it('rewrites placeholders to the project-qualified form and lists the secret names', () => {
    const ev = evaluateServer('docs', HTTP, CTX);
    expect(ev.blocked).toBeUndefined();
    expect(ev.kind).toBe('mcpsync-global');
    expect(ev.secretNames).toEqual(['DOCS_TOKEN']);
    expect(ev.wire).toEqual({ type: 'http', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer ${mcpsync-global.DOCS_TOKEN}' } });
    const tool = evaluateServer('tool', STDIO, CTX);
    expect(tool.wire).toEqual({ type: 'stdio', command: 'tool-server', args: ['--key', '${mcpsync-global.TOOL_KEY}'], env: { API_KEY: '${mcpsync-global.TOOL_KEY}' } });
  });

  it('puts a secret limited to one project in that project\'s kind and says so', () => {
    const ev = evaluateServer('p', { type: 'http', url: 'https://x.test/${PROJ_KEY}' }, CTX);
    expect(ev.kind).toBe('mcpsync-p-proj-a');
    expect(ev.limitedToProject).toBe('proj-a');
    expect(ev.wire).toMatchObject({ url: 'https://x.test/${mcpsync-p-proj-a.PROJ_KEY}' });
  });

  it('keeps projects apart: secrets of different projects cannot share a server', () => {
    const ev = evaluateServer('mix', { type: 'http', url: 'https://x.test/${PROJ_KEY}/${OTHER_KEY}' }, CTX);
    expect(ev.blocked?.code).toBe('mixed-scope');
  });

  it.each([
    ['an oauth server', 'linear', { type: 'http', url: 'https://mcp.linear.app/mcp' }, 'oauth'],
    ['a loopback URL (also the Google and OAuth proxies)', 'g', { type: 'http', url: 'http://127.0.0.1:4821/google/docs' }, 'loopback'],
    ['localhost', 'g', { type: 'sse', url: 'http://localhost:3000/sse' }, 'loopback'],
    ['a loopback URL in stdio args', 's', { type: 'stdio', command: 'x', args: ['--endpoint', 'http://127.0.0.1:9/mcp'] }, 'loopback'],
    ['a loopback URL inside an env value', 's', { type: 'stdio', command: 'x', env: { U: 'url=http://localhost:9/x' } }, 'loopback'],
    ['an environment variable that is not a stored secret', 's', { type: 'http', url: 'https://x.test/${HOME}' }, 'unsyncable-secret'],
    ['a secret name a daemon cannot store', 's', { type: 'http', url: 'https://x.test/${bad-name}' }, 'unsyncable-secret'],
    ['a literal Authorization header', 's', { type: 'http', url: 'https://x.test', headers: { Authorization: 'Bearer abc123' } }, 'literal-secret'],
    ['a literal api key env', 's', { type: 'stdio', command: 'x', env: { API_KEY: 'abc123' } }, 'literal-secret'],
    ['a token in the URL query', 's', { type: 'http', url: 'https://x.test/mcp?token=abc123def456' }, 'literal-secret'],
    ['credentials in the URL', 's', { type: 'http', url: 'https://user:pw@x.test/mcp' }, 'literal-secret'],
    ['an invalid entry', 's', { type: 'ws' }, 'invalid'],
  ])('never syncs %s', (_label, name, def, code) => {
    const ev = evaluateServer(name, def, CTX);
    expect(ev.blocked?.code).toBe(code);
    expect(ev.wire).toBeUndefined();
  });

  it('allows a literal header that is not a credential and a placeholder query value', () => {
    expect(evaluateServer('s', { type: 'http', url: 'https://x.test/mcp?api_key=${DOCS_TOKEN}&v=2', headers: { 'X-Client': 'agent-threads' } }, CTX).blocked).toBeUndefined();
  });

  it('hash changes with the command, args, env, url, headers and the credential kind, not with values', () => {
    const base = evaluateServer('tool', STDIO, CTX).hash;
    expect(evaluateServer('tool', STDIO, CTX).hash).toBe(base);
    expect(evaluateServer('tool', { ...STDIO, command: 'other' }, CTX).hash).not.toBe(base);
    expect(evaluateServer('tool', { ...STDIO, args: ['--key', '${TOOL_KEY}', '--x'] }, CTX).hash).not.toBe(base);
    expect(evaluateServer('tool', { ...STDIO, env: { API_KEY: '${TOOL_KEY}', EXTRA: '1' } }, CTX).hash).not.toBe(base);
    expect(evaluateServer('tool', STDIO, { ...CTX, secretScopes: { TOOL_KEY: ['proj-a'] } }).hash).not.toBe(base);
  });
});

// ── engine ───────────────────────────────────────────────────────────────────

class FakeTransport implements McpSyncTransport {
  pushes: Array<{ kind: string; fields: Record<string, string>; ttlSec: number }> = [];
  syncs: Array<Record<string, unknown>> = [];
  reply: (servers: Record<string, unknown>) => { accepted: string[]; rejected: Array<{ name: string; reason: string }>; requiredCreds: string[]; shadowed: string[] } =
    (s) => ({ accepted: Object.keys(s), rejected: [], requiredCreds: [], shadowed: [] });
  failWith: Error | null = null;
  async pushCreds(kind: string, fields: Record<string, string>, ttlSec: number): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.pushes.push({ kind, fields: { ...fields }, ttlSec });
  }
  async syncServers(servers: Record<string, unknown>) {
    if (this.failWith) throw this.failWith;
    this.syncs.push(JSON.parse(JSON.stringify(servers)));
    return this.reply(servers);
  }
}

interface Rig { values: Record<string, string>; engine: McpSyncEngine; daemon: RemoteDaemonConfig; transport: FakeTransport; settings: Record<string, any>; reads: string[]; logs: string[]; caps: { value: string[] | undefined }; saves: { n: number } }

function rig(over: { caps?: string[]; managed?: boolean } = {}): Rig {
  const daemon: RemoteDaemonConfig = { id: 'd1', name: 'Box', url: 'wss://box.test', tokenSecretName: 'T', ...(over.managed ? { managed: 'local-container' as const } : {}) };
  const settings: Record<string, any> = {
    mcpServers: { docs: HTTP, tool: STDIO },
    oauthMcpServers: { linear: {} },
    secretEnvKeys: ['DOCS_TOKEN', 'TOOL_KEY', 'UNRELATED_SECRET'],
    secretEnvScopes: {},
    remoteDaemons: [daemon],
  };
  const values: Record<string, string> = { DOCS_TOKEN: 'sk-docs-111111', TOOL_KEY: 'sk-tool-222222', UNRELATED_SECRET: 'sk-unrelated-333333' };
  const reads: string[] = []; const logs: string[] = [];
  const caps = { value: 'caps' in over ? over.caps : ['mcp.sync', 'mcp.sync.stdio', 'creds.push'] };
  const transport = new FakeTransport();
  const saves = { n: 0 };
  const engine = new McpSyncEngine({
    daemons: () => settings.remoteDaemons,
    settings: () => settings,
    readSecret: (n) => { reads.push(n); return values[n]; },
    capabilitiesOf: () => caps.value,
    transportFor: () => transport,
    saveSettings: async () => { saves.n++; },
    log: (m) => logs.push(m),
  });
  return { values, engine, daemon, transport, settings, reads, logs, caps, saves };
}

async function enable(r: Rig, name: string): Promise<void> {
  await r.engine.setEnabled('d1', name, true, r.engine.evaluate(name)!.hash);
  await vi.runAllTimersAsync();
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('McpSyncEngine', () => {
  it('does nothing for a daemon with no opt-ins (never replaces what an operator synced by hand)', async () => {
    const r = rig();
    await r.engine.sync('d1', 'force');
    expect(r.transport.syncs).toEqual([]);
    expect(r.transport.pushes).toEqual([]);
    expect(r.reads).toEqual([]);
  });

  it('pushes only the secrets of opted-in servers, with the 30 day TTL, then the qualified definitions', async () => {
    const r = rig();
    await enable(r, 'docs');
    expect(r.reads).toEqual(['DOCS_TOKEN']);
    expect(r.transport.pushes).toEqual([{ kind: 'mcpsync-global', fields: { DOCS_TOKEN: 'sk-docs-111111' }, ttlSec: 30 * 86400 }]);
    expect(r.transport.syncs).toEqual([{ docs: { type: 'http', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer ${mcpsync-global.DOCS_TOKEN}' } } }]);
    expect(JSON.stringify(r.transport.syncs)).not.toContain('sk-docs');
    expect(r.engine.statusOf('d1', 'docs')).toEqual({ state: 'synced', shadowed: false });
    expect(r.engine.syncedNamesOf('d1')).toEqual(new Set(['docs']));
    expect(r.daemon.mcpSyncKinds).toEqual(['mcpsync-global']);
    expect(r.daemon.mcpSyncNames).toEqual(['docs']);
    expect(r.reads).not.toContain('UNRELATED_SECRET');
  });

  it('does not sync a server whose definition the user has not confirmed, and re-asks after an edit', async () => {
    const r = rig();
    await r.engine.setEnabled('d1', 'docs', true); // no confirmed hash
    await vi.runAllTimersAsync();
    expect(r.engine.statusOf('d1', 'docs')).toEqual({ state: 'needs-confirm' });
    expect(r.transport.syncs.at(-1)).toEqual({});
    expect(r.reads).toEqual([]);

    await enable(r, 'docs');
    expect(r.engine.statusOf('d1', 'docs').state).toBe('synced');
    r.settings.mcpServers.docs = { ...HTTP, url: 'https://evil.example.test/mcp' };
    r.engine.onSettingsChanged();
    await vi.runAllTimersAsync();
    expect(r.engine.needsConfirmation('d1', 'docs')).toBe(true);
    expect(r.engine.statusOf('d1', 'docs')).toEqual({ state: 'needs-confirm' });
    expect(r.transport.syncs.at(-1)).toEqual({});
    expect(r.engine.syncedNamesOf('d1').size).toBe(0);
  });

  it('turning a server off re-syncs the smaller set and removes the kind that is no longer used', async () => {
    const r = rig();
    await enable(r, 'docs');
    await enable(r, 'tool');
    expect(Object.keys(r.transport.syncs.at(-1)!).sort()).toEqual(['docs', 'tool']);
    expect(r.transport.pushes.at(-1)!.fields).toEqual({ DOCS_TOKEN: 'sk-docs-111111', TOOL_KEY: 'sk-tool-222222' });

    await r.engine.setEnabled('d1', 'tool', false);
    await vi.runAllTimersAsync();
    expect(Object.keys(r.transport.syncs.at(-1)!)).toEqual(['docs']);
    expect(r.transport.pushes.at(-1)).toMatchObject({ kind: 'mcpsync-global', fields: { DOCS_TOKEN: 'sk-docs-111111' } });

    await r.engine.setEnabled('d1', 'docs', false);
    await vi.runAllTimersAsync();
    expect(r.transport.syncs.at(-1)).toEqual({});
    expect(r.transport.pushes.at(-1)).toEqual({ kind: 'mcpsync-global', fields: {}, ttlSec: 0 });
    expect(r.daemon.mcpSyncKinds).toEqual([]);
    // Turning it back on with the same definition needs no second confirmation.
    await r.engine.setEnabled('d1', 'docs', true);
    await vi.runAllTimersAsync();
    expect(r.engine.statusOf('d1', 'docs').state).toBe('synced');
  });

  it('reports a server whose secret is not set on this computer, without sending it', async () => {
    const r = rig();
    r.values.TOOL_KEY = '';
    await enable(r, 'tool');
    expect(r.engine.statusOf('d1', 'tool')).toEqual({ state: 'missing-secret', names: ['TOOL_KEY'] });
    expect(r.engine.unsyncedReasonOf('d1', 'tool')).toContain('TOOL_KEY');
    expect(r.transport.syncs.at(-1)).toEqual({});
    expect(r.transport.pushes).toEqual([]);
  });

  it('removes a refused server\'s secrets from the daemon and shows the reason', async () => {
    const r = rig();
    r.transport.reply = (s) => ({ accepted: ['docs'], rejected: Object.keys(s).filter((n) => n !== 'docs').map((name) => ({ name, reason: 'stdio servers are not allowed on this daemon' })), requiredCreds: [], shadowed: [] });
    await enable(r, 'docs');
    await enable(r, 'tool');
    expect(r.engine.statusOf('d1', 'tool')).toEqual({ state: 'rejected', reason: 'stdio servers are not allowed on this daemon' });
    expect(r.transport.pushes.at(-1)).toMatchObject({ kind: 'mcpsync-global', fields: { DOCS_TOKEN: 'sk-docs-111111' } });
    expect(r.transport.pushes.at(-1)!.fields).not.toHaveProperty('TOOL_KEY');
    expect(r.engine.unsyncedReasonOf('d1', 'tool')).toBe('stdio servers are not allowed on this daemon');
  });

  it('shows shadowing by config.json', async () => {
    const r = rig();
    r.transport.reply = (s) => ({ accepted: Object.keys(s), rejected: [], requiredCreds: [], shadowed: ['docs'] });
    await enable(r, 'docs');
    expect(r.engine.statusOf('d1', 'docs')).toEqual({ state: 'synced', shadowed: true });
  });

  it('is disabled with a reason when the daemon is too old, has no stdio, or needs an admin token', async () => {
    const old = rig({ caps: ['creds.push'] });
    expect(old.engine.availability('d1')).toMatchObject({ ok: false, code: 'daemon-too-old' });
    const noStdio = rig({ caps: ['mcp.sync'] });
    expect(noStdio.engine.availability('d1')).toEqual({ ok: true });
    expect(noStdio.engine.availability('d1', noStdio.engine.evaluate('tool'))).toMatchObject({ ok: false, code: 'stdio-forbidden' });
    expect(noStdio.engine.availability('d1', noStdio.engine.evaluate('docs'))).toEqual({ ok: true });
    const unknown = rig({ caps: undefined });
    expect(unknown.engine.availability('d1')).toMatchObject({ ok: false, code: 'not-connected' });

    const nonAdmin = rig();
    nonAdmin.transport.failWith = new NeedsAdminError();
    await nonAdmin.engine.setEnabled('d1', 'docs', true, nonAdmin.engine.evaluate('docs')!.hash);
    await vi.runAllTimersAsync();
    expect(nonAdmin.engine.availability('d1')).toMatchObject({ ok: false, code: 'needs-admin', reason: expect.stringContaining('admin token') });
    expect(nonAdmin.engine.statusOf('d1', 'docs')).toMatchObject({ state: 'error', reason: 'needs an admin token' });
  });

  it('with a daemon that lacks mcp.sync it changes nothing and reports why', async () => {
    const r = rig({ caps: ['creds.push'] });
    await r.engine.setEnabled('d1', 'docs', true, r.engine.evaluate('docs')!.hash);
    await vi.runAllTimersAsync();
    expect(r.transport.syncs).toEqual([]);
    expect(r.transport.pushes).toEqual([]);
    expect(r.reads).toEqual([]);
    expect(r.engine.statusOf('d1', 'docs')).toMatchObject({ state: 'error', reason: expect.stringContaining('too old') });
  });

  it('a managed daemon does not need the admin probe', () => {
    const r = rig({ managed: true });
    expect(r.engine.availability('d1')).toEqual({ ok: true });
  });

  it('skips an unchanged state on a normal trigger but repeats on connect and push now', async () => {
    const r = rig();
    await enable(r, 'docs');
    const n = r.transport.syncs.length;
    r.engine.onSettingsChanged();
    await vi.runAllTimersAsync();
    expect(r.transport.syncs.length).toBe(n);
    r.engine.onConnected('d1');
    await vi.runAllTimersAsync();
    expect(r.transport.syncs.length).toBe(n + 1);
    await r.engine.pushNow('d1');
    expect(r.transport.syncs.length).toBe(n + 2);
  });

  it('a rotated secret value is pushed on the next trigger', async () => {
    const r = rig();
    await enable(r, 'docs');
    const pushes = r.transport.pushes.length;
    const eng = new McpSyncEngine({
      daemons: () => r.settings.remoteDaemons, settings: () => r.settings, readSecret: () => 'sk-docs-ROTATED',
      capabilitiesOf: () => ['mcp.sync'], transportFor: () => r.transport, saveSettings: async () => {},
    });
    await eng.sync('d1', 'normal');
    expect(r.transport.pushes.length).toBe(pushes + 1);
    expect(r.transport.pushes.at(-1)!.fields.DOCS_TOKEN).toBe('sk-docs-ROTATED');
  });

  it('never logs or surfaces a secret value, even from an error that contains one', async () => {
    const r = rig();
    await enable(r, 'docs');
    r.transport.failWith = new Error('boom while sending Bearer sk-docs-111111 to the daemon');
    await r.engine.pushNow('d1');
    const st = r.engine.statusOf('d1', 'docs');
    expect(JSON.stringify(st)).not.toContain('sk-docs-111111');
    expect(JSON.stringify(st)).toContain('***');
    expect(r.logs.join('\n')).not.toContain('sk-docs-111111');
    expect(r.logs.join('\n')).not.toContain('sk-unrelated');
  });

  it('serialises concurrent triggers per daemon', async () => {
    const r = rig();
    await r.engine.setEnabled('d1', 'docs', true, r.engine.evaluate('docs')!.hash);
    let inFlight = 0; let max = 0;
    const orig = r.transport.syncServers.bind(r.transport);
    r.transport.syncServers = async (s) => { inFlight++; max = Math.max(max, inFlight); await Promise.resolve(); await Promise.resolve(); inFlight--; return orig(s); };
    await Promise.all([r.engine.sync('d1', 'force'), r.engine.sync('d1', 'force'), r.engine.sync('d1', 'force')]);
    expect(max).toBe(1);
  });
});

describe('partition integration', () => {
  const stored = { docs: HTTP, tool: STDIO, plain: { type: 'http', url: 'https://plain.example.test/mcp' } } as never;

  it('drops stdio and secret servers as before when nothing is synced', () => {
    const p = partitionExternalMcpServers(stored);
    expect(Object.keys(p.passthrough)).toEqual(['plain']);
    expect(p.dropped.map((d) => d.name).sort()).toEqual(['docs', 'tool']);
  });

  it('does not send a synced server in the spec and does not report it dropped', () => {
    const p = partitionExternalMcpServers(stored, undefined, { synced: new Set(['docs', 'tool', 'plain']), reasonFor: () => undefined });
    expect(p.passthrough).toEqual({});
    expect(p.dropped).toEqual([]);
  });

  it('reports an opted-in server that is not running with the sync reason', () => {
    const p = partitionExternalMcpServers(stored, undefined, { synced: new Set(['docs']), reasonFor: (n) => (n === 'tool' ? 'its definition changed and has not been confirmed' : undefined) });
    expect(p.dropped).toEqual([{ name: 'tool', reason: 'its definition changed and has not been confirmed' }]);
    expect(Object.keys(p.passthrough)).toEqual(['plain']);
  });
});

describe('settings migration', () => {
  it('leaves data without the field alone, drops entries for servers that are gone, and shape-checks the rest', () => {
    const none: RemoteDaemonConfig[] = [{ id: 'a', name: 'A', url: 'wss://a', tokenSecretName: 'T' }];
    normalizeDaemonMcpSync(none, new Set(['docs']));
    expect(none[0]).toEqual({ id: 'a', name: 'A', url: 'wss://a', tokenSecretName: 'T' });

    const d: RemoteDaemonConfig[] = [{ id: 'a', name: 'A', url: 'wss://a', tokenSecretName: 'T', mcpSync: { docs: { enabled: true, confirmedHash: 'h' }, gone: { enabled: true }, bad: 5 as never }, mcpSyncKinds: ['mcpsync-global', 7 as never] }];
    normalizeDaemonMcpSync(d, new Set(['docs', 'bad']));
    expect(d[0].mcpSync).toEqual({ docs: { enabled: true, confirmedHash: 'h' } });
    expect(d[0].mcpSyncKinds).toEqual(['mcpsync-global']);
  });
});

describe('scrubSecrets', () => {
  it('masks every occurrence of each value', () => {
    expect(scrubSecrets('a sk-aaaa b sk-aaaa c sk-bbbb', ['sk-aaaa', 'sk-bbbb'])).toBe('a *** b *** c ***');
  });
});

describe('wireTransport', () => {
  const client = (handler: (type: string, payload: any) => unknown) => ({ command: async (type: string, payload: unknown) => handler(type, payload) }) as never;

  it('maps a forbidden answer to "needs an admin token" and passes the reply through', async () => {
    const denied = wireTransport(client(() => { throw new DaemonCommandError('forbidden', 'nope'); }));
    await expect(denied.syncServers({})).rejects.toBeInstanceOf(NeedsAdminError);
    await expect(denied.pushCreds('k', { A: 'b' }, 1)).rejects.toBeInstanceOf(NeedsAdminError);
    expect(await denied.probeAdmin!()).toBe(false);
    const ok = wireTransport(client((type) => (type === 'mcp.sync' ? { accepted: ['a'] } : {})));
    expect(await ok.syncServers({ a: { type: 'http', url: 'https://x' } })).toEqual({ accepted: ['a'], rejected: [], requiredCreds: [], shadowed: [] });
    expect(await ok.probeAdmin!()).toBe(true);
  });

  it('the admin probe pushes no fields to a throwaway kind, so it changes nothing', async () => {
    const seen: Array<[string, unknown]> = [];
    await wireTransport(client((t, p) => { seen.push([t, p]); return {}; })).probeAdmin!();
    expect(seen).toEqual([['creds.push', { kind: 'mcpsync-probe', ttlSec: 0, fields: {} }]]);
  });
});
