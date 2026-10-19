/**
 * `mcp.sync` end to end: admin only, full replace, persistence, precedence against config.json, credentials by the
 * qualified `mcpsync-<project>.NAME` form (expiry and absence show as failed), and no definition or value reaching
 * `sessions/<id>.json`, the audit log or any reply.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeDriverFactory } from '../../daemon/claudeDriver';
import { CredStore } from '../../daemon/credStore';
import { parseDaemonMcpServers } from '../../daemon/mcpServers';
import { SyncedMcpStore } from '../../daemon/syncedMcp';
import { TestClient, startTestDaemon, sleep, type TestDaemon } from '../helpers/daemonTestClient';
import { ScriptedHarness, scriptedFactory } from '../helpers/scriptedHarness';

let workspace: string;
let dataDir: string;
let made: ScriptedHarness[];
const cleanups: Array<() => Promise<void>> = [];
const SECRET = 'sk-very-secret-value-123';

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'mcpsync-ws-')));
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpsync-data-')));
  mkdirSync(join(workspace, 'proj'));
  made = [];
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const DOCS = { type: 'http', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer ${mcpsync-proj.DOCS_TOKEN}' } };
const TOOL = { command: 'tool-server', args: ['--k', '${mcpsync-proj.TOOL_KEY}'], env: { API_KEY: '${mcpsync-proj.TOOL_KEY}' } };

interface Opts { allowStdio?: boolean; allowlist?: string[]; configServers?: unknown; now?: () => number }
async function daemon(o: Opts = {}): Promise<TestDaemon> {
  // The operator's servers live in config.json: the daemon's shadowing report reads them from there.
  if (o.configServers) writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ mcpServers: o.configServers }));
  const creds = new CredStore(dataDir, o.now);
  const synced = new SyncedMcpStore(dataDir, { allowStdio: o.allowStdio ?? true, commandAllowlist: o.allowlist ?? [] });
  const td = await startTestDaemon({
    dataDir,
    ...(o.now ? { now: o.now } : {}),
    config: { harness: 'claude', workspaces: [workspace], allowSyncedStdio: o.allowStdio ?? true, ...(o.allowlist ? { syncedCommandAllowlist: o.allowlist } : {}) },
    driverFactory: createClaudeDriverFactory({
      createHarness: scriptedFactory(made),
      env: {},
      mcpServers: parseDaemonMcpServers(o.configServers),
      syncedMcp: synced,
      creds,
      ...(o.now ? { now: o.now } : {}),
    }),
  });
  cleanups.push(() => td.cleanup());
  return td;
}
async function client(td: TestDaemon, token = td.adminToken): Promise<TestClient> {
  const c = await TestClient.connect(td.daemon.url, token);
  cleanups.push(() => c.close().catch(() => {}));
  return c;
}
const spec = (extra: object = {}) => ({ harness: 'claude', cwd: join(workspace, 'proj'), permissionMode: 'default', extraEnvRaw: '', model: 'haiku', ...extra });
const harness = async (n = 0): Promise<ScriptedHarness> => {
  for (let i = 0; i < 100 && !made[n]?.options; i++) await sleep(5);
  return made[n];
};

describe('mcp.sync command', () => {
  it('stores the definitions, replies with names only, persists 0600 and audits without values', async () => {
    const td = await daemon();
    const c = await client(td);
    const reply = await c.cmd('mcp.sync', { servers: { docs: DOCS, tool: TOOL, bad: { type: 'http' } } });
    expect(reply).toMatchObject({
      type: 'ack',
      result: {
        accepted: ['docs', 'tool'],
        rejected: [{ name: 'bad', reason: expect.stringContaining('url') }],
        requiredCreds: ['mcpsync-proj.DOCS_TOKEN', 'mcpsync-proj.TOOL_KEY'],
        shadowed: [],
      },
    });
    expect(statSync(join(dataDir, 'synced-mcp.json')).mode & 0o777).toBe(0o600);
    await td.cleanup();
    const audit = readFileSync(join(dataDir, 'audit.ndjson'), 'utf8');
    const rec = audit.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.event === 'mcp_sync');
    expect(rec).toMatchObject({ names: ['docs', 'tool'], added: ['docs', 'tool'], removed: [] });
    expect(audit).not.toContain('docs.example.test');
    expect(audit).not.toContain('tool-server');
  });

  it('is a full replace across calls', async () => {
    const td = await daemon();
    const c = await client(td);
    await c.cmd('mcp.sync', { servers: { docs: DOCS, tool: TOOL } });
    const second = await c.cmd('mcp.sync', { servers: { docs: DOCS } });
    expect(second).toMatchObject({ type: 'ack', result: { accepted: ['docs'] } });
    expect(Object.keys(JSON.parse(readFileSync(join(dataDir, 'synced-mcp.json'), 'utf8')).servers)).toEqual(['docs']);
    expect(await c.cmd('mcp.sync', { servers: {} })).toMatchObject({ type: 'ack', result: { accepted: [] } });
  });

  it('refuses control and read tokens, and malformed frames', async () => {
    const td = await daemon();
    for (const scope of ['read', 'control'] as const) {
      const c = await client(td, td.daemon.tokens.create(`t-${scope}`, scope).token);
      expect(await c.cmd('mcp.sync', { servers: { docs: DOCS } })).toMatchObject({ type: 'err', code: 'forbidden' });
    }
    expect(existsSync(join(dataDir, 'synced-mcp.json'))).toBe(false);
    const admin = await client(td);
    expect(await admin.cmd('mcp.sync', { servers: [] })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(await admin.cmd('mcp.sync', { servers: { a: 'x' } })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(await admin.cmd('mcp.sync', {})).toMatchObject({ type: 'err', code: 'bad_frame' });
  });

  it('advertises mcp.sync, and mcp.sync.stdio only when stdio is allowed', async () => {
    const on = await daemon({ allowStdio: true });
    const c1 = await client(on);
    expect(c1.frames.find((f) => f.type === 'welcome')!.capabilities).toEqual(expect.arrayContaining(['mcp.sync', 'mcp.sync.stdio']));
    const off = await daemon({ allowStdio: false });
    const c2 = await client(off);
    const caps = c2.frames.find((f) => f.type === 'welcome')!.capabilities as string[];
    expect(caps).toContain('mcp.sync');
    expect(caps).not.toContain('mcp.sync.stdio');
  });

  it('rejects stdio by name when allowSyncedStdio is off, and by allowlist when set', async () => {
    const off = await client(await daemon({ allowStdio: false }));
    expect(await off.cmd('mcp.sync', { servers: { docs: DOCS, tool: TOOL } })).toMatchObject({
      result: { accepted: ['docs'], rejected: [{ name: 'tool', reason: expect.stringContaining('allowSyncedStdio') }] },
    });
    const listed = await client(await daemon({ allowStdio: true, allowlist: ['other-server'] }));
    expect(await listed.cmd('mcp.sync', { servers: { tool: TOOL } })).toMatchObject({
      result: { accepted: [], rejected: [{ name: 'tool', reason: expect.stringContaining('allowlist') }] },
    });
  });
});

describe('synced servers in a session', () => {
  it('fills qualified placeholders from the project kind, beside client servers, and config.json wins a name clash', async () => {
    const td = await daemon({ configServers: { docs: { type: 'http', url: 'https://operator.test/mcp' } } });
    const c = await client(td);
    await c.cmd('creds.push', { kind: 'mcpsync-proj', ttlSec: 0, fields: { DOCS_TOKEN: SECRET, TOOL_KEY: 'key-456' } });
    const sync = await c.cmd('mcp.sync', { servers: { docs: DOCS, tool: TOOL } });
    expect(sync).toMatchObject({ result: { shadowed: ['docs'] } });
    await c.cmd('session.open', { threadId: 't', spec: spec({ mcpServers: { client: { type: 'http', url: 'https://client.test' }, tool: { type: 'http', url: 'https://spec.test' } } }) });
    const servers = (await harness()).options!.claude!.mcpServers as Record<string, any>;
    expect(Object.keys(servers).sort()).toEqual(['claude_threads', 'client', 'docs', 'tool']);
    expect(servers.docs).toEqual({ type: 'http', url: 'https://operator.test/mcp' });
    // synced beats the spec passthrough of the same name
    expect(servers.tool).toEqual({ type: 'stdio', command: 'tool-server', args: ['--k', 'key-456'], env: { API_KEY: 'key-456' } });
  });

  it('does not let one project\'s credentials fill another project\'s servers', async () => {
    const td = await daemon();
    const c = await client(td);
    await c.cmd('creds.push', { kind: 'mcpsync-other', ttlSec: 0, fields: { DOCS_TOKEN: 'other-projects-secret' } });
    await c.cmd('mcp.sync', { servers: { docs: DOCS } });
    await c.cmd('session.open', { threadId: 't', spec: spec() });
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const h = await harness();
    expect(Object.keys(h.options!.claude!.mcpServers as object)).not.toContain('docs');
    h.cb.onMcpServerStatus!([]);
    const ev = await c.waitFor((f) => f.name === 'onMcpServerStatus');
    expect(ev.args[0]).toEqual([{ name: 'docs', status: 'failed', error: 'missing credential mcpsync-proj.DOCS_TOKEN' }]);
  });

  it('shows a server as failed once its credential lapses, and recovers when it is pushed again', async () => {
    let now = 1_000_000;
    const td = await daemon({ now: () => now });
    const c = await client(td);
    await c.cmd('creds.push', { kind: 'mcpsync-proj', ttlSec: 60, fields: { DOCS_TOKEN: SECRET } });
    await c.cmd('mcp.sync', { servers: { docs: DOCS } });
    await c.cmd('session.open', { threadId: 'a', spec: spec() });
    expect(Object.keys((await harness(0)).options!.claude!.mcpServers as object)).toContain('docs');

    now += 61_000;
    await c.cmd('session.open', { threadId: 'b', spec: spec() });
    await c.cmd('attach', { ch: 't:b', afterSeq: 0 });
    const h1 = await harness(1);
    expect(Object.keys(h1.options!.claude!.mcpServers as object)).not.toContain('docs');
    h1.cb.onMcpServerStatus!([]);
    const ev = await c.waitFor((f) => f.ch === 't:b' && f.name === 'onMcpServerStatus');
    expect(ev.args[0]).toEqual([{ name: 'docs', status: 'failed', error: 'missing credential mcpsync-proj.DOCS_TOKEN' }]);

    await c.cmd('creds.push', { kind: 'mcpsync-proj', ttlSec: 60, fields: { DOCS_TOKEN: 'rotated-token' } });
    await c.cmd('session.open', { threadId: 'c', spec: spec() });
    const servers = (await harness(2)).options!.claude!.mcpServers as Record<string, any>;
    expect(servers.docs.headers.Authorization).toBe('Bearer rotated-token');
  });

  it('stops starting a synced stdio server when the operator turns allowSyncedStdio off', async () => {
    const td = await daemon({ allowStdio: true });
    const c = await client(td);
    await c.cmd('creds.push', { kind: 'mcpsync-proj', ttlSec: 0, fields: { TOOL_KEY: 'k' } });
    await c.cmd('mcp.sync', { servers: { tool: TOOL } });
    await td.cleanup();
    made.length = 0;
    const strict = await daemon({ allowStdio: false });
    const c2 = await client(strict);
    await c2.cmd('session.open', { threadId: 't', spec: spec() });
    const servers = (await harness()).options!.claude!.mcpServers as Record<string, any>;
    expect(Object.keys(servers)).not.toContain('tool');
  });

  it('never writes a synced definition or a secret into sessions/<id>.json, replies, or the journal', async () => {
    const td = await daemon();
    const c = await client(td);
    const pushed = await c.cmd('creds.push', { kind: 'mcpsync-proj', ttlSec: 0, fields: { DOCS_TOKEN: SECRET, TOOL_KEY: 'key-456' } });
    const synced = await c.cmd('mcp.sync', { servers: { docs: DOCS, tool: TOOL } });
    await c.cmd('session.open', { threadId: 't', spec: spec() });
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const h = await harness();
    h.cb.onMcpServerStatus!([{ name: 'docs', status: 'connected' }]);
    await c.waitFor((f) => f.name === 'onMcpServerStatus');
    await sleep(50);
    await td.cleanup();

    const sessionFile = readFileSync(join(dataDir, 'sessions', 't.json'), 'utf8');
    expect(sessionFile).not.toContain('docs.example.test');
    expect(sessionFile).not.toContain('tool-server');
    expect(sessionFile).not.toContain(SECRET);
    expect(sessionFile).not.toContain('mcpsync-proj');
    const everything = JSON.stringify([pushed, synced, c.frames]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('key-456');
    for (const f of readdirSync(join(dataDir, 'journal'), { recursive: true }).map(String).filter((n) => n.endsWith('.ndjson') || n.endsWith('.json'))) {
      expect(readFileSync(join(dataDir, 'journal', f), 'utf8')).not.toContain(SECRET);
    }
    expect(JSON.stringify(JSON.parse(readFileSync(join(dataDir, 'synced-mcp.json'), 'utf8')))).not.toContain(SECRET);
  });
});
