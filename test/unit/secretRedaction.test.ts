import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { redactSecrets, redactDeep, redactForStorage, setKnownSecretsProvider } from '../../src/secretRedaction';
import { logger, getLogRing, clearLogRing } from '../../src/logger';
import { RawLogWriter } from '../../src/RawLogWriter';

/** Any typed marker, e.g. `[REDACTED:github]` (JSON-string safe: no quotes or backslashes). */
const MARKER = /\[REDACTED:[a-z0-9-]+\]/;
const REDACTED = '[REDACTED:secret]';

const GH = 'ghp_' + 'a'.repeat(36);
const ANT = 'sk-ant-api03-' + 'Ab1_'.repeat(8);

describe('redactSecrets', () => {
  afterEach(() => setKnownSecretsProvider(null));

  it.each([
    ['github token', `token ${GH} end`, GH],
    ['anthropic key', `key ${ANT}`, ANT],
    ['aws key id', 'id AKIAABCDEFGHIJKLMNOP', 'AKIAABCDEFGHIJKLMNOP'],
    ['slack token', 'xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'eyJhbGciOiJIUzI1NiJ9'],
    ['bearer', 'Authorization: Bearer abc123def456ghi789', 'abc123def456ghi789'],
    ['url credentials', 'git clone https://user:hunter2pass@github.com/x/y', 'hunter2pass'],
    ['env assignment', 'MY_API_TOKEN=supersecretvalue run', 'supersecretvalue'],
    ['quoted env assignment', 'DB_PASSWORD="has spaces in it"', 'has spaces in it'],
    ['pem', '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----', 'MIIabc'],
  ])('masks %s', (_name, input, secret) => {
    const out = redactSecrets(input);
    expect(out).not.toContain(secret);
    expect(out).toMatch(MARKER);
  });

  it('masks known secret values with no recognizable shape, incl. JSON-escaped form', () => {
    setKnownSecretsProvider(() => ['p@ss"word-123']);
    expect(redactSecrets('pw is p@ss"word-123 ok')).toBe('pw is [REDACTED:known] ok');
    expect(redactSecrets('{"x":"p@ss\\"word-123"}')).toBe('{"x":"[REDACTED:known]"}');
  });

  it('masks a token that follows an escaped newline, tab or CR in serialized JSONL', () => {
    for (const esc of ['\\n', '\\r', '\\t']) {
      const line = JSON.stringify({ out: 'x' }).replace('"x"', `"first${esc}${GH}${esc}${ANT}"`);
      const out = redactSecrets(line);
      expect(out).not.toContain(GH);
      expect(out).not.toContain(ANT);
      expect(() => JSON.parse(out)).not.toThrow();
    }
    // The real-newline form already worked; keep it working.
    expect(redactSecrets(`a\n${GH}\nb`)).not.toContain(GH);
  });

  it('requires a digit for sk- so hyphenated words are left alone, but still masks real keys', () => {
    const words = ['sk-this-is-a-very-long-hyphenated-word', 'task-management-and-scheduling-system', 'sk-learn-pipeline-transformers-fit'];
    for (const w of words) expect(redactSecrets(`see ${w} here`)).toBe(`see ${w} here`);
    const key = 'sk-proj-abcdefghij0123456789ABCDEFGH';
    expect(redactSecrets(`k ${key}`)).not.toContain(key);
    expect(redactSecrets(`k sk-ant-oat01-${'Zz'.repeat(15)}`)).toMatch(/\[REDACTED:anthropic\]/);
  });

  it.each([
    ['atlassian api token', 'ATATT3xFfGF0' + 'a1B2c3D4'.repeat(8) + '=1A2B3C4D', 'atlassian'],
    ['atlassian bitbucket token', 'ATBB' + 'Qw9Er8Ty7U'.repeat(4), 'atlassian'],
    ['terraform cloud token', 'Ab12Cd34Ef56Gh.atlasv1.' + 'xYz0_9-'.repeat(12), 'terraform'],
    ['auth0 client secret param', 'client_secret=Zq8Lw3Nv5Bm1Kx7Hd4Jf2Gs6Tp9Rc0Ya&grant_type=client_credentials', 'auth0'],
  ])('masks %s with a typed marker', (_n, input, type) => {
    const out = redactSecrets(`token: ${input} end`);
    expect(out).toContain(`[REDACTED:${type}]`);
    expect(out).not.toMatch(/Zq8Lw3Nv5|a1B2c3D4|Qw9Er8Ty7U|xYz0_9/);
  });

  it('uses typed markers that survive inside a JSON string', () => {
    const out = redactSecrets(`TOKEN ${GH} and Bearer abcdefgh12345678`);
    expect(out).toMatch(/\[REDACTED:github\]/);
    expect(JSON.parse(JSON.stringify({ v: out })).v).toBe(out);
  });

  it('keeps JSON valid when redacting serialized lines that carry escaped quotes and unterminated PEM', () => {
    const lines = [
      JSON.stringify({ cmd: 'export FOO_TOKEN="abc def" && run' }),
      JSON.stringify({ cmd: `DB_PASSWORD='p w' API_KEY=plainvalue123 next` }),
      JSON.stringify({ text: 'saw -----BEGIN RSA PRIVATE KEY-----\nMIIabc' }),
      JSON.stringify({ text: `curl -H "Authorization: Bearer abcdefgh12345678" https://u:pw12345@h.io` }),
    ];
    for (const l of lines) {
      const out = redactSecrets(l);
      expect(() => JSON.parse(out), out).not.toThrow();
      expect(out).not.toMatch(/abc def|plainvalue123|MIIabc|abcdefgh12345678|pw12345/);
    }
  });

  it('ignores known secrets shorter than 8 chars and survives a throwing provider', () => {
    setKnownSecretsProvider(() => ['abc']);
    expect(redactSecrets('abc def')).toBe('abc def');
    setKnownSecretsProvider(() => { throw new Error('keychain locked'); });
    expect(redactSecrets('hello')).toBe('hello');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Read file src/main.ts, 3 tokens used, key press handled';
    expect(redactSecrets(text)).toBe(text);
  });
});

describe('redactDeep', () => {
  it('masks nested strings and secret-keyed values, leaves numbers and non-secret keys', () => {
    const out = redactDeep({
      usage: { input_tokens: 12, max_tokens: 100 },
      headers: { Authorization: 'whatever', 'x-api-key': 'k123', accept: 'json' },
      content: [{ type: 'text', text: `use ${GH}` }],
    }) as any;
    expect(out.usage).toEqual({ input_tokens: 12, max_tokens: 100 });
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers['x-api-key']).toBe(REDACTED);
    expect(out.headers.accept).toBe('json');
    expect(out.content[0].text).not.toContain(GH);
  });

  it('is cycle-safe and does not mutate its input', () => {
    const a: any = { name: 'a', password: 'p' };
    a.self = a;
    const out = redactDeep(a) as any;
    expect(out.self).toBe('[Circular]');
    expect(a.password).toBe('p');
  });

  it('redacts Error messages and stacks', () => {
    const out = redactDeep(new Error(`failed with ${GH}`)) as Error;
    expect(out.message).not.toContain(GH);
    expect(out.stack ?? '').not.toContain(GH);
  });
});

