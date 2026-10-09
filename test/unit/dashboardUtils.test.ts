import { describe, it, expect } from 'vitest';
import { relativeTime, shortenPath, isAwsSsoError, extractAwsProfile, awsExecEnv, formatWakeupCountdown, splitErrorMessage } from '../../src/dashboardUtils';

// ── formatWakeupCountdown ───────────────────────────────────────────────────────

describe('formatWakeupCountdown', () => {
  it('returns "now" when the fire time is in the past', () => {
    expect(formatWakeupCountdown(Date.now() - 5_000)).toBe('now');
  });

  it('returns "now" when the fire time is exactly now', () => {
    expect(formatWakeupCountdown(Date.now())).toBe('now');
  });

  it('formats sub-minute remaining as seconds', () => {
    expect(formatWakeupCountdown(Date.now() + 45_000)).toBe('in 45s');
    expect(formatWakeupCountdown(Date.now() + 1_000)).toBe('in 1s');
  });

  it('rounds to the nearest second', () => {
    expect(formatWakeupCountdown(Date.now() + 45_400)).toBe('in 45s');
    expect(formatWakeupCountdown(Date.now() + 45_600)).toBe('in 46s');
  });

  it('formats whole minutes once at least 60s remain', () => {
    expect(formatWakeupCountdown(Date.now() + 60_000)).toBe('in 1m');
    expect(formatWakeupCountdown(Date.now() + 4 * 60_000)).toBe('in 4m');
    expect(formatWakeupCountdown(Date.now() + 59 * 60_000)).toBe('in 59m');
  });

  it('formats hours and minutes past one hour', () => {
    expect(formatWakeupCountdown(Date.now() + 60 * 60_000)).toBe('in 1h');
    expect(formatWakeupCountdown(Date.now() + 65 * 60_000)).toBe('in 1h 5m');
    expect(formatWakeupCountdown(Date.now() + 150 * 60_000)).toBe('in 2h 30m');
  });
});

// ── relativeTime ──────────────────────────────────────────────────────────────

describe('relativeTime', () => {
  it('returns "just now" when diff is 0ms', () => {
    expect(relativeTime(Date.now())).toBe('just now');
  });

  it('returns "just now" when diff is 59 999ms (just under 1 minute)', () => {
    expect(relativeTime(Date.now() - 59_999)).toBe('just now');
  });

  it('returns "1m ago" when diff is exactly 60 000ms', () => {
    expect(relativeTime(Date.now() - 60_000)).toBe('1m ago');
  });

  it('returns "Xm ago" for any value between 1m and 59m', () => {
    expect(relativeTime(Date.now() - 30 * 60_000)).toBe('30m ago');
    expect(relativeTime(Date.now() - 59 * 60_000)).toBe('59m ago');
  });

  it('returns "1h ago" when diff is exactly 1 hour', () => {
    expect(relativeTime(Date.now() - 3_600_000)).toBe('1h ago');
  });

  it('returns "Xh ago" for values between 1h and 23h', () => {
    expect(relativeTime(Date.now() - 6 * 3_600_000)).toBe('6h ago');
    expect(relativeTime(Date.now() - 23 * 3_600_000)).toBe('23h ago');
  });

  it('returns "1d ago" when diff is exactly 24 hours', () => {
    expect(relativeTime(Date.now() - 86_400_000)).toBe('1d ago');
  });

  it('returns "Xd ago" for values ≥ 1 day', () => {
    expect(relativeTime(Date.now() - 3 * 86_400_000)).toBe('3d ago');
    expect(relativeTime(Date.now() - 30 * 86_400_000)).toBe('30d ago');
  });

  it('uses Math.floor (truncates, does not round)', () => {
    // 89m 59s → floor to 1h (not 1.5h)
    expect(relativeTime(Date.now() - 89 * 60_000 - 59_000)).toBe('1h ago');
    // 1d 23h 59m → floor to 1d
    expect(relativeTime(Date.now() - 86_400_000 - 23 * 3_600_000 - 59 * 60_000)).toBe('1d ago');
  });
});

// ── shortenPath ───────────────────────────────────────────────────────────────

