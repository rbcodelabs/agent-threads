import { describe, it, expect } from 'vitest';
import {
  CLAUDE_SIGN_IN_EXPIRED_MESSAGE,
  MAX_AUTH_AUTO_RETRIES,
  classifyClaudeAuthFailure,
  isClaudeAuthErrorText,
  isClaudeSignInExpiredError,
  parseClaudeAuthStatus,
  shouldAutoRetryAuthError,
} from '../../src/claudeAuthRecovery';

const OAUTH_EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';

describe('claudeAuthRecovery', () => {
  describe('isClaudeAuthErrorText', () => {
    it.each([
      OAUTH_EXPIRED,
      'OAuth access token could not be refreshed: another Claude Code process is holding the refresh lock',
      'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
      'authentication_failed',
      'Invalid API key · Please run /login',
      'invalid x-api-key',
      'API Error: 401 Unauthorized',
    ])('matches %s', (text) => {
      expect(isClaudeAuthErrorText(text)).toBe(true);
    });

    it.each([
      '',
      'Stream closed',
      'Server is temporarily limiting requests (not your usage limit) · Rate limited',
      'ENOENT: no such file or directory',
      // A bare number containing 401 is not an auth failure.
      'Processed 14012 rows; see line 401 of output.csv',
      'Error loading SSO Token: Token for my-profile does not exist',
      'The session expired while waiting for approval',
    ])('does not match %s', (text) => {
      expect(isClaudeAuthErrorText(text)).toBe(false);
    });
  });

  describe('classifyClaudeAuthFailure', () => {
    it('classifies an assistant message flagged error: authentication_failed', () => {
      expect(classifyClaudeAuthFailure({
        type: 'assistant',
        error: 'authentication_failed',
        message: { content: [{ type: 'text', text: OAUTH_EXPIRED }] },
      })).toBe(OAUTH_EXPIRED);
    });

    it('classifies an assistant message with a generic error flag but auth text', () => {
      expect(classifyClaudeAuthFailure({
        type: 'assistant',
        error: 'unknown',
        message: { content: [{ type: 'text', text: OAUTH_EXPIRED }] },
      })).toBe(OAUTH_EXPIRED);
    });

    it('never classifies ordinary model output that merely mentions auth errors', () => {
      expect(classifyClaudeAuthFailure({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `The server returned ${OAUTH_EXPIRED}` }] },
      })).toBeNull();
    });

    it('does not classify an assistant error of another kind', () => {
      expect(classifyClaudeAuthFailure({
        type: 'assistant',
        error: 'rate_limit',
        message: { content: [{ type: 'text', text: 'Rate limited' }] },
      })).toBeNull();
    });

    it('classifies an is_error success-subtype result by its text', () => {
      expect(classifyClaudeAuthFailure({ type: 'result', subtype: 'success', is_error: true, result: OAUTH_EXPIRED })).toBe(OAUTH_EXPIRED);
    });

    it('classifies an is_error result with api_error_status 401', () => {
      expect(classifyClaudeAuthFailure({ type: 'result', subtype: 'success', is_error: true, result: 'Something went wrong', api_error_status: 401 }))
        .toBe('Something went wrong');
    });

    it('classifies an error-subtype result by its errors[]', () => {
      expect(classifyClaudeAuthFailure({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom', OAUTH_EXPIRED] }))
        .toBe(OAUTH_EXPIRED);
    });

    it('ignores a successful result even if its text mentions auth', () => {
      expect(classifyClaudeAuthFailure({ type: 'result', subtype: 'success', is_error: false, result: OAUTH_EXPIRED })).toBeNull();
    });

    it('ignores an is_error result for an unrelated failure', () => {
      expect(classifyClaudeAuthFailure({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached max turns'] })).toBeNull();
    });

    it('classifies auth_status carrying an error', () => {
      expect(classifyClaudeAuthFailure({ type: 'auth_status', isAuthenticating: false, output: [], error: 'Token refresh failed' }))
        .toBe('Token refresh failed');
    });

    it('ignores auth_status without an error', () => {
      expect(classifyClaudeAuthFailure({ type: 'auth_status', isAuthenticating: true, output: ['Opening browser'] })).toBeNull();
    });

    it('classifies a thrown Error by message', () => {
      expect(classifyClaudeAuthFailure(new Error(OAUTH_EXPIRED))).toBe(OAUTH_EXPIRED);
      expect(classifyClaudeAuthFailure(new Error('Stream closed'))).toBeNull();
    });

    it('returns null for junk', () => {
      expect(classifyClaudeAuthFailure(null)).toBeNull();
      expect(classifyClaudeAuthFailure('string')).toBeNull();
      expect(classifyClaudeAuthFailure({ type: 'system', subtype: 'status' })).toBeNull();
    });
  });

  describe('retry budget', () => {
    it('allows exactly one automatic retry per turn', () => {
      expect(MAX_AUTH_AUTO_RETRIES).toBe(1);
      expect(shouldAutoRetryAuthError(0)).toBe(true);
      expect(shouldAutoRetryAuthError(1)).toBe(false);
      expect(shouldAutoRetryAuthError(2)).toBe(false);
    });
  });

  describe('sign-in expired message', () => {
    it('tells the user how to recover and is recognised by the UI', () => {
      expect(CLAUDE_SIGN_IN_EXPIRED_MESSAGE).toMatch(/claude auth login/);
      expect(isClaudeSignInExpiredError(`${CLAUDE_SIGN_IN_EXPIRED_MESSAGE}\n\n${OAUTH_EXPIRED}`)).toBe(true);
      expect(isClaudeSignInExpiredError(OAUTH_EXPIRED)).toBe(false);
    });
  });

  describe('parseClaudeAuthStatus', () => {
    it('reads loggedIn from `claude auth status` JSON', () => {
      expect(parseClaudeAuthStatus('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}')).toBe(true);
      expect(parseClaudeAuthStatus('{"loggedIn": false}')).toBe(false);
    });

    it('treats unparseable output as signed out', () => {
      expect(parseClaudeAuthStatus('')).toBe(false);
      expect(parseClaudeAuthStatus('Logged in')).toBe(false);
      expect(parseClaudeAuthStatus('{"loggedIn": "yes"}')).toBe(false);
    });
  });
});
