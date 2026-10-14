import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateDaemonId, resolveConfig } from '../../daemon/config';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'cfg-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('resolveConfig', () => {
  it('defaults to loopback:7433 and takes DATA_DIR from the environment', () => {
    const dir = tmp();
    const c = resolveConfig({ env: { DATA_DIR: dir } });
    expect(c).toMatchObject({ dataDir: dir, listen: '127.0.0.1', port: 7433, allowedOrigins: [] });
  });

  it('flag beats env beats config.json', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 1111, listen: '127.0.0.2', allowedOrigins: ['app://file'] }));
    expect(resolveConfig({ env: { DATA_DIR: dir } })).toMatchObject({ port: 1111, listen: '127.0.0.2', allowedOrigins: ['app://file'] });
    expect(resolveConfig({ env: { DATA_DIR: dir, AGENT_THREADS_PORT: '2222' } }).port).toBe(2222);
    expect(resolveConfig({ env: { DATA_DIR: dir, AGENT_THREADS_PORT: '2222' }, flags: { port: 3333 } }).port).toBe(3333);
    expect(resolveConfig({ flags: { dataDir: dir }, env: { DATA_DIR: '/nonexistent' } }).dataDir).toBe(dir);
  });

  it('requires an explicit acknowledgement to bind a wildcard address', () => {
    const dir = tmp();
    expect(() => resolveConfig({ env: { DATA_DIR: dir }, flags: { listen: '0.0.0.0' } })).toThrow(/i-know-this-is-open/);
    expect(resolveConfig({ env: { DATA_DIR: dir }, flags: { listen: '0.0.0.0', acknowledgeOpen: true } }).listen).toBe('0.0.0.0');
    // A specific (e.g. tailnet) address needs no acknowledgement.
    expect(resolveConfig({ env: { DATA_DIR: dir }, flags: { listen: '100.64.0.5' } }).listen).toBe('100.64.0.5');
  });

  it('persists a stable daemonId', () => {
    const dir = tmp();
    const id = loadOrCreateDaemonId(dir);
    expect(loadOrCreateDaemonId(dir)).toBe(id);
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).daemonId).toBe(id);
  });

  it('rejects an invalid port', () => {
    expect(() => resolveConfig({ env: { DATA_DIR: tmp() }, flags: { port: 70000 } })).toThrow(/invalid port/);
  });
});
