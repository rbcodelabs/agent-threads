import { describe, expect, it } from 'vitest';
import { collectFields, formatPush, parseTtl, preparePush, type CredsPushOptions } from '../../daemon/cmd/creds';
import { CliError, EXIT } from '../../daemon/cmd/exit';

const base: CredsPushOptions = { kind: 'mcp', specs: [], ttlSec: 0, remove: false, stdinJson: false, allowArgv: false };
const src = (env: NodeJS.ProcessEnv = {}, stdinText?: string) => {
  const warnings: string[] = [];
  return { env, ...(stdinText !== undefined ? { stdinText } : {}), warn: (m: string) => { warnings.push(m); }, warnings };
};
const usage = (fn: () => unknown): CliError => {
  try { fn(); } catch (e) { expect(e).toBeInstanceOf(CliError); expect((e as CliError).code).toBe(EXIT.USAGE); return e as CliError; }
  throw new Error('did not throw');
};

describe('parseTtl', () => {
  it('accepts seconds and s/m/h/d suffixes', () => {
    expect([parseTtl('90'), parseTtl('90s'), parseTtl('15m'), parseTtl('24h'), parseTtl('7d')]).toEqual([90, 90, 900, 86400, 604800]);
  });
  it('rejects anything else', () => {
    for (const bad of ['', '-5', '1.5h', 'abc', '5w']) usage(() => parseTtl(bad));
  });
});

describe('collectFields', () => {
  it('reads named fields from the environment', () => {
    expect(collectFields({ ...base, specs: ['A', 'B'] }, src({ A: 'a1', B: 'b2' }))).toEqual({ A: 'a1', B: 'b2' });
  });
  it('reads a JSON object from stdin, and env fills named fields stdin lacks', () => {
    expect(collectFields({ ...base, stdinJson: true, specs: ['B'] }, src({ B: 'b2' }, '{"A":"a1"}'))).toEqual({ A: 'a1', B: 'b2' });
  });
  it('stdin wins over env for the same field', () => {
    expect(collectFields({ ...base, stdinJson: true, specs: ['A'] }, src({ A: 'env' }, '{"A":"stdin"}'))).toEqual({ A: 'stdin' });
  });
  it('rejects malformed stdin and non-string values', () => {
    usage(() => collectFields({ ...base, stdinJson: true }, src({}, 'not json')));
    usage(() => collectFields({ ...base, stdinJson: true }, src({}, '[1]')));
    usage(() => collectFields({ ...base, stdinJson: true }, src({}, '{"A":1}')));
  });
  it('names the missing fields without any value', () => {
    const e = usage(() => collectFields({ ...base, specs: ['A', 'B'] }, src({ A: 'x' })));
    expect(e.message).toContain('B');
    expect(e.message).not.toContain('x');
  });
  it('refuses NAME=value unless --allow-argv, never echoing the value', () => {
    const e = usage(() => collectFields({ ...base, specs: ['A=hunter2'] }, src()));
    expect(e.message).not.toContain('hunter2');
    const s = src();
    expect(collectFields({ ...base, specs: ['A=hunter2'], allowArgv: true }, s)).toEqual({ A: 'hunter2' });
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).not.toContain('hunter2');
  });
  it('rejects invalid field names', () => {
    usage(() => collectFields({ ...base, specs: ['1bad'] }, src({ '1bad': 'x' })));
  });
});

describe('preparePush', () => {
  it('needs a kind and at least one field unless --remove', () => {
    usage(() => preparePush({ ...base, kind: '', specs: ['A'] }, src({ A: 'x' })));
    usage(() => preparePush({ ...base }, src()));
    expect(preparePush({ ...base, remove: true }, src())).toEqual({});
  });
  it('--remove takes no fields', () => {
    usage(() => preparePush({ ...base, remove: true, specs: ['A'] }, src({ A: 'x' })));
    usage(() => preparePush({ ...base, remove: true, stdinJson: true }, src({}, '{}')));
  });
});

describe('formatPush', () => {
  it('lists field names and expiry only', () => {
    expect(formatPush({ kind: 'mcp', fields: ['A', 'B'], removed: false, expiresAt: Date.UTC(2030, 0, 1) })).toBe('pushed 2 fields to "mcp": A, B, expires 2030-01-01T00:00:00.000Z');
    expect(formatPush({ kind: 'mcp', fields: [], removed: true })).toBe('removed credential kind "mcp"');
  });
});