describe('shortenPath', () => {
  const HOME = process.env.HOME ?? '/Users/test';

  it('strips the vaultRoot prefix and removes leading slash', () => {
    const result = shortenPath('/vault/notes/project/file.md', '/vault');
    expect(result).toBe('notes/project/file.md');
  });

  it('returns "/" when path equals vaultRoot exactly', () => {
    expect(shortenPath('/vault', '/vault')).toBe('/');
  });

  it('vaultRoot wins over HOME substitution', () => {
    // If path starts with vaultRoot, vaultRoot stripping takes precedence
    const result = shortenPath(`${HOME}/vault/notes`, `${HOME}/vault`);
    expect(result).toBe('notes');
    expect(result).not.toContain('~');
  });

  it('replaces HOME with ~ when no vaultRoot is provided', () => {
    const result = shortenPath(`${HOME}/projects/myapp`);
    expect(result).toContain('~');
    expect(result.startsWith('~')).toBe(true);
  });

  it('does not replace HOME when path does not start with HOME', () => {
    const result = shortenPath('/tmp/other/path');
    expect(result).not.toContain('~');
  });

  it('returns the path unchanged when ≤4 parts and no HOME/vaultRoot match', () => {
    // '/a/b/c' splits into ['', 'a', 'b', 'c'] = 4 parts → not shortened
    expect(shortenPath('/a/b/c')).toBe('/a/b/c');
  });

  it('shortens deep path (>4 parts) to …/parent/leaf', () => {
    const result = shortenPath('/one/two/three/four/five/leaf');
    expect(result).toBe('…/five/leaf');
  });

  it('shortens deep HOME path to …/parent/leaf after ~ substitution', () => {
    // ~/a/b/c/d/e → ['~', 'a', 'b', 'c', 'd', 'e'] = 6 parts → shortened
    const result = shortenPath(`${HOME}/a/b/c/d/e`);
    expect(result).toBe('…/d/e');
  });

  it('handles empty string input without throwing', () => {
    expect(() => shortenPath('')).not.toThrow();
  });

  it('handles path with no vaultRoot and HOME is empty string', () => {
    // Temporarily unset HOME — shortenPath falls back to empty string
    const orig = process.env.HOME;
    process.env.HOME = '';
    try {
      expect(shortenPath('/a/b/c/d/e/f')).toBe('…/e/f');
    } finally {
      process.env.HOME = orig;
    }
  });
});

// ── isAwsSsoError ─────────────────────────────────────────────────────────────

