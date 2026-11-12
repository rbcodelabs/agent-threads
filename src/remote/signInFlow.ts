/**
 * Which "Sign in to Claude" flow a thread's card runs, as a pure decision so it can be tested without a view.
 *
 *   aws              Bedrock credentials expired: AWS SSO on this computer
 *   local-container  the managed local daemon: `claude setup-token` inside its container
 *   remote           a plain remote daemon that can sign in (`auth.signin` capability, or not known yet)
 *   remote-manual    a plain remote daemon too old to sign in from the app: show instructions instead
 *   host             a thread on this computer: `claude auth login`
 *
 * Running `claude auth login` on this computer for a remote daemon's thread fixes nothing on the daemon, which is why
 * remote threads never fall through to `host`.
 */
import { AUTH_SIGNIN_CAPABILITY } from '../protocol';

export type ClaudeSignInFlow = 'aws' | 'local-container' | 'remote' | 'remote-manual' | 'host';

export interface SignInFlowInput {
  awsExpired: boolean;
  /** The thread's daemon, or undefined for a host thread (or one whose daemon was removed). */
  daemon: { managed?: string } | undefined;
  /** `welcome.capabilities` of the daemon, or undefined while it has not been reached. */
  capabilities: readonly string[] | undefined;
}

export function chooseClaudeSignInFlow(input: SignInFlowInput): ClaudeSignInFlow {
  if (input.awsExpired) return 'aws';
  if (!input.daemon) return 'host';
  if (input.daemon.managed === 'local-container') return 'local-container';
  // Unknown capabilities: try. The start command's `unknown_command` is turned into the same instructions.
  if (input.capabilities === undefined || input.capabilities.includes(AUTH_SIGNIN_CAPABILITY)) return 'remote';
  return 'remote-manual';
}

/** What to tell the user when the app cannot sign the daemon in: do it on the machine. */
export function manualRemoteSignInHint(daemonName: string, daemonUrl: string): string {
  let host = '<host>';
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(daemonUrl.trim()) ? daemonUrl.trim() : `ws://${daemonUrl.trim()}`).hostname || host; } catch { /* keep the placeholder */ }
  return `"${daemonName}" runs an older daemon that cannot sign in from here. Sign in on that machine instead: run \`ssh ${host} -t claude /login\`, complete the browser step, then press Retry.`;
}
