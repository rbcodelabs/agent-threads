/**
 * `creds.push` end to end, daemon-owned MCP servers with `${NAME}` placeholders resolved from pushed credentials,
 * and the pushed per-server MCP status event.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeDriverFactory } from '../../daemon/claudeDriver';
import { CredStore } from '../../daemon/credStore';
import { parseDaemonMcpServers } from '../../daemon/mcpServers';
import { TestClient, startTestDaemon, sleep, type TestDaemon } from '../helpers/daemonTestClient';
import { ScriptedHarness, scriptedFactory } from '../helpers/scriptedHarness';

let workspace: string;
let dataDir: string;
let made: ScriptedHarness[];
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'creds-ws-')));
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'creds-data-')));
  mkdirSync(join(workspace, 'proj'));
  made = [];
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const MCP = parseDaemonMcpServers({
  docs: { type: 'http', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } },
  tool: { command: 'tool-server', env: { API_KEY: '${TOOL_KEY}' } },
});

async function daemon(): Promise<TestDaemon> {
  const td = await startTestDaemon({
    dataDir,
    config: { harness: 'claude', workspaces: [workspace] },
    driverFactory: createClaudeDriverFactory({ createHarness: scriptedFactory(made), env: {}, mcpServers: MCP, creds: new CredStore(dataDir) }),
  });
  cleanups.push(() => td.cleanup());
  return td;
}
async function client(td: TestDaemon, token = td.adminToken): Promise<TestClient> {
  const c = await TestClient.connect(td.daemon.url, token);
  cleanups.push(() => c.close().catch(() => {}));
  return c;
}
const spec = () => ({ harness: 'claude', cwd: join(workspace, 'proj'), permissionMode: 'default', extraEnvRaw: '', model: 'haiku' });
const harness = async (n = 0): Promise<ScriptedHarness> => {
  for (let i = 0; i < 100 && !made[n]?.options; i++) await sleep(5);
  return made[n];
};

describe('creds.push', () => {
  it('stores the fields privately, replies with names only, and audits without values', async () => {
    const td = await daemon();
    const c = await client(td);
    const reply = await c.cmd('creds.push', { kind: 'mcp', ttlSec: 0, fields: { DOCS_TOKEN: 'super-secret-docs-token', TOOL_KEY: 'super-secret-tool-key' } });
    expect(reply).toMatchObject({ type: 'ack', result: { kind: 'mcp', fields: ['DOCS_TOKEN', 'TOOL_KEY'], removed: false } });
    expect(JSON.stringify(reply)).not.toContain('super-secret');

    const file = join(dataDir, 'creds', 'mcp.json');
    expect(statSync(join(dataDir, 'creds')).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).fields.DOCS_TOKEN).toBe('super-secret-docs-token');

    await td.cleanup(); // flushes the audit log
    const audit = readFileSync(join(dataDir, 'audit.ndjson'), 'utf8');
    expect(audit).toContain('creds_push');
    expect(audit).not.toContain('super-secret');
  });

  it('refuses malformed pushes with bad_frame, leaves nothing behind, and removes a kind when pushed empty', async () => {
    const td = await daemon();
    const c = await client(td);
    expect(await c.cmd('creds.push', { kind: '../etc', ttlSec: 0, fields: { A: 'x' } })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(await c.cmd('creds.push', { kind: 'k', ttlSec: 0, fields: { 'bad name': 'x' } })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(await c.cmd('creds.push', { kind: 'k', ttlSec: -5, fields: { A: 'x' } })).toMatchObject({ type: 'err', code: 'bad_frame' });
    expect(existsSync(join(dataDir, 'creds', 'k.json'))).toBe(false);
    await c.cmd('creds.push', { kind: 'k', ttlSec: 0, fields: { A: 'aaaaaaaa' } });
    expect(existsSync(join(dataDir, 'creds', 'k.json'))).toBe(true);
    expect(await c.cmd('creds.push', { kind: 'k', ttlSec: 0, fields: {} })).toMatchObject({ type: 'ack', result: { removed: true } });
    expect(existsSync(join(dataDir, 'creds', 'k.json'))).toBe(false);
  });

  it('is admin only', async () => {
    const td = await daemon();
    const control = await client(td, td.daemon.tokens.create('ctl', 'control').token);
    expect(await control.cmd('creds.push', { kind: 'k', ttlSec: 0, fields: { A: 'x' } })).toMatchObject({ type: 'err', code: 'forbidden' });
  });

  it('advertises the capabilities', async () => {
    const td = await daemon();
    const c = await client(td);
    const welcome = c.frames.find((f) => f.type === 'welcome')!;
    expect(welcome.capabilities).toEqual(expect.arrayContaining(['creds.push', 'mcp.status']));
  });
});

describe('daemon MCP servers in a session', () => {
  it('fills placeholders from pushed credentials at session start, beside the client servers and claude_threads', async () => {
    const td = await daemon();
    const c = await client(td);
    await c.cmd('creds.push', { kind: 'mcp', ttlSec: 0, fields: { DOCS_TOKEN: 'tok-docs-123', TOOL_KEY: 'key-tool-456' } });
    await c.cmd('session.open', { threadId: 't', spec: { ...spec(), mcpServers: { client: { type: 'http', url: 'https://client.test' }, docs: { type: 'http', url: 'https://evil.test' } } } });
    const servers = (await harness()).options!.claude!.mcpServers as Record<string, any>;
    expect(Object.keys(servers).sort()).toEqual(['claude_threads', 'client', 'docs', 'tool']);
    expect(servers.docs).toEqual({ type: 'http', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer tok-docs-123' } });
    expect(servers.tool).toEqual({ type: 'stdio', command: 'tool-server', env: { API_KEY: 'key-tool-456' } });
    expect(servers.claude_threads.type).toBe('sdk');
  });

  it('leaves a server out while its credential is missing and reports it as failed', async () => {
    const td = await daemon();
    const c = await client(td);
    await c.cmd('creds.push', { kind: 'mcp', ttlSec: 0, fields: { DOCS_TOKEN: 'tok-docs-123' } });
    await c.cmd('session.open', { threadId: 't', spec: spec() });
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const h = await harness();
    expect(Object.keys(h.options!.claude!.mcpServers as object)).not.toContain('tool');
    h.cb.onMcpServerStatus!([{ name: 'docs', status: 'connected' }]);
    const ev = await c.waitFor((f) => f.name === 'onMcpServerStatus');
    expect(ev.args[0]).toEqual([
      { name: 'docs', status: 'connected' },
      { name: 'tool', status: 'failed', error: 'missing credential TOOL_KEY' },
    ]);
  });
});

describe('MCP status event', () => {
  it('pushes the init report, re-reads at turn end, and shows a server that died as failed', async () => {
    const td = await daemon();
    const c = await client(td);
    await c.cmd('creds.push', { kind: 'mcp', ttlSec: 0, fields: { DOCS_TOKEN: 'tok-docs-123', TOOL_KEY: 'key-tool-456' } });
    await c.cmd('session.open', { threadId: 't', spec: spec() });
    await c.cmd('attach', { ch: 't:t', afterSeq: 0 });
    const h = await harness();
    h.mcpStatus = [{ name: 'tool', status: 'connected' }];
    h.cb.onMcpServerStatus!([{ name: 'tool', status: 'connected' }]);
    const first = await c.waitFor((f) => f.name === 'onMcpServerStatus');
    expect(first.args[0]).toEqual([{ name: 'tool', status: 'connected' }]);

    // Unchanged status adds no journal entry; the killed server does.
    await c.cmd('session.send', { threadId: 't', text: 'go', userMessageUuid: 'u1' });
    h.finish('ok');
    await c.waitFor((f) => f.name === 'onDone');
    await sleep(50);
    expect(c.events().filter((f) => f.name === 'onMcpServerStatus')).toHaveLength(1);

    h.mcpStatus = [{ name: 'tool', status: 'failed' }];
    await c.cmd('session.send', { threadId: 't', text: 'again', userMessageUuid: 'u2' });
    h.finish('ok again');
    const failed = await c.waitFor((f) => f.name === 'onMcpServerStatus' && f.args[0][0].status === 'failed');
    expect(failed.args[0]).toEqual([{ name: 'tool', status: 'failed' }]);
  });
});
