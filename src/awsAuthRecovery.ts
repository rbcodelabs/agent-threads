/**
 * Detection helpers for expired / missing AWS credentials when the provider is
 * Amazon Bedrock.
 *
 * The Claude CLI reports a Bedrock credential failure in-band, NOT as a thrown
 * error or an `authentication_failed` message. The observed stream for an
 * expired SSO profile is:
 *
 *   assistant { error: 'cloud_credential_error', message.content[0].text:
 *     "API Error: Could not load AWS credentials · The SSO session token
 *      associated with profile=NAME was not found or is invalid. To refresh
 *      this SSO session run 'aws sso login' with the corresponding profile." }
 *   result    { subtype: 'success', is_error: true, api_error_status: null,
 *               terminal_reason: 'api_error', result: <same text> }
 *
 * Because `subtype` is `success` the turn looks finished, so without this
 * classifier the failure renders as ordinary assistant text and no sign-in
 * affordance ever appears.
 *
 * Like claudeAuthRecovery, classification is conservative: plain assistant
 * output is never inspected (the model may legitimately discuss SSO), and a
 * `result` must be `is_error` with recognisable AWS text.
 */

/** Headline of the terminal error surfaced for an AWS credential failure. */
export const AWS_SIGN_IN_EXPIRED_MESSAGE = 'AWS sign-in expired — sign in to AWS SSO again';

const AWS_CREDENTIAL_PATTERN = new RegExp(
  [
    'Could not load (?:AWS )?credentials',
    'Error loading SSO Token',
    'SSO (?:session|token)[^\\n]{0,80}(?:expired|invalid|not found)',
    '\\baws sso login\\b',
    'security token included in the request is (?:expired|invalid)',
    'Token has expired and refresh failed',
    'Unable to locate credentials',
    '\\bExpiredToken(?:Exception)?\\b',
    'CredentialsProviderError',
  ].join('|'),
  'i',
);

export function isAwsCredentialErrorText(text: string): boolean {
  return !!text && AWS_CREDENTIAL_PATTERN.test(text);
}

/** True for the terminal error raised for an AWS credential failure. */
export function isAwsSignInExpiredError(message: string | undefined): boolean {
  return !!message && message.startsWith(AWS_SIGN_IN_EXPIRED_MESSAGE);
}

/** Terminal error text: clear headline, raw CLI detail underneath. */
export function formatAwsSignInExpiredMessage(detail: string): string {
  return detail ? `${AWS_SIGN_IN_EXPIRED_MESSAGE}\n\n${detail}` : AWS_SIGN_IN_EXPIRED_MESSAGE;
}

/** Pulls `profile=NAME` out of the CLI/SDK credential error text. */
export function extractAwsProfileFromText(text: string | undefined): string | null {
  if (!text) return null;
  const match = text.match(/\bprofile(?:=|\s+['"])([A-Za-z0-9_.@:+\/-]+?)['"]?(?=[\s,.;:)]|$)/i);
  return match ? match[1] : null;
}

/**
 * Picks the profile to sign in to. Precedence mirrors how the CLI subprocess
 * resolves it: the thread/extra-env `AWS_PROFILE`, then the app's own process
 * environment, then whatever profile the error text named.
 */
export function resolveAwsProfile(
  extraEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
  errorText?: string,
): string | null {
  return extraEnv.AWS_PROFILE || processEnv.AWS_PROFILE || extractAwsProfileFromText(errorText) || null;
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
 * is an AWS credential failure, otherwise null.
 *
 * - `assistant` flagged `error: 'cloud_credential_error'`, or any `error`
 *   flag with matching AWS text
 * - `result` with `is_error` whose `result`/`errors[]` text matches
 * - an `Error` whose message matches
 */
export function classifyAwsAuthFailure(msg: unknown): string | null {
  if (msg instanceof Error) return isAwsCredentialErrorText(msg.message) ? msg.message : null;
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case 'assistant': {
      if (typeof m.error !== 'string') return null;
      const text = assistantText(m.message);
      if (m.error === 'cloud_credential_error') return text || 'cloud_credential_error';
      return isAwsCredentialErrorText(text) ? text : null;
    }
    case 'result': {
      if (m.is_error !== true) return null;
      const texts = [
        ...(typeof m.result === 'string' ? [m.result] : []),
        ...(Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === 'string') : []),
      ];
      return texts.find(isAwsCredentialErrorText) ?? null;
    }
    default:
      return null;
  }
}
