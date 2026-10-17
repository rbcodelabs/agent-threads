import { CLAUDE_SIGN_IN_EXPIRED_MESSAGE } from './claudeAuthRecovery';
import { AWS_SIGN_IN_EXPIRED_MESSAGE, isAwsSignInExpiredError } from './awsAuthRecovery';
import type { SignInResult } from './claudeAuthCli';

export interface ClaudeSignInBannerDeps {
  /** The terminal sign-in-expired error (headline + raw CLI detail). */
  message: string;
  /**
   * Which credential is expired. Defaults from `message`'s headline so a card
   * rebuilt from persisted `authRequired` state picks the right copy.
   */
  flavor?: 'claude' | 'aws';
  /** False where the CLI can't be launched (mobile) — hides the sign-in button. */
  canSignIn: boolean;
  /**
   * Runs the resolved sign-in flow: `claude auth login` + `claude auth
   * status` on the host.
   */
  signIn: (
    onProgress: (text: string) => void,
    onUrl: (url: string) => void,
  ) => Promise<SignInResult>;
  /** Resends the thread's pending message on a fresh CLI session. */
  retry: () => Promise<unknown> | void;
}

const CLAUDE_COPY = {
  title: 'Claude sign-in expired',
  bodySignIn: 'Restarting the Claude session didn’t help. Sign in again and this message will be sent automatically.',
  bodyManual: 'Restarting the Claude session didn’t help. Run `claude auth login` on your computer, then retry.',
  button: 'Sign in to Claude',
};

const AWS_COPY = {
  title: 'AWS sign-in expired',
  bodySignIn: 'Amazon Bedrock couldn’t load your AWS credentials. Sign in with AWS SSO and this message will be sent automatically.',
  bodyManual: 'Amazon Bedrock couldn’t load your AWS credentials. Sign in to AWS SSO on your computer, then retry.',
  button: 'Sign in to AWS',
};

/**
 * In-thread error card for an expired Claude sign-in that the silent
 * fresh-process retry could not fix. Same `.ct-message.ct-error` shell and
 * disclosure as the generic error card, plus two actions: "Sign in to
 * Claude" (desktop) and "Retry". Removes itself once a retry is sent.
 */
export function renderClaudeSignInBanner(parent: HTMLElement, deps: ClaudeSignInBannerDeps): HTMLElement {
  const flavor = deps.flavor ?? (isAwsSignInExpiredError(deps.message) ? 'aws' : 'claude');
  const copy = flavor === 'aws' ? AWS_COPY : CLAUDE_COPY;
  const card = parent.createDiv('ct-message ct-error ct-auth-required');
  card.createEl('div', { cls: 'ct-error-text', text: copy.title });
  card.createEl('div', { cls: 'ct-auth-body', text: deps.canSignIn ? copy.bodySignIn : copy.bodyManual });

  const headline = flavor === 'aws' ? AWS_SIGN_IN_EXPIRED_MESSAGE : CLAUDE_SIGN_IN_EXPIRED_MESSAGE;
  const detail = deps.message.startsWith(headline)
    ? deps.message.slice(headline.length).trim()
    : deps.message;
  if (detail) {
    const details = card.createEl('details', { cls: 'ct-error-details' });
    details.createEl('summary', { text: 'Show technical details' });
    details.createEl('pre', { cls: 'ct-error-stack', text: detail });
  }

  const actions = card.createDiv('ct-auth-actions');
  const status = card.createDiv('ct-auth-status');
  const setStatus = (text: string, isError = false) => {
    status.setText(text);
    status.toggleClass('is-error', isError);
  };

  let busy = false;
  const retryNow = async () => {
    busy = true;
    // Keep the card until the retry is actually accepted; an outright false
    // means there was nothing to resend, so say so instead of vanishing.
    const retried = await deps.retry();
    if (retried === false) {
      busy = false;
      setStatus('Nothing to retry — send your message again.', true);
      return;
    }
    card.remove();
  };

  if (deps.canSignIn) {
    const signInBtn = actions.createEl('button', { cls: 'ct-auth-btn ct-auth-signin-btn mod-cta', text: copy.button });
    signInBtn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      signInBtn.disabled = true;
      card.querySelector('.ct-auth-link')?.remove();
      let result: SignInResult;
      try {
        result = await deps.signIn(
          (text) => setStatus(text),
          (url) => {
            card.createEl('a', {
              cls: 'ct-auth-link',
              text: 'Browser didn’t open? Open the sign-in page',
              href: url,
              attr: { target: '_blank', rel: 'noopener' },
            });
          },
        );
      } catch (err) {
        // Never strand the card on a spinner-style status if sign-in (or
        // saving its result) throws.
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) {
        setStatus('Signed in — retrying…');
        await retryNow();
        return;
      }
      setStatus(result.error, true);
      signInBtn.disabled = false;
      busy = false;
    });
  }

  const retryBtn = actions.createEl('button', { cls: 'ct-auth-btn ct-auth-retry-btn', text: 'Retry' });
  retryBtn.addEventListener('click', () => {
    if (busy) return;
    void retryNow();
  });

  return card;
}
