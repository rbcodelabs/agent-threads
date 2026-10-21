/**
 * The app's McpSyncEngine against a REAL daemon over a real socket (the integration-level equivalent of an end-to-end
 * run on a daemon): opt in a stdio server that needs a keychain secret, see it start with the secret filled in,
 * rotate the secret, let the 30 day credential lapse and recover, lose the server again by turning it off, and be
 * refused (with the reason) when the stored token is not an admin token.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClaudeDriverFactory } from '../../daemon/claudeDriver';
import { CredStore } from '../../daemon/credStore';
import { SyncedMcpStore } from '../../daemon/syncedMcp';
import { DaemonClient, type WebSocketFactory } from '../../src/remote/DaemonClient';
import { McpSyncEngine, wireTransport } from '../../src/remote/mcpSync';
import type { RemoteDaemonConfig } from '../../src/types';
import { TestClient, startTestDaemon, sleep, type TestDaemon } from '../helpers/daemonTestClient';
import { ScriptedHarness, scriptedFactory } from '../helpers/scriptedHarness';

const wsFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as ReturnType<WebSocketFactory>;
const cleanups: Array<() => Promise<void> | void> = [];
let workspace: string;
let dataDir: string;
let made: ScriptedHarness[];
let now: number;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'mcpe2e-ws-')));
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcpe2e-data-')));
  mkdirSync(join(workspace, 'proj'));
  made = [];
  now = 1_700_000_000_000;
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const STDIO = { type: 'stdio', command: 'tool-server', args: ['--serve'], env: { API_KEY: '${TOOL_KEY}' } };

async function rig(token: 'admin' | 'control') {
  const td: TestDaemon = await startTestDaemon({
    dataDir,
    now: () => now,
    config: { harness: 'claude', workspaces: [workspace], allowSyncedStdio: true },
    driverFactory: createClaudeDriverFactory({
      createHarness: scriptedFactory(made), env: {}, creds: new CredStore(dataDir, () => now),
      syncedMcp: new SyncedMcpStore(dataDir, { allowStdio: true, commandAllowlist: [] }), now: () => now,
    }),
  });
  cleanups.push(() => td.cleanup());
  const tokenValue = token === 'admin' ? td.adminToken : td.daemon.tokens.create('ctl', 'control').token;
  const client = new DaemonClient({ url: td.daemon.url, getToken: () => tokenValue, createSocket: wsFactory, clientVersion: '0.0.0-test', idleProbeMs: 60_000 });
  cleanups.push(() => client.dispose());
  client.connect();
  for (let i = 0; i < 200 && !client.daemonInfo; i++) await sleep(10);
  const daemon: RemoteDaemonConfig = { id: 'd1', name: 'Box', url: td.daemon.url, tokenSecretName: 'T' };
  const settings: { mcpServers: Record<string, unknown>; secretEnvKeys: string[]; remoteDaemons: RemoteDaemonConfig[] } = { mcpServers: { tool: STDIO }, secretEnvKeys: ['TOOL_KEY'], remoteDaemons: [daemon] };
  const secrets: Record<string, string> = { TOOL_KEY: 'key-one-aaaa' };
  const engine = new McpSyncEngine({
    daemons: () => settings.remoteDaemons, settings: () => settings, readSecret: (n) => secrets[n],
    capabilitiesOf: () => client.daemonInfo?.capabilities, transportFor: () => wireTransport(client), saveSettings: async () => {},
  });
  const admin = await TestClient.connect(td.daemon.url, td.adminToken);
  cleanups.push(() => admin.close().catch(() => {}));
  let n = 0;
  /** Open a fresh session as the user would and return the MCP servers its harness was started with. */
  const openSession = async (): Promise<Record<string, any>> => {
    const id = `t${n++}`;
    await admin.cmd('session.open', { threadId: id, spec: { harness: 'claude', cwd: join(workspace, 'proj'), permissionMode: 'default', extraEnvRaw: '', model: 'haiku' } });
    const idx = made.length - 1;
    for (let i = 0; i < 100 && !made[idx]?.options; i++) await sleep(5);
    return made[idx].options!.claude!.mcpServers as Record<string, any>;
  };
  return { td, client, daemon, settings, secrets, engine, admin, openSession };
}

describe('McpSyncEngine against a real daemon', () => {
  it('runs a stdio server with a keychain secret, follows rotation and TTL lapse, and stops when turned off', async () => {
    const r = await rig('admin');
    expect(r.client.daemonInfo?.capabilities).toEqual(expect.arrayContaining(['mcp.sync', 'mcp.sync.stdio']));
    expect(r.engine.availability('d1', r.engine.evaluate('tool'))).toEqual({ ok: true });

    await r.engine.setEnabled('d1', 'tool', true, r.engine.evaluate('tool')!.hash);
    await r.engine.sync('d1', 'force');
    expect(r.engine.statusOf('d1', 'tool')).toEqual({ state: 'synced', shadowed: false });
    // The wire form is project-qualified; the value sits only in the credential kind.
    expect(JSON.parse(readFileSync(join(dataDir, 'synced-mcp.json'), 'utf8')).servers.tool.def.env.API_KEY).toBe('${mcpsync-global.TOOL_KEY}');
    expect(readFileSync(join(dataDir, 'synced-mcp.json'), 'utf8')).not.toContain('key-one-aaaa');

    let servers = await r.openSession();
    expect(servers.tool).toEqual({ type: 'stdio', command: 'tool-server', args: ['--serve'], env: { API_KEY: 'key-one-aaaa' } });

    // Rotation: the next session carries the new value without a daemon restart.
    r.secrets.TOOL_KEY = 'key-two-bbbb';
    await r.engine.sync('d1', 'normal');
    servers = await r.openSession();
    expect(servers.tool.env.API_KEY).toBe('key-two-bbbb');

    // TTL lapse (30 days): the server is not started and shows as failed until the app pushes again (reconnect / Push now).
    now += 31 * 24 * 3600_000;
    servers = await r.openSession();
    expect(servers.tool).toBeUndefined();
    await r.engine.pushNow('d1');
    servers = await r.openSession();
    expect(servers.tool.env.API_KEY).toBe('key-two-bbbb');

    // Off: the definition and the credential kind are gone from the daemon.
    await r.engine.setEnabled('d1', 'tool', false);
    await r.engine.sync('d1', 'force');
    servers = await r.openSession();
    expect(servers.tool).toBeUndefined();
    expect(existsSync(join(dataDir, 'creds', 'mcpsync-global.json'))).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(join(dataDir, 'synced-mcp.json'), 'utf8')).servers)).toEqual([]);
  });

  it('is refused with the reason, and changes nothing, when the stored token is not an admin token', async () => {
    const r = await rig('control');
    await r.engine.probeAdmin('d1');
    expect(r.engine.availability('d1')).toMatchObject({ ok: false, code: 'needs-admin' });
    await r.engine.setEnabled('d1', 'tool', true, r.engine.evaluate('tool')!.hash).catch(() => {});
    await r.engine.sync('d1', 'force');
    expect(r.engine.statusOf('d1', 'tool')).toMatchObject({ state: 'error', reason: expect.stringMatching(/admin token/i) });
    expect(existsSync(join(dataDir, 'synced-mcp.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'creds', 'mcpsync-global.json'))).toBe(false);
  });
});
