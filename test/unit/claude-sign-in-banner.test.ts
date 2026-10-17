/**
 * @vitest-environment jsdom
 *
 * The in-thread "Sign in to Claude" banner shown when a turn fails to
 * authenticate even after the silent fresh-process retry.
 */
import '../setup/obsidian-dom';
import { describe, it, expect, vi } from 'vitest';
import { renderClaudeSignInBanner } from '../../src/claudeSignInBanner';
import { formatSignInExpiredMessage } from '../../src/claudeAuthRecovery';
import { formatAwsSignInExpiredMessage } from '../../src/awsAuthRecovery';
import type { SignInResult } from '../../src/claudeAuthCli';

const MESSAGE = formatSignInExpiredMessage('Failed to authenticate: OAuth session expired and could not be refreshed');

function mount(overrides: Partial<Parameters<typeof renderClaudeSignInBanner>[1]> = {}) {
  const parent = document.createElement('div');
  const deps = {
    message: MESSAGE,
    canSignIn: true,
    signIn: vi.fn(async (): Promise<SignInResult> => ({ ok: true })),
    retry: vi.fn(async () => {}),
    ...overrides,
  };
  const el = renderClaudeSignInBanner(parent, deps);
  const button = (label: string) => [...el.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement | undefined;
  const status = () => el.querySelector('.ct-auth-status')?.textContent ?? '';
  return { parent, el, deps, button, status };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('renderClaudeSignInBanner', () => {
  it('renders a clear headline, the raw detail, and both actions', () => {
    const { el, button } = mount();
    expect(el.classList.contains('ct-auth-required')).toBe(true);
    expect(el.querySelector('.ct-error-text')?.textContent).toBe('Claude sign-in expired');
    expect(el.querySelector('.ct-error-stack')?.textContent).toContain('OAuth session expired');
    expect(button('Sign in to Claude')).toBeDefined();
    expect(button('Retry')).toBeDefined();
  });

  it('signs in, shows progress, then retries the pending message and removes itself', async () => {
    let finish!: (r: SignInResult) => void;
    const signIn = vi.fn((onProgress: (t: string) => void) => {
      onProgress('Waiting for browser sign-in…');
      return new Promise<SignInResult>(r => { finish = r; });
    });
    const { el, deps, button, status } = mount({ signIn });
    button('Sign in to Claude')!.click();
    expect(button('Sign in to Claude')!.disabled).toBe(true);
    expect(status()).toBe('Waiting for browser sign-in…');
    finish({ ok: true });
    await flush();
    expect(deps.retry).toHaveBeenCalledTimes(1);
    expect(el.isConnected).toBe(false);
  });

  it('keeps the card and says so when there is nothing to retry', async () => {
    const { parent, el, deps, button, status } = mount({ retry: vi.fn(async () => false) });
    button('Retry')!.click();
    await flush();
    expect(deps.retry).toHaveBeenCalledTimes(1);
    expect(parent.contains(el)).toBe(true);
    expect(status()).toContain('Nothing to retry');
    button('Retry')!.click();
    await flush();
    expect(deps.retry).toHaveBeenCalledTimes(2);
  });

  it('shows the failure and keeps the button on a failed sign-in', async () => {
    const { el, deps, button, status } = mount({ signIn: vi.fn(async () => ({ ok: false as const, error: 'Sign-in timed out after 5 min.' })) });
    document.body.appendChild(el);
    button('Sign in to Claude')!.click();
    await flush();
    expect(status()).toBe('Sign-in timed out after 5 min.');
    expect(el.querySelector('.ct-auth-status')?.classList.contains('is-error')).toBe(true);
    expect(button('Sign in to Claude')!.disabled).toBe(false);
    expect(deps.retry).not.toHaveBeenCalled();
    expect(el.isConnected).toBe(true);
  });

  it('offers a sign-in link when the CLI prints one', async () => {
    const signIn = vi.fn(async (_p: (t: string) => void, onUrl: (u: string) => void) => {
      onUrl('https://claude.ai/oauth/authorize?x=1');
      return new Promise<SignInResult>(() => {});
    });
    const { el, button } = mount({ signIn });
    button('Sign in to Claude')!.click();
    await flush();
    const link = el.querySelector('a.ct-auth-link') as HTMLAnchorElement;
    expect(link.href).toBe('https://claude.ai/oauth/authorize?x=1');
  });

  it('shows the error and re-enables the button when signIn REJECTS, instead of freezing on the last status', async () => {
    const signIn = vi.fn(async (onProgress: (t: string) => void) => {
      onProgress('Verifying code…');
      throw new Error('secret storage unavailable');
    });
    const { el, deps, button, status } = mount({ signIn });
    document.body.appendChild(el);
    button('Sign in to Claude')!.click();
    await flush();
    expect(status()).toBe('secret storage unavailable');
    expect(el.querySelector('.ct-auth-status')?.classList.contains('is-error')).toBe(true);
    expect(button('Sign in to Claude')!.disabled).toBe(false);
    expect(deps.retry).not.toHaveBeenCalled();
  });

  it('Retry resends without signing in', async () => {
    const { deps, button } = mount();
    button('Retry')!.click();
    await flush();
    expect(deps.retry).toHaveBeenCalledTimes(1);
    expect(deps.signIn).not.toHaveBeenCalled();
  });

  it('hides the sign-in button where the CLI cannot be launched (mobile)', () => {
    const { el, button } = mount({ canSignIn: false });
    expect(button('Sign in to Claude')).toBeUndefined();
    expect(button('Retry')).toBeDefined();
    expect(el.textContent).toContain('claude auth login');
  });

  describe('container sign-in (ADR-0015 paste-code flow)', () => {
    function findCodeInput(el: HTMLElement): HTMLInputElement {
      return el.querySelector('.ct-auth-code-input') as HTMLInputElement;
    }
    function findCodeButton(el: HTMLElement, label: string): HTMLButtonElement | undefined {
      return [...el.querySelectorAll('.ct-auth-code-row button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
    }

    it('calls onCodePrompt, shows a paste-code field, and resolves with the typed code on Submit', async () => {
      let capturedOnCodePrompt!: () => Promise<string | null>;
      const signIn = vi.fn((onProgress: (t: string) => void, onUrl: (u: string) => void, onCodePrompt: () => Promise<string | null>) => {
        capturedOnCodePrompt = onCodePrompt;
        return new Promise<SignInResult>(() => {});
      });
      const { el, button } = mount({ signIn });
      button('Sign in to Claude')!.click();
      await flush();

      const promptPromise = capturedOnCodePrompt();
      expect(el.querySelector('.ct-auth-code-prompt')).toBeTruthy();
      const input = findCodeInput(el);
      input.value = 'ABCD-1234';
      findCodeButton(el, 'Submit')!.click();

      expect(await promptPromise).toBe('ABCD-1234');
      expect(el.querySelector('.ct-auth-code-prompt')).toBeNull();
    });

    it('resolves with null and removes the field on Cancel', async () => {
      let capturedOnCodePrompt!: () => Promise<string | null>;
      const signIn = vi.fn((onProgress: (t: string) => void, onUrl: (u: string) => void, onCodePrompt: () => Promise<string | null>) => {
        capturedOnCodePrompt = onCodePrompt;
        return new Promise<SignInResult>(() => {});
      });
      const { el, button } = mount({ signIn });
      button('Sign in to Claude')!.click();
      await flush();

      const promptPromise = capturedOnCodePrompt();
      findCodeButton(el, 'Cancel')!.click();

      expect(await promptPromise).toBeNull();
      expect(el.querySelector('.ct-auth-code-prompt')).toBeNull();
    });

    it('submits on Enter without clicking Submit', async () => {
      let capturedOnCodePrompt!: () => Promise<string | null>;
      const signIn = vi.fn((onProgress: (t: string) => void, onUrl: (u: string) => void, onCodePrompt: () => Promise<string | null>) => {
        capturedOnCodePrompt = onCodePrompt;
        return new Promise<SignInResult>(() => {});
      });
      const { el, button } = mount({ signIn });
      button('Sign in to Claude')!.click();
      await flush();

      const promptPromise = capturedOnCodePrompt();
      const input = findCodeInput(el);
      input.value = 'WXYZ-9999';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

      expect(await promptPromise).toBe('WXYZ-9999');
    });

    it('a leftover paste-code field is cleaned up once sign-in finishes, even if the user never resolved it', async () => {
      let finish!: (r: SignInResult) => void;
      const signIn = vi.fn((onProgress: (t: string) => void, onUrl: (u: string) => void, onCodePrompt: () => Promise<string | null>) => {
        void onCodePrompt(); // container flow calls this itself; never resolved by the test
        return new Promise<SignInResult>((r) => { finish = r; });
      });
      const { el, deps, button } = mount({ signIn });
      button('Sign in to Claude')!.click();
      await flush();
      expect(el.querySelector('.ct-auth-code-prompt')).toBeTruthy();

      finish({ ok: true });
      await flush();
      expect(deps.retry).toHaveBeenCalledTimes(1);
      expect(el.querySelector('.ct-auth-code-prompt')).toBeNull();
    });

    it('the host flow never sees onCodePrompt invoked', async () => {
      let capturedOnCodePrompt!: () => Promise<string | null>;
      const signIn = vi.fn((onProgress: (t: string) => void, onUrl: (u: string) => void, onCodePrompt: () => Promise<string | null>) => {
        capturedOnCodePrompt = onCodePrompt;
        onProgress('Waiting for browser sign-in…');
        return new Promise<SignInResult>(() => {});
      });
      const { el, button } = mount({ signIn });
      button('Sign in to Claude')!.click();
      await flush();
      expect(capturedOnCodePrompt).toBeDefined();
      expect(el.querySelector('.ct-auth-code-prompt')).toBeNull();
    });
  });
});

describe("renderClaudeSignInBanner — AWS flavor", () => {
  const AWS_DETAIL = "API Error: Could not load AWS credentials · The SSO session token associated with profile=probe-expired was not found or is invalid.";
  const AWS_MESSAGE = formatAwsSignInExpiredMessage(AWS_DETAIL);

  it("auto-selects AWS copy from the message and keeps the raw detail", () => {
    const { el, button } = mount({ message: AWS_MESSAGE });
    expect(el.querySelector(".ct-error-text")?.textContent).toBe("AWS sign-in expired");
    expect(el.querySelector(".ct-error-stack")?.textContent).toContain("profile=probe-expired");
    expect(button("Sign in to AWS")).toBeDefined();
    expect(button("Sign in to Claude")).toBeUndefined();
    expect(button("Retry")).toBeDefined();
  });

  it("signs in and retries the pending message like the Claude flavor", async () => {
    const { el, deps, button } = mount({ message: AWS_MESSAGE });
    button("Sign in to AWS")!.click();
    await flush();
    expect(deps.signIn).toHaveBeenCalledTimes(1);
    expect(deps.retry).toHaveBeenCalledTimes(1);
    expect(el.isConnected).toBe(false);
  });

  it("surfaces the manual sign-in link from the CLI", async () => {
    const signIn = vi.fn(async (_p: (t: string) => void, onUrl: (u: string) => void) => {
      onUrl("https://oidc.us-east-1.amazonaws.com/authorize?x=1");
      return new Promise<SignInResult>(() => {});
    });
    const { el, button } = mount({ message: AWS_MESSAGE, signIn });
    button("Sign in to AWS")!.click();
    await flush();
    expect((el.querySelector("a.ct-auth-link") as HTMLAnchorElement).href).toBe("https://oidc.us-east-1.amazonaws.com/authorize?x=1");
  });
});