describe('redactForStorage', () => {
  afterEach(() => setKnownSecretsProvider(null));

  it('masks strings and structured values alike, without mutating the input', () => {
    const input = { name: 'onMessage', args: [`out\n${GH}\nmore`, { password: 'hunter2hunter2' }] };
    const out = redactForStorage(input);
    expect(JSON.stringify(out)).not.toContain(GH);
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(input.args[0]).toContain(GH);
    expect(redactForStorage(`x ${GH}`)).toBe('x [REDACTED:github]');
  });

  it('passes primitives through and never throws (fails closed on a hostile value)', () => {
    expect(redactForStorage(42)).toBe(42);
    expect(redactForStorage(null)).toBeNull();
    const hostile = { get boom(): string { throw new Error('nope'); } };
    expect(JSON.stringify(redactForStorage(hostile))).not.toContain('nope');
  });

  it('keeps every serialized JSONL line parseable and masks known secrets unchanged', () => {
    setKnownSecretsProvider(() => ['correct-horse-battery']);
    const events = [
      { type: 'user', text: `line1\n${GH}\n${ANT}` },
      { type: 'tool', input: { command: 'export API_TOKEN="a b c"; echo correct-horse-battery' } },
      { type: 'x', blob: '-----BEGIN PRIVATE KEY-----\nMIIabc' },
    ];
    for (const e of events) {
      const line = JSON.stringify(redactForStorage(e));
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line).not.toMatch(/ghp_a|sk-ant|a b c|correct-horse|MIIabc/);
    }
  });
});

describe('logger integration', () => {
  beforeEach(() => {
    clearLogRing();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('masks secrets in the ring and in console output', () => {
    logger.error('auth failed', { token: 'abcdef123456' }, `GITHUB_TOKEN=${GH}`);
    const msg = getLogRing()[0].msg;
    expect(msg).not.toContain('abcdef123456');
    expect(msg).not.toContain(GH);
    const consoleArgs = JSON.stringify((console.error as any).mock.calls);
    expect(consoleArgs).not.toContain(GH);
    expect(consoleArgs).not.toContain('abcdef123456');
  });
});

describe('RawLogWriter integration', () => {
  it('never writes secrets to the JSONL file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rawlog-redact-'));
    try {
      const w = new RawLogWriter(() => root, () => 'Claude');
      w.append('t1', 's1', 'user', {
        message: { content: [{ type: 'tool_result', content: `leaked ${ANT}` }] },
        env: { OPENAI_API_KEY: 'plainvalue' },
      });
      await w.flushAll();
      const raw = fs.readFileSync(path.join(root, 'Claude', 'logs', 't1.jsonl'), 'utf8');
      expect(raw).not.toContain(ANT);
      expect(raw).not.toContain('plainvalue');
      expect(raw).toMatch(MARKER);
      for (const l of raw.trim().split('\n')) expect(() => JSON.parse(l)).not.toThrow();
      const read = await w.read('t1');
      expect(read?.entries[0].threadId).toBe('t1');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('PEM redaction performance', () => {
  it('stays fast on many unterminated BEGIN headers and still masks a full key', () => {
    const hostile = '-----BEGIN PRIVATE KEY-----'.repeat(20000);
    const t = Date.now();
    redactSecrets(hostile);
    expect(Date.now() - t).toBeLessThan(1000);
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(`k=${key} after`)).not.toContain('MIIBOg');
  });
});
