/**
 * @vitest-environment jsdom
 */
import '../setup/obsidian-dom';
import { describe, it, expect, vi } from 'vitest';
import { renderLocalDaemonPanel, type LocalDaemonPanelDeps } from '../../src/localDaemon/localDaemonPanel';
import type { LocalDaemonSnapshot } from '../../src/localDaemon/controller';
import { snap } from '../helpers/localDaemonSnap';

const flush = () => new Promise((r) => setTimeout(r, 0));
const mount = () => { const el = document.createElement('div'); document.body.appendChild(el); return el; };
const probe = (codexSignedIn: boolean, antigravitySignedIn = false) => ({
  claude: { cli: true, signedIn: false },
  codex: { cli: true, signedIn: codexSignedIn },
  opencode: { cli: true, signedIn: false },
  antigravity: { cli: true, signedIn: antigravitySignedIn },
});

function setup(snapshot: LocalDaemonSnapshot, over: Partial<LocalDaemonPanelDeps> = {}) {
  const d = {
    isMobile: false,
    pluginVersion: '0.65.0',
    snapshot: vi.fn(async () => snapshot),
    subscribe: vi.fn(() => () => undefined),
    confirm: vi.fn(async () => true),
    run: vi.fn(async () => undefined),
    signIn: vi.fn(async () => ({ ok: true as const })),
    signInHarness: vi.fn(async (_h: 'codex', handlers: { onProgress: (t: string) => void; onUrl: (u: string) => void }) => {
      handlers.onProgress('Enter the code ABCD-12345');
      handlers.onUrl('https://auth.openai.com/codex/device');
      return { ok: true as const };
    }),
    setHarnesses: vi.fn(async () => undefined),
    cancel: vi.fn(),
    openUrl: vi.fn(),
    ...over,
  } as unknown as LocalDaemonPanelDeps & Record<'signInHarness' | 'setHarnesses' | 'run' | 'confirm' | 'openUrl', ReturnType<typeof vi.fn>>;
  const parent = mount();
  renderLocalDaemonPanel(parent, d);
  return { d, parent };
}

const rowOf = (parent: HTMLElement, id: string) => parent.querySelector(`.ct-local-daemon-harness-${id}`) as HTMLElement;
const boxOf = (parent: HTMLElement, id: string) => rowOf(parent, id).querySelector('input[type=checkbox]') as HTMLInputElement;

