import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { redactSecrets, redactDeep, setKnownSecretsProvider, REDACTED } from '../../src/secretRedaction';
import { logger, getLogRing, clearLogRing } from '../../src/logger';
import { RawLogWriter } from '../../src/RawLogWriter';

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
    expect(out).toContain(REDACTED);
  });

  it('masks known secret values with no recognizable shape, incl. JSON-escaped form', () => {
    setKnownSecretsProvider(() => ['p@ss"word-123']);
    expect(redactSecrets('pw is p@ss"word-123 ok')).toBe(`pw is ${REDACTED} ok`);
    expect(redactSecrets('{"x":"p@ss\\"word-123"}')).toBe(`{"x":"${REDACTED}"}`);
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
      expect(raw).toContain(REDACTED);
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
