import { describe, it, expect } from 'vitest';
import {
  AWS_SIGN_IN_EXPIRED_MESSAGE,
  classifyAwsAuthFailure,
  extractAwsProfileFromText,
  formatAwsSignInExpiredMessage,
  isAwsCredentialErrorText,
  isAwsSignInExpiredError,
  resolveAwsProfile,
} from '../../src/awsAuthRecovery';
import {
  classifyClaudeAuthFailure,
  formatSignInExpiredMessage,
  isSignInExpiredError,
} from '../../src/claudeAuthRecovery';

// Captured from a real Claude CLI run against an expired SSO profile.
const REAL_TEXT =
  "API Error: Could not load AWS credentials · The SSO session token associated with profile=probe-expired was not found or is invalid. To refresh this SSO session run 'aws sso login' with the corresponding profile. Check or refresh your AWS credentials and try again.";
const REAL_ASSISTANT = {
  type: 'assistant',
  error: 'cloud_credential_error',
  message: { content: [{ type: 'text', text: REAL_TEXT }] },
};
const REAL_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: null,
  terminal_reason: 'api_error',
  result: REAL_TEXT,
};

describe('awsAuthRecovery', () => {
  describe('isAwsCredentialErrorText', () => {
    it.each([
      REAL_TEXT,
      'Error loading SSO Token: Token for my-profile does not exist',
      'The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login',
      'The security token included in the request is expired',
      'Token has expired and refresh failed',
      'Unable to locate credentials. You can configure credentials by running "aws configure".',
      'ExpiredTokenException: The security token included in the request is expired',
    ])('matches %s', (text) => expect(isAwsCredentialErrorText(text)).toBe(true));

    it.each([
      '',
      'Stream closed',
      'Failed to authenticate: OAuth session expired and could not be refreshed',
      'The session expired while waiting for approval',
      'Rate limited',
    ])('does not match %s', (text) => expect(isAwsCredentialErrorText(text)).toBe(false));
  });

  describe('classifyAwsAuthFailure', () => {
    it('classifies the real cloud_credential_error assistant message', () => {
      expect(classifyAwsAuthFailure(REAL_ASSISTANT)).toBe(REAL_TEXT);
    });

    it('classifies the real is_error success-subtype result', () => {
      expect(classifyAwsAuthFailure(REAL_RESULT)).toBe(REAL_TEXT);
    });

    it('classifies cloud_credential_error even with empty text', () => {
      expect(classifyAwsAuthFailure({ type: 'assistant', error: 'cloud_credential_error', message: { content: [] } }))
        .toBe('cloud_credential_error');
    });

    it('classifies a result by errors[]', () => {
      expect(classifyAwsAuthFailure({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['x', REAL_TEXT] }))
        .toBe(REAL_TEXT);
    });

    it('classifies a thrown Error by message', () => {
      expect(classifyAwsAuthFailure(new Error(REAL_TEXT))).toBe(REAL_TEXT);
      expect(classifyAwsAuthFailure(new Error('Stream closed'))).toBeNull();
    });

    it('never inspects ordinary assistant output that merely discusses SSO', () => {
      expect(classifyAwsAuthFailure({ type: 'assistant', message: { content: [{ type: 'text', text: `You can run 'aws sso login'. ${REAL_TEXT}` }] } })).toBeNull();
    });

    it('ignores a successful result mentioning credentials', () => {
      expect(classifyAwsAuthFailure({ type: 'result', subtype: 'success', is_error: false, result: REAL_TEXT })).toBeNull();
    });

    it('ignores unrelated error results, other assistant errors and junk', () => {
      expect(classifyAwsAuthFailure({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached max turns'] })).toBeNull();
      expect(classifyAwsAuthFailure({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Rate limited' }] } })).toBeNull();
      expect(classifyAwsAuthFailure(null)).toBeNull();
      expect(classifyAwsAuthFailure('x')).toBeNull();
    });
  });

  describe('profile resolution', () => {
    it('extracts profile=NAME from the real error text', () => {
      expect(extractAwsProfileFromText(REAL_TEXT)).toBe('probe-expired');
    });

    it('does not mistake prose ("this profile has expired") for a name', () => {
      expect(extractAwsProfileFromText('The SSO session associated with this profile has expired')).toBeNull();
    });

    it('extracts a quoted profile', () => {
      expect(extractAwsProfileFromText("Error loading SSO Token for profile 'dev-admin'.")).toBe('dev-admin');
    });

    it('prefers extra-env, then process env, then the error text', () => {
      expect(resolveAwsProfile({ AWS_PROFILE: 'a' }, { AWS_PROFILE: 'b' }, REAL_TEXT)).toBe('a');
      expect(resolveAwsProfile({}, { AWS_PROFILE: 'b' }, REAL_TEXT)).toBe('b');
      expect(resolveAwsProfile({}, {}, REAL_TEXT)).toBe('probe-expired');
      expect(resolveAwsProfile({}, {}, 'nothing here')).toBeNull();
    });
  });

  describe('terminal message', () => {
    it('is recognised by the UI', () => {
      const msg = formatAwsSignInExpiredMessage(REAL_TEXT);
      expect(msg.startsWith(AWS_SIGN_IN_EXPIRED_MESSAGE)).toBe(true);
      expect(isAwsSignInExpiredError(msg)).toBe(true);
      expect(isAwsSignInExpiredError(REAL_TEXT)).toBe(false);
      expect(AWS_SIGN_IN_EXPIRED_MESSAGE).toMatch(/sign in to AWS SSO/);
    });
  });

  describe('integration with claudeAuthRecovery', () => {
    it('routes the real stream messages through classifyClaudeAuthFailure', () => {
      expect(classifyClaudeAuthFailure(REAL_ASSISTANT)).toBe(REAL_TEXT);
      expect(classifyClaudeAuthFailure(REAL_RESULT)).toBe(REAL_TEXT);
    });

    it('uses the AWS headline, not the Claude one, for AWS text', () => {
      const msg = formatSignInExpiredMessage(REAL_TEXT);
      expect(msg).toContain('AWS sign-in expired');
      expect(msg).not.toMatch(/claude auth login/);
      expect(isSignInExpiredError(msg)).toBe(true);
    });

    it('keeps the Claude headline for Claude auth text', () => {
      const msg = formatSignInExpiredMessage('Failed to authenticate: OAuth session expired');
      expect(msg).toMatch(/claude auth login/);
      expect(isSignInExpiredError(msg)).toBe(true);
    });
  });
});
