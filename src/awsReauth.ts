import { effectiveExtraEnv, parseExtraEnv, type PluginSettings } from './types';
import { resolveAwsProfile } from './awsAuthRecovery';
import { checkAwsCredentials, signInToAws, type AwsCredentialCheck, type AwsSignInResult } from './awsSsoLogin';

/**
 * Shared "re-authenticate AWS SSO" entry point used by the in-thread sign-in
 * card, the dashboard / kanban buttons and Settings. Resolves the profile and
 * environment the same way the Claude subprocess does, so we sign in to the
 * profile that actually failed. Sign-in is native (OIDC device flow) — the
 * `aws` CLI is not required.
 */

type AwsSettings = Pick<PluginSettings, 'extraEnv' | 'provider'>;

/** Profile to sign in to: extra-env AWS_PROFILE, app env AWS_PROFILE, then the one named in the error. */
export function resolveSignInProfile(
  settings: AwsSettings,
  errorText?: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): string | null {
  return resolveAwsProfile(parseExtraEnv(effectiveExtraEnv(settings)), processEnv, errorText);
}

/** Environment the sign-in reads (HOME, AWS_CONFIG_FILE, AWS_PROFILE) with the user's AWS_* overrides applied. */
export function awsSignInEnv(settings: AwsSettings): NodeJS.ProcessEnv {
  return { ...process.env, ...parseExtraEnv(effectiveExtraEnv(settings)) };
}

export interface AwsReauthHooks {
  onProgress?: (text: string) => void;
  /** Verification URL, shown as a fallback link in case the browser doesn't open. */
  onUrl?: (url: string) => void;
  onCode?: (code: string) => void;
}

function openInBrowser(url: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron') as { shell: { openExternal: (u: string) => void } };
    shell.openExternal(url);
  } catch {
    window.open(url, '_blank');
  }
}

/**
 * Desktop only. Signs in to the resolved profile with the OIDC device flow,
 * opens the approval page (this runs only from a user click), then verifies.
 */
export function reauthenticateAws(
  settings: AwsSettings,
  errorText: string | undefined,
  hooks: AwsReauthHooks = {},
): Promise<AwsSignInResult> {
  return signInToAws({
    env: awsSignInEnv(settings),
    profile: resolveSignInProfile(settings, errorText),
    openUrl: openInBrowser,
    ...hooks,
  });
}

/** Desktop only. Non-interactive credential probe for the resolved profile (Settings "Check"). */
export function checkAwsCredentialsNow(settings: AwsSettings): Promise<AwsCredentialCheck> {
  return checkAwsCredentials({ env: awsSignInEnv(settings), profile: resolveSignInProfile(settings) });
}
