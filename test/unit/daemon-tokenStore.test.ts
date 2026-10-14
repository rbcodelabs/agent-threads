import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FailureThrottle } from '../../daemon/failureThrottle';
import { CommandCache } from '../../daemon/cmdCache';
import { TokenStore, scopeSatisfies, sha256Hex } from '../../daemon/tokenStore';
import { runCli } from '../../daemon/cli';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'tok-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('TokenStore', () => {
  it('stores only the SHA-256, 0600, and verifies the plaintext', () => {
    const dir = tmp();
    const store = new TokenStore(dir);
    const { token, record } = store.create('laptop', 'control');
    expect(token).toMatch(/^atd_[A-Za-z0-9_-]{43}$/); // 256 bits, base64url
    const raw = readFileSync(join(dir, 'tokens.json'), 'utf8');
    expect(raw).not.toContain(token);
    expect(raw).toContain(sha256Hex(token));
    expect(statSync(join(dir, 'tokens.json')).mode & 0o777).toBe(0o600);
    expect(store.verify(token)).toEqual({ id: record.id, name: 'laptop', scope: 'control' });
    expect(store.verify(`${token}x`)).toBeNull();
    expect(store.verify('')).toBeNull();
  });

  it('revocation takes effect, including from another process writing the file', () => {
    const dir = tmp();
    const daemon = new TokenStore(dir);
    const { token, record } = daemon.create('a', 'read');
    const cli = new TokenStore(dir);
    expect(cli.revoke(record.id)).toBe(true);
    expect(daemon.verify(token)).toBeNull();
    expect(daemon.isActive(record.id)).toBe(false);
    expect(cli.revoke(record.id)).toBe(false);
  });

  it('picks up tokens created by a separate store instance without restart', () => {
    const dir = tmp();
    const daemon = new TokenStore(dir);
    expect(daemon.hasActiveTokens).toBe(false);
    const { token } = new TokenStore(dir).create('later', 'admin');
    expect(daemon.verify(token)?.scope).toBe('admin');
  });

  it('records lastUsedAt', () => {
    const dir = tmp();
    let now = 1000;
    const store = new TokenStore(dir, () => now);
    const { token } = store.create('t', 'read');
    now = 5000;
    store.verify(token);
    expect(store.list()[0].lastUsedAt).toBe(5000);
  });

  it('orders scopes read < control < admin', () => {
    expect(scopeSatisfies('admin', 'control')).toBe(true);
    expect(scopeSatisfies('control', 'read')).toBe(true);
    expect(scopeSatisfies('read', 'control')).toBe(false);
  });

  it('rejects a corrupt tokens.json loudly rather than allowing everyone', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'tokens.json'), '{"not":"an array"}');
    expect(() => new TokenStore(dir)).toThrow(/JSON array/);
  });
});

describe('FailureThrottle', () => {
  it('blocks after the limit and recovers when failures age out or on success', () => {
    let now = 0;
    const t = new FailureThrottle(3, 1000, () => now);
    t.recordFailure('1.1.1.1'); t.recordFailure('1.1.1.1');
    expect(t.isBlocked('1.1.1.1')).toBe(false);
    t.recordFailure('1.1.1.1');
    expect(t.isBlocked('1.1.1.1')).toBe(true);
    expect(t.isBlocked('2.2.2.2')).toBe(false);
    now = 1001;
    expect(t.isBlocked('1.1.1.1')).toBe(false);
    t.recordFailure('1.1.1.1'); t.recordFailure('1.1.1.1'); t.recordFailure('1.1.1.1');
    t.reset('1.1.1.1');
    expect(t.isBlocked('1.1.1.1')).toBe(false);
  });
});

describe('CommandCache', () => {
  it('replays within the TTL, expires after, and isolates tokens', () => {
    let now = 0;
    const c = new CommandCache(10 * 60_000, () => now);
    const reply = { v: 1 as const, type: 'ack' as const, cmdId: 'c1' };
    c.set('tokA', 'c1', reply);
    expect(c.get('tokA', 'c1')).toBe(reply);
    expect(c.get('tokB', 'c1')).toBeUndefined();
    now = 10 * 60_000 + 1;
    expect(c.get('tokA', 'c1')).toBeUndefined();
  });
});

describe('agent-threads token CLI', () => {
  it('create prints the token once; list never shows it; revoke works', async () => {
    const dir = tmp();
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(`ERR ${l}`) };
    expect(await runCli(['token', 'create', '--name', 'ci', '--scope', 'admin', '--data-dir', dir], io)).toBe(0);
    const token = /token:\s+(\S+)/.exec(out.join('\n'))![1];
    const id = /id:\s+(\S+)/.exec(out.join('\n'))![1];
    out.length = 0;
    expect(await runCli(['token', 'list', '--data-dir', dir], io)).toBe(0);
    expect(out.join('\n')).toContain('ci');
    expect(out.join('\n')).not.toContain(token);
    out.length = 0;
    expect(await runCli(['token', 'revoke', id, '--data-dir', dir], io)).toBe(0);
    expect(new TokenStore(dir).verify(token)).toBeNull();
    expect(await runCli(['token', 'revoke', id, '--data-dir', dir], io)).toBe(1);
    expect(await runCli(['token', 'create', '--data-dir', dir], io)).toBe(2);
    expect(await runCli(['token', 'create', '--name', 'x', '--scope', 'root', '--data-dir', dir], io)).toBe(2);
  });

  it('refuses a wildcard bind without --i-know-this-is-open', async () => {
    const err: string[] = [];
    const code = await runCli(['serve', '--listen', '0.0.0.0', '--port', '0', '--data-dir', tmp()], { out: () => {}, err: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(err.join('')).toMatch(/i-know-this-is-open/);
  });
});
