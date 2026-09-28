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
});