describe('isAwsSsoError', () => {
  it('returns false for undefined', () => {
    expect(isAwsSsoError(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isAwsSsoError('')).toBe(false);
  });

  it('returns false for an unrelated error message', () => {
    expect(isAwsSsoError('Permission denied: /etc/hosts')).toBe(false);
    expect(isAwsSsoError('Command not found: claude')).toBe(false);
    expect(isAwsSsoError('ENOENT: no such file or directory')).toBe(false);
  });

  it('returns true for "token expired" pattern', () => {
    expect(isAwsSsoError('Error: token has expired')).toBe(true);
  });

  it('returns true for "expir.*token" pattern (reversed order)', () => {
    expect(isAwsSsoError('Credentials expired — token refresh required')).toBe(true);
  });

  it('returns true for "aws sso login" literal', () => {
    expect(isAwsSsoError('Run aws sso login to refresh')).toBe(true);
  });

  it('returns true for "sso.*session.*expir" pattern', () => {
    expect(isAwsSsoError('SSO session has expired, please re-authenticate')).toBe(true);
  });

  it('returns true for "Error loading SSO" pattern', () => {
    expect(isAwsSsoError('Error loading SSO Token: The SSO session has expired or is invalid')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAwsSsoError('TOKEN EXPIRED')).toBe(true);
    expect(isAwsSsoError('AWS SSO LOGIN')).toBe(true);
  });
});

// ── splitErrorMessage ────────────────────────────────────────────────────────

describe('splitErrorMessage', () => {
  it('returns the whole message as the headline when there is no stack marker', () => {
    expect(splitErrorMessage('Something went wrong')).toEqual({ headline: 'Something went wrong' });
  });

  it('returns an empty-string headline unchanged for an empty message', () => {
    expect(splitErrorMessage('')).toEqual({ headline: '' });
  });

  it('splits a message with a trailing "\\n\\nStack:" block', () => {
    const message = 'Rate limited\n\nStack: Error: Rate limited\n    at foo (bar.ts:1:1)';
    expect(splitErrorMessage(message)).toEqual({
      headline: 'Rate limited',
      stack: 'Stack: Error: Rate limited\n    at foo (bar.ts:1:1)',
    });
  });

  it('splits a message that also has a Zod issues block before the stack', () => {
    const message = 'Bad input\n\nZod issues: [{"path":["x"]}]\n\nStack: Error: Bad input\n    at foo (bar.ts:1:1)';
    expect(splitErrorMessage(message)).toEqual({
      headline: 'Bad input\n\nZod issues: [{"path":["x"]}]',
      stack: 'Stack: Error: Bad input\n    at foo (bar.ts:1:1)',
    });
  });

  it('only splits on the first "\\n\\nStack:" occurrence', () => {
    const message = 'Outer\n\nStack: inner\n\nStack: nested';
    expect(splitErrorMessage(message)).toEqual({
      headline: 'Outer',
      stack: 'Stack: inner\n\nStack: nested',
    });
  });
});

// ── extractAwsProfile ─────────────────────────────────────────────────────────

describe('extractAwsProfile', () => {
  it('returns null for an empty string', () => {
    expect(extractAwsProfile('')).toBeNull();
  });

  it('returns null when AWS_PROFILE is not present', () => {
    expect(extractAwsProfile('FOO=bar\nBAZ=qux')).toBeNull();
  });

  it('extracts AWS_PROFILE from a single-line block', () => {
    expect(extractAwsProfile('AWS_PROFILE=staging')).toBe('staging');
  });

  it('extracts AWS_PROFILE from a multi-line block', () => {
    const block = 'FOO=bar\nAWS_PROFILE=production\nBAR=baz';
    expect(extractAwsProfile(block)).toBe('production');
  });

  it('extracts AWS_PROFILE when it appears first in the block', () => {
    const block = 'AWS_PROFILE=dev\nFOO=bar';
    expect(extractAwsProfile(block)).toBe('dev');
  });

  it('extracts AWS_PROFILE when it appears last in the block', () => {
    const block = 'FOO=bar\nBAR=baz\nAWS_PROFILE=last';
    expect(extractAwsProfile(block)).toBe('last');
  });

  it('returns null when line starts with a prefix that prevents matching (e.g., X_AWS_PROFILE)', () => {
    // The regex anchors on ^ or \n so X_AWS_PROFILE= on its own line won't match
    // because it isn't preceded by \n or start-of-string in the right way.
    // X_AWS_PROFILE=foo is NOT a line beginning — it is on a line starting with X
    expect(extractAwsProfile('X_AWS_PROFILE=foo')).toBeNull();
  });

  it('handles Windows-style line endings (\\r\\n)', () => {
    // \r is non-whitespace in the value capture group, so profile may include \r
    // Just verify it does not throw and extracts something
    const block = 'FOO=bar\r\nAWS_PROFILE=myprofile\r\nBAR=baz';
    const result = extractAwsProfile(block);
    // The regex [^\s]+ stops at \r (whitespace), so this extracts cleanly
    expect(result).toBe('myprofile');
  });

  it('handles profile name with hyphens and underscores', () => {
    expect(extractAwsProfile('AWS_PROFILE=my-team_prod')).toBe('my-team_prod');
  });
});

// ── awsExecEnv ────────────────────────────────────────────────────────────────

describe('awsExecEnv', () => {
  it('prepends /opt/homebrew/bin and /usr/local/bin to PATH', () => {
    const env = awsExecEnv();
    expect(env.PATH).toMatch(/^\/opt\/homebrew\/bin:\/usr\/local\/bin:/);
  });

  it('preserves the existing PATH at the end', () => {
    const origPath = process.env.PATH;
    process.env.PATH = '/sentinel/path';
    try {
      const env = awsExecEnv();
      expect(env.PATH?.endsWith('/sentinel/path')).toBe(true);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('inherits the rest of process.env (copies, not strips)', () => {
    const origVar = process.env.CT_TEST_VAR;
    process.env.CT_TEST_VAR = 'hello';
    try {
      const env = awsExecEnv();
      expect(env.CT_TEST_VAR).toBe('hello');
    } finally {
      if (origVar === undefined) delete process.env.CT_TEST_VAR;
      else process.env.CT_TEST_VAR = origVar;
    }
  });

  it('includes ~/.local/bin in PATH when HOME is set', () => {
    const origHome = process.env.HOME;
    process.env.HOME = '/Users/probe';
    try {
      const env = awsExecEnv();
      expect(env.PATH).toContain('/Users/probe/.local/bin');
    } finally {
      process.env.HOME = origHome;
    }
  });

  it('handles undefined PATH gracefully', () => {
    const origPath = process.env.PATH;
    delete process.env.PATH;
    try {
      const env = awsExecEnv();
      // Should still have homebrew + usr/local at minimum, ending with empty suffix
      expect(env.PATH).toMatch(/^\/opt\/homebrew\/bin:\/usr\/local\/bin:/);
    } finally {
      process.env.PATH = origPath;
    }
  });
});
