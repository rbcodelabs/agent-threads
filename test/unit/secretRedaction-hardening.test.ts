/**
 * Review fixes for redact-at-write-time: bounded patterns (no ReDoS), one known-secret lookup per
 * redaction, DAG-safe deep walk, and a KEY=value rule that leaves ordinary code and prose alone.
 * Fake secrets only.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CredStore } from '../../daemon/credStore';
import { redactDeep, redactForStorage, redactSecrets, setKnownSecretsProvider } from '../../src/secretRedaction';

const GH = 'ghp_' + 'a'.repeat(36);
const BYTES = 200_000;
const rep = (unit: string): string => unit.repeat(Math.ceil(BYTES / unit.length));

afterEach(() => setKnownSecretsProvider(null));

describe('redaction is linear on hostile input (200 KB)', () => {
  // One entry per pattern family, built to maximize rescans. Before the fix `a.`, `sk-`, `sk-a`, `a1-` and
  // `x.atlasv1.` each took seconds to tens of seconds; the bound below is generous for a loaded CI box yet
  // three orders of magnitude under the broken behaviour.
  const hostile: Array<[string, string]> = [
    ['a. (url scheme)', rep('a.')],
    ['a+ (url scheme)', rep('a+')],
    ['x.atlasv1. (terraform)', rep('x.atlasv1.')],
    ['sk- repeats (openai)', rep('sk-')],
    ['sk-a repeats (openai)', rep('sk-a')],
    ['a1- (openai/hyphen runs)', rep('a1-')],
    ['sk- plus 30 chars', rep('sk-' + 'a'.repeat(30))],
    ['sk-ant- repeats', rep('sk-ant-')],
    ['ghp_ repeats', rep('ghp_')],
    ['github_pat_ repeats', rep('github_pat_')],
    ['eyJ jwt prefixes', rep('eyJabcdefgh.')],
    ['eyJ.eyJ jwt prefixes', rep('eyJabcdefgh.eyJabcdefgh.')],
    ['AKIA repeats', rep('AKIA')],
    ['xoxb- repeats', rep('xoxb-')],
    ['AIza repeats', rep('AIza')],
    ['ATATT3 repeats', rep('ATATT3')],
    ['ATBB repeats', rep('ATBB')],
    ['Bearer repeats', rep('Bearer ')],
    ['Bearer a repeats', rep('Bearer a')],
    ['pem begin repeats', rep('-----BEGIN PRIVATE KEY-----')],
    ['KEY= repeats', rep('KEY=')],
    ['A_KEY= repeats', rep('A_KEY= ')],
    ['TOKEN=" repeats', rep('TOKEN="')],
    ['TOKEN=\\" repeats', rep('TOKEN=\\"')],
    ['KEY=\\\\ repeats', rep('KEY=\\\\')],
    ['TOKEN_ one long name', rep('TOKEN_')],
    ['ABCKEY one long name', rep('ABCKEY')],
    ['A_ one long name', rep('A_')],
    ['KEY then spaces', 'KEY' + ' '.repeat(BYTES) + 'x'],
    ['KEY= then spaces', 'KEY=' + ' '.repeat(BYTES)],
    ['url scheme repeats', rep('a://b:')],
    ['url userinfo colons', 'a://u:' + ':'.repeat(BYTES)],
    ['client_secret= repeats', rep('client_secret=')],
    ['escaped newlines', rep('\\n')],
    ['plain a', 'a'.repeat(BYTES)],
  ];

  it.each(hostile)('%s', (_name, input) => {
    const t0 = performance.now();
    redactSecrets(input);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(250);
  });

  it('still masks real tokens next to the hostile runs', () => {
    const noise = rep('sk-');
    expect(redactSecrets(`${noise} ${GH} ${noise}`)).not.toContain(GH);
    expect(redactSecrets(`${rep('a.')} https://u:pw1234567@h.io/x`)).not.toContain('pw1234567');
  });

  it('keeps the openai digit rule: hyphenated words stay, keys with a digit go', () => {
    expect(redactSecrets('see sk-learn-pipeline-transformers-fit here')).toBe('see sk-learn-pipeline-transformers-fit here');
    expect(redactSecrets('k sk-proj-abcdefghij0123456789ABCDEFGH')).toBe('k [REDACTED:openai]');
  });

  it('masks a url credential whose password is long, and one with a long scheme-like prefix', () => {
    expect(redactSecrets(`git clone https://bob:${'p'.repeat(300)}@host/x`)).toContain('https://[REDACTED:url-credentials]@host/x');
  });
});

describe('known-secret lookup cost', () => {
  const event = (i: number) => ({
    name: 'onToolUse',
    args: [{ name: 'Bash', input: { command: `echo ${i} ${'word '.repeat(20)}`, description: 'd'.repeat(30), tags: ['a', 'b', 'c', 'd'], nested: { x: 'y', z: ['1', '2', '3'] } } }],
  });

  it('calls the provider O(events), not O(strings), when redacting 10,000 events', () => {
    let calls = 0;
    setKnownSecretsProvider(() => { calls++; return ['correct-horse-battery-staple']; });
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) redactForStorage(event(i));
    const ms = performance.now() - t0;
    // ~35 strings per event: per-string lookup would be ~350,000 calls.
    expect(calls).toBeLessThanOrEqual(10_000);
    expect(ms).toBeLessThan(5_000);
  });

  it('resolves the list once per redactDeep call however many strings it holds', () => {
    let calls = 0;
    setKnownSecretsProvider(() => { calls++; return ['correct-horse-battery-staple']; });
    redactDeep({ a: ['x', 'y', 'z'], b: { c: 'w', d: ['v', 'u'] } });
    expect(calls).toBeLessThanOrEqual(1);
  });

  it('with a real CredStore provider, 10,000 events stay fast and masked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-redact-'));
    try {
      const store = new CredStore(dir);
      store.push('github', 0, { GH_TOKEN: 'fake-known-secret-value-1' });
      store.push('sessenv-a', 0, { NPM: 'fake-known-secret-value-2' });
      store.push('sessenv-b', 0, { OTHER: 'fake-known-secret-value-3' });
      setKnownSecretsProvider(() => store.secretValues());
      const t0 = performance.now();
      let last: unknown;
      for (let i = 0; i < 10_000; i++) last = redactForStorage({ ...event(i), leak: 'has fake-known-secret-value-2 inside' });
      const ms = performance.now() - t0;
      expect(JSON.stringify(last)).toContain('[REDACTED:known]');
      expect(JSON.stringify(last)).not.toContain('fake-known-secret-value-2');
      expect(ms).toBeLessThan(5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('picks up a newly pushed credential straight away (push invalidates the cache)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-redact-'));
    try {
      const store = new CredStore(dir);
      setKnownSecretsProvider(() => store.secretValues());
      expect(redactSecrets('x fresh-pushed-secret-1 y')).toBe('x fresh-pushed-secret-1 y');
      store.push('github', 0, { GH_TOKEN: 'fresh-pushed-secret-1' });
      expect(redactSecrets('x fresh-pushed-secret-1 y')).toBe('x [REDACTED:known] y');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('swapping the provider takes effect immediately', () => {
    setKnownSecretsProvider(() => ['first-secret-value']);
    expect(redactSecrets('first-secret-value')).toBe('[REDACTED:known]');
    setKnownSecretsProvider(() => ['second-secret-value']);
    expect(redactSecrets('first-secret-value')).toBe('first-secret-value');
  });
});

describe('redactDeep shared references', () => {
  it('keeps a value referenced twice (a DAG) and only flags a true cycle', () => {
    const shared = { note: `see ${GH}`, n: 1 };
    const out = redactDeep({ x: shared, y: shared, list: [shared, shared] }) as any;
    expect(out.x).toEqual({ note: 'see [REDACTED:github]', n: 1 });
    expect(out.y).toEqual(out.x);
    expect(out.list[0]).toEqual(out.x);
    expect(out.list[1]).toEqual(out.x);
    const cyc: any = { a: { b: 1 } };
    cyc.a.back = cyc;
    expect((redactDeep(cyc) as any).a.back).toBe('[Circular]');
  });
});

describe('KEY=value rule', () => {
  it.each([
    'const key = foo(); if (key == other) { run(); }',
    'let tokens = []',
    'const author = "bob"',
    'PASSENGER=3',
    'MONKEY=banana',
    'keyboard=us',
    'const passthrough = true',
    'if (secretary == null) return',
    'x.token = compute()',
    'authors = ["a", "b"]',
    'while (key <= max) n >= key',
  ])('leaves %j alone', (text) => {
    expect(redactSecrets(text)).toBe(text);
  });

  it.each([
    ['API_KEY=abc123def456', 'abc123def456'],
    ['GITHUB_TOKEN=ghx-not-a-shape-value', 'ghx-not-a-shape-value'],
    ['DB_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
    ['export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG', 'wJalrXUtnFEMI'],
    ['DB_PASSWORD="has spaces in it"', 'has spaces in it'],
    ["MY_AUTH='single quoted value'", 'single quoted value'],
    ['SECRET = spaced-around-value', 'spaced-around-value'],
    ['KEY=plainvalue123', 'plainvalue123'],
    ['password=querystringvalue&x=1', 'querystringvalue'],
    ['api_key=lowercasetightvalue', 'lowercasetightvalue'],
    ['PASSWD=abcdefghijk', 'abcdefghijk'],
    ['OPENAI_APIKEY=abcdefghijk', 'abcdefghijk'],
  ])('masks %j', (text, secret) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED:secret]');
  });

  it('keeps the key name and surrounding text, and leaves == comparisons alone', () => {
    expect(redactSecrets('run API_KEY=abc123def456 now')).toBe('run API_KEY=[REDACTED:secret] now');
    expect(redactSecrets('API_KEY == other')).toBe('API_KEY == other');
  });
});

describe('fail-closed shape', () => {
  it('returns a marker string for a value it could not walk', () => {
    const poison = { get boom(): string { throw new Error('nope'); } };
    expect(redactForStorage(poison)).toBe('[REDACTED:error]');
  });
});
