import { describe, it, expect } from 'vitest';
import { appendStderrTail, isResumeFailure, withStderr, MAX_STDERR_TAIL_CHARS } from '../../src/resumeFailureRecovery';

const exit1 = 'Claude Code process exited with code 1';

describe('isResumeFailure', () => {
  it('matches exit code 1 on a resumed session before any message', () => {
    expect(isResumeFailure(exit1, '', { resumed: true, sawMessage: false })).toBe(true);
  });
  it('matches "No conversation found" in stderr', () => {
    expect(isResumeFailure('boom', 'No conversation found with session ID: x', { resumed: true, sawMessage: false })).toBe(true);
  });
  it('does not match a fresh (non-resumed) session', () => {
    expect(isResumeFailure(exit1, '', { resumed: false, sawMessage: false })).toBe(false);
  });
  it('does not match once the session has produced output', () => {
    expect(isResumeFailure(exit1, '', { resumed: true, sawMessage: true })).toBe(false);
  });
  it('does not match other exit codes', () => {
    expect(isResumeFailure('Claude Code process exited with code 143', '', { resumed: true, sawMessage: false })).toBe(false);
  });
});

describe('stderr helpers', () => {
  it('bounds the tail', () => {
    const t = appendStderrTail('', 'x'.repeat(MAX_STDERR_TAIL_CHARS + 50));
    expect(t.length).toBe(MAX_STDERR_TAIL_CHARS);
  });
  it('withStderr appends only when present', () => {
    expect(withStderr('m', '  ')).toBe('m');
    expect(withStderr('m', 'bad')).toContain('Claude Code stderr:\nbad');
  });
});
