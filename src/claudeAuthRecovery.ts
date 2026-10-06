/**
 * Detection and recovery helpers for an expired Claude sign-in.
 *
 * The plugin has no login of its own: every thread's CLI subprocess reads the
 * CLI's OAuth credentials from the macOS keychain ("Claude Code-credentials").
 * When several CLI processes run at once they race to refresh the shared
 * token; the loser keeps a dead access token in memory ("OAuth access token
 * could not be refreshed: another Claude Code process is holding the refresh
 * lock") until the process is restarted. So the first recovery step is
 * simply to tear down the thread's CLI process and replay the turn — the new
 * process re-reads the (by now refreshed) keychain entry. Only if that also
 * fails is the user asked to sign in again.
 *
 * Classification is deliberately conservative: ordinary assistant output is
 * never inspected (the model may legitimately talk about 401s), and an
 * `is_error` result must carry recognisable auth text or a 401 status.
 */

import { classifyAwsAuthFailure, formatAwsSignInExpiredMessage, isAwsCredentialErrorText, isAwsSignInExpiredError } from './awsAuthRecovery';

/** One silent retry per user turn — never loop. */
export const MAX_AUTH_AUTO_RETRIES = 1;

/** Headline of the terminal error surfaced once the silent retry also failed. */
export const CLAUDE_SIGN_IN_EXPIRED_MESSAGE = 'Claude sign-in expired — run `claude auth login`';

const AUTH_ERROR_PATTERN = new RegExp(
  [
    'OAuth session expired',
    '(?:token|OAuth|session)[^\\n]{0,60}could not be refreshed',
    'Failed to authenticate',
    'authentication_failed',
    'invalid[^\\n]{0,40}(?:api key|x-api-key)',
    '\\bAPI Error:?\\s*401\\b',
    '\\b401\\b[^\\n]{0,40}(?:unauthori[sz]ed|authentication)',
  ].join('|'),
  'i',
);

export function isClaudeAuthErrorText(text: string): boolean {
  return !!text && AUTH_ERROR_PATTERN.test(text);
}

export function shouldAutoRetryAuthError(currentRetryCount: number): boolean {
  return currentRetryCount < MAX_AUTH_AUTO_RETRIES;
}

/** True for the terminal error ThreadSession/ConstrainedRun raise after the retry failed. */
export function isClaudeSignInExpiredError(message: string | undefined): boolean {
  return !!message && message.startsWith(CLAUDE_SIGN_IN_EXPIRED_MESSAGE);
}

/** True for either terminal sign-in error (Claude OAuth or AWS credentials). */
export function isSignInExpiredError(message: string | undefined): boolean {
  return isClaudeSignInExpiredError(message) || isAwsSignInExpiredError(message);
}

/** Terminal error text: clear headline, raw CLI detail underneath. */
export function formatSignInExpiredMessage(detail: string): string {
  // Bedrock credential failures need the AWS headline, not the Claude one.
  if (isAwsCredentialErrorText(detail)) return formatAwsSignInExpiredMessage(detail);
  return detail ? `${CLAUDE_SIGN_IN_EXPIRED_MESSAGE}\n\n${detail}` : CLAUDE_SIGN_IN_EXPIRED_MESSAGE;
}

function assistantText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Returns the error text if `msg` — an SDK stream message or a thrown error —
 * is an authentication failure, otherwise null.
 *
 * AWS/Bedrock credential failures (`cloud_credential_error`) are recognised
 * first via awsAuthRecovery so they take the same recovery path.
 *
 * - `assistant` with `error: 'authentication_failed'`, or with any `error`
 *   flag and auth text (the CLI's synthetic API-error message)
 * - `result` with `is_error` whose `result`/`errors[]` text matches, or
 *   whose `api_error_status` is 401
 * - `auth_status` carrying an `error`
 * - an `Error` whose message matches
 */
export function classifyClaudeAuthFailure(msg: unknown): string | null {
  const aws = classifyAwsAuthFailure(msg);
  if (aws) return aws;
  if (msg instanceof Error) return isClaudeAuthErrorText(msg.message) ? msg.message : null;
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case 'assistant': {
      if (typeof m.error !== 'string') return null;
      const text = assistantText(m.message);
      if (m.error === 'authentication_failed') return text || 'authentication_failed';
      return isClaudeAuthErrorText(text) ? text : null;
    }
    case 'result': {
      if (m.is_error !== true) return null;
      const texts = [
        ...(typeof m.result === 'string' ? [m.result] : []),
        ...(Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === 'string') : []),
      ];
      const match = texts.find(isClaudeAuthErrorText);
      if (match) return match;
      if (m.api_error_status === 401) return texts[0] || 'API Error: 401';
      return null;
    }
    case 'auth_status':
      return typeof m.error === 'string' && m.error ? m.error : null;
    default:
      return null;
  }
}

/** Parses `claude auth status` (JSON by default) — true only for `loggedIn: true`. */
export function parseClaudeAuthStatus(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
    return parsed?.loggedIn === true;
  } catch {
    return false;
  }
}
