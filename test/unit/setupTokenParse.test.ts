import { describe, expect, it } from 'vitest';
import { extractOAuthError, extractSignInUrl, extractToken, redactToken, stripAnsi } from '../../src/setupTokenParse';

const TOKEN = 'sk-ant-oat01-AbCdEf_123-xyz';

describe('stripAnsi', () => {
  it('removes OSC hyperlinks, CSI colors/cursor moves and CRs', () => {
    expect(stripAnsi('\x1b]8;;https://x\x07link\x1b]8;;\x07 \x1b[31mred\x1b[0m\x1b[3G!\r')).toBe('link red!');
  });
});

describe('extractToken', () => {
  it('prefers the sk-ant-oat prefix and takes the last match', () => {
    expect(extractToken(`noise sk-ant-oat01-first\n${TOKEN}`)).toBe(TOKEN);
  });
  it('falls back to a bare token-shaped last line only', () => {
    expect(extractToken('done\nABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(extractToken('done\nnot a token at all')).toBeUndefined();
    expect(extractToken('done\nshort')).toBeUndefined();
  });
});

describe('redactToken', () => {
  it('masks by content, everywhere', () => {
    expect(redactToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe('a <redacted> b <redacted>');
    expect(redactToken('unchanged', undefined)).toBe('unchanged');
  });
});

describe('extractSignInUrl', () => {
  it('stops at the first control byte so the OSC-8 duplicate is not included', () => {
    const raw = '\x1b]8;;https://claude.ai/oauth/authorize?code=true&state=abc\x07https://claude.ai/oauth/auth…\x1b]8;;\x07';
    expect(extractSignInUrl(raw)).toBe('https://claude.ai/oauth/authorize?code=true&state=abc');
  });
  it('returns undefined before any URL is printed', () => {
    expect(extractSignInUrl('Opening browser…')).toBeUndefined();
  });
});

describe('extractOAuthError', () => {
  it('drops the TUI retry hint', () => {
    expect(extractOAuthError('OAuth error: invalid code Press Enter to retry.')).toBe('OAuth error: invalid code');
  });
  it('is undefined when there is no rejection', () => {
    expect(extractOAuthError('all good')).toBeUndefined();
  });
});
