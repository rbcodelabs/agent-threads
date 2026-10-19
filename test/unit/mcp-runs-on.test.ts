import { describe, expect, it } from 'vitest';
import { buildRunsOnRows, describeSyncConfirmation } from '../../src/mcpRunsOn';
import { evaluateServer, type EvalContext, type McpSyncAvailability, type McpSyncServerStatus } from '../../src/remote/mcpSync';
import type { RemoteDaemonConfig } from '../../src/types';

const CTX: EvalContext = { secretKeys: ['DOCS_TOKEN'], secretScopes: { DOCS_TOKEN: ['proj-a'] }, oauthNames: new Set() };
const GLOBAL: EvalContext = { ...CTX, secretScopes: {} };
const daemons: RemoteDaemonConfig[] = [
  { id: 'a', name: 'Homelab', url: 'wss://a', tokenSecretName: 'A' },
  { id: 'b', name: 'Old box', url: 'wss://b', tokenSecretName: 'B' },
];

function engine(over: { enabled?: string[]; avail?: Record<string, McpSyncAvailability>; status?: Record<string, McpSyncServerStatus> } = {}) {
  return {
    entryOf: (id: string) => (over.enabled?.includes(id) ? { enabled: true, confirmedHash: 'h' } : undefined),
    availability: (id: string): McpSyncAvailability => over.avail?.[id] ?? { ok: true },
    statusOf: (id: string): McpSyncServerStatus => over.status?.[id] ?? { state: 'off' },
  };
}
const http = evaluateServer('docs', { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } }, GLOBAL);

describe('buildRunsOnRows', () => {
  it('offers an enabled-able toggle per daemon, off by default', () => {
    const rows = buildRunsOnRows({ engine: engine(), daemons, server: http, reported: () => undefined });
    expect(rows).toEqual([
      { daemonId: 'a', daemonName: 'Homelab', checked: false, disabled: false },
      { daemonId: 'b', daemonName: 'Old box', checked: false, disabled: false },
    ]);
  });

  it.each([
    ['daemon too old', { ok: false, code: 'daemon-too-old', reason: 'This daemon is too old to receive MCP servers. Update it.' }],
    ['needs an admin token', { ok: false, code: 'needs-admin', reason: 'Needs an admin token. Create one with `agent-threads token create --scope admin` on the daemon and use it for this daemon.' }],
    ['stdio forbidden', { ok: false, code: 'stdio-forbidden', reason: 'This daemon does not accept programs from the app (its operator must enable allowSyncedStdio).' }],
  ] as const)('disables the toggle with the reason: %s', (_l, avail) => {
    const [row] = buildRunsOnRows({ engine: engine({ avail: { a: avail } }), daemons: [daemons[0]], server: http, reported: () => undefined });
    expect(row).toMatchObject({ disabled: true, checked: false, reason: avail.reason });
  });

  it.each([
    ['an oauth server', 'linear', { type: 'http', url: 'https://mcp.linear.app' }, { ...GLOBAL, oauthNames: new Set(['linear']) }, /OAuth/],
    ['a loopback-only server', 'loc', { type: 'http', url: 'http://localhost:9/mcp' }, GLOBAL, /localhost/],
  ])('disables every daemon for %s', (_l, name, def, ctx, reason) => {
    const ev = evaluateServer(name, def, ctx);
    const rows = buildRunsOnRows({ engine: engine(), daemons, server: ev, reported: () => undefined });
    expect(rows.every((r) => r.disabled && r.reason && reason.test(r.reason))).toBe(true);
  });

  it('shows the status chip from the daemon\'s own report once synced', () => {
    const synced: McpSyncServerStatus = { state: 'synced', shadowed: false };
    const row = (reported: Array<{ name: string; status: string; error?: string }> | undefined) =>
      buildRunsOnRows({ engine: engine({ enabled: ['a'], status: { a: synced } }), daemons: [daemons[0]], server: http, reported: () => reported })[0];
    expect(row(undefined).chip).toEqual({ kind: 'neutral', text: 'Synced; not started yet' });
    expect(row([{ name: 'docs', status: 'connected' }]).chip).toEqual({ kind: 'ok', text: 'Connected' });
    expect(row([{ name: 'docs', status: 'needs-auth' }]).chip).toEqual({ kind: 'warn', text: 'Needs sign-in' });
    const failed = row([{ name: 'docs', status: 'failed', error: 'missing credential mcpsync-global.DOCS_TOKEN' }]);
    expect(failed.chip).toEqual({ kind: 'bad', text: 'Failed: missing credential mcpsync-global.DOCS_TOKEN' });
    expect(failed.action).toBe('push-now');
    expect(row([{ name: 'docs', status: 'failed', error: 'spawn ENOENT' }]).action).toBeUndefined();
    expect(row([{ name: 'other', status: 'failed' }]).chip?.kind).toBe('neutral');
  });

  it('shows shadowing, changed definitions, missing secrets and refusals', () => {
    const one = (status: McpSyncServerStatus) => buildRunsOnRows({ engine: engine({ enabled: ['a'], status: { a: status } }), daemons: [daemons[0]], server: http, reported: () => undefined })[0];
    expect(one({ state: 'synced', shadowed: true }).note).toMatch(/config\.json/);
    expect(one({ state: 'needs-confirm' })).toMatchObject({ action: 'review', chip: { kind: 'warn' } });
    expect(one({ state: 'missing-secret', names: ['DOCS_TOKEN'] }).chip?.text).toContain('DOCS_TOKEN');
    expect(one({ state: 'rejected', reason: 'stdio servers are not allowed' }).chip).toEqual({ kind: 'bad', text: 'Refused by the daemon: stdio servers are not allowed' });
    expect(one({ state: 'error', reason: 'needs an admin token' }).chip?.kind).toBe('bad');
  });

  it('keeps an enabled toggle usable even when the daemon can no longer take servers, and says why', () => {
    const [row] = buildRunsOnRows({ engine: engine({ enabled: ['a'], avail: { a: { ok: false, code: 'daemon-too-old', reason: 'too old' } }, status: { a: { state: 'error', reason: 'too old' } } }), daemons: [daemons[0]], server: http, reported: () => undefined });
    expect(row).toMatchObject({ checked: true, disabled: false, reason: 'too old' });
  });
});

