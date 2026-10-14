import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../daemon/auditLog';
import { installCrashGuards } from '../../daemon/cli';
import { resolveConfig } from '../../daemon/config';
import { ControlRegistry } from '../../daemon/controlRegistry';
import { sweepRawLogs } from '../../daemon/logRetention';
import { isLoopbackPeer } from '../../daemon/server';
import { TokenStore } from '../../daemon/tokenStore';
import { decodeClientFrame, validateSpecShape, validateWireImages } from '../../src/protocol';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'dh-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('ControlRegistry seat identity (finding A)', () => {
  it('same token + different instance is refused; same instance takes over; no instance id = per-token', () => {
    const r = new ControlRegistry();
    expect(r.claim('t', { id: 1, tokenId: 'a', instanceId: 'x' })).toBe(true);
    expect(r.claim('t', { id: 2, tokenId: 'a', instanceId: 'y' })).toBe(false);
    expect(r.claim('t', { id: 3, tokenId: 'a', instanceId: 'x' })).toBe(true); // reconnect takes its own seat
    expect(r.isController('t', 3)).toBe(true);
    expect(r.claim('t', { id: 4, tokenId: 'a' })).toBe(true); // old client: legacy per-token behaviour
    expect(r.claim('t', { id: 5, tokenId: 'b', instanceId: 'x' })).toBe(false); // other token never
  });
});

