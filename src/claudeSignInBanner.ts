import { CLAUDE_SIGN_IN_EXPIRED_MESSAGE } from './claudeAuthRecovery';
import type { SignInResult } from './claudeAuthCli';

export interface ClaudeSignInBannerDeps {
  /** The terminal sign-in-expired error (headline + raw CLI detail). */
  message: string;
  /** False where the CLI can't be launched (mobile) — hides the sign-in button. */
  canSignIn: boolean;
  /**
   * Runs the resolved sign-in flow: `claude auth login` + `claude auth
   * status` on the host, or (ADR-0015 container-routed threads) the
   * container's own `claude setup-token` via `onCodePrompt`. Host-flow
   * callers can ignore the third argument — it is only invoked by the
   * container flow.
   */
  signIn: (
    onProgress: (text: string) => void,
    onUrl: (url: string) => void,
    onCodePrompt: () => Promise<string | null>,
  ) => Promise<SignInResult>;
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

  // Owned by whichever onCodePrompt() call is currently in flight, so a
  // terminal result (success, failure, or timeout) can always clean it up
  // even if the user never explicitly submits or cancels it.
  let codePromptEl: HTMLElement | null = null;
  const removeCodePrompt = () => {
    codePromptEl?.remove();
    codePromptEl = null;
  };

  /**
   * Shows an inline "paste the login code" field (ADR-0015 container sign-in
   * flow) and resolves with the typed code, or `null` on Cancel/Enter-less
   * abandonment. The host flow's `signIn` never calls this.
   */
  const onCodePrompt = (): Promise<string | null> => {
    return new Promise((resolve) => {
      removeCodePrompt();
      const wrap = card.createDiv('ct-auth-code-prompt');
      wrap.createEl('div', { cls: 'ct-auth-code-label', text: 'Paste the login code shown in your browser:' });
      const row = wrap.createDiv('ct-auth-code-row');
      const input = row.createEl('input', { cls: 'ct-auth-code-input', attr: { type: 'text', placeholder: 'Login code' } });
      const submitBtn = row.createEl('button', { cls: 'ct-auth-btn ct-auth-code-submit mod-cta', text: 'Submit' });
      const cancelBtn = row.createEl('button', { cls: 'ct-auth-btn ct-auth-code-cancel', text: 'Cancel' });
      codePromptEl = wrap;
      const finish = (value: string | null) => {
        removeCodePrompt();
        resolve(value);
      };
      submitBtn.addEventListener('click', () => finish(input.value.trim() || null));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(input.value.trim() || null);
      });
      cancelBtn.addEventListener('click', () => finish(null));
      input.focus();
    });
  };

  if (deps.canSignIn) {
    const signInBtn = actions.createEl('button', { cls: 'ct-auth-btn ct-auth-signin-btn mod-cta', text: 'Sign in to Claude' });
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
          onCodePrompt,
        );
      } catch (err) {
        // Never strand the card on a spinner-style status if sign-in (or
        // saving its result) throws.
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      removeCodePrompt();
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
