import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredError, CredStore } from '../../daemon/credStore';

let dir: string;
let clock: number;
let store: CredStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'credstore-'));
  clock = 1_000_000;
  store = new CredStore(dir, () => clock);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CredStore', () => {
  it('stores a kind as creds/<kind>.json with a private directory and file', () => {
    const res = store.push('mcp', 0, { API_KEY: 'secret-value-1', OTHER: 'x' });
    expect(res).toEqual({ kind: 'mcp', fields: ['API_KEY', 'OTHER'], removed: false });
    expect(readdirSync(join(dir, 'creds'))).toEqual(['mcp.json']);
    expect(statSync(join(dir, 'creds')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'creds', 'mcp.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, 'creds', 'mcp.json'), 'utf8')).fields.API_KEY).toBe('secret-value-1');
  });

  it('replaces a kind wholesale rather than merging', () => {
    store.push('mcp', 0, { A: 'aaaaaaaa', B: 'bbbbbbbb' });
    store.push('mcp', 0, { A: 'cccccccc' });
    expect(store.get('mcp')).toEqual({ A: 'cccccccc' });
  });

  it('a push with no fields removes the kind (revocation)', () => {
    store.push('mcp', 0, { A: 'aaaaaaaa' });
    expect(store.push('mcp', 0, {})).toEqual({ kind: 'mcp', fields: [], removed: true });
    expect(store.get('mcp')).toBeUndefined();
    expect(store.push('mcp', 0, {}).removed).toBe(false);
  });

  it('honours ttlSec and deletes the expired file on the next read', () => {
    const res = store.push('mcp', 60, { A: 'aaaaaaaa' });
    expect(res.expiresAt).toBe(1_000_000 + 60_000);
    clock += 59_999;
    expect(store.lookup('A')).toBe('aaaaaaaa');
    clock += 1;
    expect(store.lookup('A')).toBeUndefined();
    expect(readdirSync(join(dir, 'creds'))).toEqual([]);
  });

  it('looks a name up across kinds in name order, or qualified as kind.NAME', () => {
    store.push('zeta', 0, { TOKEN: 'from-zeta-1' });
    store.push('alpha', 0, { TOKEN: 'from-alpha1' });
    expect(store.lookup('TOKEN')).toBe('from-alpha1');
    expect(store.lookup('zeta.TOKEN')).toBe('from-zeta-1');
    expect(store.lookup('nope')).toBeUndefined();
  });

  it('lists every stored value for the redactor and skips unrelated or corrupt files', () => {
    store.push('a', 0, { X: 'value-one-1' });
    store.push('b', 0, { Y: 'value-two-2' });
    writeFileSync(join(dir, 'creds', 'claude-token'), 'bare-token');
    writeFileSync(join(dir, 'creds', 'broken.json'), '{nope');
    expect(store.secretValues().sort()).toEqual(['value-one-1', 'value-two-2']);
  });

  it.each([
    ['kind', ['../x', 0, {}]],
    ['kind', ['', 0, {}]],
    ['kind', ['Upper', 0, {}]],
    ['ttlSec', ['k', -1, {}]],
    ['ttlSec', ['k', 1.5, {}]],
    ['ttlSec', ['k', 366 * 24 * 3600, {}]],
    ['fields', ['k', 0, []]],
    ['fields', ['k', 0, null]],
    ['field name', ['k', 0, { '1bad': 'x' }]],
    ['field name', ['k', 0, { 'a.b': 'x' }]],
    ['string', ['k', 0, { A: 5 }]],
    ['too large', ['k', 0, { A: 'x'.repeat(64 * 1024 + 1) }]],
  ] as const)('rejects bad input (%s)', (_what, args) => {
    expect(() => store.push(...(args as [unknown, unknown, unknown]))).toThrow(CredError);
    expect(readdirSync(dir)).not.toContain('creds');
  });

  it('rejects too many fields', () => {
    const fields = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`F${i}`, 'v']));
    expect(() => store.push('k', 0, fields)).toThrow(/too many fields/);
  });
});
