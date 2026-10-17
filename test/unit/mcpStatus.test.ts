import { describe, expect, it } from 'vitest';
import { DaemonMcpStatusStore, describeMcpServer, parseInitMcpServers } from '../../src/mcpStatus';

describe('parseInitMcpServers', () => {
  it('maps the SDK init mcp_servers array', () => {
    expect(parseInitMcpServers([
      { name: 'a', status: 'connected' },
      { name: 'b', status: 'failed', error: 'spawn ENOENT' },
      { name: 'c' },
      { status: 'connected' },
      'junk',
    ])).toEqual([
      { name: 'a', status: 'connected' },
      { name: 'b', status: 'failed', error: 'spawn ENOENT' },
      { name: 'c', status: 'unknown' },
    ]);
  });
  it('is null when init carries no list', () => {
    expect(parseInitMcpServers(undefined)).toBeNull();
    expect(parseInitMcpServers({})).toBeNull();
    expect(parseInitMcpServers([])).toEqual([]);
  });
});

describe('describeMcpServer', () => {
  it('flags anything but connected, and shows the reason', () => {
    expect(describeMcpServer({ name: 'a', status: 'connected' })).toEqual({ text: 'a: connected', ok: true });
    expect(describeMcpServer({ name: 'b', status: 'failed', error: 'boom' })).toEqual({ text: 'b: failed (boom)', ok: false });
    expect(describeMcpServer({ name: 'c', status: 'needs-auth' })).toEqual({ text: 'c: needs sign-in', ok: false });
  });
});

describe('DaemonMcpStatusStore', () => {
  it('keeps the latest report per daemon', () => {
    const store = new DaemonMcpStatusStore(() => 5);
    expect(store.get('d1')).toBeUndefined();
    store.set('d1', [{ name: 'a', status: 'connected' }]);
    store.set('d1', [{ name: 'a', status: 'failed' }]);
    expect(store.get('d1')).toEqual({ at: 5, servers: [{ name: 'a', status: 'failed' }] });
    expect(store.get('d2')).toBeUndefined();
  });
});