describe('Local daemon panel: harness toggles', () => {
  it('lists the four harnesses with their state; Claude is on by default and, being the only one on, cannot be turned off', async () => {
    const { parent } = setup(snap({}, { harnesses: ['claude'] }));
    await flush();
    expect(boxOf(parent, 'claude').checked).toBe(true);
    expect(boxOf(parent, 'claude').disabled).toBe(true);
    expect(boxOf(parent, 'codex').checked).toBe(false);
    expect(boxOf(parent, 'opencode').checked).toBe(false);
    expect(boxOf(parent, 'antigravity').checked).toBe(false);
    expect(rowOf(parent, 'codex').textContent).toContain('Off');
    expect(rowOf(parent, 'antigravity').textContent).toContain('Off');
  });

  it('turning one on stores the new set (Claude kept) and re-reads the state', async () => {
    const { d, parent } = setup(snap({}, { harnesses: ['claude'] }));
    await flush();
    const box = boxOf(parent, 'codex');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await flush();
    expect(d.setHarnesses).toHaveBeenCalledWith(['claude', 'codex']);
    expect((d.snapshot as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it('turning Claude off while Codex is on stores Codex only', async () => {
    const { d, parent } = setup(snap({}, { harnesses: ['claude', 'codex'] }));
    await flush();
    const box = boxOf(parent, 'claude');
    expect(box.disabled).toBe(false);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await flush();
    expect(d.setHarnesses).toHaveBeenCalledWith(['codex']);
  });

  it('a failed change is shown, not swallowed', async () => {
    const { parent } = setup(snap({}, { harnesses: ['claude'] }), { setHarnesses: vi.fn(async () => { throw new Error('Wait for it to finish'); }) });
    await flush();
    const box = boxOf(parent, 'codex');
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await flush();
    expect(parent.querySelector('.ct-local-daemon-error')?.textContent).toContain('Wait for it to finish');
  });

  it('shows Apply changes when the container differs from the toggles, and it runs the update', async () => {
    const { d, parent } = setup(snap({ containerSpec: 'stale', credentialInVolume: true }, { harnesses: ['claude', 'codex'] }));
    await flush();
    const apply = [...parent.querySelectorAll('button')].find((b) => b.textContent === 'Apply changes') as HTMLButtonElement;
    expect(apply).toBeTruthy();
    apply.click();
    await flush();
    expect(d.confirm.mock.calls[0]![0]).toContain('Codex CLI');
    expect(d.run).toHaveBeenCalledWith('update', expect.anything());
  });
});

describe('Local daemon panel: harness sign-in state', () => {
  const all = { harnesses: ['claude', 'codex', 'opencode', 'antigravity'] as Array<'claude' | 'codex' | 'opencode' | 'antigravity'> };

  it('shows CLI and sign-in state per harness', async () => {
    const { parent } = setup(snap({ credentialInVolume: true, harnessProbe: probe(true) }, all));
    await flush();
    expect(rowOf(parent, 'codex').textContent).toContain('CLI installed, signed in');
    expect(rowOf(parent, 'opencode').textContent).toContain('CLI installed, not signed in');
    expect(rowOf(parent, 'codex').querySelector('button')).toBeNull();
  });

  it('Codex not signed in: a Sign in button runs the device flow, shows the sign-in link, and opens it', async () => {
    const { d, parent } = setup(snap({ credentialInVolume: true, harnessProbe: probe(false) }, all));
    await flush();
    const button = rowOf(parent, 'codex').querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toBe('Sign in to Codex');
    let linkSeen = '';
    d.signInHarness.mockImplementationOnce(async (_h: string, handlers: { onProgress: (t: string) => void; onUrl: (u: string) => void }) => {
      handlers.onUrl('https://auth.openai.com/codex/device');
      handlers.onProgress('Enter the code ABCD-12345');
      linkSeen = (parent.querySelector('.ct-local-daemon-signin-link a') as HTMLAnchorElement | null)?.href ?? '';
      expect(parent.querySelector('.ct-local-daemon-signin-status')?.textContent).toContain('ABCD-12345');
      return { ok: true as const };
    });
    button.click();
    await flush();
    expect(d.signInHarness).toHaveBeenCalledWith('codex', expect.anything());
    expect(d.openUrl).toHaveBeenCalledWith('https://auth.openai.com/codex/device');
    expect(linkSeen).toContain('auth.openai.com');
  });

  it('Antigravity not signed in: Sign in to Antigravity opens the Google URL, renders the code input, and submits the pasted code', async () => {
    const { d, parent } = setup(snap({ credentialInVolume: true, harnessProbe: probe(true, false) }, all));
    await flush();
    const button = rowOf(parent, 'antigravity').querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toBe('Sign in to Antigravity');
    expect(button.classList.contains('ct-local-daemon-btn-sign-in-antigravity')).toBe(true);
    let pastedCode: string | null = null;
    d.signInHarness.mockImplementationOnce(async (_h: string, handlers: { onProgress: (t: string) => void; onUrl: (u: string) => void; onCodePrompt?: () => Promise<string | null> }) => {
      handlers.onUrl('https://accounts.google.com/o/oauth2/auth');
      const codePromise = handlers.onCodePrompt!();
      const input = parent.querySelector('.ct-local-daemon-code input') as HTMLInputElement;
      expect(input).toBeTruthy();
      input.value = '  4/0AcvDMrTestCode  ';
      (parent.querySelector('.ct-local-daemon-code button.mod-cta') as HTMLButtonElement).click();
      pastedCode = await codePromise;
      return { ok: true as const };
    });
    button.click();
    await flush();
    expect(d.signInHarness).toHaveBeenCalledWith('antigravity', expect.objectContaining({ onCodePrompt: expect.any(Function) }));
    expect(d.openUrl).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/auth');
    expect(pastedCode).toBe('4/0AcvDMrTestCode');
  });

  it('a Codex sign-in failure is shown with the exact fallback command', async () => {
    const { parent } = setup(snap({ credentialInVolume: true, harnessProbe: probe(false) }, all), {
      signInHarness: vi.fn(async () => ({ ok: false as const, error: 'Codex sign-in did not complete (exit 1).\nOr run this in a terminal:\ncontainer exec -it --user 10001 n /opt/harnesses/bin/codex login --device-auth' })),
    });
    await flush();
    (rowOf(parent, 'codex').querySelector('button') as HTMLButtonElement).click();
    await flush();
    const err = parent.querySelector('.ct-local-daemon-error')?.textContent ?? '';
    expect(err).toContain('did not complete');
    expect(err).toContain('codex login --device-auth');
  });

  it('OpenCode has no button, but the exact command is on screen', async () => {
    const { parent } = setup(snap({ credentialInVolume: true, harnessProbe: probe(true) }, all));
    await flush();
    const row = rowOf(parent, 'opencode');
    expect(row.querySelector('button')).toBeNull();
    expect(row.querySelector('code')?.textContent).toContain('exec -it --user 10001 agent-threads-local-abcd1234 /opt/harnesses/bin/opencode auth login');
    // the managed runtime path contains a space, so it is quoted
    expect(row.querySelector('code')?.textContent?.startsWith("'/Users/user/Library/Application Support")).toBe(true);
  });

  it('renders no harness block while an operation is running', async () => {
    const { parent } = setup(snap({}, { ...all, busy: { kind: 'update', label: 'Updating the local daemon' } }));
    await flush();
    expect(parent.querySelector('.ct-local-daemon-harnesses')?.children.length).toBe(0);
  });
});