describe('codec: images and spec (finding C)', () => {
  const frame = (type: string, payload: object) => JSON.stringify({ v: 1, cmdId: 'c', type, ...payload });
  const img = { base64: 'AAAA', mediaType: 'image/png', name: 'a.png' };

  it('accepts a good image and rejects every malformed shape', () => {
    expect(validateWireImages([img])).toBeNull();
    expect(validateWireImages(undefined)).toBeNull();
    for (const bad of [null, 'x', [null], [[]], [{}], [{ ...img, mediaType: 'text/html' }], [{ ...img, base64: '' }], [{ ...img, base64: 7 }], [{ ...img, base64: 'a b' }], [{ ...img, name: 3 }], [{ ...img, base64: 'A'.repeat(7_000_001) }], new Array(11).fill(img)]) {
      expect(validateWireImages(bad), JSON.stringify(bad)?.slice(0, 60)).not.toBeNull();
    }
  });

  it('decodeClientFrame refuses them on session.send and prepareForSend', () => {
    for (const type of ['session.send', 'session.prepareForSend']) {
      const base = { threadId: 't', text: 'x', userMessageUuid: 'u' };
      expect(decodeClientFrame(frame(type, { ...base, images: [img] })).ok).toBe(true);
      const r = decodeClientFrame(frame(type, { ...base, images: [null] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ code: 'bad_frame', cmdId: 'c' });
    }
  });

  it('validates the shape of a spec', () => {
    const spec = { harness: 'claude', cwd: '/x', permissionMode: 'default', extraEnvRaw: '' };
    expect(validateSpecShape(spec)).toBeNull();
    expect(validateSpecShape({ ...spec, sessionOptions: { effort: 'low', betas: ['b'], agents: { a: {} } }, mcpServers: { d: { type: 'http', url: 'https://x', headers: { a: 'b' } } }, hostTools: [{ name: 'n' }], skills: ['s'] })).toBeNull();
    for (const bad of [null, 'x', [], { ...spec, harness: 1 }, { ...spec, cwd: '' }, { ...spec, permissionMode: null },
      { ...spec, model: 3 }, { ...spec, disallowedTools: 'x' }, { ...spec, disallowedTools: [1] }, { ...spec, additionalDirectories: [null] },
      { ...spec, sessionOptions: 'x' }, { ...spec, sessionOptions: { betas: [1] } }, { ...spec, sessionOptions: { agents: { a: null } } },
      { ...spec, mcpServers: { a: null } }, { ...spec, mcpServers: { a: { type: 'stdio', url: 'x' } } }, { ...spec, mcpServers: { a: { type: 'http', url: 'x', headers: { a: 1 } } } },
      { ...spec, hostTools: [null] }, { ...spec, appendSystemPrompt: 'x'.repeat(1_000_001) }]) {
      expect(validateSpecShape(bad), JSON.stringify(bad)?.slice(0, 80)).not.toBeNull();
    }
  });
});

describe('TokenStore: corrupt file (finding B)', () => {
  it('startup throws, later corruption fails closed without throwing, a fixed file recovers', () => {
    const dir = tmp();
    const logs: string[] = [];
    const store = new TokenStore(dir, undefined, (l) => logs.push(l));
    const { token, record } = store.create('a', 'control');
    const file = join(dir, 'tokens.json');
    const good = readFileSync(file, 'utf8');

    writeFileSync(file, 'garbage{');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(store.verify(token)).toBeNull();
    expect(store.isActive(record.id)).toBe(false);
    expect(store.verify(token)).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('tokens.json is unusable');
    expect(() => store.list()).toThrow(/unusable/); // management paths stay loud
    expect(() => new TokenStore(dir)).toThrow(/unusable/); // so does startup

    writeFileSync(file, good);
    utimesSync(file, new Date(), new Date(Date.now() + 9000));
    expect(store.verify(token)).toMatchObject({ id: record.id });
  });

  it('a wrong-shaped file (not an array, bad entry) is corrupt too', () => {
    const dir = tmp();
    const store = new TokenStore(dir);
    const { token } = store.create('a', 'read');
    const file = join(dir, 'tokens.json');
    writeFileSync(file, '{"x":1}');
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(store.verify(token)).toBeNull();
    writeFileSync(file, '[{"id":"a"}]');
    utimesSync(file, new Date(), new Date(Date.now() + 9000));
    expect(store.verify(token)).toBeNull();
  });
});

describe('installCrashGuards (finding B)', () => {
  it('logs an uncaught exception / unhandled rejection instead of exiting, and uninstalls cleanly', () => {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    const lines: string[] = [];
    const off = installCrashGuards({ out: () => {}, err: (l) => lines.push(l) }, proc);
    expect(() => proc.emit('uncaughtException', new Error('kaboom'))).not.toThrow();
    expect(() => proc.emit('unhandledRejection', new Error('nope'), Promise.resolve())).not.toThrow();
    expect(lines.join('\n')).toContain('kaboom');
    expect(lines.join('\n')).toContain('unhandled rejection');
    off();
    expect(proc.listenerCount('uncaughtException')).toBe(0);
    expect(proc.listenerCount('unhandledRejection')).toBe(0);
  });
});

describe('AuditLog (finding G)', () => {
  it('batches writes, rotates by size and keeps a bounded number of files', () => {
    const dir = tmp();
    const file = join(dir, 'audit.ndjson');
    const log = new AuditLog(file, { maxBytes: 300, keep: 2, flushMs: 1_000_000 });
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 4; i++) log.record({ event: 'command', type: 'x', round, i });
      log.flushSync();
    }
    const names = readdirSync(dir).sort();
    expect(names).toEqual(['audit.ndjson', 'audit.ndjson.1', 'audit.ndjson.2']);
    for (const n of names) expect(readFileSync(join(dir, n), 'utf8').length).toBeLessThan(300 + 200);
    // The newest record is in the live file.
    expect(readFileSync(file, 'utf8')).toContain('"round":5');
  });

  it('nothing is written until flush; an unserializable record is dropped, not thrown', () => {
    const dir = tmp();
    const file = join(dir, 'audit.ndjson');
    const log = new AuditLog(file, { flushMs: 1_000_000 });
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => log.record(cyc)).not.toThrow();
    log.record({ event: 'a' });
    expect(existsSync(file)).toBe(false);
    log.flushSync();
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('sweepRawLogs (finding G)', () => {
  it('deletes old logs and rotates oversized ones once', () => {
    const dir = tmp();
    const now = Date.now();
    writeFileSync(join(dir, 'old.jsonl'), 'x');
    utimesSync(join(dir, 'old.jsonl'), new Date(now - 10 * 86_400_000), new Date(now - 10 * 86_400_000));
    writeFileSync(join(dir, 'big.jsonl'), 'y'.repeat(100));
    writeFileSync(join(dir, 'big.jsonl.1'), 'previous');
    writeFileSync(join(dir, 'small.jsonl'), 'z');
    writeFileSync(join(dir, 'note.txt'), 'keep me');
    const res = sweepRawLogs(dir, { maxAgeMs: 7 * 86_400_000, maxBytes: 50 }, now);
    expect(res.deleted).toEqual(['old.jsonl']);
    expect(res.rotated).toEqual(['big.jsonl']);
    expect(readdirSync(dir).sort()).toEqual(['big.jsonl.1', 'note.txt', 'small.jsonl']);
    expect(readFileSync(join(dir, 'big.jsonl.1'), 'utf8')).toBe('y'.repeat(100));
  });

  it('tolerates a missing directory and no limits', () => {
    expect(sweepRawLogs(join(tmp(), 'nope'), {})).toEqual({ deleted: [], rotated: [] });
    const dir = tmp();
    mkdirSync(join(dir, 'sub.jsonl'));
    expect(sweepRawLogs(dir, { maxBytes: 1 }).rotated).toEqual([]);
  });
});

describe('config: new limits (finding E, H)', () => {
  it('has safe defaults and rejects bad values', () => {
    const base = { flags: { dataDir: tmp() }, env: {} };
    expect(resolveConfig(base)).toMatchObject({ maxConnections: 64, maxLiveSessions: 8, requestTimeoutMinutes: 60, allowedClientEnv: [] });
    expect(resolveConfig({ ...base, flags: { ...base.flags, maxLiveSessions: 2, requestTimeoutMinutes: 0 } })).toMatchObject({ maxLiveSessions: 2, requestTimeoutMinutes: 0 });
    expect(() => resolveConfig({ ...base, flags: { ...base.flags, maxLiveSessions: 0 } })).toThrow(/maxLiveSessions/);
    expect(() => resolveConfig({ ...base, flags: { ...base.flags, allowedClientEnv: ['BAD NAME'] } })).toThrow(/allowedClientEnv/);
  });

  it('reads the env allowlist from config.json', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ allowedClientEnv: ['FOO', 'BAR'] }));
    expect(resolveConfig({ flags: { dataDir: dir }, env: {} }).allowedClientEnv).toEqual(['FOO', 'BAR']);
  });
});

describe('isLoopbackPeer (finding F)', () => {
  it('recognises IPv4, IPv6 and mapped loopback only', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopbackPeer(ip), ip).toBe(true);
    for (const ip of ['100.64.0.5', '192.168.1.2', '::ffff:10.0.0.1', 'unknown', 'fd7a:115c:a1e0::1']) expect(isLoopbackPeer(ip), ip).toBe(false);
  });
});