describe('describeSyncConfirmation', () => {
  it('shows the exact command, arguments, env NAMES and the secret names, never a value', () => {
    const ev = evaluateServer('tool', { type: 'stdio', command: '/opt/bin/tool-server', args: ['--mode', 'x y', '--key', '${DOCS_TOKEN}'], env: { API_KEY: '${DOCS_TOKEN}', REGION: 'eu' } }, GLOBAL);
    const c = describeSyncConfirmation(ev, { name: 'Homelab' })!;
    expect(c.title).toBe('Run "tool" on Homelab?');
    expect(c.details).toEqual([{ label: 'Command', value: '/opt/bin/tool-server' }, { label: 'Arguments', value: '--mode x y --key ${DOCS_TOKEN}' }]);
    expect(c.envNames).toEqual(['API_KEY', 'REGION']);
    expect(JSON.stringify(c)).not.toContain('"eu"');
    expect(c.secretNames).toEqual(['DOCS_TOKEN']);
    expect(c.warnings[0]).toMatch(/starts a program on Homelab/);
  });

  it('shows the URL and header names for an http server, and warns about a project-limited secret', () => {
    const ev = evaluateServer('docs', { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer ${DOCS_TOKEN}' } }, CTX);
    const c = describeSyncConfirmation(ev, { name: 'Homelab' })!;
    expect(c.details).toEqual([{ label: 'URL', value: 'https://x.test/mcp' }]);
    expect(c.headerNames).toEqual(['Authorization']);
    expect(c.warnings.join(' ')).toMatch(/limited to one project/);
  });

  it('has nothing to confirm for a server that cannot be synced', () => {
    expect(describeSyncConfirmation(evaluateServer('l', { type: 'http', url: 'http://localhost:1/x' }, GLOBAL), { name: 'Homelab' })).toBeUndefined();
  });
});
