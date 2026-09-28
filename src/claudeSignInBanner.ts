import { CLAUDE_SIGN_IN_EXPIRED_MESSAGE } from './claudeAuthRecovery';
import type { SignInResult } from './claudeAuthCli';

export interface ClaudeSignInBannerDeps {
  /** The terminal sign-in-expired error (headline + raw CLI detail). */
  message: string;
  /** False where the CLI can't be launched (mobile) — hides the sign-in button. */
  canSignIn: boolean;
  /** Runs `claude auth login` + `claude auth status`. */
  signIn: (onProgress: (text: string) => void, onUrl: (url: string) => void) => Promise<SignInResult>;
  /** Resends the thread's pending message on a fresh CLI session. */
  retry: () => Promise<unknown> | void;
}

/**
 * In-thread error card for an expired Claude sign-in that the silent
 * fresh-process retry could not fix. Same `.ct-message.ct-error` shell and
 * disclosure as the generic error card, plus two actions: "Sign in to
 * Claude" (desktop) and "Retry". Removes itself once a retry is sent.
 */
export function renderClaudeSignInBanner(parent: HTMLElement, deps: ClaudeSignInBannerDeps): HTMLElement {
  const card = parent.createDiv('ct-message ct-error ct-auth-required');
  card.createEl('div', { cls: 'ct-error-text', text: 'Claude sign-in expired' });
  card.createEl('div', {
    cls: 'ct-auth-body',
    text: deps.canSignIn
      ? 'Restarting the Claude session didn’t help. Sign in again and this message will be sent automatically.'
      : 'Restarting the Claude session didn’t help. Run `claude auth login` on your computer, then retry.',
  });

  const detail = deps.message.startsWith(CLAUDE_SIGN_IN_EXPIRED_MESSAGE)
    ? deps.message.slice(CLAUDE_SIGN_IN_EXPIRED_MESSAGE.length).trim()
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
    card.remove();
    await deps.retry();
  };

  if (deps.canSignIn) {
    const signInBtn = actions.createEl('button', { cls: 'ct-auth-btn ct-auth-signin-btn mod-cta', text: 'Sign in to Claude' });
    signInBtn.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      signInBtn.disabled = true;
      card.querySelector('.ct-auth-link')?.remove();
      const result = await deps.signIn(
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
