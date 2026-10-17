/**
 * @vitest-environment jsdom
 */
import '../setup/obsidian-dom';
import { describe, it, expect, vi } from 'vitest';
import { renderLocalDaemonPanel, type LocalDaemonPanelDeps } from '../../src/localDaemon/localDaemonPanel';
import { LocalDaemonAbortedError } from '../../src/localDaemon/provision';
import type { LocalDaemonSnapshot } from '../../src/localDaemon/controller';
import { snap } from '../helpers/localDaemonSnap';

const flush = () => new Promise((r) => setTimeout(r, 0));
const NOT_SET_UP = snap({ container: 'absent', imageReady: false, volumesPresent: false, health: 'na', welcome: undefined }, {}, false);

function deps(over: Partial<LocalDaemonPanelDeps> & { snapshots?: LocalDaemonSnapshot[] } = {}) {
  const snapshots = over.snapshots ?? [NOT_SET_UP];
  const listeners = new Set<() => void>();
  let calls = 0;
  const d = {
    isMobile: false,
    pluginVersion: '0.65.0',
    snapshot: vi.fn(async () => snapshots[Math.min(calls++, snapshots.length - 1)]!),
    subscribe: vi.fn((l: () => void) => { listeners.add(l); return () => listeners.delete(l); }),
    confirm: vi.fn(async () => true),
    run: vi.fn(async () => undefined),
    signIn: vi.fn(async () => ({ ok: true as const })),
    cancel: vi.fn(),
    setVisible: vi.fn(),
    ...over,
  } as unknown as LocalDaemonPanelDeps & { snapshot: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn>; signIn: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn> };
  return { d, listeners, emit: () => listeners.forEach((l) => l()) };
}
const mount = () => { const el = document.createElement('div'); document.body.appendChild(el); return el; };
const btn = (root: HTMLElement, label: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const text = (root: HTMLElement, sel: string) => root.querySelector(sel)?.textContent ?? '';

describe('renderLocalDaemonPanel', () => {
  it('renders nothing at all on mobile', async () => {
    const parent = mount();
    const { d } = deps({ isMobile: true });
    const panel = renderLocalDaemonPanel(parent, d);
    await flush();
    expect(panel.el).toBeNull();
    expect(parent.children).toHaveLength(0);
    expect(d.snapshot).not.toHaveBeenCalled();
  });

  it('hides its whole block on an unsupported Mac', async () => {
    const parent = mount();
    const { d } = deps({ snapshots: [snap({ supported: false, unsupportedReason: 'macOS 26' })] });
    renderLocalDaemonPanel(parent, d);
    await flush();
    expect(d.setVisible).toHaveBeenLastCalledWith(false);
    expect(parent.querySelector('.ct-local-daemon')?.classList.contains('is-hidden')).toBe(true);
  });

  it('shows status and a Set up button; Set up confirms with the disclosure, then runs', async () => {
    const parent = mount();
    const { d } = deps();
    renderLocalDaemonPanel(parent, d);
    await flush();
    expect(text(parent, '.ct-local-daemon-status-value')).toBe('Not set up');
    expect(parent.querySelector('.ct-local-daemon-note')?.textContent).toMatch(/survive|keep running/);
    btn(parent, 'Set up')!.click();
    await flush();
    expect(d.confirm).toHaveBeenCalledOnce();
    const message = d.confirm.mock.calls[0]![0] as string;
    expect(message).toContain('READ-WRITE');
    expect(message).toContain('/Users/user/Vault');
    expect(d.run).toHaveBeenCalledWith('setup', expect.anything());
  });

  it('declining the confirmation runs nothing', async () => {
    const parent = mount();
    const { d } = deps({ confirm: vi.fn(async () => false) } as never);
    renderLocalDaemonPanel(parent, d);
    await flush();
    btn(parent, 'Set up')!.click();
    await flush();
    expect(d.run).not.toHaveBeenCalled();
  });

  it('Start needs no confirmation; Reset and Remove do', async () => {
    const parent = mount();
    const { d } = deps({ snapshots: [snap({ container: 'stopped', health: 'na', welcome: undefined })] });
    renderLocalDaemonPanel(parent, d);
    await flush();
    btn(parent, 'Start')!.click();
    await flush();
    expect(d.confirm).not.toHaveBeenCalled();
    expect(d.run).toHaveBeenCalledWith('start', expect.anything());
    btn(parent, 'Reset daemon data')!.click();
    await flush();
    expect(d.confirm).toHaveBeenCalledOnce();
    expect(d.run).toHaveBeenLastCalledWith('reset', expect.anything());
  });

  it('shows a failure from a run and keeps the buttons usable', async () => {
    const parent = mount();
    const { d } = deps({ run: vi.fn(async () => { throw new Error('Port 7433 is in use'); }) } as never);
    renderLocalDaemonPanel(parent, d);
    await flush();
    btn(parent, 'Set up')!.click();
    await flush();
    expect(text(parent, '.ct-local-daemon-error')).toBe('Port 7433 is in use');
    expect(btn(parent, 'Set up')).toBeTruthy();
  });

  it('a cancelled run is not reported as an error', async () => {
    const parent = mount();
    const { d } = deps({ run: vi.fn(async () => { throw new LocalDaemonAbortedError(); }) } as never);
    renderLocalDaemonPanel(parent, d);
    await flush();
    btn(parent, 'Set up')!.click();
    await flush();
    expect(text(parent, '.ct-local-daemon-error')).toBe('');
  });

  it('while busy it shows progress and only Cancel, and re-renders on controller events', async () => {
    const parent = mount();
    const busy = snap({ container: 'absent', imageReady: false, volumesPresent: false, health: 'na', welcome: undefined }, { busy: { kind: 'setup', label: 'Downloading the daemon image', percent: 40, line: 'layer 2' } }, true);
    const { d, emit } = deps({ snapshots: [NOT_SET_UP, busy] });
    renderLocalDaemonPanel(parent, d);
    await flush();
    emit();
    await flush();
    expect(text(parent, '.ct-local-daemon-progress')).toBe('Downloading the daemon image 40%: layer 2');
    expect([...parent.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Cancel']);
    btn(parent, 'Cancel')!.click();
    expect(d.cancel).toHaveBeenCalled();
  });

  it('sign in: link, code prompt, submit', async () => {
    const parent = mount();
    let handlers!: Parameters<LocalDaemonPanelDeps['signIn']>[0];
    let result!: (v: { ok: true }) => void;
    const signIn = vi.fn((h: typeof handlers) => { handlers = h; return new Promise<{ ok: true }>((r) => { result = r; }); });
    const { d } = deps({ snapshots: [snap({ credentialInKeychain: false, credentialInVolume: false })], signIn } as never);
    renderLocalDaemonPanel(parent, d);
    await flush();
    btn(parent, 'Sign in to Claude')!.click();
    await flush();
    handlers.onProgress('Opening sign-in');
    handlers.onUrl('https://claude.ai/oauth/x');
    expect(parent.querySelector('.ct-local-daemon-signin-link a')?.getAttribute('href')).toBe('https://claude.ai/oauth/x');
    const code = handlers.onCodePrompt();
    await flush();
    (parent.querySelector('.ct-local-daemon-code input') as HTMLInputElement).value = ' abc123 ';
    btn(parent, 'Submit')!.click();
    expect(await code).toBe('abc123');
    result({ ok: true });
    await flush();
    expect(parent.querySelector('.ct-local-daemon-signin')?.children).toHaveLength(0);
  });

  it('a failed sign-in is shown', async () => {
    const parent = mount();
    const { d } = deps({ snapshots: [snap({ credentialInKeychain: false, credentialInVolume: false })], signIn: vi.fn(async () => ({ ok: false as const, error: 'Sign-in timed out' })) } as never);
    renderLocalDaemonPanel(parent, d);
    await flush();
    btn(parent, 'Sign in to Claude')!.click();
    await flush();
    expect(text(parent, '.ct-local-daemon-error')).toBe('Sign-in timed out');
  });

  it('stops listening once the block has been removed from the page', async () => {
    const parent = mount();
    const { d, listeners, emit } = deps();
    renderLocalDaemonPanel(parent, d);
    await flush();
    parent.remove();
    emit();
    await flush();
    expect(listeners.size).toBe(0);
  });
});
